// 全景导航条（07§4.2a）：把整条 domain 压成一屏的活动概览。
//
// 解决的是一个真实的导航问题：domain 是十年，而一屏只看得见几周到几个月。头部读数只告诉你
// **现在在哪**，不告诉你**一共有哪些地方可去**；想跳到「2019 年那阵子」只能一路滚。
//
// v3.2 起这条概览要说清三件事，而不只是「哪里热闹」：
//   · 柱子**分两段**——底段是事件（购买 / 首玩 / 成就 / 发售），顶段是截图。同样高的两根柱子，
//     一根可能是那周解了 20 个成就，另一根是截了 20 张图，混成一个色块就把这个区别抹掉了。
//   · 柱顶的**蓝帽**= 那一格里有「首次游玩」，也就是开了新游戏——十年里最值得跳过去的点。
//   · 年分隔 + 年号是地标；domain 短于三年时再加一层季度细线，否则十年下密得看不清。
// 悬停出读数，点 / 拖跳转。
//
// v3.19 去掉了条上的文字图例（事件 / 截图 / 首玩）。它和年号地标抢的是**同一条边**：横排下
// 图例钉在右上沿、年号也钉在上沿，domain 右端那个年号必然被压住；竖排下图例钉在左下角，正好
// 盖住最后一段柱子。而它说的事，悬停读数本来就逐项报了（「YYYY.MM · 事件 N · 截图 N · 有首玩」），
// 删掉不丢信息，只是把「要先看图例才懂」换成「指哪读哪」。
//
// 位置口径全部走 **p = scale(t) / 轨道总长**，不自己算第二套时间→位置映射：坐标层仍是全页
// 唯一位置真源（05§1.2），这里只是把它整条按比例缩进一个条里。方向跟随主视图（07§4.10）。

const BUCKETS = 220;   // 固定桶数 → 位置全用百分比，条的尺寸变化不必重建

let host = null;
let barsEl = null;
let axesEl = null;
let winEl = null;
let tipEl = null;
let cursorEl = null;
let onSeek = null;
let orient = 'h';
let totalMain = 1;
let dragging = false;
/** 供悬停读数用：每桶的事件数 / 截图数 / 有无首玩，以及当前 scale（把桶位置换回时间）。 */
let stats = { events: null, shots: null, fresh: null, scale: null };

const V = () => orient === 'v';

/**
 * @param {HTMLElement} container 主体区内、与轨道同级的容器（不随轨道平移）
 * @param {{onSeek: (centerMain: number) => void}} handlers
 */
export function mount(container, handlers) {
  onSeek = handlers.onSeek;
  host = document.createElement('div');
  host.className = 'ov-rail';
  host.dataset.orient = orient;
  host.tabIndex = 0;
  host.setAttribute('role', 'slider');
  host.setAttribute('aria-label', '时间轴全景导航：点击或拖动跳转');

  barsEl = document.createElement('div');
  barsEl.className = 'ov-bars';
  axesEl = document.createElement('div');
  axesEl.className = 'ov-axes';
  winEl = document.createElement('div');
  winEl.className = 'ov-win';
  cursorEl = document.createElement('div');
  cursorEl.className = 'ov-cursor';
  cursorEl.hidden = true;
  host.append(barsEl, axesEl, winEl, cursorEl);
  container.appendChild(host);

  tipEl = document.createElement('div');
  tipEl.className = 'ov-tip mono';
  tipEl.hidden = true;
  container.appendChild(tipEl);

  host.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;   // 中键留给自动滚动，右键留给上下文菜单
    dragging = true;
    host.setPointerCapture(ev.pointerId);
    seekTo(ev);
  });
  host.addEventListener('pointermove', (ev) => {
    if (dragging) seekTo(ev);
    showTip(ev);
  });
  const end = (ev) => {
    if (!dragging) return;
    dragging = false;
    try { host.releasePointerCapture(ev.pointerId); } catch { /* 指针已离开 */ }
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
  host.addEventListener('pointerleave', () => { tipEl.hidden = true; cursorEl.hidden = true; });
  return host;
}

/** @param {'h'|'v'} o */
export function setOrient(o) {
  orient = o === 'v' ? 'v' : 'h';
  if (host) host.dataset.orient = orient;
}

function seekTo(ev) {
  const rect = host.getBoundingClientRect();
  const size = V() ? rect.height : rect.width;
  // 条被收起（hidden）时 rect 全是 0，除下去就是 NaN，而 NaN 会一路流进 offset ——
  // 之后头部读数、视窗框、平移全部停在原地，**一行报错都没有**。宁可什么都不做。
  if (!(size > 0)) return;
  const at = V() ? ev.clientY - rect.top : ev.clientX - rect.left;
  onSeek?.(Math.min(1, Math.max(0, at / size)) * totalMain);
}

/**
 * 重建柱与地标。每次 scale 重建（缩放 / 过滤 / 方向 / 列容量变化）后调一次。
 * @param {{groups: Array<{ts:number, p:number, units:any[], plus?:number, shots?:any[]}>,
 *          scale: any, totalMain: number, now: number}} model
 */
