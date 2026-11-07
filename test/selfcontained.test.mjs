// 自测：把用户脚本塞进一个最小 DOM/浏览器桩里跑起来，验证纯逻辑部分。
// 覆盖：K 加权系数、BS.1770 积分响度、sidx 解析、增益规划、缓存、音频源守卫。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, '..', 'bili-loudnorm.user.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
function near(a, b, eps, name) {
  const d = Math.abs(a - b);
  ok(d <= eps, name, 'a=' + a + ' b=' + b + ' Δ=' + d);
}
function group(title) { console.log('\n' + title); }

/* ---------------- 浏览器桩 ---------------- */
class FakeNode {
  constructor(ctx) { this.context = ctx; this.connected = []; }
  connect(d) { this.connected.push(d); return d; }
  disconnect() { this.connected.length = 0; }
}
class FakeSource extends FakeNode {}
class FakeGain extends FakeNode {
  constructor(ctx) {
    super(ctx);
    this.gain = {
      value: 1,
      setTargetAtTime() {},
      cancelScheduledValues() {},
      setValueAtTime() {},
      linearRampToValueAtTime(v, t) { lastRampTime = t; },
    };
  }
}
let decodeCount = 0;
let lastRampTime = null;
class FakeCtx {
  constructor() {
    this.state = 'running';
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = new FakeNode(this);
    this.used = new WeakSet();
  }
  createGain() { return new FakeGain(this); }
  createMediaElementSource(el) {
    if (this.used.has(el)) {
      const e = new Error('already connected');
      e.name = 'InvalidStateError';
      throw e;
    }
    this.used.add(el);
    return new FakeSource(this);
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  // 解码桩：第一段给 0.05 幅度、之后给 0.1 —— 用来区分「按第一段先落位」和「全部抽完后的终值」
  decodeAudioData() {
    const amp = decodeCount++ === 0 ? 0.05 : 0.1;
    const n = 24000;
    const chans = [new Float32Array(n), new Float32Array(n)];
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < n; i++) chans[c][i] = amp * Math.sin(2 * Math.PI * 997 * i / 48000);
    }
    return Promise.resolve({
      numberOfChannels: 2,
      sampleRate: 48000,
      length: n,
      getChannelData: (c) => chans[c],
    });
  }
}

// 网络桩：测试里按需接管
const net = { handler: null, fetch: null };

function fakeEl() {
  // className / classList 保持同步（真实 DOM 就是这样），否则断言看不出类到底有没有被换掉
  const cls = new Set();
  const sync = () => { el._cn = Array.from(cls).join(' '); };
  const el = {
    _cn: '',
    style: {},
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    innerHTML: '',
    parentElement: null,
    isConnected: false,
    classList: {
      add(c) { cls.add(c); sync(); },
      remove(c) { cls.delete(c); sync(); },
      toggle(c, v) {
        const on = v === undefined ? !cls.has(c) : !!v;
        if (on) cls.add(c); else cls.delete(c);
        sync();
        return on;
      },
      contains(c) { return cls.has(c); },
    },
    addEventListener(t, f) { (this._ev || (this._ev = {}))[t] = f; },
    removeEventListener() {},
    appendChild(c) { c.parentElement = this; c.isConnected = true; (this._kids || (this._kids = [])).push(c); return c; },
    insertBefore(c, a) {
      c.parentElement = this; c.isConnected = true;
      (this._kids || (this._kids = [])).push(c);
      this._anchor = a || null;
      return c;
    },
    attachShadow() { return shadowRoot; },
    getBoundingClientRect() { return { left: 10, top: 10, right: 60, bottom: 40, width: 50, height: 30 }; },
    querySelector(sel) {
      if (!this._q) this._q = {};
      return this._q[sel] || (this._q[sel] = fakeEl());
    },
    setAttribute(k, v) { (this._attrs || (this._attrs = {}))[k] = String(v); },
    hasAttribute(k) { return !!(this._attrs && Object.prototype.hasOwnProperty.call(this._attrs, k)); },
    getAttribute(k) { return (this._attrs && this._attrs[k]) || null; },
    removeAttribute(k) { if (this._attrs) delete this._attrs[k]; },
  };
  el.tagName = 'DIV';
  Object.defineProperty(el, 'className', {
    get() { return Array.from(cls).join(' '); },
    set(v) {
      cls.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c));
      sync();
    },
  });
  return el;
}
const shadowEls = {};
const shadowRoot = {
  innerHTML: '',
  getElementById(id) { return shadowEls[id] || (shadowEls[id] = fakeEl()); },
  querySelector() { return null; },
};

const store = {};
const docHandlers = {};
const documentStub = {
  readyState: 'complete',
  body: { appendChild() {}, addEventListener() {} },
  documentElement: { appendChild() {} },
  head: { appendChild() {} },
  createElement() { return fakeEl(); },
  getElementById() { return null; },
  querySelector() { return null; },
  addEventListener(t, f) { (docHandlers[t] || (docHandlers[t] = [])).push(f); },
  removeEventListener() {},
  fullscreenElement: null,
};

const win = {
  AudioContext: FakeCtx,
  OfflineAudioContext: FakeCtx,
  location: { pathname: '/video/BV1test12345', search: '?p=1', origin: 'https://www.bilibili.com', href: 'https://www.bilibili.com/video/BV1test12345?p=1' },
  document: documentStub,
  navigator: { userAgent: 'node' },
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
};
win.unsafeWindow = win;
win.window = win;

const ctx = {
  window: win,
  document: documentStub,
  location: win.location,
  unsafeWindow: win,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URLSearchParams,
  Promise,
  Object,
  Array,
  Number,
  Math,
  JSON,
  Error,
  Set,
  WeakMap,
  WeakSet,
  Float32Array,
  Uint8Array,
  DataView,
  ArrayBuffer,
  String,
  Boolean,
  Date,
  RegExp,
  isFinite,
  parseInt,
  parseFloat,
  encodeURIComponent,
  GM_getValue: (k) => store[k],
  GM_setValue: (k, v) => { store[k] = v; },
  GM_deleteValue: (k) => { delete store[k]; },
  GM_registerMenuCommand: () => {},
  GM_xmlhttpRequest: (o) => {
    if (!net.handler) { if (o.onerror) o.onerror(new Error('offline')); return; }
    net.handler(o);
  },
  MutationObserver: class { observe() {} disconnect() {} },
  fetch: (url, init) => (net.fetch ? net.fetch(url, init) : Promise.reject(new Error('no net'))),
};

