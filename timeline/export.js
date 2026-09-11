// 导出长图的对话框（07§4.11）：全局单例，挂在 <body> 上，position:fixed 盖住整页。
//
// 它自己不画图、也不知道时间轴长什么样，只做三件事：把当前口径**摊开给用户看**、
// 收下方向 / 倍率 / 范围三个选择、把进度回显出来。真正的活在 timeline.js::exportLongImage。
//
// 为什么要有这个面板，而不是点一下就直接下载：
//   · 长图的尺寸是**算出来才知道**的（几千到几万像素不等），点之前得让人看见自己要拿到
//     多大一张图——否则一次误点就是几十秒的等待加一个几十 MB 的文件。
//   · 导出沿用主页面的过滤规则，这件事必须**写在脸上**。用户刚关掉成就、开着精简模式，
//     导出来少了一半内容却没人提过一句，那是界面在骗人（05§0 规则 3）。
//   · 方向是导出时才选的一项，选完会同步改主页面——这种「点这里会改那边」的联动
//     不能不打招呼。
//   · 范围（整条轴 / 某几年）决定了清晰度：整条轴会被画布上限压到 0.7×，按年切才能 1×、2×。
//     面板上的尺寸与「已自动降到」那行就是把这个取舍摆在眼前。

import { svg } from './lib/icons.js';

let root = null;
let card = null;
let dirBtns = {};
let scaleBtns = {};
let rangeBtns = {};
let spanBtns = {};
let yearRow = null;
let yearSelect = null;
let rulesEl = null;
let sizeEl = null;
let noteEl = null;
let statusEl = null;
let goBtn = null;
let closeBtn = null;
let cancelBtn = null;

let opened = false;
let busy = false;
let lastFocus = null;
/** 调用方（timeline.js）注入：读口径 / 换方向 / 真正去导 */
let api = { read: () => null, setOrient: () => {}, run: async () => {} };
/** 申请的倍率。1× 是「屏幕上多大就多大」，2× 给要放大看细节 / 拿去打印的人。 */
let wantScale = 1;
/** 'all' = 整条轴；'years' = 从 fromYear 起连着 spanYears 年 */
let rangeMode = 'all';
let fromYear = null;
let spanYears = 1;

const STAGE_TEXT = {
  achievements: (d, t) => `补全成就图标 ${d}/${t}`,
  images: (d, t) => `内联封面与截图 ${d}/${t}`,
  draw: (d, t) => `绘制切片 ${d}/${t}`,
  encode: () => '编码 PNG…',
};

/** 像素数写成人能读的量级：`12480 × 726` 后面跟一句「约 906 万像素」才有体感。 */
function fmtPixels(w, h) {
  const px = w * h;
  if (px >= 1e8) return `约 ${(px / 1e8).toFixed(1)} 亿像素`;
  if (px >= 1e4) return `约 ${Math.round(px / 1e4)} 万像素`;
  return `${px} 像素`;
}

function fmtBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

/** 当前选择折成喂给 timeline 的 range（'all' 时为 null）。 */
function currentRange() {
  if (rangeMode !== 'years' || fromYear === null) return null;
  return { fromYear, toYear: fromYear + spanYears - 1 };
}

function seg(host, map, value, label, onPick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'exp-seg';
  b.textContent = label;
  b.addEventListener('click', () => { if (!busy) onPick(value); });
  host.appendChild(b);
  map[value] = b;
  return b;
}

function row(labelText) {
  const r = document.createElement('div');
  r.className = 'exp-row';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = labelText;
  const segs = document.createElement('div');
  segs.className = 'exp-segs';
  r.append(label, segs);
  return { row: r, segs };
}

