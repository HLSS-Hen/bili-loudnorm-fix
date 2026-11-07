// ==UserScript==
// @name         响度均衡
// @namespace    bili-loudnorm
// @version      1.1.0
// @description  测量整段视频的响度，按需施加一个固定增益，拉齐 B 站连播时忽大忽小的音量。不压缩原声、不干预播放器；覆盖普通投稿、多 P、番剧影视选集。
// @license      MIT
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/festival/*
// @exclude      https://www.bilibili.com/video/*/play/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      bilibili.com
// @connect      bilivideo.com
// @connect      bilivideo.cn
// @connect      hdslb.com
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * 设计要点（改代码前先看这几条）
 *
 * 1. 一个 <video> 只能被一个 AudioContext 抢到 createMediaElementSource()。
 *    我们抢到之后，B 站播放器换集时还会对同一个元素再要一次，原生会抛
 *    InvalidStateError；B 站那侧的 gain 就建不起来，它的 dispose 里
 *    setGain() 读 this.gain.gain 会炸，换集直接失败（页面上表现为
 *    「Cannot read properties of undefined (reading 'gain')」+ 新一集不播）。
 *    所以这里给 createMediaElementSource 加了守卫：同一个元素第二次被要时
 *    返回一个同 context 的静音 GainNode，B 站拿到节点就不再崩。
 *
 * 2. 永不 disconnect 任何节点、永不 pause、永不 preventDefault。
 *    切集时 <video> 会被复用，断链等于把这个元素永久弄哑。
 *
 * 3. 只有 AudioContext 确实 running 时才接管，否则声音会被路由进挂起的 context。
 *
 * 4. 整片响度靠 DASH 索引 + 等距抽样算出来，全程只读不写；算不出来就保持原声，
 *    绝不拿错的数据去改音量。
 */