vm.createContext(ctx);
vm.runInContext(code, ctx, { filename: 'bili-loudnorm.user.js' });

const api = win.__bln;
ok(!!api && !!api._, '脚本加载后暴露 __bln 调试接口');
const { Sidx, Loudness, GainPlan, Store, Engine } = api._;

group('节奏参数');
ok(api._.CFG.partialIntervalMs === 500, '抽样重算间隔 = 500ms');
ok(api._.CFG.fadeMs === 100, '增益淡入淡出 = 100ms');

/* ---------------- 显示格式 ---------------- */
group('显示格式');
{
  const num = api._.U.fmtDbNum;
  ok(num(2.3) === '+2.3', '数值只取一位小数（+2.3）', num(2.3));
  ok(num(0) === '+0.0', '零增益是 +0.0', num(0));
  ok(num(-0.82) === '-0.8', '衰减也是一位小数', num(-0.82));
  ok(num(0.004) === '+0.0', '先四舍五入再取位', num(0.004));
  ok(num(-0.04) === '-0.0' || num(-0.04) === '+0.0', '不出现 -0.0', num(-0.04));
  ok(api._.U.fmtDb(2.3) === '+2.3 dB', '日志里仍带 dB 后缀', api._.U.fmtDb(2.3));
}

/* ---------------- K 加权 ---------------- */
group('K 加权（BS.1770-4，48kHz）');
{
  const kw = Loudness.kWeighting(48000);
  near(kw.shelf.b0, 1.53512485958697, 1e-9, 'shelf b0');
  near(kw.shelf.b1, -2.69169618940638, 1e-9, 'shelf b1');
  near(kw.shelf.b2, 1.19839281085285, 1e-9, 'shelf b2');
  near(kw.shelf.a1, -1.69065929318241, 1e-9, 'shelf a1');
  near(kw.shelf.a2, 0.73248077421585, 1e-9, 'shelf a2');
  near(kw.hp.b0, 1.0, 1e-9, 'hp b0');
  near(kw.hp.b1, -2.0, 1e-9, 'hp b1');
  near(kw.hp.b2, 1.0, 1e-9, 'hp b2');
  near(kw.hp.a1, -1.99004745483398, 1e-9, 'hp a1');
  near(kw.hp.a2, 0.99007225036621, 1e-9, 'hp a2');
}

/* ---------------- 积分响度 ---------------- */
group('积分响度');
function sine(amp, freq, seconds, fs, channels) {
  const n = Math.round(seconds * fs);
  const out = [];
  for (let c = 0; c < (channels || 2); c++) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = amp * Math.sin(2 * Math.PI * freq * i / fs);
    out.push(a);
  }
  return out;
}

{
  // 997Hz、幅度 0.1：单声道 RMS ≈ -23 dBFS。BS.1770 对声道是求和，
  // 所以「双声道同一信号」比单声道高 3.01dB —— 这是标准行为，不是 bug。
  const stereo = Loudness.measure(sine(0.1, 997, 5, 48000, 2), 48000);
  ok(stereo.integrated > -21.0 && stereo.integrated < -19.5, '双声道 0.1 正弦 ≈ -20.1 LUFS', stereo.integrated.toFixed(2));

  const mono = Loudness.measure(sine(0.1, 997, 5, 48000, 1), 48000);
  ok(mono.integrated > -23.6 && mono.integrated < -22.0, '单声道 0.1 正弦 ≈ -23.1 LUFS', mono.integrated.toFixed(2));

  near(stereo.integrated - mono.integrated, 3.01, 0.05, '双声道比单声道高 3.01dB（声道求和）');

  const m2 = Loudness.measure(sine(0.2, 997, 5, 48000, 2), 48000);
  near(m2.integrated - stereo.integrated, 6.02, 0.15, '幅度 ×2 → +6 dB');

  const silent = Loudness.measure([new Float32Array(48000), new Float32Array(48000)], 48000);
  ok(silent.integrated === -Infinity, '全静音 → -Infinity（不会算出假增益）');

  const peak = Loudness.measure(sine(0.5, 997, 2, 48000), 48000);
  near(peak.peakDb, 20 * Math.log10(0.5), 0.2, '峰值检测 ≈ -6 dBFS');
}

/* ---------------- 增益规划 ---------------- */
group('增益规划');
{
  const a = GainPlan.plan({ measuredI: -23.8, truePeak: -20 });
  near(a.gainDb, 9.8, 0.001, '-23.8 → -14 = +9.8 dB');

  const b = GainPlan.plan({ measuredI: -40, truePeak: -20 });
  near(b.gainDb, 12, 0.001, '提升上限 12 dB 生效');
  ok(b.reasons.includes('提升上限'), '记录限幅原因');

  const c = GainPlan.plan({ measuredI: -23.8, truePeak: -3 });
  near(c.gainDb, 2, 0.001, '峰值预算把 +9.8 压到 +2 dB');
  ok(c.reasons.includes('峰值受限'), '提升被峰值挡住时给「峰值受限」（面板第二行用）');
  ok(!c.reasons.includes('峰值预算'), '不再出现内部名「峰值预算」');

  // 素材本身就顶到满刻度时，只挡提升，绝不下压（-22.2 LUFS + 近满刻度峰值 → 0，而不是 -0.82）
  const hot = GainPlan.plan({ measuredI: -22.2, truePeak: -0.3 });
  near(hot.gainDb, 0, 0.001, '峰值超预算时增益停在 0 dB，不会变成负的', hot.gainDb);
  ok(hot.reasons.includes('峰值受限'), '并标明峰值受限');
  ok(!hot.reasons.includes('峰值预算'), '不混进「峰值预算」');

  const loud = GainPlan.plan({ measuredI: -8, truePeak: -0.3 });
  near(loud.gainDb, -6, 0.001, '本来就要衰减的照常衰减（峰值不挡衰减）');

  const d = GainPlan.plan({ measuredI: -23.8, truePeak: null });
  near(d.gainDb, 9.8, 0.001, '没有峰值数据时按增益上限走');

  const e = GainPlan.plan({ measuredI: 0.001, truePeak: 0 });
  ok(e.gainDb === 0, '0.001 占位值不会被当成有效响度');

  ok(api._.PlayInfo.pickMeta({ measured_i: 0.001, measured_tp: 0.001 }) === null, 'pickMeta 挡掉 0.001 占位元数据');
  const good = api._.PlayInfo.pickMeta({ measured_i: -13.5, measured_tp: -1.2 });
  ok(!!good && good.i === -13.5, 'pickMeta 正常返回元数据');
}