export function setModel(model) {
  totalMain = Math.max(1, model.totalMain);
  const events = new Int32Array(BUCKETS);
  const shots = new Int32Array(BUCKETS);
  const fresh = new Uint8Array(BUCKETS);
  let peak = 0;
  for (const g of model.groups) {
    const i = Math.min(BUCKETS - 1, Math.max(0, Math.floor((g.p / totalMain) * BUCKETS)));
    events[i] += g.units.length + (g.plus ?? 0);
    shots[i] += g.shots?.length ?? 0;
    if (g.units.some((u) => u.type === 'first_play')) fresh[i] = 1;
    peak = Math.max(peak, events[i] + shots[i]);
  }
  stats = { events, shots, fresh, scale: model.scale };

  const step = 100 / BUCKETS;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < BUCKETS; i++) {
    const total = events[i] + shots[i];
    if (!total) continue;
    const bar = document.createElement('i');
    bar.className = 'ov-bar' + (fresh[i] ? ' fresh' : '');
    // 开方压一下动态范围：一个 40 张截图的日子会把其余十年全压成一条线
    const len = (Math.max(0.14, Math.sqrt(total / peak)) * 100).toFixed(1);
    const evPct = ((events[i] / total) * 100).toFixed(0);
    bar.style.setProperty('--seg', `${evPct}%`);
    bar.style.setProperty('--len', `${len}%`);
    bar.style.setProperty('--at', `${i * step}%`);
    bar.style.setProperty('--w', `${step}%`);
    frag.appendChild(bar);
  }
  barsEl.innerHTML = '';
  barsEl.appendChild(frag);

  // 地标：年分隔恒有；domain 短于三年时再补一层季度细线，十年跨度下那会密得看不清
  const [d0, d1] = model.scale.domain();
  const years = (d1 - d0) / (365 * 86400);
  const af = document.createDocumentFragment();
  const put = (t, cls, text) => {
    if (t < d0 || t > d1) return;
    const at = `${(model.scale(t) / totalMain) * 100}%`;
    const tick = document.createElement('i');
    tick.className = cls;
    tick.style.setProperty('--at', at);
    af.appendChild(tick);
    if (!text) return;
    const label = document.createElement('span');
    label.className = 'mono ov-ylabel';
    label.style.setProperty('--at', at);
    label.textContent = text;
    af.appendChild(label);
  };
  const y0 = new Date(d0 * 1000).getUTCFullYear();
  const y1 = new Date(d1 * 1000).getUTCFullYear();
  for (let y = y0; y <= y1; y++) {
    put(Date.UTC(y, 0, 1) / 1000, 'ov-year', String(y));
    if (years <= 3) for (const m of [3, 6, 9]) put(Date.UTC(y, m, 1) / 1000, 'ov-quarter', null);
  }
  put(model.now, 'ov-today', null);
  axesEl.innerHTML = '';
  axesEl.appendChild(af);
}

/** 每次平移都调（很便宜：只动一个元素的两个百分比）。 */
export function setViewport(offset, view) {
  if (!winEl) return;
  const at = Math.max(0, Math.min(100, (offset / totalMain) * 100));
  const len = Math.max(0.8, Math.min(100 - at, (view / totalMain) * 100));
  winEl.style.setProperty('--at', `${at}%`);
  winEl.style.setProperty('--w', `${len}%`);
}

/** @param {boolean} on 整条收起（连同悬停读数）。 */
export function setVisible(on) {
  if (!host) return;
  host.hidden = !on;
  if (!on && tipEl) { tipEl.hidden = true; }
}

/** 悬停读数：把光标位置换回时间（走 scale.invert，不另算一套），再报那一格的构成。 */
function showTip(ev) {
  if (!stats.scale) return;
  const rect = host.getBoundingClientRect();
  const size = V() ? rect.height : rect.width;
  const at = V() ? ev.clientY - rect.top : ev.clientX - rect.left;
  const frac = Math.min(1, Math.max(0, at / size));
  const i = Math.min(BUCKETS - 1, Math.floor(frac * BUCKETS));
  const d = new Date(stats.scale.invert(frac * totalMain) * 1000);
  const ym = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const e = stats.events[i];
  const s = stats.shots[i];
  tipEl.textContent = e || s
    ? `${ym} · 事件 ${e} · 截图 ${s}${stats.fresh[i] ? ' · 有首玩' : ''}`
    : `${ym} · 无记录`;
  tipEl.hidden = false;

  cursorEl.hidden = false;
  cursorEl.style.setProperty('--at', `${frac * 100}%`);

  // 贴着光标走，但不许被自己顶出容器
  const parent = tipEl.offsetParent ?? host.parentElement;
  const pr = parent.getBoundingClientRect();
  if (V()) {
    tipEl.style.left = `${rect.right - pr.left + 8}px`;
    const maxTop = parent.clientHeight - tipEl.offsetHeight - 8;
    tipEl.style.top = `${Math.min(maxTop, Math.max(8, at + rect.top - pr.top - tipEl.offsetHeight / 2))}px`;
  } else {
    tipEl.style.top = `${rect.bottom - pr.top + 6}px`;
    const maxLeft = parent.clientWidth - tipEl.offsetWidth - 8;
    tipEl.style.left = `${Math.min(maxLeft, Math.max(8, at + rect.left - pr.left - tipEl.offsetWidth / 2))}px`;
  }
}