function build() {
  if (root) return;
  root = document.createElement('div');
  root.className = 'exp';

  card = document.createElement('div');
  card.className = 'exp-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', '导出长图');

  const title = document.createElement('div');
  title.className = 'heading';
  title.textContent = '导出长图';
  const sub = document.createElement('div');
  sub.className = 'caption';
  sub.textContent = '把时间轴拍成一张 PNG，内容与主页面完全一致。';

  closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'exp-close';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.innerHTML = svg('close', 14, 2);
  closeBtn.addEventListener('click', close);

  // ---- 方向 ----
  const dir = row('方向');
  seg(dir.segs, dirBtns, 'h', '横向', pickOrient);
  seg(dir.segs, dirBtns, 'v', '纵向', pickOrient);

  // ---- 范围 ----
  const range = row('范围');
  seg(range.segs, rangeBtns, 'all', '整条轴', pickRange);
  seg(range.segs, rangeBtns, 'years', '按年份', pickRange);

  // ---- 年份（只在「按年份」时出现）----
  // 起始年用原生 <select>：十来个年份塞成一排分段按钮会把面板撑得比轴还宽。
  // 跨度只有 1 / 2 两档（上限由 timeline.js::EXPORT_MAX_YEARS 定，这里只是照着画）。
  const years = row('年份');
  yearRow = years.row;
  yearSelect = document.createElement('select');
  yearSelect.className = 'exp-select';
  yearSelect.setAttribute('aria-label', '起始年份');
  yearSelect.addEventListener('change', () => {
    if (busy) return;
    fromYear = Number(yearSelect.value);
    paint();
  });
  years.segs.appendChild(yearSelect);
  seg(years.segs, spanBtns, 1, '1 年', pickSpan);
  seg(years.segs, spanBtns, 2, '2 年', pickSpan);

  // ---- 倍率 ----
  const scale = row('倍率');
  seg(scale.segs, scaleBtns, 1, '1×', pickScale);
  seg(scale.segs, scaleBtns, 2, '2×', pickScale);

  // ---- 只读信息 ----
  rulesEl = document.createElement('div');
  rulesEl.className = 'caption exp-rules';
  sizeEl = document.createElement('div');
  sizeEl.className = 'mono exp-size';
  noteEl = document.createElement('div');
  noteEl.className = 'caption exp-note';
  statusEl = document.createElement('div');
  statusEl.className = 'caption exp-status';
  statusEl.setAttribute('role', 'status');

  // ---- 操作 ----
  const foot = document.createElement('div');
  foot.className = 'exp-foot';
  cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', close);
  goBtn = document.createElement('button');
  goBtn.type = 'button';
  goBtn.className = 'btn-primary';
  goBtn.textContent = '导出 PNG';
  goBtn.addEventListener('click', run);
  foot.append(cancelBtn, goBtn);

  card.append(
    closeBtn, title, sub, dir.row, range.row, years.row, scale.row,
    rulesEl, sizeEl, noteEl, statusEl, foot,
  );
  root.appendChild(card);
  // 点遮罩关闭；导出中不关（正在跑的活没法半路撤，见 run()）
  root.addEventListener('click', (ev) => { if (ev.target === root) close(); });
  document.body.appendChild(root);
  window.addEventListener('keydown', onKeydown);
}

function onKeydown(ev) {
  if (!opened || ev.key !== 'Escape') return;
  ev.stopPropagation();   // 别让 ESC 顺手把底下的 panel / 自动滚动也一起收了
  close();
}

function pickOrient(orient) {
  // 方向切换直接落到主页面：所见即所得。重排完再读一次口径——长度会跟着方向变。
  api.setOrient(orient);
  paint();
}

function pickRange(mode) {
  rangeMode = mode;
  paint();
}

function pickSpan(n) {
  spanYears = n;
  paint();
}

function pickScale(s) {
  wantScale = s;
  paint();
}