/* ---------------- sidx ---------------- */
group('sidx 解析');
function buildSidx(refs, timescale, firstOffset) {
  const size = 32 + 12 * refs.length;
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0);
  buf.write('sidx', 4, 'ascii');
  buf.writeUInt8(0, 8);      // version
  buf.writeUIntBE(0, 9, 3);  // flags
  buf.writeUInt32BE(1, 12);  // reference_ID
  buf.writeUInt32BE(timescale, 16);
  buf.writeUInt32BE(0, 20);  // earliest_presentation_time
  buf.writeUInt32BE(firstOffset, 24);
  buf.writeUInt16BE(0, 28);  // reserved
  buf.writeUInt16BE(refs.length, 30);
  let p = 32;
  for (const r of refs) {
    buf.writeUInt32BE(r.size, p);       // type=0 | size
    buf.writeUInt32BE(r.duration, p + 4);
    buf.writeUInt32BE(0x90000000, p + 8);
    p += 12;
  }
  return buf;
}

{
  const refs = [{ size: 1000, duration: 48000 }, { size: 2000, duration: 48000 }, { size: 3000, duration: 48000 }];
  const box = buildSidx(refs, 48000, 100);
  const anchor = 5000;
  const ab = box.buffer.slice(box.byteOffset, box.byteOffset + box.byteLength);
  const r = Sidx.parse(ab, anchor);
  ok(!!r, 'sidx 能被找到并解析');
  ok(r.refs.length === 3, '3 个引用');
  ok(r.refs[0].offset === 5000 + 68 + 100, '首段偏移 = anchor + box + first_offset', r.refs[0].offset);
  ok(r.refs[1].offset === r.refs[0].offset + 1000, '第二段偏移累加');
  ok(r.refs[2].offset === r.refs[1].offset + 2000, '第三段偏移累加');
  ok(r.endOffset === r.refs[2].offset + 3000, 'endOffset = 末段结束');
  near(r.refs[0].duration, 1, 1e-9, '每段时长 1s（timescale 48000 / 48000）');
  near(r.refs[2].start, 2, 1e-9, '最后一段的起始时间 = 前两段之和');
}
{
  const many = [];
  for (let i = 0; i < 100; i++) many.push({ offset: i * 10, size: 10, duration: 1 });
  const picked = Sidx.pickEvenly(many, 12);
  ok(picked.length === 12, '等距抽 12 段');
  ok(picked[0].offset === 0 && picked[11].offset === 990, '覆盖首尾');
  ok(Sidx.pickEvenly(many.slice(0, 5), 12).length === 5, '段数不足时全取');
}
{
  ok(Sidx.parseRange('0-820').end === 820, 'parseRange 正常');
  ok(Sidx.parseRange('821-').start === 821, 'parseRange 开放尾');
  ok(Sidx.parseRange('bad') === null, 'parseRange 非法输入');
}

/* ---------------- 缓存 ---------------- */
group('缓存');
{
  Store.putMeta('BVtest:p1', -18.5, -2.3);
  const m = Store.getMeta('BVtest:p1');
  ok(!!m && Math.abs(m.i + 18.5) < 1e-9, '写入/读回测量结果');
  ok(Store.stats().entries === 1, '缓存条数 +1');
  Store.dropMeta('BVtest:p1');
  ok(Store.getMeta('BVtest:p1') === null, 'drop 后读不到');
}

/* ---------------- 音频源守卫 ---------------- */
group('音频源守卫（选集崩溃的修复）');
{
  const el = { tagName: 'VIDEO', currentSrc: 'blob:x' };
  const a = new FakeCtx();
  const b = new FakeCtx();

  const n1 = a.createMediaElementSource(el);
  ok(n1 instanceof FakeSource, '首个调用拿到真节点');

  let n2 = null, threw = false;
  try { n2 = b.createMediaElementSource(el); } catch (e) { threw = true; }
  ok(!threw, '第二个 context 再要同一元素不抛 InvalidStateError');
  ok(n2 instanceof FakeGain && n2.gain.value === 0, '拿到静音哑节点');
  ok(api._.SourceGuard.isDummy(n2), '哑节点可被识别（用于降级判定）');

  // 模拟 B 站 dispose 里的 this.gain.gain
  let okDispose = true;
  try { n2.gain.value = 1; n2.disconnect(); } catch (e) { okDispose = false; }
  ok(okDispose, 'B 站 dispose 路径不再抛 reading "gain"');
}

/* ---------------- 引擎 ---------------- */
group('音频引擎');
{
  const el = { tagName: 'VIDEO', currentSrc: 'blob:y' };
  const attached = await Engine.attach(el);
  ok(attached === true, '接管成功');
  ok(Engine.isAttached(el), 'isAttached 为真');
  ok(Engine.setGainDb(6) === true, '写增益成功');
  near(lastRampTime, 0.1, 1e-9, '淡变时长 100ms（ramp 目标 = now + 0.1s）', lastRampTime);
  near(Engine.appliedDb(), 6, 1e-9, 'appliedGain = +6dB');
  near(Engine.desiredDb(), 6, 1e-9, 'desiredGain 保留');
  ok(typeof Engine.setBypass === 'undefined' && typeof Engine.toggleBypass === 'undefined',
    '旁路 API 已删除（没有 setBypass / toggleBypass）');
}

/* ---------------- 端到端（假 DOM + 假 playinfo） ---------------- */
group('端到端：接管 → 取元数据 → 落位');
{
  const videoEl = {
    tagName: 'VIDEO',
    duration: 300,
    currentTime: 0,
    paused: true,
    volume: 1,
    currentSrc: 'blob:https://www.bilibili.com/fake',
    addEventListener() {},
    removeEventListener() {},
  };
  win.__playinfo__ = {
    code: 0,
    data: {
      dash: {
        duration: 300,
        audio: [{
          id: 30232,
          baseUrl: 'https://xy.hdslb.com/audio.m4s',
          SegmentBase: { Initialization: '0-800', indexRange: '801-1600' },
        }],
      },
      timelength: 300000,
      volume: { measured_i: -23.8, measured_tp: -20.0 },
    },
  };
  documentStub.querySelector = (sel) => (sel === 'video' ? videoEl : null);

  await api._.Lifecycle.tick('test');
  await new Promise((r) => setTimeout(r, 60));

  const st = api._.Analyzer.snapshot();
  ok(st.state === 'applied', '分析完成并落位', st.state + ' / ' + st.text);
  ok(st.source === 'meta', '走 B 站元数据快路径');
  near(st.gain, 9.8, 0.01, '增益 = -14 −(−23.8) = +9.8dB');
  near(Engine.appliedDb(), 9.8, 0.01, '增益真的写进了音频图');
  ok(Engine.isAttached(videoEl), '元素已接管');

  // 换目标响度：应当立刻用缓存里的测量值重算，不再取流
  api.setTarget(-20);
  near(Engine.appliedDb(), 3.8, 0.01, '目标改成 -20 后增益变 +3.8dB');
  ok(typeof api.bypass === 'undefined', '__bln.bypass 也已删除');
}

