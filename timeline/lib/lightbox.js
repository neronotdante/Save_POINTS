// 封面放大灯箱（07 V1）：全局单例，挂在 <body> 上，position:fixed 盖住整页。
//
// 单例的理由：同一时刻只可能有一个封面被放大；每个轮播各建一份会在 DOM 里留下一堆
// 空壳，还得各自维护 Escape 监听。这里统一一份，打开时由调用方喂 slides。

import { svg } from './icons.js';

// 封面舞台的原型取值（2:3）。截图是 16:9，尺寸由调用方通过 opts.stage 传，
// 再按视口夹一次——横版舞台按封面那套 336×504 硬写，1366 宽的笔记本上会两边出血。
const DEFAULT_STAGE = { w: 336, h: 504 };
const VIEW_PAD_X = 220;   // 左右翻页热区要留得住
const VIEW_PAD_Y = 190;   // 上方关闭钮 + 下方圆点与操作行

let stageW = DEFAULT_STAGE.w;
let stageH = DEFAULT_STAGE.h;
/** 基准舞台的面积。换比例时保面积不保边长，见 stageFor()。 */
let stageArea = DEFAULT_STAGE.w * DEFAULT_STAGE.h;

let root = null;
let actionsWrap = null;
let actions = [];
let stage = null;
let track = null;
let dotsWrap = null;
let closeBtn = null;

let slides = [];
let index = 0;
/** 'cover'（默认，铺满裁边）| 'contain'（整张看全，留边）。混比例的封面组必须用后者。 */
let fitMode = 'cover';
/** 每张幻灯片的加载态：'idle' | 'loading' | 'ok' | 'fail'。只在真正翻到时才去加载。 */
let loadState = [];
let opened = false;
let lastFocus = null;
let onIndex = null;

/** 滚轮攒够 28px 或距上次超过 260ms 才走一格——触控板的惯性流不该一路狂翻。 */
let acc = 0;
let lastStep = 0;

function build() {
  if (root) return;
  root = document.createElement('div');
  root.className = 'lb';

  const card = document.createElement('div');
  card.className = 'lb-card';

  stage = document.createElement('div');
  stage.className = 'lb-stage';
  track = document.createElement('div');
  track.className = 'lb-track';
  stage.appendChild(track);

  const meta = document.createElement('div');
  meta.className = 'lb-meta';
  dotsWrap = document.createElement('div');
  dotsWrap.className = 'cover-dots';
  dotsWrap.style.marginTop = '0';
  actionsWrap = document.createElement('div');
  actionsWrap.className = 'lb-actions';
  const hint = document.createElement('div');
  hint.className = 'lb-hint';
  hint.textContent = '滚轮 / 点击左右侧切换 · ESC 关闭';
  meta.append(dotsWrap, actionsWrap, hint);

  card.append(stage, meta);
  root.appendChild(card);

  closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lb-close';
  closeBtn.setAttribute('aria-label', '关闭放大');
  closeBtn.innerHTML = svg('close', 15, 2);
  closeBtn.addEventListener('click', close);
  root.appendChild(closeBtn);

  root.appendChild(zone('prev', 'chevL', '上一张'));
  root.appendChild(zone('next', 'chevR', '下一张'));

  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('click', (ev) => { if (ev.target === root) close(); });

  document.body.appendChild(root);
  window.addEventListener('keydown', onKeydown);
}

function zone(dir, icon, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'lb-zone';
  b.dataset.dir = dir;
  b.setAttribute('aria-label', label);
  b.innerHTML = `<span class="zb">${svg(icon, 20, 2)}</span>`;
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    step(dir === 'next' ? 1 : -1);
  });
  return b;
}

function onWheel(ev) {
  ev.preventDefault();
  const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
  acc += d;
  if (Math.abs(acc) >= 28 || (acc !== 0 && Date.now() - lastStep >= 260)) {
    const dir = acc > 0 ? 1 : -1;
    acc = 0;
    lastStep = Date.now();
    step(dir);
  }
}

function onKeydown(ev) {
  if (ev.key === 'Escape' && opened) { ev.stopPropagation(); close(); return; }
  if (!opened) return;
  if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') { ev.preventDefault(); step(1); }
  else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') { ev.preventDefault(); step(-1); }
}

function step(delta) {
  if (!slides.length) return;
  index = (index + delta + slides.length) % slides.length;
  paint();
  onIndex?.(index);
}

function paint() {
  applyStage(slides[index]);
  // 幻灯片宽度是 100%，所以位移用百分比——舞台尺寸会随每张的比例变，用像素算就对不上了
  track.style.transform = `translateX(${-index * 100}%)`;
  [...dotsWrap.children].forEach((d, i) => d.classList.toggle('on', i === index));
  paintActions();
  // 只加载看得见的那张与左右各一张：一个时点可能有几十张截图，全量预载会把带宽打满
  for (const i of [index, index - 1, index + 1]) {
    if (i >= 0 && i < slides.length) ensureLoaded(i);
  }
}

/**
 * 把舞台调成这一张素材的比例（07§4.8）。
 *
 * 为什么要按张变：一款游戏的封面变体里，第一张常是竖版海报（600×900），第二张是横版头图
 * （460×215）——比例差了三倍多。固定一个 2:3 的舞台时，横图要么被 `cover` 裁成正中间
 * 窄窄一条（看不出是什么），要么被 `contain` 缩在中间、上下留出两大片空。两种都不好。
 *
 * 换比例时**保面积不保边长**：`w = √(area·a)`, `h = √(area/a)`。这样竖版 336×504、
 * 横版 602×281，两者在屏幕上的分量相当，翻页时不会一张突然铺满、一张缩成一条。
 */