(function () {
  'use strict';

  const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  const TAG = '[响度均衡]';

  /* ================================================================
   * 配置
   * ================================================================ */
  const CFG = {
    enabled: true,
    target: -14,          // 目标响度 LUFS
    maxBoost: 12,         // 最大提升 dB
    minGain: -60,         // 最大衰减 dB
    preset: 'standard',   // 当前预设：standard / dynamic / headphone / speaker / night（custom = 用 API 直接改过目标）
    ceiling: -1.0,        // 峰值余量上限 dBFS（留一点真峰值空间）
    fadeMs: 100,          // 增益切换的淡入淡出时长（ms）
    partialIntervalMs: 500, // 抽样期间的最小计算间隔：到点就重算一次
    partialDeadbandDb: 0.2, // 预估增益变化小于它就不重复落位，避免抖动
    presets: {
      standard: { label: '标准', target: -14, maxBoost: 12 },
      dynamic: { label: '高动态', target: -24, maxBoost: 12 },
      night: { label: '深夜', target: -20, maxBoost: 6 },
      headphone: { label: '耳机', target: -16, maxBoost: 12 },
      speaker: { label: '外放', target: -11, maxBoost: 10 },
    },
    sampleSegments: 12,   // 等距抽几段
    concurrency: 4,
    requestGapMs: 80,     // 两次请求发起之间的最小间隔，防 CDN 限流
    fetchTimeoutMs: 15000, // 索引/init 这类小请求的超时
    segTimeout: 8000,     // 单段超时（超时只是丢这一段，不再中断整次分析）
    segRetry: 1,          // 单段重试次数
    minSegments: 3,       // 成功段数少于这个就放弃本次测量，绝不拿残数据算
    pollMs: 300,
    mutationDebounce: 250,
    waitTolerance: 3,     // 元素时长与流时长容差（秒）
    waitGraceMs: 20000,
    cacheMax: 2233,       // 写死，不对外开放设置
    cacheTtlMs: 30 * 24 * 3600 * 1000,
    ssrMeta: true,        // 接口没元数据时，回读该集页面 SSR 的 __playinfo__
    /* 本地算出来的条目，播放中回头看看 B 站有没有测好官方的 */
    upgradeCheckMs: 60000,   // 首次检查延迟（播放中）
    upgradeRetryMs: 5 * 60 * 1000, // 没查到再试一次
    debug: false,
  };

  /* ================================================================
   * 日志
   * ================================================================ */
  const Log = (() => {
    const ring = [];
    let debugOn = CFG.debug;

    function stringify(a) {
      if (a instanceof Error) return a.message;
      if (a && typeof a === 'object' && typeof a.message === 'string' && !a.tagName) return a.message;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }
      return String(a);
    }

    function push(level, args) {
      const msg = args.map(stringify).join(' ');
      ring.push({ t: Date.now(), level, msg });
      if (ring.length > 400) ring.shift();
      // 控制台只留 warn / error（info 仍在 __bln.logs() 里，debug 打开时才放出来）
      if ((level === 'info' || level === 'debug') && !debugOn) return;
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn.call(console, TAG, msg);
    }

    return {
      info: function () { push('info', [].slice.call(arguments)); },
      warn: function () { push('warn', [].slice.call(arguments)); },
      error: function () { push('error', [].slice.call(arguments)); },
      debug: function () { push('debug', [].slice.call(arguments)); },
      setDebug: function (v) { debugOn = !!v; },
      ring: function () { return ring.slice(); },
      clear: function () { ring.length = 0; },
    };
  })();

  /* ================================================================
   * 小工具
   * ================================================================ */
  const U = {
    round: function (v, n) {
      const p = Math.pow(10, n === undefined ? 2 : n);
      return Math.round(v * p) / p;
    },
    dbToLinear: function (db) { return Math.pow(10, db / 20); },
    linearToDb: function (lin) { return 20 * Math.log10(lin > 0 ? lin : 1e-12); },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    /** 只算数值（+2.3 / -0.8 / +0.0），单位由 HTML 里的独立节点给出，便于控制间距 */
    fmtDbNum: function (v) {
      if (!Number.isFinite(v)) return '—';
      // 先四舍五入再取一位：+0.004 不能被显示成 +0.0，+0.006 不能被抹成 +0.0
      const r = Math.round(v * 10) / 10;
      const z = r === 0 ? 0 : r;   // 去掉 -0.0
      return v > 0 && z === 0 ? '+0.0' : (z >= 0 ? '+' : '') + z.toFixed(1);
    },
    fmtDb: function (v) {
      if (!Number.isFinite(v)) return '—';
      return U.fmtDbNum(v) + ' dB';
    },
    now: function () { return Date.now(); },
  };

  /* ================================================================
   * 缓存与设置（GM 存储）
   * ================================================================ */
  const Store = (() => {
    const P = 'bln:';
    const K_SET = P + 'settings';
    const K_META = P + 'm:';
    const K_IDX = P + 'index';
    const has = typeof GM_getValue === 'function';

    function read(key, def) {
      if (!has) return def;
      try {
        const v = GM_getValue(key);
        if (v === undefined || v === null) return def;
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch (e) {
        return def;
      }
    }

    function write(key, value) {
      if (!has) return false;
      try {
        GM_setValue(key, typeof value === 'string' ? value : JSON.stringify(value));
        return true;
      } catch (e) {
        Log.warn('写缓存失败', e);
        return false;
      }
    }

    function del(key) {
      if (typeof GM_deleteValue === 'function') {
        try { GM_deleteValue(key); } catch (e) { /* 忽略 */ }
      }
    }

    function index() { return read(K_IDX, {}) || {}; }

    /**
     * 预设归一：认识的直接用它的参数（预设是死数，以它为准）；
     * 旧配置里没存预设的，按目标响度 + 提升上限反推；都对不上就是 custom。
     */
    function pickPreset(name, target, maxBoost) {
      if (name && CFG.presets[name]) {
        CFG.target = CFG.presets[name].target;
        CFG.maxBoost = CFG.presets[name].maxBoost;
        return name;
      }
      const keys = Object.keys(CFG.presets);
      for (let i = 0; i < keys.length; i++) {
        const p = CFG.presets[keys[i]];
        if (Math.abs(p.target - target) < 0.01 && Math.abs(p.maxBoost - maxBoost) < 0.01) return keys[i];
      }
      return 'custom';
    }

    /** 删一条：正文 + 索引一起删，别留死条目 */
    function dropKey(key) {
      del(K_META + key);
      const idx = index();
      if (Object.prototype.hasOwnProperty.call(idx, key)) {
        delete idx[key];
        write(K_IDX, idx);
      }
    }

    function touch(key) {
      const idx = index();
      idx[key] = U.now();
      write(K_IDX, idx);
      enforce();
    }

    /** 按「最久未使用」淘汰到上限，返回删掉的条数 */
    function enforce() {
      const idx = index();
      const keys = Object.keys(idx);
      if (keys.length <= CFG.cacheMax) return 0;
      keys.sort(function (a, b) { return (idx[a] || 0) - (idx[b] || 0); });
      let removed = 0;
      while (keys.length > CFG.cacheMax) {
        const dead = keys.shift();
        delete idx[dead];
        del(K_META + dead);
        removed++;
      }
      write(K_IDX, idx);
      return removed;
    }

    return {
      /* 设置 */
      loadSettings: function () {
        const s = read(K_SET, null);
        if (!s) return;
        if (typeof s.enabled === 'boolean') CFG.enabled = s.enabled;
        if (Number.isFinite(s.minGain)) CFG.minGain = s.minGain;
        const t = Number.isFinite(s.target) ? s.target : CFG.target;
        const b = Number.isFinite(s.maxBoost) ? s.maxBoost : CFG.maxBoost;
        CFG.target = t;
        CFG.maxBoost = b;
        CFG.preset = pickPreset(s.preset, t, b);
      },
      saveSettings: function () {
        write(K_SET, {
          enabled: CFG.enabled,
          preset: CFG.preset,
          target: CFG.target,
          maxBoost: CFG.maxBoost,
          minGain: CFG.minGain,
        });
      },

      /* 测量结果：{ i, tp, at } */
      getMeta: function (key) {
        const v = read(K_META + key, null);
        if (!v || !Number.isFinite(v.i)) {
          if (v) dropKey(key);
          return null;
        }
        if (U.now() - (v.at || 0) > CFG.cacheTtlMs) {
          dropKey(key);        // 过期连索引一起清，否则 stats 会虚高、还挤占 500 条名额
          return null;
        }
        touch(key);            // 命中即刷新时间戳 —— 这样才是真的 LRU
        return v;
      },
      putMeta: function (key, i, tp, dur, src) {
        write(K_META + key, {
          i: U.round(i, 2),
          tp: Number.isFinite(tp) ? U.round(tp, 2) : null,
          d: Number.isFinite(dur) ? U.round(dur, 2) : null,
          src: src === 'meta' ? 'meta' : 'sample',   // 记来源：本地算的以后要试着换成官方的
          at: U.now(),
        });
        touch(key);
      },
      dropMeta: function (key) {
        dropKey(key);
      },
      clear: function () {
        const idx = index();
        Object.keys(idx).forEach(function (k) { del(K_META + k); });
        write(K_IDX, {});
        Log.info('测量缓存已清空');
      },
      /** 上限调小后立刻按 LRU 淘汰 */
      trim: function () { return enforce(); },
      stats: function () {
        const idx = index();
        const keys = Object.keys(idx);
        return { entries: keys.length, max: CFG.cacheMax };
      },
    };
  })();

  /* ================================================================
   * ISO-BMFF sidx 解析
   *
   * 目标：拿到每一段音频在文件里的绝对字节偏移与时长，用来做 Range 抽样。
   * 偏移基准：sidx box 结束后的第一个字节（file 里常见就是 indexRange.end + 1）。
   * ================================================================ */
  const Sidx = (() => {
    function u64(dv, off) {
      return dv.getUint32(off) * 4294967296 + dv.getUint32(off + 4);
    }

    function boxType(dv, off) {
      return String.fromCharCode(
        dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7)
      );
    }

    /**
     * @param {ArrayBuffer} buf    含 sidx 的那一小段（indexRange 拉回来的字节）
     * @param {number} anchor      buf[0] 在文件里的绝对偏移（通常是 indexRange.start）
     * @returns {null|{endOffset:number, refs:Array<{offset:number,size:number,duration:number,start:number}>}}
     */
    function parse(buf, anchor) {
      if (!buf || buf.byteLength < 16) return null;
      const dv = new DataView(buf);
      let off = 0;
      let sidxOff = -1;
      let sidxSize = 0;

      while (off + 8 <= buf.byteLength) {
        let size = dv.getUint32(off);
        const type = boxType(dv, off);
        if (size === 1) {
          if (off + 16 > buf.byteLength) break;
          size = u64(dv, off + 8);
        } else if (size === 0) {
          size = buf.byteLength - off;
        }
        if (type === 'sidx') {
          sidxOff = off;
          sidxSize = size;
          break;
        }
        if (size < 8) break;
        off += size;
      }

      if (sidxOff < 0) return null;

      let p = sidxOff + 8;
      if (p + 12 > buf.byteLength) return null;
      const version = dv.getUint8(p);
      p += 4;                 // version + flags
      p += 4;                 // reference_ID
      const timescale = dv.getUint32(p);
      p += 4;
      if (!timescale) return null;

      let firstOffset;
      if (version === 0) {
        p += 4;               // earliest_presentation_time
        firstOffset = dv.getUint32(p);
        p += 4;
      } else {
        p += 8;
        firstOffset = u64(dv, p);
        p += 8;
      }
      p += 2;                 // reserved
      const count = dv.getUint16(p);
      p += 2;

      const refs = [];
      let cursor = anchor + (sidxOff + sidxSize) + firstOffset;
      let t = 0;

      for (let i = 0; i < count; i++) {
        if (p + 12 > buf.byteLength) break;
        const w0 = dv.getUint32(p);
        const dur = dv.getUint32(p + 4);
        p += 12;              // + SAP
        const refType = w0 >>> 31;
        const size = w0 & 0x7fffffff;
        if (refType === 0 && size > 0) {
          refs.push({ offset: cursor, size: size, duration: dur / timescale, start: t });
          cursor += size;
          t += dur / timescale;
        }
      }

      return { endOffset: cursor, refs: refs };
    }

    /** 等距挑 n 段（含首尾），去重后返回 */
    function pickEvenly(refs, n) {
      if (!refs || !refs.length) return [];
      if (refs.length <= n) return refs.slice();
      const out = [];
      const seen = new Set();
      for (let i = 0; i < n; i++) {
        const idx = Math.round((i * (refs.length - 1)) / (n - 1));
        if (!seen.has(idx)) { seen.add(idx); out.push(refs[idx]); }
      }
      return out;
    }

    /** "0-820" / "0-" → {start, end}（end 含） */
    function parseRange(str) {
      if (typeof str !== 'string') return null;
      const m = str.match(/^(\d+)-(\d*)$/);
      if (!m) return null;
      return { start: Number(m[1]), end: m[2] ? Number(m[2]) : null };
    }

    return { parse: parse, pickEvenly: pickEvenly, parseRange: parseRange };
  })();

  /* ================================================================
   * HTTP（Range 取片段）
   * ================================================================ */
  const Http = (() => {
    const hasGM = typeof GM_xmlhttpRequest === 'function';

    function normalizeUrl(u) {
      if (typeof u !== 'string' || !u) return u;
      if (u.indexOf('//') === 0) return 'https:' + u;          // 协议相对 → 补 https
      if (u.indexOf('http://') === 0) return 'https://' + u.slice(7);
      return u;
    }

    /** 页面原生 fetch：B 站 CDN 带 ACAO，正常情况走这条最快 */
    async function viaFetch(url, rangeValue, timeoutMs) {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      let timer = null;
      if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { Range: rangeValue },
          credentials: 'omit',
          cache: 'default',
          signal: ctrl ? ctrl.signal : undefined,
        });
        if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
        return { status: res.status, buf: await res.arrayBuffer() };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    /** GM 兜底：CDN 有防盗链，必须带 Referer，否则 403 */
    function viaGM(url, rangeValue, timeoutMs) {
      return new Promise(function (resolve, reject) {
        if (!hasGM) { reject(new Error('无 GM_xmlhttpRequest')); return; }
        try {
          GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: { Range: rangeValue, Referer: 'https://www.bilibili.com/' },
            responseType: 'arraybuffer',
            timeout: timeoutMs,
            onload: function (r) {
              if (r.status === 200 || r.status === 206) resolve({ status: r.status, buf: r.response });
              else reject(new Error('HTTP ' + r.status));
            },
            onerror: function () { reject(new Error('网络错误')); },
            ontimeout: function () { reject(new Error('超时')); },
          });
        } catch (e) {
          reject(e);
        }
      });
    }

    /**
     * 取一段字节。
     *
     * 顺序：先 fetch（页面上下文，CDN 回 ACAO），失败再 GM（补 Referer）。
     * 之前只用 GM 且不带 Referer —— 这正是 `index 失败：HTTP 403` 的来源。
     *
     * 另外两种 CDN 脾气也一并在这一层消化：
     *   - 忽略 Range 回 200 整包：按 start 切出需要的那段；
     *   - 长度不符/截断：当作失败重试。
     */
    async function range(url, start, end, tag, opts) {
      const u = normalizeUrl(url);
      const rangeValue = 'bytes=' + start + '-' + (end === null || end === undefined ? '' : end);
      const expected = (end === null || end === undefined) ? null : end - start + 1;
      const o = opts || {};
      const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : CFG.fetchTimeoutMs;
      const tries = Number.isFinite(o.retries) ? o.retries : CFG.segRetry;
      const label = tag || 'range';
      let lastErr = null;

      for (let attempt = 0; attempt <= tries; attempt++) {
        try {
          let r;
          try {
            r = await viaFetch(u, rangeValue, timeoutMs);
          } catch (e) {
            lastErr = e;
            Log.debug(label + ' fetch 失败（' + (e && e.message) + '）→ 改走 GM');
            r = await viaGM(u, rangeValue, timeoutMs);
          }

          let buf = r.buf;
          if (!buf) throw new Error('空响应');
          if (!expected || buf.byteLength === expected) return buf;
          if (r.status === 200 && buf.byteLength >= expected) {
            Log.debug(label + ' 服务端忽略了 Range（200/' + buf.byteLength + 'B）→ 本地切片');
            return buf.slice(start, start + expected);
          }
          throw new Error('长度不符 ' + buf.byteLength + '/' + expected);
        } catch (e) {
          lastErr = e;
          if (attempt < tries) await U.sleep(200 + 150 * attempt);
        }
      }
      throw new Error(label + ' 失败：' + (lastErr && lastErr.message));
    }

    async function json(url) {
      const opts = { method: 'GET', url: url, responseType: 'text', timeout: 15000, withCredentials: true };
      const r = hasGM ? await gmRequest(opts) : await fetch(url, { credentials: 'include' });
      const text = hasGM ? r.response : await r.text();
      try { return JSON.parse(text); } catch (e) { throw new Error('响应不是 JSON'); }
    }

    /** 取整页 HTML（要带 cookie，SSR 才会给出登录态下的 playinfo） */
    async function text(url) {
      if (hasGM) {
        const r = await gmRequest({ method: 'GET', url: url, responseType: 'text', timeout: 20000, withCredentials: true });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return String(r.response || '');
      }
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    }

    function gmRequest(opts) {
      return new Promise(function (resolve, reject) {
        GM_xmlhttpRequest({
          method: opts.method || 'GET',
          url: opts.url,
          headers: opts.headers || {},
          responseType: opts.responseType || 'arraybuffer',
          timeout: opts.timeout || 15000,
          withCredentials: !!opts.withCredentials,
          onload: function (r) { resolve(r); },
          onerror: function () { reject(new Error('网络错误')); },
          ontimeout: function () { reject(new Error('超时')); },
        });
      });
    }

    return { range: range, json: json, text: text, normalizeUrl: normalizeUrl };
  })();

  /* ================================================================
   * 响度（ITU-R BS.1770-4 / EBU R128）
   *
   *   1. K 加权：高架滤波 + 38Hz 高通（按采样率解析计算系数）
   *   2. 400ms 窗、100ms 步进，算每块能量
   *   3. 绝对门限 -70 LUFS，相对门限 -10 LU，取过门限块的平均
   * ================================================================ */
  const Loudness = (() => {
    function kWeighting(fs) {
      // 第一级：高架（头相关）
      const f0 = 1681.974450955533;
      const G = 3.999843853973347;
      const Q = 0.7071752369554196;
      let K = Math.tan(Math.PI * f0 / fs);
      const Vh = Math.pow(10, G / 20);
      const Vb = Math.pow(Vh, 0.4996667741545416);
      let a0 = 1 + K / Q + K * K;
      const shelf = {
        b0: (Vh + Vb * K / Q + K * K) / a0,
        b1: 2 * (K * K - Vh) / a0,
        b2: (Vh - Vb * K / Q + K * K) / a0,
        a1: 2 * (K * K - 1) / a0,
        a2: (1 - K / Q + K * K) / a0,
      };

      // 第二级：38Hz 高通
      // 注意：分子不除以 a0（分子固定 1,-2,1），这是 BS.1770-4 的写法，
      // 也是 libebur128 / pyloudnorm 的实现；除下去会整体偏 -0.043dB。
      const f1 = 38.13547087602444;
      const Q1 = 0.5003270373238773;
      K = Math.tan(Math.PI * f1 / fs);
      a0 = 1 + K / Q1 + K * K;
      const hp = {
        b0: 1,
        b1: -2,
        b2: 1,
        a1: 2 * (K * K - 1) / a0,
        a2: (1 - K / Q1 + K * K) / a0,
      };
      return { shelf: shelf, hp: hp };
    }

    function biquad(x, c) {
      const y = new Float32Array(x.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) {
        const xi = x[i];
        const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = xi;
        y2 = y1; y1 = yi;
        y[i] = yi;
      }
      return y;
    }

    /**
     * 把一段多声道 PCM 拆成 400ms/100ms 的块，返回每块的响度（LUFS）。
     * @param {Float32Array[]} channels
     * @param {number} fs
     * @returns {{blocks: Float32Array, peak: number}}
     */
    function blocks(channels, fs) {
      const n = channels[0] ? channels[0].length : 0;
      if (!n) return { blocks: new Float32Array(0), peak: 0 };

      const kw = kWeighting(fs);
      const weighted = channels.map(function (ch) {
        return biquad(biquad(ch, kw.shelf), kw.hp);
      });

      // 峰值按加权前的原始信号取（真实峰值近似）
      let peak = 0;
      for (let c = 0; c < channels.length; c++) {
        const ch = channels[c];
        for (let i = 0; i < ch.length; i++) {
          const a = ch[i] < 0 ? -ch[i] : ch[i];
          if (a > peak) peak = a;
        }
      }

      const win = Math.round(fs * 0.4);
      const hop = Math.round(fs * 0.1);
      const count = Math.max(0, Math.floor((n - win) / hop) + 1);
      const out = new Float32Array(count);

      for (let b = 0; b < count; b++) {
        const s = b * hop;
        const e = s + win;
        let sum = 0;
        for (let c = 0; c < weighted.length; c++) {
          const ch = weighted[c];
          let acc = 0;
          for (let i = s; i < e; i++) acc += ch[i] * ch[i];
          sum += acc / win;
        }
        out[b] = -0.691 + 10 * Math.log10(sum > 0 ? sum : 1e-12);
      }
      return { blocks: out, peak: peak };
    }

    /** 门限积分（block 级） */
    function integrate(allBlocks) {
      let gated = [];
      let sum = 0;
      for (let i = 0; i < allBlocks.length; i++) {
        const l = allBlocks[i];
        if (l > -70) { gated.push(l); sum += Math.pow(10, l / 10); }
      }
      if (!gated.length) return -Infinity;

      const absAvg = 10 * Math.log10(sum / gated.length);
      const rel = absAvg - 10;
      let sum2 = 0, n2 = 0;
      for (let i = 0; i < allBlocks.length; i++) {
        const l = allBlocks[i];
        if (l > -70 && l > rel) { sum2 += Math.pow(10, l / 10); n2++; }
      }
      if (!n2) return absAvg;
      return 10 * Math.log10(sum2 / n2);
    }

    /** 便捷入口：PCM → { integrated, peakDb, seconds } */
    function measure(channels, fs) {
      const r = blocks(channels, fs);
      const integrated = integrate(r.blocks);
      return {
        integrated: integrated,
        peakDb: r.peak > 0 ? U.linearToDb(r.peak) : -Infinity,
        seconds: (channels[0] ? channels[0].length : 0) / fs,
      };
    }

    return { kWeighting: kWeighting, blocks: blocks, integrate: integrate, measure: measure };
  })();

  /* ================================================================
   * 增益规划
   * ================================================================ */
  const GainPlan = (() => {
    /**
     * @param {{measuredI:number, truePeak:number}} m
     * @returns {{gainDb:number, reasons:string[]}}
     */
    function plan(m) {
      const reasons = [];
      // 响度不可能是正数；B 站对没测过的视频填 0.001 占位，也一并挡掉
      if (!Number.isFinite(m.measuredI) || m.measuredI <= -70 || m.measuredI > 0) {
        return { gainDb: 0, reasons: ['无有效响度'] };
      }

      let gain = CFG.target - m.measuredI;

      if (gain > CFG.maxBoost) { gain = CFG.maxBoost; reasons.push('提升上限'); }
      if (gain < CFG.minGain) { gain = CFG.minGain; reasons.push('衰减下限'); }

      if (Number.isFinite(m.truePeak)) {
        // 峰值上限只能「挡住提升」，绝不因为峰值高就把声音压小
        const budget = Math.max(0, CFG.ceiling - m.truePeak);
        if (gain > budget) {
          gain = budget;
          // 面板第二行只认「峰值受限」；衰减本就不可能被峰值挡，那时留个内部标记够排障用了
          reasons.push(CFG.target - m.measuredI > 0 ? '峰值受限' : '峰值上限');
        }
      }

      return { gainDb: U.round(gain, 2), reasons: reasons };
    }

    return { plan: plan };
  })();

  /* ================================================================
   * 音频源守卫（关键修复）
   *
   * 同一个 <video> 第二次被要 createMediaElementSource 时，原生抛
   * InvalidStateError。B 站播放器换集时正好会再来一次，它那侧的 gain 就
   * 建不起来，dispose 里 setGain() 读 this.gain.gain 直接炸，换集失败。
   * 这里给第二次调用方一个同 context 的静音 GainNode：接口齐全、不发声。
   * ================================================================ */
  const SourceGuard = (() => {
    let installed = false;
    let dummies = 0;
    const claimed = new WeakMap();

    function install() {
      if (installed) return true;
      const ctor = PAGE.AudioContext || PAGE.webkitAudioContext;
      if (!ctor || !ctor.prototype) return false;

      const proto = ctor.prototype;
      const orig = proto.createMediaElementSource;
      if (typeof orig !== 'function') return false;
      if (orig.__blnGuard) { installed = true; return true; }

      const patched = function (el) {
        if (el && typeof el === 'object' && claimed.has(el)) {
          dummies++;
          const dummy = this.createGain();
          try {
            dummy.gain.value = 0;
            Object.defineProperty(dummy, 'mediaElement', {
              get: function () { return el; },
              configurable: true,
            });
            Object.defineProperty(dummy, '__blnDummy', { value: true, configurable: true });
          } catch (e) { /* 标记失败不影响返回 */ }
          Log.info('页面再次索取同一 <video> 的音频源 → 返回哑节点（避免它换集时崩）');
          return dummy;
        }
        const node = orig.apply(this, arguments);
        if (el && typeof el === 'object') claimed.set(el, this);
        return node;
      };
      patched.__blnGuard = true;

      try {
        Object.defineProperty(proto, 'createMediaElementSource', {
          value: patched,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      } catch (e) {
        try { proto.createMediaElementSource = patched; } catch (e2) { return false; }
      }
      if (proto.createMediaElementSource !== patched) {
        Log.warn('createMediaElementSource 守卫安装失败（沙箱隔离），换集仍有崩溃风险');
        return false;
      }
      installed = true;
      Log.debug('createMediaElementSource 守卫已安装');
      return true;
    }

    return {
      install: install,
      isDummy: function (node) { return !!(node && node.__blnDummy); },
      isInstalled: function () { return installed; },
      count: function () { return dummies; },
    };
  })();

  /* ================================================================
   * 音频引擎：<video> → MediaElementSource → masterGain → destination
   * ================================================================ */
  const Engine = (() => {
    let ctx = null;
    let master = null;
    let appliedDb = 0;
    let desiredDb = 0;
    let gestureArmed = false;
    let warnedOccupied = false;

    const attached = new WeakSet();
    const failed = new WeakSet();
    const pending = new Set();
    const stats = { attached: 0, failed: 0, deferred: 0, resumes: 0, gainSets: 0 };

    function ensureCtx() {
      if (ctx) return ctx;
      const Ctor = PAGE.AudioContext || PAGE.webkitAudioContext;
      if (!Ctor) { Log.error('浏览器不支持 AudioContext'); return null; }
      try {
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = 1;
        master.connect(ctx.destination);
        Log.debug('AudioContext 就绪 · state=' + ctx.state + ' · ' + ctx.sampleRate + 'Hz');
      } catch (e) {
        Log.error('AudioContext 创建失败', e);
        ctx = null;
        master = null;
      }
      return ctx;
    }

    async function ensureRunning() {
      if (!ctx) return false;
      if (ctx.state === 'running') return true;
      try { await ctx.resume(); stats.resumes++; } catch (e) { Log.debug('resume 被拒绝'); }
      return ctx.state === 'running';
    }

    function armGesture() {
      if (gestureArmed) return;
      gestureArmed = true;
      const events = ['click', 'keydown', 'touchstart', 'pointerdown'];
      const once = async function () {
        events.forEach(function (t) { document.removeEventListener(t, once, true); });
        gestureArmed = false;
        if (ctx) { try { await ctx.resume(); } catch (e) { /* 忽略 */ } }
        await drain();
      };
      events.forEach(function (t) { document.addEventListener(t, once, true); });
      Log.debug('已挂一次性手势钩子');
    }

    async function drain() {
      if (!ctx || ctx.state !== 'running' || !pending.size) return;
      const list = Array.from(pending);
      pending.clear();
      for (let i = 0; i < list.length; i++) await attach(list[i]);
    }

    async function attach(el) {
      if (!el || el.tagName !== 'VIDEO') return false;
      if (attached.has(el)) return true;
      if (failed.has(el) || pending.has(el)) return false;
      if (!CFG.enabled) return false;

      SourceGuard.install();

      const c = ensureCtx();
      if (!c) return false;

      if (c.state !== 'running') {
        const ok = await ensureRunning();
        if (!ok) {
          pending.add(el);
          stats.deferred++;
          armGesture();
          Log.info('AudioContext 尚未 running → 暂缓接管（保持原声）');
          return false;
        }
      }

      try {
        const src = c.createMediaElementSource(el);
        if (SourceGuard.isDummy(src)) {
          failed.add(el);
          stats.failed++;
          // 只在第一次说：轮询每 300ms 会反复走到这里，刷屏没有信息量
          if (!warnedOccupied) {
            warnedOccupied = true;
            Log.warn('该 <video> 的音频源已被页面先占用 → 保持原声（B 站自己的音效在管）');
          } else {
            Log.debug('音频源仍被占用（已提示过）');
          }
          return false;
        }
        src.connect(master);
        attached.add(el);
        stats.attached++;
        Log.info('已接管 video #' + stats.attached);
        applyGain(true);
        return true;
      } catch (e) {
        failed.add(el);
        stats.failed++;
        Log.warn('接管失败，保持原声：' + (e && e.message));
        return false;
      }
    }

    function applyGain(immediate) {
      const target = desiredDb;
      if (!ctx || !master) return false;
      const linear = U.dbToLinear(target);
      try {
        // 100ms 线性淡入淡出：不要硬切，避免「咔」和突兀的音量跳变
        if (!immediate && ctx.state === 'running' && master.gain.linearRampToValueAtTime) {
          const now = ctx.currentTime;
          const cur = master.gain.value;
          master.gain.cancelScheduledValues(now);
          master.gain.setValueAtTime(cur, now);
          master.gain.linearRampToValueAtTime(linear, now + CFG.fadeMs / 1000);
        } else {
          master.gain.value = linear;
        }
        appliedDb = target;
        stats.gainSets++;
        Log.info('施加增益 ' + U.fmtDb(target) + '（' + CFG.fadeMs + 'ms 淡变）');
        return true;
      } catch (e) {
        Log.warn('设置增益失败：' + (e && e.message));
        return false;
      }
    }

    return {
      attach: attach,
      isAttached: function (el) { return !!el && attached.has(el); },
      hasFailed: function (el) { return !!el && failed.has(el); },
      setGainDb: function (db) {
        if (!Number.isFinite(db)) return false;
        desiredDb = db;
        return applyGain(false);
      },
      appliedDb: function () { return appliedDb; },
      desiredDb: function () { return desiredDb; },
      contextState: function () { return ctx ? ctx.state : null; },
      stats: function () {
        return Object.assign({}, stats, {
          pending: pending.size,
          guard: SourceGuard.isInstalled(),
          dummies: SourceGuard.count(),
        });
      },
    };
  })();

  /* ================================================================
   * 页型与目标
   * ================================================================ */
  const Target = (() => {
    /** 查询串（页面把 location.search 清掉时回落到 href，活动页换视频就是只改 URL） */
    function pageQuery() {
      try {
        if (location.search) return String(location.search);
      } catch (e) { /* 忽略 */ }
      try {
        const href = String(location.href || '');
        const i = href.indexOf('?');
        return i >= 0 ? href.slice(i) : '';
      } catch (e) { return ''; }
    }

    /** 页面里能摸到的 bvid：查询串 → 路径 → SSR 初始状态 */
    function pageBvid() {
      let qs = null;
      try { qs = new URLSearchParams(pageQuery()); } catch (e) { qs = null; }
      const fromQuery = qs && (qs.get('bvid') || qs.get('bvid_extra'));
      if (fromQuery && /^BV[0-9A-Za-z]+$/.test(fromQuery)) return fromQuery;

      const m = String(location.pathname || '').match(/\/video\/(BV[0-9A-Za-z]+)/);
      if (m) return m[1];

      const st = PAGE.__INITIAL_STATE__;
      const vd = st && (st.videoData || (st.videoInfo && st.videoInfo.videoData));
      if (vd && typeof vd.bvid === 'string' && /^BV[0-9A-Za-z]+$/.test(vd.bvid)) return vd.bvid;
      return null;
    }

    function kind() {
      const p = String(location.pathname || '');
      if (/^\/video\//.test(p)) return 'video';
      if (/^\/list\//.test(p)) return 'video';
      // 活动页 /festival/...：里面的播放器同样走 DASH，bvid 在查询串里
      if (/^\/festival\//.test(p)) return 'video';
      if (/^\/bangumi\/play\//.test(p)) return 'pgc';
      return null;
    }

    function resolve() {
      const k = kind();
      if (!k) return null;

      if (k === 'video') {
        const bv = pageBvid();
        if (!bv) return null;
        let p = 1;
        try { p = Number(new URLSearchParams(pageQuery()).get('p') || 1) || 1; } catch (e) { p = 1; }
        return { kind: k, bvid: bv, p: p, key: bv + ':p' + p, label: bv + ' · P' + p };
      }

      const ep = (String(location.pathname || '').match(/\/ep(\d+)/) || [])[1];
      if (ep) return { kind: k, epId: Number(ep), key: 'ep:' + ep, label: 'ep' + ep };

      const ss = (String(location.pathname || '').match(/\/ss(\d+)/) || [])[1];
      if (!ss) return null;
      const st = PAGE.__INITIAL_STATE__;
      const live = st && st.epInfo && st.epInfo.id;
      if (live) return { kind: k, epId: Number(live), key: 'ep:' + live, label: 'ep' + live };
      return { kind: k, seasonId: Number(ss), key: 'ss:' + ss, label: 'ss' + ss };
    }

    return { kind: kind, resolve: resolve, pageQuery: pageQuery };
  })();

  /* ================================================================
   * 取流信息（DASH 音频轨 + 响度元数据）
   * ================================================================ */
  const PlayInfo = (() => {
    const mem = {};
    const viewCache = {};
    /* SSE / 环绕 / 空间音频这类 id 不能当分析对象；30280 是「音乐 / Hi-Res」，正是活动页与音乐稿的主轨，必须留着 */
    const EXCLUDE = [30250, 30251];

    function memGet(key) {
      const c = mem[key];
      return c && U.now() - c.at < 10 * 60 * 1000 ? c.data : null;
    }
    function memPut(key, data) { mem[key] = { at: U.now(), data: data }; }

    function pickAudio(dash) {
      if (!dash || !Array.isArray(dash.audio) || !dash.audio.length) return null;
      const hasIndex = function (a) {
        const sb = a.SegmentBase || a.segment_base || a.segmentBase || {};
        return (sb.indexRange || sb.index_range) && (a.baseUrl || a.base_url);
      };
      let list = dash.audio.filter(function (a) {
        return EXCLUDE.indexOf(a.id) === -1 && hasIndex(a);
      });
      // 只剩「没索引」的轨时也别丢：没有别的选择，先把能取到的那条用上
      if (!list.length) {
        list = dash.audio.filter(function (a) { return EXCLUDE.indexOf(a.id) === -1; });
      }
      if (!list.length) return null;

      let pick = null;
      // 优先要 B 站测过响度的那一档（30232），其次 Hi-Res / 音乐轨（30280），最后才回落到第一条
      const PREF = [30232, 30280];
      for (let k = 0; k < PREF.length && !pick; k++) {
        for (let i = 0; i < list.length; i++) if (list[i].id === PREF[k]) { pick = list[i]; break; }
      }
      if (!pick) {
        // 没有首选档（30216 低码率 / 30250 等）时退回第一条可用轨，
        // 不能把 dash.audio[0]（可能正是被排除的那条）拿回来
        pick = list[0];
      }

      const sb = pick.SegmentBase || pick.segment_base || pick.segmentBase || {};
      return {
        url: pick.baseUrl || pick.base_url,
        backup: (pick.backupUrl || pick.backup_url || [])[0] || null,
        id: pick.id,
        bandwidth: pick.bandwidth,
        mimeType: pick.mimeType || pick.mime_type,
        initRange: Sidx.parseRange(sb.Initialization || sb.initialization),
        indexRange: Sidx.parseRange(sb.indexRange || sb.index_range),
      };
    }

    /* B 站对「没测过响度」的视频会填 0.001 占位，必须识别出来 */
    function pickMeta(v) {
      if (!v) return null;
      const i = Number(v.measured_i !== undefined ? v.measured_i : v.measuredI);
      const tp = Number(v.measured_tp !== undefined ? v.measured_tp : v.measuredTp);
      if (!Number.isFinite(i) || Math.abs(i) < 1) return null;
      return { i: i, tp: Number.isFinite(tp) ? tp : null };
    }

    function fits(info, el) {
      if (!info) return false;
      if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return true;
      if (!info.duration) return true;
      return Math.abs(el.duration - info.duration) <= CFG.waitTolerance + 1;
    }

    function fromVideoData(data) {
      const dash = data.dash;
      // 未付费的充电专属视频只给 mp4 整包（durl，约 180s 试看），没有 DASH 音轨。
      // 这条只在 readVideoPage 里被 try 掉，真正的报错由 get() 统一给出。
      if (!dash) throw new Error('该视频没有 DASH 音轨');
      const audio = pickAudio(dash);
      if (!audio) throw new Error('没有可用的音频轨');
      return {
        duration: Number(dash.duration) || Number(data.timelength) / 1000 || 0,
        audio: audio,
        meta: pickMeta(data.volume),
      };
    }

    function fromPgcData(res) {
      if (!res) throw new Error('番剧接口返回为空');
      const vi = res.video_info || {};
      const dash = res.dash || vi.dash;
      if (!dash) throw new Error('番剧没有 dash（试看 / 地区限制 / 版权限制）');
      const audio = pickAudio(dash);
      if (!audio) throw new Error('番剧没有可用的音频轨');
      return {
        duration: Number(dash.duration) || Number(vi.duration) || 0,
        audio: audio,
        meta: pickMeta(vi.volume),
      };
    }

    function readVideoPage() {
      const pi = PAGE.__playinfo__;
      if (!pi || !pi.data) return null;
      if (!pi.data.dash && !pi.data.durl) return null;
      try { return fromVideoData(pi.data); } catch (e) { return null; }
    }

    function readPgcPage() {
      const pi = PAGE.__playinfo__;
      if (!pi) return null;
      const res = pi.result || pi.data || pi;
      try { return fromPgcData(res); } catch (e) { return null; }
    }

    async function view(bvid) {
      const c = viewCache[bvid];
      if (c && U.now() - c.at < 10 * 60 * 1000) return c.data;
      const j = await Http.json('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
      if (!j || j.code !== 0 || !j.data) throw new Error('view 接口失败 code=' + (j && j.code));
      viewCache[bvid] = { at: U.now(), data: j.data };
      return j.data;
    }

    async function cidOf(target) {
      const st = PAGE.__INITIAL_STATE__;
      const vd = st && st.videoData;
      if (vd && vd.bvid === target.bvid) {
        if (Array.isArray(vd.pages)) {
          const page = vd.pages[target.p - 1];
          if (page && page.cid) return page.cid;
        }
        if (target.p === 1 && vd.cid) return vd.cid;
      }
      const v = await view(target.bvid);
      const pages = v.pages || [];
      const page = pages[target.p - 1] || pages[0];
      return page ? page.cid : v.cid;
    }

    /* ------------------------------------------------ SSR 元数据兜底 */
    /**
     * B 站只把响度元数据（volume.measured_i / measured_tp）塞进**首屏 SSR** 的
     * __playinfo__；运行时的 x/player/playurl 接口里没有这个字段（实测）。
     * 所以换集 / 点推荐视频之后，页面里那份 playinfo 是旧的、接口又不给，
     * 播放器自己也拿不到新一集的数字 —— 这就是「只有首个视频被均衡」的原因。
     *
     * 但「那一集的页面」本身是带着它的：按当前 bvid/p 重新请求一次 HTML，
     * 把 window.__playinfo__ 抠出来，就能继续用 B 站自己的测量值，不必本地抽样。
     */
    const ssrCache = {};

    function ssrUrl(target) {
      if (target.kind === 'pgc') {
        // 永远按当前这一集的 ep 地址回读：/ss 的当前页只带第一集，换集后就是别人的数据
        if (target.epId) return 'https://www.bilibili.com/bangumi/play/ep' + target.epId;
        return String(location.href || '');
      }
      // 读者所在的落地页 URL（去掉 p 之类的选集参数），活动页 /festival/… 也按它自己的地址回读
      let here = '';
      try { here = String(location.origin || '') + String(location.pathname || ''); } catch (e) { here = ''; }
      const l = Target.pageQuery();
      const p = Number((/(?:^|[?&])p=(\d+)/.exec(l) || [])[1] || 1);
      if (here) {
        const cur = String(location.href || '');
        // 当前页本来就是这一集：直接读当前页。活动页的 __playinfo__ 只在它自己的 SSR 里，
        // 重开 /video/ 落地页拿到的是另一套（常常连 volume 都没有）
        if (p === target.p) return cur || here;
        // 选集后的「同一张视频另一集」也走这里：/video/BVxxxx?p=N 的 SSR 就是这一集的
        return here + '?p=' + target.p;
      }
      const q = target.p > 1 ? '?p=' + target.p : '';
      return 'https://www.bilibili.com/video/' + target.bvid + q;
    }

    /** 从 start（指向 '{'）开始做括号配对，返回完整 JSON 文本 */
    function sliceJson(text, start) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
      return null;
    }

    function extractPlayinfo(html) {
      const m = /window\.__playinfo__\s*=\s*/.exec(html);
      if (!m) return null;
      const start = m.index + m[0].length;
      if (html.slice(start, start + 4) === 'null') return null;
      if (html[start] !== '{') return null;
      const json = sliceJson(html, start);
      if (!json) return null;
      try { return JSON.parse(json); } catch (e) { return null; }
    }

    async function ssrMeta(target, info, opts) {
      if (!CFG.ssrMeta) return null;
      const force = !!(opts && opts.force);
      if (!force) {
        const c = ssrCache[target.key];
        if (c && U.now() - c.at < 10 * 60 * 1000) return c.meta;
      }

      try {
        const url = ssrUrl(target);
        Log.info('接口无响度元数据 → 回读该集页面 SSR：' + url);
        const html = await Http.text(url);
        if (!html) throw new Error('页面为空');
        if (html.length > 4000000) throw new Error('页面过大 ' + html.length + 'B');

        const pi = extractPlayinfo(html);
        if (!pi) throw new Error('页面里没有 __playinfo__');

        const d = pi.data || pi.result;
        if (!d) throw new Error('__playinfo__ 结构不对');

        const vol = target.kind === 'pgc'
          ? pickMeta((d.video_info || {}).volume)
          : pickMeta(d.volume);
        if (!vol) throw new Error('SSR 里也没有 volume');

        const dur = Number((d.dash && d.dash.duration)
          || (d.video_info && d.video_info.duration) || 0);
        if (dur && info && info.duration && Math.abs(dur - info.duration) > CFG.waitTolerance) {
          throw new Error('SSR 时长对不上（' + dur + ' vs ' + info.duration + '）');
        }

        ssrCache[target.key] = { at: U.now(), meta: vol };
        Log.info('SSR 元数据命中：' + U.round(vol.i, 1) + ' LUFS / 峰值 ' + vol.tp + ' dB');
        return vol;
      } catch (e) {
        Log.info('SSR 元数据不可用：' + (e && e.message) + ' → 本地抽样');
        ssrCache[target.key] = { at: U.now(), meta: null };
        return null;
      }
    }

    async function fetchVideoPlayurl(target, cid) {
      const q = 'bvid=' + encodeURIComponent(target.bvid) + '&cid=' + cid
        + '&qn=80&fnval=4048&fnver=0&fourk=1';
      const urls = [
        'https://api.bilibili.com/x/player/wbi/playurl?' + q,   // 登录态裸调可用
        'https://api.bilibili.com/x/player/playurl?' + q,       // 老接口兜底
      ];
      let lastErr = null;
      for (let i = 0; i < urls.length; i++) {
        try {
          const j = await Http.json(urls[i]);
          if (j && j.code === 0 && j.data) return j.data;
          lastErr = new Error('code=' + (j && j.code) + ' ' + ((j && j.message) || ''));
        } catch (e) {
          lastErr = e;
        }
      }
      throw new Error('播放地址接口失败：' + (lastErr && lastErr.message));
    }

    async function get(target, el) {
      const cached = memGet(target.key);
      if (cached && fits(cached, el)) return cached;

      if (target.kind === 'video') {
        const page = readVideoPage();
        if (fits(page, el)) { memPut(target.key, page); return page; }

        const cid = await cidOf(target);
        if (!cid) throw new Error('拿不到 cid');
        const data = await fetchVideoPlayurl(target, cid);
        // 未付费的充电专属视频只给 mp4 试看整包：没有 DASH 音轨、没有官方响度，
        // 既不能按整片测也不能便宜地测，直接如实报错（不做降级的「试看段」测量）
        if (!data.dash) {
          throw new Error(data.durl && data.durl.length
            ? '充电专属未付费'
            : '响应里既没有 DASH 也没有 durl');
        }
        const info = fromVideoData(data);
        // 接口里的 volume 为空时不在这儿回读 SSR —— 由 Analyzer 统一问一次官方响度，
        // 那边既能带上时长做校验，也不会在一次分析里连拉两遍整页
        memPut(target.key, info);
        return info;
      }

      const page = readPgcPage();
      if (fits(page, el)) { memPut(target.key, page); return page; }

      const st = PAGE.__INITIAL_STATE__;
      const epId = target.epId || (st && st.epInfo && st.epInfo.id);
      if (!epId) throw new Error('拿不到 ep_id');
      const j = await Http.json('https://api.bilibili.com/pgc/player/web/playurl'
        + '?ep_id=' + epId + '&qn=80&fnval=4048&fourk=1');
      const res = (j && (j.result || (j.data && j.data.result))) || j;
      if (!res) throw new Error('番剧接口失败 code=' + (j && j.code));
      if (res.error_code) throw new Error('番剧接口错误 ' + res.error_code + ' ' + (res.message || ''));
      const info = fromPgcData(res);
      // 番剧接口永远不带元数据，SSR 由 Analyzer 统一问，这里不再自己拉一遍
      memPut(target.key, info);
      return info;
    }

    return {
      get: get,
      pickAudio: pickAudio,
      pickMeta: pickMeta,
      /** 只问官方要一次元数据（不看缓存、不写负缓存），给「本地值升级成官方值」用 */
      officialMeta: function (target, info) { return ssrMeta(target, info || null, { force: true }); },
    };
  })();

  /* ================================================================
   * 分析编排
   * ================================================================ */
  const Analyzer = (() => {
    let busy = false;
    let queued = null;
    let currentKey = null;
    let lastMeta = null;

    const status = {
      state: 'idle',
      text: '等待视频',
      key: null,
      label: '',
      i: null,
      gain: null,
      reasons: [],
      source: '',
      progress: '',
      pct: 0,
      cached: false,
      metaSrc: '',
      attached: false,
      backup: '',
    };

    function set(patch) {
      Object.keys(patch).forEach(function (k) { status[k] = patch[k]; });
      UI.render(status);
    }

    function snapshot() { return JSON.parse(JSON.stringify(status)); }

    // 带启动间隔的并发池：相邻两次请求至少隔 gapMs，避免 CDN 限流
    async function pool(items, limit, gapMs, worker) {
      let next = 0;
      let lastStart = 0;
      const n = Math.max(1, Math.min(limit, items.length));

      async function runner() {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          const wait = lastStart + gapMs - U.now();
          if (wait > 0) await U.sleep(wait);
          lastStart = U.now();
          await worker(items[i], i);
        }
      }

      const runners = [];
      for (let k = 0; k < n; k++) runners.push(runner());
      await Promise.all(runners);
    }

    let decodeCtx = null;
    function decoder() {
      if (decodeCtx) return decodeCtx;
      const OAC = PAGE.OfflineAudioContext || PAGE.webkitOfflineAudioContext;
      decodeCtx = new OAC(1, 1, 48000);
      return decodeCtx;
    }

    async function decodeSegment(init, seg) {
      const total = (init ? init.byteLength : 0) + seg.byteLength;
      const buf = new Uint8Array(total);
      let off = 0;
      if (init) { buf.set(new Uint8Array(init), 0); off = init.byteLength; }
      buf.set(new Uint8Array(seg), off);
      return await decoder().decodeAudioData(buf.buffer);
    }

    function concatFloat(chunks) {
      let len = 0;
      for (let i = 0; i < chunks.length; i++) len += chunks[i].length;
      const out = new Float32Array(len);
      let o = 0;
      for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
      return out;
    }

    async function sampleStream(info, hooks) {
      const a = info.audio;
      if (!a || !a.indexRange) throw new Error('该音频轨没有字节索引');

      set({ text: '读取索引…', progress: '', pct: 10 });

      // init 和索引互不重叠，并行发，省一个 RTT
      const idxJob = Http.range(a.url, a.indexRange.start, a.indexRange.end, 'index',
        { timeoutMs: CFG.fetchTimeoutMs });
      const initJob = a.initRange
        ? Http.range(a.url, a.initRange.start, a.initRange.end, 'init', { timeoutMs: CFG.fetchTimeoutMs })
        : Promise.resolve(null);

      const anchorBuf = await idxJob;
      const init = await initJob;

      const parsed = Sidx.parse(anchorBuf, a.indexRange.start);
      if (!parsed || !parsed.refs.length) throw new Error('sidx 解析失败');

      const picked = Sidx.pickEvenly(parsed.refs, CFG.sampleSegments);

      const chunks = [];
      let done = 0;
      let dropped = 0;
      let peakDb = -Infinity;
      let dirty = false;
      let ticker = null;

      function snapshot() {
        if (!chunks.length) return null;
        const blocks = concatFloat(chunks);
        if (!blocks.length) return null;
        const integrated = Loudness.integrate(blocks);
        if (!Number.isFinite(integrated)) return null;
        return {
          i: integrated,
          // 抽到的只是样点峰值，真峰值会更高；留 0.7dB 余量再去算峰值上限
          tp: peakDb === -Infinity ? null : U.round(peakDb + 0.7, 2),
          segments: done,
          total: picked.length,
        };
      }

      // 500ms 一拍：有新片段就重算并回调；这一拍没有新数据就空过，等下一拍
      function emit() {
        if (!dirty) return;
        dirty = false;
        const s = snapshot();
        if (s && hooks && typeof hooks.onPartial === 'function') hooks.onPartial(s);
      }

      function startTicker() {
        if (ticker) return;
        ticker = setInterval(emit, CFG.partialIntervalMs);
        emit();                     // 第一段到手立刻先估一次，不等下一个 500ms
      }

      /** 单段取字节：主地址失败就换 backupUrl，都失败返回 null（这一段丢掉，不影响整体） */
      async function fetchSeg(ref) {
        const rangeArgs = [ref.offset, ref.offset + ref.size - 1];
        try {
          return await Http.range(a.url, rangeArgs[0], rangeArgs[1], 'seg', { timeoutMs: CFG.segTimeout });
        } catch (e) {
          if (!a.backup) return null;
          try {
            return await Http.range(a.backup, rangeArgs[0], rangeArgs[1], 'seg-backup', { timeoutMs: CFG.segTimeout });
          } catch (e2) {
            return null;
          }
        }
      }

      try {
        await pool(picked, CFG.concurrency, CFG.requestGapMs, async function (ref) {
          const bytes = await fetchSeg(ref);
          if (!bytes) {
            dropped++;
            Log.warn('有一段没取到，跳过（累计丢 ' + dropped + ' 段）');
            set({ text: '采样中', progress: done + '/' + picked.length + ' · 丢 ' + dropped });
            return;
          }
          let buf = null;
          try {
            buf = await decodeSegment(init, bytes);
          } catch (e) {
            buf = null;
          }
          if (!buf || !buf.numberOfChannels) {
            dropped++;
            Log.warn('有一段解码失败，跳过（累计丢 ' + dropped + ' 段）');
            set({ text: '采样中', progress: done + '/' + picked.length + ' · 丢 ' + dropped });
            return;
          }

          const chans = [];
          for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
          const r = Loudness.blocks(chans, buf.sampleRate);
          chunks.push(r.blocks);
          if (r.peak > 0) {
            const db = U.linearToDb(r.peak);
            if (db > peakDb) peakDb = db;
          }
          done++;
          dirty = true;
          set({ text: '采样中', progress: done + '/' + picked.length + (dropped ? ' · 丢 ' + dropped : '') });
          startTicker();
        });
      } finally {
        if (ticker) clearInterval(ticker);
      }

      if (done < CFG.minSegments) {
        throw new Error('抽样失败：只拿到 ' + done + ' 段（至少需要 ' + CFG.minSegments + ' 段）');
      }

      const last = snapshot();
      if (!last) throw new Error('抽样没有解出音频');
      return last;
    }

    /** 局部结果能不能现在就落位：得确认还是同一张视频、同一帧流 */
    function canApplyNow(el, target, info) {
      const now = Target.resolve();
      if (!now || now.key !== target.key) return false;
      if (el !== Lifecycle.currentElement()) return false;
      if (info && Number.isFinite(info.duration) && info.duration > 0 && Number.isFinite(el.duration)) {
        return Math.abs(el.duration - info.duration) <= CFG.waitTolerance;
      }
      return true;
    }

    async function waitStream(el, duration, target) {
      if (!Number.isFinite(duration) || duration <= 0) return;
      const t0 = U.now();
      while (U.now() - t0 < CFG.waitGraceMs) {
        if (!el || el !== Lifecycle.currentElement()) throw new Error('播放器元素已更换');
        const now = Target.resolve();
        if (!now || now.key !== target.key) throw new Error('视频已切换');
        if (Number.isFinite(el.duration) && Math.abs(el.duration - duration) <= CFG.waitTolerance) return;
        await U.sleep(300);
      }
      Log.debug('等切流超时，照常落位');
    }

    async function run(el, why) {
      if (!CFG.enabled) { set({ state: 'off', text: '已关闭' }); return; }
      const target = Target.resolve();
      if (!target || !el) return;
      // 同一张视频正在跑，先排队 —— 连播/快速切集时不能把新视频漏掉
      if (busy) { queued = { el: el, why: why }; return; }
      if (target.key === currentKey && status.state === 'applied') return;

      busy = true;
      currentKey = target.key;
      cancelUpgrade();
      let info = null;
      let srcType = '';

      set({
        state: 'run', text: why === 'cache' ? '检查缓存…' : '准备中…',
        key: target.key, label: target.label,
        i: null, gain: null, reasons: [], source: '', progress: '', pct: 0, backup: '',
        cached: false, metaSrc: '',
      });

      try {
        let meta = Store.getMeta(target.key);
        let source = '';
        if (meta) {
          source = 'cache';
          srcType = meta.src || 'sample';
          set({ text: '命中缓存', cached: true, metaSrc: srcType });
          // 缓存里是本地抽样值：先去问一次官方响度。选集来回切时最容易踩这个坑 ——
          // 早先本地算过一次就一直「命中缓存」，永远不再看 B 站到底测没测。
          if (srcType !== 'meta' && CFG.ssrMeta) {
            set({ text: '查官方响度…', pct: 8 });
            const official = await PlayInfo.officialMeta(target, meta.d ? { duration: meta.d } : null);
            if (official) {
              Store.dropMeta(target.key);
              Store.putMeta(target.key, official.i, official.tp, meta.d || null, 'meta');
              meta = { i: official.i, tp: official.tp, d: meta.d || null, src: 'meta' };
              srcType = 'meta';
              source = 'meta';
              set({ backup: '已换成 B 站官方值' });
              Log.info('缓存里的本地值换成 B 站官方值');
            }
          }
        } else {
          set({ text: '读取流信息…', pct: 5 });
          info = await PlayInfo.get(target, el);
          // 有些集数接口不带 volume，但那一集的页面 SSR 是带官方响度的：
          // 先问官方，问不到（或者缓存里就是官方值）才走本地抽样
          if (!info.meta && CFG.ssrMeta) {
            set({ text: '查官方响度…', pct: 8 });
            info.meta = await PlayInfo.officialMeta(target, info);
          }
          if (info.meta) {
            meta = { i: info.meta.i, tp: info.meta.tp };
            source = 'meta';
            srcType = 'meta';
          } else {
            const s = await sampleStream(info, {
              onPartial: function (p) {
                if (!canApplyNow(el, target, info)) return;
                const est = GainPlan.plan({ measuredI: p.i, truePeak: p.tp });
                // 先按已有片段落位，不用等整轮抽完；差异小于阈值就不重复淡变，免得抖
                if (Math.abs(est.gainDb - Engine.desiredDb()) >= CFG.partialDeadbandDb) {
                  Engine.setGainDb(est.gainDb);
                }
                set({
                  i: U.round(p.i, 1),
                  gain: est.gainDb,
                  source: 'sample',
                  text: '采样中',
                  pct: Math.round((p.segments / Math.max(1, p.total)) * 100),
                  backup: '按 ' + p.segments + ' 段预估',
                });
              },
            });
            meta = { i: s.i, tp: s.tp };
            source = 'sample';
            srcType = 'sample';
            set({ backup: '抽样 ' + s.segments + ' 段' });
          }
          Store.putMeta(target.key, meta.i, meta.tp, info ? info.duration : null, srcType);
        }
        lastMeta = meta;
        lastMeta.src = srcType;   // 记住来源，预设切换重算时 [官]/[本] 不会丢

        const now = Target.resolve();
        if (!now || now.key !== target.key) throw new Error('视频已切换，丢弃本次结果');
        if (el !== Lifecycle.currentElement()) throw new Error('播放器元素已更换，丢弃本次结果');

        const plan = GainPlan.plan({ measuredI: meta.i, truePeak: meta.tp });
        // 命中缓存时没有 info，用缓存里记的时长照样等切流
        const waitDur = info ? info.duration : (meta.d || null);
        set({ text: '等待切流…' });
        await waitStream(el, waitDur, target);

        const ok = await Engine.attach(el);
        // 即便此刻还没接管（自动播放策略拦着），也先把目标增益记下来：
        // 等用户第一次交互、引擎补接管时会自己落位。
        Engine.setGainDb(plan.gainDb);

        set({
          state: 'applied',
          text: ok ? '当前响度' : (Engine.hasFailed(el) ? '音频源被占用' : '未接管'),
          i: U.round(meta.i, 1),
          gain: plan.gainDb,
          reasons: plan.reasons,
          source: source,
          progress: '',
          pct: 100,
          cached: source === 'cache',
          metaSrc: srcType,
          attached: ok,
        });

        // 本地算出来的：播放中回头看看 B 站有没有把官方响度测出来
        if (srcType === 'sample') scheduleUpgrade(el, target);
      } catch (e) {
        Log.warn('分析失败：' + (e && e.message));
        set({ state: 'error', text: (e && e.message) || '分析失败', progress: '' });
      } finally {
        busy = false;
        if (queued) {
          const q = queued;
          queued = null;
          run(q.el, q.why).catch(function (e) { Log.debug('排队任务异常 ' + (e && e.message)); });
        }
      }
    }

    /* ------------------------- 本地值 → 官方值 ------------------------- */
    let upgradeTimer = null;
    let upgradeKey = null;
    let upgradeTries = 0;

    function cancelUpgrade() {
      if (upgradeTimer) { clearTimeout(upgradeTimer); upgradeTimer = null; }
      upgradeKey = null;
      upgradeTries = 0;
    }

    /**
     * 这条缓存是本地算的 → 播放中回头问一次 B 站：
     * 官方响度测好了就删掉本地缓存、换成官方值（静默淡变，不打断播放）。
     *
     * 只在「同一条视频还在播」时动手；暂停就往后顺延，避免白拉整页。
     */
    function scheduleUpgrade(el, target) {
      cancelUpgrade();
      upgradeKey = target.key;

      const attempt = function () {
        upgradeTimer = null;
        if (!CFG.enabled || !CFG.ssrMeta) return;
        const now = Target.resolve();
        if (!now || now.key !== upgradeKey) return;
        if (Lifecycle.currentElement() !== el) return;
        if (el.paused) {
          if (upgradeTries < 2) { upgradeTries++; upgradeTimer = setTimeout(attempt, 20000); }
          return;
        }

        upgradeTries++;
        // 带上缓存里记的时长，SSR 那边才能验「这一页是不是这一集」
        const before = Store.getMeta(upgradeKey);
        PlayInfo.officialMeta(target, before && before.d ? { duration: before.d } : null).then(function (official) {
          if (!official) {
            if (upgradeTries < 2) upgradeTimer = setTimeout(attempt, CFG.upgradeRetryMs);
            return;
          }
          const cached = Store.getMeta(upgradeKey);
          if (!cached || cached.src === 'meta') return;

          Store.dropMeta(upgradeKey);
          Store.putMeta(upgradeKey, official.i, official.tp, cached.d || null, 'meta');

          // 拉整页要几百毫秒，回来时用户可能已经切走了 —— 只更新缓存，不再动当前音频
          const live = Target.resolve();
          if (!live || live.key !== upgradeKey || Lifecycle.currentElement() !== el) {
            Log.info('官方值已写入缓存，但当前已不是这条视频，跳过重新落位');
            return;
          }

          lastMeta = { i: official.i, tp: official.tp, src: 'meta' };
          const plan = GainPlan.plan({ measuredI: official.i, truePeak: official.tp });
          Engine.setGainDb(plan.gainDb);
          set({
            source: 'meta',
            i: U.round(official.i, 1),
            gain: plan.gainDb,
            reasons: plan.reasons,
            backup: '已换成 B 站官方值',
            cached: true,
            metaSrc: 'meta',
          });
          Log.info('本地测量已升级为 B 站官方值');
        }).catch(function (e) {
          Log.debug('官方值检查失败 ' + (e && e.message));
        });
      };

      upgradeTimer = setTimeout(attempt, CFG.upgradeCheckMs);
    }

    function reapply() {
      if (!lastMeta) return false;
      const plan = GainPlan.plan({ measuredI: lastMeta.i, truePeak: lastMeta.tp });
      Engine.setGainDb(plan.gainDb);
      const el = Lifecycle.currentElement();
      const ok = el ? Engine.isAttached(el) : false;
      // 状态灯和状态字必须一起复位：否则从「关闭」切回预设时，
      // 会留下 state='off' + 「已关闭」的旧文案，灯也一直是灰的
      set({
        state: 'applied',
        text: ok ? '当前响度' : (el && Engine.hasFailed(el) ? '音频源被占用' : '未接管'),
        gain: plan.gainDb,
        i: U.round(lastMeta.i, 1),
        reasons: plan.reasons,
        source: lastMeta.src || 'cache',
        metaSrc: lastMeta.src || status.metaSrc,
        progress: '',
        pct: 100,
        attached: ok,
      });
      return true;
    }

    function reanalyze() {
      const t = Target.resolve();
      if (!t) return;
      Store.dropMeta(t.key);
      currentKey = null;
      lastMeta = null;
      const el = Lifecycle.currentElement();
      if (el) run(el, '手动重测');
    }

    return {
      run: run,
      reapply: reapply,
      reanalyze: reanalyze,
      snapshot: snapshot,
      status: status,
      setStatus: set,
    };
  })();

  /* ================================================================
   * 界面
   * ================================================================ */
  const UI = (() => {
    let host = null;        // 面板本体：挂在「响」按钮里的 light DOM，皮肤全用播放器自带的 bui 组件
    let toastEl = null;
    let toastTimer = null;
    let btn = null;         // 控制栏上的「响」
    let open = false;
    let closeTimer = null;
    let stickyUntil = 0;    // 刚点过按钮时别被“移开鼠标”立刻关掉（触屏 / 手抖）
    let lastOrder = null;
    const refs = {};

    const PANEL_ID = 'bln-menu-host';
    const TOAST_ID = 'bln-toast';
    /* 控制栏按钮的命中选择器：不用 title，免得按钮带原生 tooltip */
    const BTN_SEL = '.bpx-player-ctrl-btn[data-bln-btn]';

    /* 控制栏按钮：节点结构和原生一模一样，只有 order 用样式表下发；不设 cursor —— 光标交给播放器自己 */
    const CTRL_CSS = [
      BTN_SEL + '{user-select:none;-webkit-user-select:none}',
    ].join('');

    /* 面板：外形全部来自 B 站自己的 .bui-panel / .bui-radio / .bpx-player-ctrl-setting-menu-right，
       这里只补排版（宽度、行距、按钮文字），不重画任何控件的配色和形状。 */
    const PANEL_CSS = [
      '#' + PANEL_ID + '{position:absolute;left:50%;z-index:10;display:none;width:240px;',
      'transform:translateX(-50%);font-size:12px;line-height:22px;text-align:left;',
      'font-family:inherit;overflow-y:auto}',
      '#' + PANEL_ID + '.bln-show{display:block}',
      '#' + PANEL_ID + ' .bpx-player-ctrl-setting-menu-right{padding:12px 16px}',
      '#' + PANEL_ID + ' .bln-head{display:flex;align-items:center;gap:4px;margin-bottom:4px}',
      '#' + PANEL_ID + ' .bln-dot{width:6px;height:6px;border-radius:50%;background:#666;flex:none}',
      '#' + PANEL_ID + ' .bln-dot.ok{background:#3ecf8e}',
      '#' + PANEL_ID + ' .bln-dot.run{background:#f0b429;animation:bln-blink 1s infinite}',
      '#' + PANEL_ID + ' .bln-dot.err{background:#ff5f56}',
      '@keyframes bln-blink{50%{opacity:.35}}',
      '#' + PANEL_ID + ' .bln-name{flex:none;white-space:nowrap}',
      '#' + PANEL_ID + ' .bln-gain{margin-left:auto;display:flex;align-items:baseline;gap:4px;',
      'font-size:13px;font-variant-numeric:tabular-nums;flex:none;white-space:nowrap}',
      '#' + PANEL_ID + ' .bln-src{flex:none;white-space:nowrap;color:var(--bpx-primary-color,#00a1d6)}',
      '#' + PANEL_ID + ' .bln-link{flex:none;margin-left:auto;background:none;border:0;font-size:12px;',
      'padding:0;cursor:pointer;font-family:inherit;white-space:nowrap}',
      '#' + PANEL_ID + ' .bln-link:hover{opacity:.75}',
      '#' + PANEL_ID + ' .bln-line{display:flex;align-items:center;gap:4px;line-height:24px;',
      'white-space:nowrap}',
      '#' + PANEL_ID + ' .bln-k{flex:none;white-space:nowrap}',
      // 第二行右半部分整体居右：说明文居左，数值组（原始 → 实际 LUFS [限]）居右。
      // 和上一行的 .bln-gain 用同一套 flex + gap，五个元素之间的间隔完全一致
      '#' + PANEL_ID + ' .bln-v{margin-left:auto;flex:none;display:flex;align-items:baseline;gap:4px;',
      'white-space:nowrap;font-variant-numeric:tabular-nums}',
      // 箭头和实际值是一个整体，内部也用同样的 4px，五个元素的间隔才齐
      '#' + PANEL_ID + ' #bln-goal{display:inline-flex;align-items:baseline;gap:4px}',
      '#' + PANEL_ID + ' .bln-v i{font-style:normal}',
      '#' + PANEL_ID + ' .bln-title{margin:6px 0 4px;line-height:16px;font-size:12px}',
      '#' + PANEL_ID + ' .bln-gap{height:14px}',
      '#' + PANEL_ID + ' .bln-hide{display:none!important}',
      // 报错时第二行整行换成原因文字，允许换行，别把面板撑破
      '#' + PANEL_ID + ' .bln-err{white-space:normal;font-size:12px;line-height:18px}',
      '#' + TOAST_ID + '{position:absolute;left:50%;bottom:82px;transform:translateX(-50%);',
      'background:rgba(20,20,20,.9);color:#fff;padding:6px 12px;border-radius:4px;font-size:12px;',
      'line-height:18px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:20;',
      'white-space:nowrap}',
      '#' + TOAST_ID + '.show{opacity:1}',
    ].join('');

    /** 原生 radio 组：一行三档，结构和播放器「音量均衡」那组完全一致 */
    function radioRow(items) {
      const inner = items.map(function (it) {
        return '<label class="bui-radio-item" style="margin:0 4px">'
          + '<input type="radio" class="bui-radio-input" name="bln-preset" id="bln-p-' + it[0] + '"'
          + ' value="' + it[0] + '">'
          + '<span class="bui-radio-label"><span class="bui-radio-text">' + it[1] + '</span></span>'
          + '</label>';
      }).join('');
      return '<div class="bui bui-radio bui-dark"><div class="bui-area"><div class="bui-radio-wrap bui-radio-button">'
        + '<div class="bui-radio-group" style="margin:0 -4px">' + inner + '</div>'
        + '</div></div></div>';
    }

    function presetRows() {
      const items = Object.keys(CFG.presets).map(function (k) { return [k, CFG.presets[k].label]; });
      items.push(['off', '关闭']);
      const rows = [];
      for (let i = 0; i < items.length; i += 3) rows.push(radioRow(items.slice(i, i + 3)));
      return rows.join('<div class="bln-gap"></div>');
    }

    function html() {
      return ''
        + '<div class="bui bui-panel bui-dark">'
        + '  <div class="bpx-player-ctrl-setting-menu-right">'
        + '    <div class="bln-head"><span class="bln-name">响度增益</span>'
        + '<span class="bln-dot" id="bln-dot"></span>'
        + '<span class="bln-gain" id="bln-gain"><span id="bln-gain-val">—</span>'
        + '<span id="bln-gain-unit">dB</span></span>'
        + '<span class="bln-src" id="bln-src">[—]</span></div>'
        + '    <div class="bln-line">'
        + '      <span class="bln-k" id="bln-st">等待视频</span>'
        + '      <span class="bln-v" id="bln-v"><span id="bln-meas">—</span>'
        + '<span id="bln-goal"><i>→</i><span id="bln-tgt">—</span></span>'
        + '<span id="bln-meas-unit">LUFS</span>'
        + '<span id="bln-meas-tag"></span></span>'
        + '    </div>'
        + '    <div class="bln-title">预设</div>'
        + presetRows()
        + '    <div class="bln-line" style="margin-top:6px">'
        + '      <span class="bln-k" id="bln-cache">缓存 —</span>'
        + '      <button class="bln-link" id="bln-clear">清空</button></div>'
        + '  </div>'
        + '</div>';
    }

    function playerBox() {
      const sels = ['.bpx-player-container', '.bpx-player-primary-area', '#bilibili-player', '.bilibili-player'];
      for (let i = 0; i < sels.length; i++) {
        let el = null;
        try { el = document.querySelector(sels[i]); } catch (e) { el = null; }
        if (el) return el;
      }
      return null;
    }

    /** 找一组候选元素里最靠上的那条边（进度条 / 控制栏），用来把面板贴上去 */
    function topOf(sels, root) {
      for (let i = 0; i < sels.length; i++) {
        let el = null;
        try { el = root.querySelector(sels[i]); } catch (e) { el = null; }
        if (!el) continue;
        try {
          const r = el.getBoundingClientRect();
          if (r && r.height > 0) return r.top;
        } catch (e) { /* 忽略 */ }
      }
      return null;
    }

    /**
     * 「响」的字体度量：读原生倍速按钮里那个文字的 computed style。
     * 有些版本 B 站把字号写在后代选择器里（`.bpx-player-ctrl-playbackrate .bpx-player-ctrl-playbackrate-result`），
     * 我们的节点不在那条链上，只会继承到按钮上的 0 号字 —— 字看不见、盒子还在。
     */
    function textRule(rate) {
      const d = { size: '14px', line: '22px', family: 'inherit', color: '#fff' };
      try {
        const res = rate ? rate.querySelector('.bpx-player-ctrl-playbackrate-result') : null;
        const s = res ? window.getComputedStyle(res) : null;
        if (s) {
          if (s.fontSize && parseFloat(s.fontSize) >= 8) d.size = s.fontSize;
          if (s.lineHeight && s.lineHeight !== 'normal') d.line = s.lineHeight;
          if (s.fontFamily) d.family = s.fontFamily;
          if (s.color && s.color !== 'rgba(0, 0, 0, 0)' && s.color !== 'transparent') d.color = s.color;
        }
      } catch (e) { /* 用默认值 */ }
      return BTN_SEL + ' .bpx-player-ctrl-playbackrate-result{'
        + 'font-size:' + d.size + ';line-height:' + d.line + ';font-family:' + d.family
        + ';color:' + d.color + ';-webkit-text-fill-color:currentColor;padding:0;margin:0;'
        + 'white-space:nowrap;opacity:1;visibility:visible}';
    }

    function injectCss(order, textCss) {
      const key = (order || '') + '|' + (textCss || '');
      let style = document.getElementById('bln-ctrl-style');
      if (style && lastOrder === key) return;
      if (!style) {
        style = document.createElement('style');
        style.id = 'bln-ctrl-style';
        const head = document.head || document.documentElement;
        if (head) head.appendChild(style);
      }
      style.textContent = CTRL_CSS + PANEL_CSS
        + (order ? BTN_SEL + '{order:' + order + '}' : '')
        + (textCss || '');
      lastOrder = key;
    }

    function makeButton() {
      const el = document.createElement('div');
      el.className = 'bpx-player-ctrl-btn';
      // 不设 title / aria-label：悬停只弹面板，不弹「响度均衡」这种原生提示框。
      // 也就不用 title 当选择器，改用 data-bln-btn 标记（样式表和 ensureButton 都靠它）。
      el.setAttribute('data-bln-btn', '');
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');

      // 文字节点直接用原生那个类，字号行高由 B 站 CSS + 我们量的兜底规则决定
      const txt = document.createElement('div');
      txt.className = 'bpx-player-ctrl-playbackrate-result';
      txt.textContent = '响';
      el.appendChild(txt);

      el.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      el.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      el.addEventListener('dblclick', function (e) { e.stopPropagation(); });

      // hover 打开；离开时给一点缓冲，方便鼠标跨过按钮和面板之间那条缝
      el.addEventListener('mouseenter', function () {
        cancelClose();
        setOpen(true);
      });
      el.addEventListener('mouseleave', function () { scheduleClose(); });

      el.addEventListener('click', function (e) {
        // 面板里的控件也会冒泡上来，别把它们一起吞掉
        if (e.target && e.target !== el && e.target !== txt) return;
        e.preventDefault();
        e.stopPropagation();
        cancelClose();
        stickyUntil = Date.now() + 400;   // 触屏点一下不会紧接着一个 mouseleave 就关掉
        setOpen(true);
      });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          e.stopPropagation();
          setOpen(!open);
        }
      });
      return el;
    }

    /** 把「响」插到控制栏里：紧跟倍速按钮之后（倍速右侧、音量左侧） */
    function ensureButton() {
      let bar = null;
      try { bar = document.querySelector('.bpx-player-control-bottom-right'); } catch (e) { bar = null; }
      if (!bar) {
        try { bar = document.querySelector('.bpx-player-control-bottom'); } catch (e) { bar = null; }
      }
      if (!bar) return false;

      if (!btn) btn = makeButton();

      let rate = null;
      try { rate = bar.querySelector('.bpx-player-ctrl-playbackrate'); } catch (e) { rate = null; }
      if (!rate) {
        try { rate = document.querySelector('.bpx-player-ctrl-playbackrate'); } catch (e) { rate = null; }
      }

      if (rate && rate.parentNode) {
        if (!(btn.parentNode === rate.parentNode && btn.previousElementSibling === rate)) {
          try { rate.parentNode.insertBefore(btn, rate.nextSibling); } catch (e) { /* 下一轮再试 */ }
        }
        styleButton(rate);
        ensureHost();
        return true;
      }

      let anchor = null;
      try { anchor = bar.querySelector('.bpx-player-ctrl-volume'); } catch (e) { anchor = null; }
      if (!anchor) {
        try { anchor = bar.querySelector('.bpx-player-ctrl-setting'); } catch (e) { anchor = null; }
      }
      if (!(btn.parentNode === bar && btn.nextElementSibling === anchor)) {
        try { bar.insertBefore(btn, anchor); } catch (e) { bar.appendChild(btn); }
      }
      styleButton(null);
      ensureHost();
      return true;
    }

    /**
     * 控制栏靠 flex order 排序，order 必须跟倍速一致；
     * 用样式表下发（按 [data-bln-btn] 命中），保证按钮节点上没有内联样式，也不带 title。
     */
    function styleButton(rate) {
      let order = null;
      if (rate) {
        try {
          const bs = window.getComputedStyle(rate);
          if (bs && bs.order && bs.order !== '0' && bs.order !== 'normal') order = String(bs.order);
        } catch (e) { /* 忽略 */ }
      }
      injectCss(order, textRule(rate));
    }

    function ensureHost() {
      if (!btn) return false;

      if (!host) {
        host = document.createElement('div');
        host.id = PANEL_ID;
        host.innerHTML = html();

        refs.dot = q('bln-dot');
        refs.st = q('bln-st');
        refs.meas = q('bln-meas');
        refs.vGroup = q('bln-v');
        refs.measUnit = q('bln-meas-unit');
        refs.measTag = q('bln-meas-tag');
        refs.gainVal = q('bln-gain-val');
        refs.gainUnit = q('bln-gain-unit');
        refs.tgt = q('bln-tgt');
        refs.goal = q('bln-goal');
        refs.gain = q('bln-gain');
        refs.src = q('bln-src');
        refs.cache = q('bln-cache');
        refs.clear = q('bln-clear');
        refs.preset = {};
        Object.keys(CFG.presets).forEach(function (k) { refs.preset[k] = q('bln-p-' + k); });
        refs.preset.off = q('bln-p-off');

        bind();
        syncControls();
      }

      // 面板是「响」按钮的子节点，和原生设置菜单一个位置
      if (host.parentElement !== btn) {
        btn.appendChild(host);
        open = false;
        host.classList.remove('bln-show');
      }
      return true;
    }

    function q(id) { return host ? host.querySelector('#' + id) : null; }

    function placeMenu() {
      if (!host || !btn) return;
      const box = playerBox();
      if (!box) return;
      const c = box.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      const w = host.offsetWidth || 240;

      // 水平：按按钮中线居中，贴边时往回挪，别跑出播放器
      const cx = b.left + b.width / 2;
      const desired = cx - w / 2;
      const minL = c.left + 8;
      const maxL = Math.max(minL, c.right - w - 8);
      const offset = Math.min(Math.max(desired, minL), maxL) - desired;
      host.style.marginLeft = Math.round(offset) + 'px';

      // 垂直：和原生面板一样贴着进度条（以进度条 / 控制栏上沿为基准往上顶）
      let base = b.top;
      const barTop = topOf(['.bpx-player-control-bottom'], box);
      if (barTop !== null && barTop < base) base = barTop;
      const progTop = topOf(['.bpx-player-progress-wrap', '.bpx-player-progress',
        '.bpx-player-control-bottom-progress', '.bpx-player-control-progress'], box);
      if (progTop !== null && progTop < base) base = progTop;
      const anchored = base < b.top;
      const gap = Math.max(16, anchored ? Math.round(b.top - base) + 2 : 0);
      host.style.bottom = Math.round(b.height + gap) + 'px';

      // 播放器矮的时候面板别顶出画面外，内部滚动
      try {
        const space = b.top - gap - c.top - 8;
        host.style.maxHeight = Math.max(140, Math.round(space)) + 'px';
      } catch (e) { /* 忽略 */ }
    }

    function cancelClose() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    }

    /** 「响」和面板都没人停留了才关，给鼠标留一点跨过缝隙的时间 */
    function scheduleClose() {
      cancelClose();
      const wait = Math.max(220, stickyUntil - Date.now());
      closeTimer = setTimeout(function () {
        closeTimer = null;
        setOpen(false);
      }, wait);
    }

    function setOpen(v) {
      const next = !!v;
      if (next && !ensureButton()) return;
      if (next === open) {
        if (open) placeMenu();
        return;
      }
      open = next;
      if (!host) return;
      if (open) {
        cancelClose();
        render();
        host.classList.add('bln-show');
        placeMenu();       // 显示之后才有真实宽度，再摆一次
      } else {
        host.classList.remove('bln-show');
      }
    }

    function toast(text) {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.id = TOAST_ID;
        const box = playerBox();
        if (box) box.appendChild(toastEl);
      }
      if (!toastEl.parentElement) {
        const box = playerBox();
        if (box) box.appendChild(toastEl);
      }
      toastEl.textContent = text;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1500);
    }

    function syncControls() {
      if (!host) return;
      const cur = CFG.enabled ? CFG.preset : 'off';
      Object.keys(refs.preset || {}).forEach(function (k) {
        const el = refs.preset[k];
        if (el) el.checked = (k === cur);
      });
      syncCache();
    }

    function syncCache() {
      if (!refs.cache) return;
      const s = Store.stats();
      refs.cache.textContent = '缓存 ' + s.entries + ' / ' + CFG.cacheMax + ' 条';
    }

    /** 选中一个预设（或「关闭」）：有测量值就零下载重算，没有就触发一次分析 */
    function applyPreset(k) {
      if (k === 'off') {
        CFG.enabled = false;
        Store.saveSettings();
        Engine.setGainDb(0);
        Analyzer.setStatus({ state: 'off', text: '已关闭' });
        syncControls();
        return;
      }
      const p = CFG.presets[k];
      if (!p) return;
      CFG.preset = k;
      CFG.target = p.target;
      CFG.maxBoost = p.maxBoost;
      CFG.enabled = true;
      Store.saveSettings();
      syncControls();
      const applied = Analyzer.reapply();
      if (!applied) {
        Lifecycle.start();
        void Lifecycle.tick('预设');
      }
      render();
    }

    function render(s) {
      if (!host) return;
      const st = s || Analyzer.status;
      const off = !CFG.enabled || st.state === 'off';
      const failed = !off && st.state === 'error';
      const reasons = st.reasons || [];

      // 报错时：第一行数值换成 error（单位与 [官]/[本] 一起收起），第二行的数值组整块不显示，
      // 说明文换成报错原因
      if (failed) {
        refs.st.textContent = (st.text || '分析失败').replace(/^.*?：/, '');
        refs.st.classList.add('bln-err');
        refs.vGroup.classList.add('bln-hide');
        refs.gainVal.textContent = 'error';
        refs.gainUnit.classList.add('bln-hide');
        if (refs.src) refs.src.textContent = '';
        refs.dot.className = 'bln-dot err';
        if (refs.gain && refs.gain.hasAttribute('title')) refs.gain.removeAttribute('title');
        return;
      }
      if (refs.st.classList.contains('bln-err')) refs.st.classList.remove('bln-err');

      // 第二行永远是「当前响度」这个说法；关掉时只是不画数值，标题行已经写了「已关闭」
      refs.st.textContent = off ? '当前响度'
        : (st.progress ? st.text + ' ' + st.progress : st.text);

      // 第二行的数值组永远是「原始 → 实际 LUFS [限]」，单位画在实际值后面、[限] 前面：
      //   -16.0 → -14.0 LUFS      （增益 +2.0 dB）
      //   -16.0 → -16.0 LUFS [限]（峰值挡住，一点没提上去）
      //   -10.0 → -14.0 LUFS      （衰减）
      // 单位、箭头、[限] 都是常驻节点，只改文字不改显隐，位置不会跳。
      refs.goal.classList.remove('bln-hide');
      const hasI = !off && Number.isFinite(st.i);
      // 还没测出数（读取中 / 采样中 / 已关闭）时整组隐藏，不画「— LUFS」
      refs.vGroup.classList.toggle('bln-hide', !hasI);
      const actual = hasI && Number.isFinite(st.gain) ? U.round(st.i + st.gain, 1) : null;
      refs.meas.textContent = hasI ? st.i.toFixed(1) : '';
      refs.measUnit.textContent = 'LUFS';
      refs.tgt.textContent = actual === null ? '' : actual.toFixed(1);
      // 只有「想提没提上去」才挂 [限]
      const limited = hasI && reasons.indexOf('峰值受限') >= 0;
      refs.measTag.textContent = limited ? '[限]' : '';
      // 「已关闭」时数值与单位都收起，只剩这几个字
      const gainText = off ? '已关闭' : (Number.isFinite(st.gain) ? U.fmtDbNum(st.gain) : '—');
      refs.gainVal.textContent = gainText;
      refs.gainUnit.classList.toggle('bln-hide', off);
      // 首行的间距由 bln-head 的 flex 布局给；面板上只有 [官]/[本] 带色（var(--bpx-primary-color)），其余文字用播放器自己的颜色
      if (refs.src) refs.src.textContent = off ? '' : (st.metaSrc === 'meta' ? '[官]' : '[本]');

      refs.dot.className = 'bln-dot';
      if (st.state === 'applied') refs.dot.classList.add('ok');
      else if (st.state === 'error') refs.dot.classList.add('err');
      else if (st.state === 'run') refs.dot.classList.add('run');

      // 限幅原因不挂在任何 title 上，免得鼠标停一下冒出一行提示
      if (refs.gain && refs.gain.hasAttribute('title')) refs.gain.removeAttribute('title');
    }

    function bind() {
      const outside = function (e) {
        if (!open) return;
        let path = [];
        try { path = (e.composedPath && e.composedPath()) || []; } catch (err) { path = []; }
        if (path.length) {
          if (path.indexOf(host) >= 0 || path.indexOf(btn) >= 0) return;
        } else if (host && host.contains && host.contains(e.target)) {
          return;
        }
        setOpen(false);
      };
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('pointerdown', outside, true);

      document.addEventListener('keydown', function (e) {
        if (open && e.key === 'Escape') setOpen(false);
      }, true);

      window.addEventListener('resize', function () { if (open) placeMenu(); });
      document.addEventListener('fullscreenchange', function () { if (open) placeMenu(); });

      Object.keys(refs.preset).forEach(function (k) {
        refs.preset[k].addEventListener('change', function () { applyPreset(k); });
      });

      refs.clear.addEventListener('click', function () {
        Store.clear();
        syncCache();
        toast('缓存已清空');
      });
    }

    function init() {
      ensureButton();
      if (!host) Log.debug('播放器控制栏还没出现，等 tick 里补');
    }

    return {
      init: init,
      ensure: ensureButton,
      render: render,
      toast: toast,
      syncControls: syncControls,
      isOpen: function () { return open; },
    };
  })();

  /* ================================================================
   * 生命周期：找 <video>、跟路由、触发分析
   * ================================================================ */
  const Lifecycle = (() => {
    let timer = null;
    let observer = null;
    let debounce = null;
    let lastEl = null;
    let lastHref = null;
    let started = false;
    const stats = { ticks: 0, swaps: 0 };

    const SELECTORS = ['.bpx-player-container', '.bpx-player-primary-area', '#bilibili-player', '.bilibili-player'];
    const EVENTS = ['loadedmetadata', 'durationchange', 'emptied'];

    function isVideo(el) { return !!el && el.tagName === 'VIDEO'; }

    function find() {
      for (let i = 0; i < SELECTORS.length; i++) {
        let box = null;
        try { box = document.querySelector(SELECTORS[i]); } catch (e) { box = null; }
        if (box) {
          const v = box.querySelector('video');
          if (isVideo(v)) return v;
        }
      }
      const v = document.querySelector('video');
      return isVideo(v) ? v : null;
    }

    function onMedia(ev) {
      if (!CFG.enabled) return;
      if (ev.type === 'emptied') return;
      const el = ev.target;
      Analyzer.run(el, 'media:' + ev.type);
    }

    function bind(el) { EVENTS.forEach(function (t) { el.addEventListener(t, onMedia); }); }
    function unbind(el) { EVENTS.forEach(function (t) { el.removeEventListener(t, onMedia); }); }

    async function tick(why) {
      stats.ticks++;
      UI.ensure();                       // 控制栏会被重绘，随时把「响」补回去
      const el = find();
      if (!el) return;

      const href = location.href;
      let routeChanged = false;
      if (lastHref === null) lastHref = href;
      else if (href !== lastHref) { lastHref = href; routeChanged = true; Log.info('路由变化'); }

      const swapped = el !== lastEl;
      if (swapped) {
        const prev = lastEl;
        lastEl = el;
        stats.swaps++;
        if (prev) { try { unbind(prev); } catch (e) { /* 忽略 */ } }
        bind(el);
      }

      if (!CFG.enabled) return;
      await Engine.attach(el);

      if (swapped || routeChanged) {
        Analyzer.run(el, why).catch(function (e) { Log.debug('run 异常 ' + (e && e.message)); });
      }
    }

    function schedule(why) {
      if (debounce) return;
      debounce = setTimeout(function () {
        debounce = null;
        tick(why).catch(function (e) { Log.error('tick 异常', e); });
      }, CFG.mutationDebounce);
    }

    function start() {
      if (started) return;
      started = true;
      timer = setInterval(function () {
        tick('poll').catch(function (e) { Log.error('tick 异常', e); });
      }, CFG.pollMs);

      const obs = function () {
        try {
          observer = new MutationObserver(function () { schedule('mutation'); });
          observer.observe(document.body, { childList: true, subtree: true });
        } catch (e) { Log.warn('MutationObserver 挂载失败'); }
        tick('init').catch(function (e) { Log.error('tick 异常', e); });
      };

      if (document.body) obs();
      else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', obs, { once: true });
      else obs();

      Log.info('已启动 · ' + location.pathname);
    }

    return {
      start: start,
      tick: tick,
      currentElement: function () { return lastEl; },
      stats: function () { return Object.assign({}, stats); },
    };
  })();

  /* ================================================================
   * 启动
   * ================================================================ */
  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try {
      GM_registerMenuCommand('开关响度均衡', function () {
        CFG.enabled = !CFG.enabled;
        Store.saveSettings();
        UI.syncControls();
        if (CFG.enabled) {
          Analyzer.setStatus({ state: 'idle', text: '已启用' });
          Lifecycle.start();
          void Lifecycle.tick('菜单启用');
        } else {
          Engine.setGainDb(0);
          Analyzer.setStatus({ state: 'off', text: '已关闭' });
        }
      });
      GM_registerMenuCommand('清空测量缓存', function () {
        Store.clear();
        UI.toast('缓存已清空');
      });
    } catch (e) { Log.debug('菜单注册失败'); }
  }

  function expose() {
    const api = {
      status: function () {
        return {
          target: Target.resolve(),
          state: Analyzer.snapshot(),
          engine: Engine.stats(),
          context: Engine.contextState(),
          gainApplied: Engine.appliedDb(),
          gainDesired: Engine.desiredDb(),
          video: (function () {
            const el = Lifecycle.currentElement();
            if (!el) return null;
            return {
              duration: Number.isFinite(el.duration) ? U.round(el.duration, 2) : null,
              paused: el.paused,
              currentTime: U.round(el.currentTime, 2),
              src: String(el.currentSrc || el.src || '').slice(0, 80),
            };
          })(),
          cache: Store.stats(),
          lifecycle: Lifecycle.stats(),
          config: { enabled: CFG.enabled, preset: CFG.preset, target: CFG.target, maxBoost: CFG.maxBoost, minGain: CFG.minGain },
        };
      },
      reanalyze: function () { Analyzer.reanalyze(); },
      reapply: function () { return Analyzer.reapply(); },
      /** 切预设：standard / dynamic / headphone / speaker / night；传 'off' 等于关闭 */
      preset: function (k) {
        if (k === 'off') { CFG.enabled = false; Store.saveSettings(); UI.syncControls(); Engine.setGainDb(0); return true; }
        const p = CFG.presets[k];
        if (!p) return false;
        CFG.preset = k;
        CFG.target = p.target;
        CFG.maxBoost = p.maxBoost;
        CFG.enabled = true;
        Store.saveSettings();
        UI.syncControls();
        return Analyzer.reapply();
      },
      presets: function () { return Object.keys(CFG.presets).map(function (k) { return { key: k, label: CFG.presets[k].label, target: CFG.presets[k].target }; }); },
      setTarget: function (v) {
        if (!Number.isFinite(v)) return false;
        CFG.target = v;
        CFG.preset = 'custom';
        Store.saveSettings();
        UI.syncControls();
        return Analyzer.reapply();
      },
      cache: {
        stats: function () { return Store.stats(); },
        clear: function () { Store.clear(); },
      },
      logs: function () { return Log.ring(); },
      debug: function (v) { Log.setDebug(v !== false); },
      /* 内部结构，调试/自测用 */
      _: {
        CFG: CFG,
        U: U,
        Sidx: Sidx,
        Loudness: Loudness,
        GainPlan: GainPlan,
        Store: Store,
        Engine: Engine,
        Analyzer: Analyzer,
        Target: Target,
        PlayInfo: PlayInfo,
        Http: Http,
        SourceGuard: SourceGuard,
        Lifecycle: Lifecycle,
        UI: UI,
      },
    };
    try { PAGE.__bln = api; } catch (e) { Log.warn('调试接口挂载失败'); }
  }

  function boot() {
    const kind = Target.kind();
    if (!kind) return;

    Store.loadSettings();
    Log.setDebug(CFG.debug);

    SourceGuard.install();   // document-start 就装，赶在 B 站建图之前
    UI.init();

    // 即便总开关是关的也要起轮询：控制栏按钮得靠它插进去，否则用户没入口再打开
    Lifecycle.start();

    registerMenu();

    Log.info('就绪 · ' + kind + ' · 目标 ' + CFG.target + ' LUFS');
  }

  // 先挂 __bln 再启动：哪怕 boot 中途出错，控制台也能拿到接口排障
  expose();
  try {
    boot();
  } catch (e) {
    Log.error('启动失败', e);
  }
})();