/* ---------------- 端到端：抽样路径 ---------------- */
group('端到端：sidx 抽样路径（没有 B 站元数据时）');
{
  function buildSidxLocal(refsIn, timescale, firstOffset) {
    const size = 32 + 12 * refsIn.length;
    const buf = Buffer.alloc(size);
    buf.writeUInt32BE(size, 0);
    buf.write('sidx', 4, 'ascii');
    buf.writeUInt8(0, 8);
    buf.writeUIntBE(0, 9, 3);
    buf.writeUInt32BE(1, 12);
    buf.writeUInt32BE(timescale, 16);
    buf.writeUInt32BE(0, 20);
    buf.writeUInt32BE(firstOffset, 24);
    buf.writeUInt16BE(0, 28);
    buf.writeUInt16BE(refsIn.length, 30);
    let p = 32;
    for (const r of refsIn) {
      buf.writeUInt32BE(r.size, p);
      buf.writeUInt32BE(r.duration, p + 4);
      buf.writeUInt32BE(0, p + 8);
      p += 12;
    }
    return buf;
  }

  win.location.pathname = '/video/BV1sample999';
  win.location.search = '';
  win.location.href = 'https://www.bilibili.com/video/BV1sample999';
  api.setTarget(-14);   // 上一组把目标改成了 -20，这里恢复默认

  const box = buildSidxLocal([
    { size: 1000, duration: 48000 },
    { size: 2000, duration: 48000 },
    { size: 3000, duration: 48000 },
  ], 48000, 0);
  const boxAb = box.buffer.slice(box.byteOffset, box.byteOffset + box.byteLength);

  const requests = [];
  net.handler = (o) => {
    const m = String(o.headers.Range || '').match(/bytes=(\d+)-(\d+)/);
    const a = Number(m[1]);
    const b = Number(m[2]);
    requests.push([a, b]);
    const ab = a === 16 ? boxAb.slice(0) : new ArrayBuffer(b - a + 1);
    // 第一段立刻给，其余拖 400ms —— 用来验证「第一段到手就落位」
    const delay = (a === 1084 || a === 3084) ? 400 : 0;
    setTimeout(() => o.onload({ status: 206, response: ab }), delay);
  };

  win.__playinfo__ = {
    data: {
      dash: {
        duration: 300,
        audio: [{
          id: 30232,
          baseUrl: 'https://xy.hdslb.com/a.m4s',
          SegmentBase: { Initialization: '0-15', indexRange: '16-83' },
        }],
      },
      timelength: 300000,
    },
  };

  const video2 = {
    tagName: 'VIDEO', duration: 300, currentTime: 0, paused: true, volume: 1,
    currentSrc: 'blob:2', addEventListener() {}, removeEventListener() {},
  };
  documentStub.querySelector = (sel) => (sel === 'video' ? video2 : null);

  await api._.Lifecycle.tick('sample-test');

  // 第一段到手（0ms）后应当立刻落位，不等 500ms 那一拍
  await new Promise((r) => setTimeout(r, 180));
  const early = Engine.appliedDb();
  ok(early >= 10, '第一段到手就先落位（不等整轮抽完）', String(early));

  await new Promise((r) => setTimeout(r, 700));

  const st = api._.Analyzer.snapshot();
  ok(st.state === 'applied', '抽样路径跑完并落位', st.state + ' / ' + st.text);
  ok(st.source === 'sample', '走的是本地抽样，不是元数据');

  const segReqs = requests.filter((r) => r[0] !== 0 && r[0] !== 16).sort((x, y) => x[0] - y[0]);
  ok(segReqs.length === 3, '取了 3 段（索引里只有 3 段）', JSON.stringify(segReqs));
  ok(segReqs[0][0] === 84, '首段偏移 = anchor(16) + box(68) = 84', JSON.stringify(segReqs[0]));
  ok(segReqs[1][0] === 84 + 1000, '第二段偏移累加 +1000');
  ok(segReqs[2][0] === 84 + 3000, '第三段偏移累加 +3000');

  ok(st.gain < early - 2, '全部抽完后增益被修正（预估 → 终值）', st.gain + ' vs 预估 ' + early);
  ok(st.gain > 5 && st.gain < 9, '终值增益在合理区间', String(st.gain));
  ok(Math.abs(Engine.appliedDb() - st.gain) < 0.01, '终值确实落到了音频图上');
  ok(Engine.isAttached(video2), '新元素也接管了');
}

/* ---------------- Range 请求策略 ---------------- */
group('Range 请求策略（403 / 超时的修法）');
{
  const { Http } = api._;

  // 1) fetch 能通就不该走 GM（GM 不带 Referer 会被 CDN 403）
  let gmCalled = 0;
  net.handler = (o) => { gmCalled++; o.onload({ status: 206, response: new ArrayBuffer(0) }); };
  net.fetch = (url, init) => {
    const m = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/);
    const len = Number(m[2]) - Number(m[1]) + 1;
    return Promise.resolve({ ok: true, status: 206, arrayBuffer: () => Promise.resolve(new ArrayBuffer(len)) });
  };
  const b1 = await Http.range('https://x.test/a.m4s', 0, 9, 't');
  ok(b1.byteLength === 10, 'fetch 路径拿到 10 字节');
  ok(gmCalled === 0, 'fetch 成功时不走 GM');

  // 2) fetch 被挡 → 回落 GM，且 GM 请求必须带 Referer
  let sawReferer = null;
  net.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  net.handler = (o) => {
    sawReferer = o.headers.Referer;
    o.onload({ status: 206, response: new ArrayBuffer(10) });
  };
  const b2 = await Http.range('https://x.test/a.m4s', 0, 9, 't');
  ok(b2.byteLength === 10, 'fetch 失败后 GM 兜底成功');
  ok(sawReferer === 'https://www.bilibili.com/', 'GM 请求带上了 Referer（403 的根源）', sawReferer);

  // 3) 协议相对地址补 https
  ok(Http.normalizeUrl('//upos.test/a.m4s') === 'https://upos.test/a.m4s', '// 开头的地址补 https');

  // 4) 服务端忽略 Range 回 200 整包 → 本地切出需要的那段
  net.fetch = () => {
    const full = new Uint8Array(100);
    for (let i = 0; i < 100; i++) full[i] = i;
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(full.buffer) });
  };
  net.handler = null;
  const b4 = await Http.range('https://x.test/a.m4s', 10, 19, 't');
  const u4 = new Uint8Array(b4);
  ok(u4.length === 10 && u4[0] === 10 && u4[9] === 19, '200 整包按 start 切片');

  net.fetch = null;
}