function stageFor(slide) {
  const a = slide?.aspect;
  if (!a) return { w: stageW, h: stageH };
  let w = Math.sqrt(stageArea * a);
  let h = Math.sqrt(stageArea / a);
  const k = Math.min(1, (window.innerWidth - VIEW_PAD_X) / w, (window.innerHeight - VIEW_PAD_Y) / h);
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

function applyStage(slide) {
  const s = stageFor(slide);
  stage.style.width = `${s.w}px`;
  stage.style.height = `${s.h}px`;
}

/**
 * 加载第 i 张的大图。
 *
 * 为什么要有这套状态机、不能直接 `background: url(...)`：CSS 背景图加载失败是**静默**的，
 * 浏览器既不报错也不留痕，画面上就是一片空白，跟「图还在路上」完全分不清。截图的大图地址
 * 又恰恰是最容易拿错 / 失效的一环（见 lib/media.js 里那段：后端一度把网页地址塞进图片字段），
 * 所以这里改成 `new Image()` 预载 —— 成功才铺上去，失败就明说失败。
 */
function ensureLoaded(i) {
  const slide = slides[i];
  const el = track.children[i];
  if (!slide?.image || !el || loadState[i] === 'loading' || loadState[i] === 'ok') return;
  loadState[i] = 'loading';
  setSlideState(el, 'loading', '正在加载原图…');
  const img = new Image();
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';   // Steam 的 UGC CDN 对来路敏感，带上反而更容易被拒
  img.onload = () => {
    loadState[i] = 'ok';
    el.style.background = `url("${slide.image}") center / ${fitMode} no-repeat, ${slide.background}`;
    setSlideState(el, null);
  };
  img.onerror = () => {
    loadState[i] = 'fail';
    setSlideState(el, 'fail', '原图加载失败');
  };
  img.src = slide.image;
}

function setSlideState(el, kind, text) {
  let tip = el.querySelector('.lb-state');
  if (!kind) { tip?.remove(); return; }
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'lb-state mono';
    el.appendChild(tip);
  }
  tip.classList.toggle('fail', kind === 'fail');
  tip.textContent = text;
}

/** 操作按钮的文案每次都现算：「设为页面背景 / 取消页面背景」是同一个按钮的两态。 */
function paintActions() {
  if (!actionsWrap) return;
  actionsWrap.hidden = !actions.length;
  [...actionsWrap.children].forEach((btn, i) => {
    const a = actions[i];
    if (!a) return;
    const slide = slides[index];
    btn.textContent = typeof a.label === 'function' ? a.label(slide, index) : a.label;
    btn.classList.toggle('on', !!a.active?.(slide, index));
  });
}

/**
 * 打开灯箱。
 * @param {{slides: Array<{background: string, image?: string, label?: string}>, index?: number,
 *          stage?: {w:number, h:number}, fit?: 'cover'|'contain',
 *          slides[].aspect?: number  素材自身的宽高比，给了就按它换舞台（见 stageFor）,
 *          actions?: Array<{label: string|((s:any,i:number)=>string),
 *                           onClick: (s:any, i:number)=>void,
 *                           active?: (s:any, i:number)=>boolean}>,
 *          onIndex?: (i:number)=>void, returnFocusTo?: HTMLElement}} opts
 */
export function open(opts) {
  build();
  slides = opts.slides ?? [];
  if (!slides.length) return;
  index = Math.min(Math.max(opts.index ?? 0, 0), slides.length - 1);
  onIndex = opts.onIndex ?? null;
  lastFocus = opts.returnFocusTo ?? null;

  // 舞台按传入比例等比缩到视口内（两边都不许溢出，谁更紧听谁的）
  const want = opts.stage ?? DEFAULT_STAGE;
  const k = Math.min(1,
    (window.innerWidth - VIEW_PAD_X) / want.w,
    (window.innerHeight - VIEW_PAD_Y) / want.h);
  stageW = Math.round(want.w * k);
  stageH = Math.round(want.h * k);
  stageArea = stageW * stageH;

  fitMode = opts.fit === 'contain' ? 'contain' : 'cover';
  actions = opts.actions ?? [];
  actionsWrap.innerHTML = '';
  actions.forEach((a, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lb-action';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      a.onClick(slides[index], index);
      paintActions();      // 点完立刻反映新状态，不用重开灯箱
    });
    actionsWrap.appendChild(btn);
    void i;
  });

  track.innerHTML = '';
  dotsWrap.innerHTML = '';
  loadState = slides.map(() => 'idle');
  for (const s of slides) {
    const el = document.createElement('div');
    el.className = 'lb-slide';
    // 先铺占位（主题色渐变），真图由 ensureLoaded() 预载成功后才叠上来
    el.style.background = s.background;
    el.style.backgroundSize = fitMode;
    if (s.label) {
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = s.label;
      el.appendChild(t);
    }
    track.appendChild(el);
    const d = document.createElement('span');
    d.className = 'cdot';
    dotsWrap.appendChild(d);
  }

  // 先无动画落到起始位，再恢复过渡——否则打开瞬间会从第 0 张滑过来
  track.style.transition = 'none';
  paint();
  root.classList.add('open');
  opened = true;
  requestAnimationFrame(() => requestAnimationFrame(() => { track.style.transition = ''; }));
  try { closeBtn.focus({ preventScroll: true }); } catch { closeBtn.focus(); }
}

export function close() {
  if (!opened) return;
  opened = false;
  root.classList.remove('open');
  onIndex = null;
  if (lastFocus?.isConnected) {
    try { lastFocus.focus({ preventScroll: true }); } catch { lastFocus.focus(); }
  }
  lastFocus = null;
}

export const isOpen = () => opened;