function markOn(map, value) {
  for (const [k, b] of Object.entries(map)) {
    const on = String(k) === String(value);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

/** 年份下拉按轴上真实的年份区间重建；起始年默认落在**最近一年**——最近的最常导。 */
function syncYears([minY, maxY]) {
  const want = [];
  for (let y = maxY; y >= minY; y--) want.push(y);
  const have = [...yearSelect.options].map((o) => Number(o.value));
  if (have.join(',') !== want.join(',')) {
    yearSelect.innerHTML = '';
    for (const y of want) {
      const o = document.createElement('option');
      o.value = String(y);
      o.textContent = String(y);
      yearSelect.appendChild(o);
    }
  }
  if (fromYear === null || fromYear < minY || fromYear > maxY) fromYear = maxY;
  yearSelect.value = String(fromYear);
}

/** 把当前口径摊到面板上。任何一个选项一变就重来一次，尺寸永远是真值。 */
function paint() {
  const ctx = api.read({ scale: wantScale, range: currentRange() });
  if (!ctx) return;
  syncYears(ctx.years);
  // 起始年是最后一年时没有「下一年」可连，两年这档就没意义——禁掉而不是悄悄夹成一年
  const [, maxY] = ctx.years;
  const canSpanTwo = fromYear < maxY && ctx.maxYears >= 2;
  if (!canSpanTwo && spanYears !== 1) spanYears = 1;
  spanBtns[2].disabled = !canSpanTwo;
  spanBtns[2].title = canSpanTwo ? '' : `${fromYear} 已是最近一年，没有下一年可连`;
  yearRow.hidden = rangeMode !== 'years';

  markOn(dirBtns, ctx.orient);
  markOn(rangeBtns, rangeMode);
  markOn(spanBtns, spanYears);
  markOn(scaleBtns, wantScale);

  const f = ctx.filters;
  const on = [];
  if (f.hideNeverLaunched) on.push('隐藏从未启动');
  if (f.hideAch) on.push('隐藏成就');
  if (f.minimal) on.push('精简模式');
  const span = ctx.range
    ? (ctx.range.fromYear === ctx.range.toYear
      ? `${ctx.range.fromYear} 年`
      : `${ctx.range.fromYear}–${ctx.range.toYear} 年`)
    : '整条轴';
  rulesEl.textContent = `沿用主页面的过滤规则：${on.length ? on.join(' · ') : '未启用任何过滤'}`
    + `｜缩放 ${f.pxPerDay.toFixed(2)} px/天｜${span} · ${ctx.groups} 个时点`;

  const w = Math.round(ctx.width * ctx.scale);
  const h = Math.round(ctx.height * ctx.scale);
  sizeEl.textContent = `${w} × ${h} px · ${fmtPixels(w, h)}`;

  const notes = [];
  if (ctx.scale < ctx.wanted) {
    // 降倍率不是选项而是**结果**（浏览器的位图上限），所以要说清是谁决定的，以及怎么绕开
    notes.push(`这一段太长，${ctx.wanted}× 超出浏览器的画布上限，已自动降到 ${ctx.scale}×`
      + (ctx.range ? '' : '——想要原倍率，改成「按年份」导'));
  }
  notes.push('方向会同步应用到主页面');
  noteEl.textContent = notes.join('｜');
}

function setBusy(v) {
  busy = v;
  goBtn.disabled = v;
  cancelBtn.disabled = v;
  closeBtn.disabled = v;
  yearSelect.disabled = v;
  card.classList.toggle('busy', v);
}

async function run() {
  if (busy) return;
  setBusy(true);
  statusEl.classList.remove('fail');
  statusEl.textContent = '准备中…';
  try {
    const out = await api.run({
      scale: wantScale,
      range: currentRange(),
      onProgress: (stage, done, total) => {
        statusEl.textContent = (STAGE_TEXT[stage] ?? (() => stage))(done, total);
      },
    });
    const miss = out.images?.failed ?? 0;
    statusEl.textContent = `已导出 ${out.width} × ${out.height} px · ${fmtBytes(out.blob.size)}`
      // 取不回来的贴图在图上是主题色占位块，得说一声，不然用户会以为是自己的库缺图
      + (miss ? `（${miss} 张贴图取不回来，已留主题色占位）` : '');
  } catch (err) {
    console.error('[export] 导出失败', err);
    statusEl.classList.add('fail');
    statusEl.textContent = `导出失败：${err.message}`;
  } finally {
    setBusy(false);
    paint();
  }
}

/**
 * 打开面板。
 * @param {{read:(opts:{scale:number, range:object|null})=>object,
 *          setOrient:(o:'h'|'v')=>void, run:(opts:object)=>Promise<object>}} hooks
 */
export function open(hooks) {
  build();
  api = { ...api, ...hooks };
  opened = true;
  lastFocus = document.activeElement;
  statusEl.textContent = '';
  statusEl.classList.remove('fail');
  paint();
  root.classList.add('open');
  goBtn.focus();
}

export function close() {
  if (!opened || busy) return;
  opened = false;
  root.classList.remove('open');
  lastFocus?.focus?.();
}