/* ---------------- 缓存淘汰与清理 ---------------- */
group('缓存：过期清理 + 命中刷新');
{
  store['bln:m:OLD'] = JSON.stringify({ i: -20, tp: -2, at: Date.now() - 40 * 24 * 3600 * 1000 });
  store['bln:index'] = JSON.stringify({ OLD: Date.now() });
  ok(Store.getMeta('OLD') === null, '过期条目读不到');
  ok(Store.stats().entries === 0, '过期条目连索引一起清掉');

  Store.putMeta('HOT', -20, -2, 100);
  const t1 = JSON.parse(store['bln:index']).HOT;
  await new Promise((r) => setTimeout(r, 5));
  Store.getMeta('HOT');
  const t2 = JSON.parse(store['bln:index']).HOT;
  ok(t2 > t1, '命中后索引时间戳被刷新（真 LRU）');
  Store.dropMeta('HOT');
  ok(Store.stats().entries === 0, 'dropMeta 同时清索引');
}

/* ---------------- 端到端：个别片段失败也能出结果 ---------------- */
group('端到端：个别片段失败不拖垮整次分析');
{
  const { CFG } = api._;
  const savedRetry = CFG.segRetry;
  CFG.segRetry = 0;   // 省掉重试等待，测试更快
  net.fetch = null;

  win.location.pathname = '/video/BV1lossy777';
  win.location.search = '';
  win.location.href = 'https://www.bilibili.com/video/BV1lossy777';
  api.setTarget(-14);

  function buildSidx4(refsIn, timescale) {
    const size = 32 + 12 * refsIn.length;
    const buf = Buffer.alloc(size);
    buf.writeUInt32BE(size, 0);
    buf.write('sidx', 4, 'ascii');
    buf.writeUInt8(0, 8); buf.writeUIntBE(0, 9, 3);
    buf.writeUInt32BE(1, 12); buf.writeUInt32BE(timescale, 16);
    buf.writeUInt32BE(0, 20); buf.writeUInt32BE(0, 24);
    buf.writeUInt16BE(0, 28); buf.writeUInt16BE(refsIn.length, 30);
    let p = 32;
    for (const r of refsIn) {
      buf.writeUInt32BE(r.size, p); buf.writeUInt32BE(r.duration, p + 4); buf.writeUInt32BE(0, p + 8);
      p += 12;
    }
    return buf;
  }

  const box = buildSidx4([
    { size: 100, duration: 48000 }, { size: 100, duration: 48000 },
    { size: 100, duration: 48000 }, { size: 100, duration: 48000 },
  ], 48000);
  const boxAb = box.buffer.slice(box.byteOffset, box.byteOffset + box.byteLength);

  // 第 4 段（偏移 96+300=396）固定 503，其余正常
  net.handler = (o) => {
    const m = String(o.headers.Range).match(/bytes=(\d+)-(\d+)/);
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 396) { setTimeout(() => o.onload({ status: 503, response: new ArrayBuffer(0) }), 0); return; }
    const ab = a === 16 ? boxAb.slice(0) : new ArrayBuffer(b - a + 1);
    setTimeout(() => o.onload({ status: 206, response: ab }), 0);
  };

  win.__playinfo__ = {
    data: {
      dash: {
        duration: 300,
        audio: [{ id: 30232, baseUrl: 'https://xy.hdslb.com/b.m4s', SegmentBase: { Initialization: '0-15', indexRange: '16-95' } }],
      },
      timelength: 300000,
    },
  };

  const video3 = {
    tagName: 'VIDEO', duration: 300, currentTime: 0, paused: true, volume: 1,
    currentSrc: 'blob:3', addEventListener() {}, removeEventListener() {},
  };
  documentStub.querySelector = (sel) => (sel === 'video' ? video3 : null);

  await api._.Lifecycle.tick('lossy-test');
  await new Promise((r) => setTimeout(r, 900));

  const st = api._.Analyzer.snapshot();
  ok(st.state === 'applied', '丢了 1 段仍然出结果', st.state + ' / ' + st.text);
  ok(st.source === 'sample', '走的抽样路径');
  ok(/抽样 3 段/.test(st.backup), '只按 3 段算（第 4 段被丢弃）', st.backup);
  ok(Number.isFinite(st.gain), '增益有值', String(st.gain));

  CFG.segRetry = savedRetry;
}

/* ---------------- 端到端：换集后回读 SSR 元数据 ---------------- */
group('端到端：接口没有 volume → 回读该集 SSR 继续用 B 站参数');
{
  net.fetch = null;
  win.location.pathname = '/video/BV1ssr888';
  win.location.href = 'https://www.bilibili.com/video/BV1ssr888';
  // 真浏览器里 href 与 pathname 始终同步：这里也必须一起改，否则 pageQuery()
  // 会从 href 里读到上一组用例留下的旧地址
  win.location.search = '';
  api.setTarget(-14);

  // 页面里的 __playinfo__ 是旧的（时长对不上），应判定不可信
  win.__playinfo__ = {
    data: {
      dash: {
        duration: 100,
        audio: [{ id: 30232, baseUrl: 'https://x.test/old.m4s', SegmentBase: { Initialization: '0-9', indexRange: '10-40' } }],
      },
    },
  };

  const ssrHtml = '<html><script>window.__playinfo__='
    + JSON.stringify({ data: { dash: { duration: 250 }, volume: { measured_i: -21.7, measured_tp: -20 } } })
    + '</script></html>';

  let ssrHits = 0;
  net.handler = (o) => {
    const u = o.url;
    let body;
    if (u.indexOf('web-interface/view') >= 0) {
      body = JSON.stringify({ code: 0, data: { pages: [{ cid: 111, page: 1 }] } });
    } else if (u.indexOf('playurl') >= 0) {
      body = JSON.stringify({
        code: 0,
        data: {
          dash: {
            duration: 250,
            audio: [{ id: 30232, baseUrl: 'https://x.test/new.m4s', SegmentBase: { Initialization: '0-9', indexRange: '10-40' } }],
          },
          timelength: 250000,
          // 注意：接口这里没有 volume —— 复现线上情况
        },
      });
    } else if (u.indexOf('www.bilibili.com/video/BV1ssr888') >= 0) {
      ssrHits++;
      body = ssrHtml;
    } else {
      body = '{}';
    }
    const payload = o.responseType === 'arraybuffer' ? new ArrayBuffer(10) : body;
    setTimeout(() => o.onload({ status: 200, response: payload }), 0);
  };

  const video4 = {
    tagName: 'VIDEO', duration: 250, currentTime: 0, paused: true, volume: 1,
    currentSrc: 'blob:4', addEventListener() {}, removeEventListener() {},
  };
  documentStub.querySelector = (sel) => (sel === 'video' ? video4 : null);

  await api._.Lifecycle.tick('ssr-test');
  await new Promise((r) => setTimeout(r, 300));

  const st = api._.Analyzer.snapshot();
  ok(ssrHits >= 1, '确实回读了一次该集页面', String(ssrHits));
  ok(st.state === 'applied', '分析完成', st.state + ' / ' + st.text);
  ok(st.source === 'meta', '仍然走 B 站元数据，而不是本地抽样');
  near(st.i, -21.7, 0.1, '实测响度来自 SSR volume');
  near(st.gain, 7.7, 0.05, '增益 = -14 −(−21.7) = +7.7dB');
}

/* ---------------- 缓存上限 / 淘汰 ---------------- */
group('缓存：上限与手动清理');
{
  const savedMax = api._.CFG.cacheMax;
  Store.clear();
  api._.CFG.cacheMax = 2;
  Store.putMeta('A', -20, -2, 100);
  await new Promise((r) => setTimeout(r, 2));
  Store.putMeta('B', -20, -2, 100);
  await new Promise((r) => setTimeout(r, 2));
  Store.putMeta('C', -20, -2, 100);
  ok(Store.stats().entries === 2, '超过上限自动淘汰到 2 条', String(Store.stats().entries));
  ok(Store.getMeta('A') === null, '最旧的 A 被淘汰');
  ok(Store.getMeta('C') !== null, '最新的 C 还在');

  ok(Store.trim() === 0, '未超限时 trim 不删东西');
  Store.clear();
  ok(Store.stats().entries === 0, '手动清空后条数为 0');
  api._.CFG.cacheMax = savedMax;
}

/* ---------------- 本地值 → 官方值 自动升级 ---------------- */
group('本地算出来的条目：播放中自动升级成 B 站官方值');
{
  const { CFG } = api._;
  const savedDelay = CFG.upgradeCheckMs;
  CFG.upgradeCheckMs = 60;
  CFG.upgradeRetryMs = 60;

  Store.clear();
  win.location.pathname = '/video/BV1upg555';
  win.location.search = '';
  win.location.href = 'https://www.bilibili.com/video/BV1upg555';
  api.setTarget(-14);

  // 缓存里是本地算的 -25 LUFS
  Store.putMeta('BV1upg555:p1', -25, -3, 200, 'sample');

  const ssrHtml = '<html><script>window.__playinfo__='
    + JSON.stringify({ data: { dash: { duration: 200 }, volume: { measured_i: -14, measured_tp: -20 } } })
    + '</script></html>';

  net.fetch = null;
  net.handler = (o) => {
    const body = o.url.indexOf('www.bilibili.com/video/BV1upg555') >= 0 ? ssrHtml : '{}';
    const payload = o.responseType === 'arraybuffer' ? new ArrayBuffer(10) : body;
    setTimeout(() => o.onload({ status: 200, response: payload }), 0);
  };

  const video5 = {
    tagName: 'VIDEO', duration: 200, currentTime: 0, paused: false, volume: 1,
    currentSrc: 'blob:5', addEventListener() {}, removeEventListener() {},
  };
  documentStub.querySelector = (sel) => (sel === 'video' ? video5 : null);

  await api._.Lifecycle.tick('upgrade-test');
  await new Promise((r) => setTimeout(r, 400));

  const entry = Store.getMeta('BV1upg555:p1');
  ok(!!entry && entry.src === 'meta', '缓存条目已被换成官方来源', entry && entry.src);
  ok(!!entry && Math.abs(entry.i + 14) < 0.1, '缓存里的响度变成官方 -14 LUFS', entry && String(entry.i));

  const st = api._.Analyzer.snapshot();
  ok(st.source === 'meta', '状态来源变成 B 站元数据', st.source);
  ok(/官方/.test(st.backup), '备注标明已换成官方值', st.backup);
  near(st.gain, 0, 0.05, '增益按官方值重算：-14 −(-14) = 0dB');

  CFG.upgradeCheckMs = savedDelay;
  Store.clear();
}

/* ---------------- 控制栏按钮 + 面板 ---------------- */
group('嵌进播放器控制栏：「响」按钮 + 面板');
{
  const volumeBtn = fakeEl();
  const rateBtn = fakeEl();
  const bar = fakeEl();
  rateBtn.parentNode = bar;
  rateBtn.nextSibling = volumeBtn;
  rateBtn.querySelector = (sel) => (sel === '.bpx-player-ctrl-playbackrate-result' ? fakeEl() : null);
  bar.querySelector = (sel) => {
    if (sel === '.bpx-player-ctrl-playbackrate') return rateBtn;
    if (sel === '.bpx-player-ctrl-volume') return volumeBtn;
    return null;
  };
  const box = fakeEl();

  documentStub.querySelector = (sel) => {
    if (sel === '.bpx-player-control-bottom-right') return bar;
    if (sel === '.bpx-player-container') return box;
    return null;
  };

  ok(api._.UI.ensure() === true, '控制栏在时能插入按钮');

  const inserted = (bar._kids || []).filter((k) => k.hasAttribute('data-bln-btn'))[0];
  ok(!!inserted, '「响」被插进控制栏');
  ok(inserted.className === 'bpx-player-ctrl-btn', '按钮只带原生类名，没有额外类', inserted.className);
  ok(!inserted.hasAttribute('title') && !inserted.title, '按钮不带 title（悬停不会弹「响度均衡」提示框）');
  ok(!inserted.hasAttribute('aria-label'), '按钮不带 aria-label');
  ok(bar._anchor === volumeBtn, '插在倍速之后（即倍速右侧、音量左侧）');
  ok(inserted.parentElement === bar, '父节点就是控制栏');

  const txt = (inserted._kids || [])[0];
  ok(txt && txt.className === 'bpx-player-ctrl-playbackrate-result', '文字节点复用原生结果类');
  ok(txt && txt.textContent === '响', '文字就是「响」');
  ok(txt && Object.keys(txt.style).length === 0, '文字节点没有任何内联样式');

  const host = (inserted._kids || []).filter((k) => k.id === 'bln-menu-host')[0];
  ok(!!host, '面板挂在「响」按钮里（和原生设置菜单同一位置）');
  ok(host && host.parentElement === inserted, '面板的父节点就是「响」按钮');

  const html = host.innerHTML;
  const el = (id) => host._q['#' + id];

  // —— 严格复用官方组件：外壳和控件都用 B 站自己的类名
  ok(/class="bui bui-panel bui-dark"/.test(html), '面板外壳用官方 .bui-panel.bui-dark');
  ok(/class="bpx-player-ctrl-setting-menu-right"/.test(html), '内容区用官方设置面板的内边距容器');
  ok((html.match(/class="bui-radio-item"/g) || []).length === 6, '六个选项都是官方 radio 组件');
  ok((html.match(/class="bui-radio-input"/g) || []).length === 6, 'radio 输入框用官方类');
  ok((html.match(/class="bui-radio-label"/g) || []).length === 6, 'radio 标签用官方类');
  ok(/class="bui-radio-wrap bui-radio-button"/.test(html), 'radio 组是官方的按钮形态（bui-radio-button）');
  ok(!/class="seg"/.test(html), '不再自绘分段按钮');
  ok(!/class="menu"/.test(html), '不再自绘面板外壳');

  ok(/响度增益/.test(html), '第一行标题是「响度增益」');
  ok(!/aria-label=/.test(code) && !/setAttribute\('aria-label'/.test(code), '脚本里不再写 aria-label');
  ok(html.indexOf('bln-remeasure') < 0, '「重新获取」已从面板移除');
  ok(/<span id="bln-gain-val">—<\/span><span id="bln-gain-unit">dB<\/span>/.test(html),
    '「dB」是独立节点，不在数值里');
  ok(/<span id="bln-meas">—<\/span><span id="bln-goal"><i>→<\/i><span id="bln-tgt">—<\/span><\/span><span id="bln-meas-unit">LUFS<\/span>/.test(html),
    '顺序是「原始 → 实际 LUFS」，LUFS 在 [限] 之前');
  ok(/<span id="bln-meas-tag"><\/span>/.test(html), '[限] 也是独立节点');
  ok(/<div class="bln-head"><span class="bln-name">响度增益<\/span><span class="bln-dot"/.test(html),
    '状态灯紧跟在「响度增益」后面');
  ok(!/旁路|toggleBypass|setBypass|isBypass|shiftKey/.test(code), '旁路相关代码全部删除');
  ok(/@match\s+https:\/\/www\.bilibili\.com\/festival\/\*/.test(code), '元数据里加了 /festival/* 匹配');

  ['标准', '高动态', '深夜', '耳机', '外放', '关闭'].forEach(function (label) {
    ok(html.indexOf('>' + label + '<') >= 0, '选项里有「' + label + '」');
  });
  let pos = -1;
  let ordered = true;
  ['标准', '高动态', '深夜', '耳机', '外放', '关闭'].forEach(function (label) {
    const at = html.indexOf('>' + label + '<');
    if (at < pos) ordered = false;
    pos = at;
  });
  ok(ordered, '预设顺序：标准 → 高动态 → 深夜 → 耳机 → 外放 → 关闭');
  ok((html.match(/name="bln-preset"/g) || []).length === 6, '五个预设 + 关闭 = 6 个选项');

  // hover 打开，离开后收起
  inserted._ev.mouseenter({});
  ok(api._.UI.isOpen() === true, '鼠标悬停「响」就打开面板');
  ok(host.classList.contains('bln-show'), '面板进入显示状态');
  ok(/^\[(官|本)\]$/.test(el('bln-src').textContent), '来源标签显示 [官] 或 [本]', el('bln-src').textContent);

  const gap = parseFloat(host.style.bottom);
  ok(Number.isFinite(gap) && gap >= 16, '面板抬到按钮上方（不压着控制栏）', host.style.bottom);

  inserted._ev.mouseleave({});
  await new Promise((r) => setTimeout(r, 280));
  ok(api._.UI.isOpen() === false, '鼠标离开「响」和面板后自动收起');
  ok(!host.classList.contains('bln-show'), '收起后面板不显示');

  // 点空白关闭
  inserted._ev.click({ target: inserted, preventDefault() {}, stopPropagation() {} });
  ok(api._.UI.isOpen() === true, '点击也能打开');
  const outside = fakeEl();
  (docHandlers.mousedown || []).forEach((f) => f({ composedPath: () => [outside] }));
  ok(api._.UI.isOpen() === false, '点空白处关闭面板');

  // Esc 关闭
  inserted._ev.click({ target: inserted, preventDefault() {}, stopPropagation() {} });
  ok(api._.UI.isOpen() === true, '再次打开');
  (docHandlers.keydown || []).forEach((f) => f({ key: 'Escape' }));
  ok(api._.UI.isOpen() === false, 'Esc 关闭面板');

  // 切预设：n 选 1
  const CFG = api._.CFG;
  const saved = { preset: CFG.preset, target: CFG.target, boost: CFG.maxBoost, enabled: CFG.enabled };
  el('bln-p-night')._ev.change({});
  ok(CFG.preset === 'night', '选中「深夜」· 记下预设名', CFG.preset);
  ok(CFG.target === -20 && CFG.maxBoost === 6, '「深夜」= -20 LUFS / 上限 +6 dB', CFG.target + '/' + CFG.maxBoost);
  ok(CFG.enabled === true, '选预设会自动重新启用');
  ok(el('bln-p-night').checked === true, '「深夜」是选中态');

  el('bln-p-speaker')._ev.change({});
  ok(CFG.target === -11 && CFG.maxBoost === 10, '「外放」= -11 LUFS / 上限 +10 dB', CFG.target + '/' + CFG.maxBoost);
  ok(el('bln-p-night').checked === false && el('bln-p-speaker').checked === true, '单选：同一时刻只有一个选中');

  el('bln-p-off')._ev.change({});
  ok(CFG.enabled === false, '选「关闭」→ 均衡关掉');
  ok(CFG.preset === 'speaker', '关掉时预设名仍保留，便于再打开', CFG.preset);
  ok(el('bln-p-off').checked === true && el('bln-p-speaker').checked === false, '「关闭」是选中态');

  // 渲染：关闭时不能还显示 dB 和单位
  api._.UI.render({ state: 'off', text: '已关闭', gain: -0.82, i: -22.2, metaSrc: 'meta', reasons: [] });
  ok(el('bln-gain-val').textContent === '已关闭', '关闭时第一行显示「已关闭」而不是数值', el('bln-gain-val').textContent);
  ok(el('bln-st').textContent === '当前响度', '关闭时第二行仍写「当前响度」', el('bln-st').textContent);
  ok(el('bln-src').textContent === '', '关闭时不显示 [官]/[本]');
  ok(el('bln-v').classList.contains('bln-hide'), '关闭时数值组整块不显示');
  ok(!el('bln-dot').classList.contains('ok'), '关闭时状态灯不是绿的');

  CFG.enabled = true;
  api._.UI.render({ state: 'applied', text: '当前响度', gain: 0, i: -22.2, metaSrc: 'meta', reasons: ['峰值受限'] });
  ok(el('bln-gain-val').textContent === '+0.0', '增益数值只放数字（+0.0），dB 是独立节点', el('bln-gain-val').textContent);
  ok(!el('bln-v').classList.contains('bln-hide'), '有数值时数值组显示');
  ok(el('bln-tgt').textContent === '-22.2', '增益为 0 时也显示「原始 → 实际」（两边相同）', el('bln-tgt').textContent);
  ok(!el('bln-goal').classList.contains('bln-hide'), '箭头始终显示，不随增益变化');
  ok(el('bln-meas-tag').textContent === '[限]', '[限] 是独立节点，不再塞进单位里', el('bln-meas-tag').textContent);
  ok(!el('bln-gain').hasAttribute('title'), 'dB 值上不挂任何 title（鼠标停上去没有提示）');
  ok(el('bln-dot').classList.contains('ok'), '状态灯恢复绿色');

  // 单位只出现一次：箭头后面不再跟 LUFS
  ok(html.indexOf('bln-tgt-unit') < 0, '箭头后面没有第二个 LUFS 节点');

  // 正常落到目标：-16.3 LUFS +2.3 dB → 「-16.3 LUFS → -14.0」
  api._.UI.render({ state: 'applied', text: '当前响度', gain: 2.3, i: -16.3, metaSrc: 'meta', reasons: [] });
  ok(el('bln-meas').textContent === '-16.3' && el('bln-meas-unit').textContent === 'LUFS',
    '实测值 + 唯一一个 LUFS', el('bln-meas').textContent + ' ' + el('bln-meas-unit').textContent);
  ok(el('bln-tgt').textContent === '-14.0', '箭头后面是加完增益的实际响度', el('bln-tgt').textContent);
  ok(el('bln-meas-tag').textContent === '', '正常落地不挂 [限]');

  // 峰值受限：-18 LUFS 只给 +3 dB → 「-18.0 LUFS → -15.0 [限]」
  api._.UI.render({ state: 'applied', text: '当前响度', gain: 3, i: -18, metaSrc: 'meta', reasons: ['峰值受限'] });
  ok(el('bln-tgt').textContent === '-15.0', '[限] 时箭头后面是真正落到的响度', el('bln-tgt').textContent);
  ok(el('bln-meas-tag').textContent === '[限]', '[限] 仍然显示', el('bln-meas-tag').textContent);

  // 峰值受限但一点没提上去：-16.0 + 0 dB，预算是 0
  api._.UI.render({ state: 'applied', text: '当前响度', gain: 0, i: -16, metaSrc: 'meta', reasons: ['峰值受限'] });
  ok(el('bln-meas').textContent === '-16.0' && el('bln-meas-unit').textContent === 'LUFS',
    '+0.0 dB 时单位仍然紧跟原始值', el('bln-meas').textContent + ' ' + el('bln-meas-unit').textContent);
  ok(el('bln-tgt').textContent === '-16.0', '原始 → 实际，实际也是 -16.0', el('bln-tgt').textContent);
  ok(!el('bln-goal').classList.contains('bln-hide'), '箭头照样显示');
  ok(el('bln-meas-tag').textContent === '[限]', '[限] 照样显示', el('bln-meas-tag').textContent);

  api._.UI.render({ state: 'error', text: '分析失败：试看片段抽样失败：只拿到 0 段', gain: null, i: null, metaSrc: 'tourist', reasons: [] });
  ok(el('bln-gain-val').textContent === 'error', '报错时第一行显示 error', el('bln-gain-val').textContent);
  ok(el('bln-st').textContent === '试看片段抽样失败：只拿到 0 段', '报错时第二行说明文换成原因', el('bln-st').textContent);
  ok(el('bln-v').classList.contains('bln-hide'), '报错时数值组整块不显示');
  ok(el('bln-dot').classList.contains('err'), '报错时状态灯是红的');

  api._.UI.render({ state: 'error', text: '分析失败：试看片段无法解码（mp4a aot=2）：Unable to decode audio data', gain: null, i: null, metaSrc: 'tourist', reasons: [] });
  ok(el('bln-src').textContent === '', '报错时不显示 [官]/[本]');
  ok(el('bln-st').textContent.indexOf('试看片段无法解码') === 0, '报错时第二行写原因', el('bln-st').textContent);
  ok(el('bln-v').classList.contains('bln-hide'), '报错时数值组不显示');

  api._.UI.render({ state: 'run', text: '读取 moov 样本表…', progress: '1/8', gain: null, i: null, metaSrc: 'tourist', reasons: [] });
  ok(el('bln-v').classList.contains('bln-hide'), '读取中还没有数值时数值组整块不显示');
  CFG.preset = saved.preset;
  CFG.target = saved.target;
  CFG.maxBoost = saved.boost;
  CFG.enabled = saved.enabled;
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(fail ? 1 : 0);