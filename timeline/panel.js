// 悬浮 panel（07§4.8 + V1）：游戏形态 / 成就形态共用一个容器，封盘标注是游戏形态的附加态。
// 渲染模块：mount() 只建一次 DOM，show()/hide() 反复调用切换内容与可见性。
//
// V1 起两种形态的封面都是**轮播**：
//   · 游戏形态 —— 同一款游戏的多张封面（无真图时按主题色派生 3 张，见 lib/cover.js）；
//   · 成就形态 —— 同一时点的多款游戏，切封面就是切游戏，正文整体跟着换。
// 卡片构造函数对外导出，月档的「点击成就 ICON 浮出面板」直接复用同一份实现。

import { svg, EVENT_ICON } from './lib/icons.js';
import { COVER_W, COVER_H, ACH_COVER_W, ACH_COVER_H, ACH_ROWS_MAX, PANEL_W } from './lib/layout.js';
import { coverVariants, lighten } from './lib/cover.js';
import { createCarousel } from './lib/carousel.js';
import * as API from './api.js';

let panelEl = null;
let hideTimer = null;
// 竞态保护统一用「承载元素还在不在文档里」判断：重绘时 host.innerHTML='' 会把旧节点摘下来，
// 迟到的异步结果自然作废——比模块级 token 更可靠，也让卡片能被多处（悬浮 panel / 月档读数）复用。

/** 当日分钟数 → HH:MM（后端 /calendar/day 的 rows[].time 就是这个口径）。 */
function minutesToHHMM(minutes) {
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** 游戏显示名：中文优先，缺失回退英文（后端 name_zh 可能为 NULL，见 05 §8.3）。 */
const displayName = (game) => game.name_zh || game.name_en || `App ${game.appid}`;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const divider = () => {
  const d = document.createElement('div');
  d.style.cssText = 'height:1px;background:var(--divider);';
  return d;
};

/* ---------------- 游戏形态 ---------------- */

/**
 * 游戏形态卡片内容（07§4.8）。
 * data: { game, date, day, rows:[{type,color,xn,appid}], shelfInfo }
 * 事件行时刻不在 timeline 出参里，渲染后异步用 getDayDetail(day) 补齐。
 * @param {HTMLElement} host 卡片容器（display:flex，横向：封面列 + 右列）
 */
export function buildGameCard(host, data) {
  const { game, date, day, rows = [], shelfInfo } = data;
  host.innerHTML = '';

  // 横版头图（460×215）不再占轮播的一格（07§4.8 v3.19），改当整块面板的底。
  //
  // 理由是这两张图**说的是同一件事**：竖版海报和横版头图都是「这款游戏长什么样」，并排摆两张
  // 只是把「同一件事说两遍」（05§0 规则 2）做成了一个可以滚的控件——首玩这种一天只有一行内容的
  // 时点尤其明显，面板一半的高度都在让人翻封面。而横图的构图本来就是横的，塞进 96×144 的竖框
  // 里两边全被裁掉；铺成 320×186 的底反倒是它的原生比例。
  const variants = coverVariants(game);
  const portraits = variants.filter((v) => v.shape !== 'wide');
  const wide = variants.find((v) => v.shape === 'wide' && v.image);
  host.classList.toggle('has-wide-bg', !!wide);
  if (wide) {
    const bg = el('div', 'hp-bg');
    // ⚠️ 只能写 backgroundImage，**不能写 background 简写**：简写会把样式表里的
    // `background-size: cover` / `background-position: center` 一并重置成 auto / 0% 0%，
    // 而且写在**行内**，之后再改 backgroundImage 也盖不回来（同 timeline.js 的成就图标）。
    // 这层图加载失败是静默的，但它只是装饰：挂了就是一块白底面板，一个字的信息都不少——
    // 和灯箱主图（那里必须走 new Image() 报失败）是两种东西。
    bg.style.backgroundImage = `url("${wide.image}")`;
    host.appendChild(bg);
  }

  const coverCol = el('div');
  coverCol.style.cssText = 'display:flex;flex-direction:column;flex:none;';
  const car = createCarousel({
    slides: portraits.length ? portraits : variants,
    width: COVER_W, height: COVER_H, radius: 10, dots: true,
    ariaLabel: `${displayName(game)} 封面：滚轮切换，点击放大`,
  });
  coverCol.appendChild(car.frame);
  if (car.dots) coverCol.appendChild(car.dots);
  host.appendChild(coverCol);

  const right = el('div', 'right-col');

  const head = el('div');
  head.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
  const headLine = el('div', 'head-line');
  headLine.appendChild(el('div', 'body-text', displayName(game)));
  if (shelfInfo) headLine.appendChild(el('span', 'shelved-tag', '封盘'));
  head.appendChild(headLine);
  head.appendChild(el('div', 'mono caption', date));
  if (shelfInfo) {
    head.appendChild(el('div', 'mono caption',
      `运行 ${shelfInfo.days} 天 · 成就 ${shelfInfo.unlocked}/${shelfInfo.total}`));
  }
  right.appendChild(head);
  right.appendChild(divider());

  const rowsEl = el('div', 'rows');
  const rowEls = rows.map((r) => {
    const node = eventRow(r);
    rowsEl.appendChild(node);
    return { spec: r, el: node };
  });
  right.appendChild(rowsEl);
  host.appendChild(right);

  if (!rowEls.length) return;

  // 时刻补齐：/calendar/day/{date} 的 rows[].time 是当日分钟数，按 (appid, type) 配对回填。
  // 失败或无匹配时时间戳位留空——拿不到时刻不该让整个 panel 报错。
  API.getDayDetail(day).then((detail) => {
    if (!rowsEl.isConnected) return;
    const timeOf = new Map();
    for (const r of detail.rows ?? []) timeOf.set(`${r.game?.appid}|${r.type}`, r.time);
    for (const { spec, el: node } of rowEls) {
      const t = timeOf.get(`${spec.appid}|${spec.type}`);
      if (typeof t === 'number') node.querySelector('.ts').textContent = minutesToHHMM(t);
    }
    // 07§4.8：事件行按时间戳升序
    rowEls
      .slice()
      .sort((a, b) => (timeOf.get(`${a.spec.appid}|${a.spec.type}`) ?? 1e9)
        - (timeOf.get(`${b.spec.appid}|${b.spec.type}`) ?? 1e9))
      .forEach(({ el: node }) => rowsEl.appendChild(node));
  }).catch(() => { /* 时刻缺失不影响 panel 主体 */ });
}

function eventRow({ type, color, xn }) {
  const row = el('div', 'event-row');
  const iconWrap = el('div');
  iconWrap.style.cssText = `display:flex;align-items:center;gap:3px;color:${color};`;
  iconWrap.innerHTML = svg(EVENT_ICON[type]);
  if (xn) {
    const x = el('span', 'mono xn', `×${xn}`);
    x.style.color = color;
    iconWrap.appendChild(x);
  }
  row.appendChild(iconWrap);
  row.appendChild(el('div', 'spacer'));
  row.appendChild(el('div', 'mono caption ts')); // 时刻由 getDayDetail 异步回填，初始留空
  return row;
}

/* ---------------- 成就形态 ---------------- */

/**
 * 成就明细缓存：同一时点在轮播里来回切不该反复打接口。
 * **对外导出**是为了让轴上的成就图标（07§4.2c）与本面板共用同一份缓存——
 * 同一个 (appid, day) 被两处各拉一次，等于把懒加载的意义抵消掉一半。
 */
const achCache = new Map();
const achKey = (appid, day) => `${appid}|${day}`;

export function loadAchievements(appid, day) {
  const key = achKey(appid, day);
  if (!achCache.has(key)) {
    achCache.set(key, API.getAchievementDetail(appid, day).catch((err) => {
      achCache.delete(key);   // 失败不缓存，下次切回来还能重试
      throw err;
    }));
  }
  return achCache.get(key);
}

/**
 * 成就形态卡片（07§4.8 + V1 多游戏轮播）。
 * data: { games:[{game, xn}], day }
 * @param {HTMLElement} host 卡片容器（竖向布局）
 */
export function buildAchievementCard(host, data) {
  const { games, day } = data;
  host.innerHTML = '';

  const col = el('div');
  col.style.cssText = 'flex:1 1 auto;display:flex;flex-direction:column;gap:10px;min-width:0;';

  const header = el('div', 'ach-header');
  const car = createCarousel({
    slides: games.map(({ game }) => coverVariants(game)[0]),
    width: ACH_COVER_W, height: ACH_COVER_H, radius: 8, chip: true, labelSize: 11,
    ariaLabel: games.length > 1
      ? `当日共 ${games.length} 款游戏解锁成就：滚轮切换，点击放大`
      : '游戏封面：点击放大',
    onSlide: (i) => paint(i),
  });
  header.appendChild(car.frame);

  const info = el('div');
  info.style.cssText = 'display:flex;flex-direction:column;gap:3px;min-width:0;';
  const nameEl = el('div', 'body-text');
  nameEl.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  const dateEl = el('div', 'mono caption');
  info.append(nameEl, dateEl);
  header.appendChild(info);

  const spacer = el('div');
  spacer.style.flex = '1 1 auto';
  header.appendChild(spacer);

  const countWrap = el('div');
  countWrap.style.cssText = 'display:flex;align-items:center;gap:3px;';
  header.appendChild(countWrap);
  col.appendChild(header);
  col.appendChild(divider());

  const list = el('div', 'ach-list');
  list.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1 1 auto;';
  col.appendChild(list);

  const foot = el('div', 'ach-foot');
  foot.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding-top:2px;';
  const footNote = el('span', 'mono', '全球解锁率');
  footNote.style.cssText = 'font-size:9px;color:var(--text-3);';
  const moreEl = el('span', 'mono');
  moreEl.style.cssText = 'font-size:9px;color:var(--text-3);';
  foot.append(footNote, moreEl);
  col.appendChild(foot);

  host.appendChild(col);

  /** 切到第 idx 款游戏：头部立刻换，明细走缓存/懒加载。 */
  function paint(idx) {
    const { game, xn } = games[idx];
    nameEl.textContent = displayName(game);
    dateEl.textContent = data.date;
    countWrap.style.color = game.theme_color;
    countWrap.innerHTML = svg('key')
      + `<span class="mono xn" style="color:${game.theme_color}">×${xn}</span>`;
    moreEl.textContent = '';
    list.innerHTML = '';
    list.appendChild(el('div', 'caption', '加载成就明细…'));

    loadAchievements(game.appid, day).then((detail) => {
      if (!list.isConnected || car.index() !== idx) return;
      list.innerHTML = '';
      const shown = detail.slice(0, ACH_ROWS_MAX);
      for (const a of shown) list.appendChild(achRow(a, game));
      const overflow = detail.length - shown.length;
      moreEl.textContent = overflow > 0 ? `+${overflow}` : '';
      if (!shown.length) list.appendChild(el('div', 'caption', '当日无成就明细'));
    }).catch(() => {
      if (!list.isConnected || car.index() !== idx) return;
      list.innerHTML = '';
      list.appendChild(el('div', 'caption', '成就明细加载失败'));
    });
  }

  paint(0);
}

function achRow(a, game) {
  const row = el('div', 'ach-row');
  // 成就三件套（03§4.3a）任一源采集失败时后端给 null，逐项降级、不整行报错
  const icon = el('div', 'icon');
  if (a.icon_url) {
    icon.style.backgroundImage = `url("${a.icon_url}")`;
    icon.style.backgroundSize = 'cover';
  } else {
    icon.style.background = `linear-gradient(150deg, ${lighten(game.theme_color, .30)}, ${game.theme_color})`;
  }
  row.appendChild(icon);
  row.appendChild(el('div', 'name body-text', a.display_name || a.achievement_id));
  row.appendChild(el('div', 'mono caption',
    typeof a.global_percent === 'number' ? `${a.global_percent.toFixed(1)}%` : ''));
  return row;
}

/* ---------------- 容器与显隐 ---------------- */

/** 挂载唯一的 panel 容器（只调用一次）。 */
export function mount(root) {
  panelEl = document.createElement('div');
  panelEl.className = 'hover-panel';
  panelEl.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  panelEl.addEventListener('mouseleave', scheduleHide);
  root.appendChild(panelEl);
  return panelEl;
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => panelEl.classList.remove('visible'), 120);
}

/**
 * 显示 panel（120ms 微延时由调用方——timeline.js 的命中区事件——负责，这里只管渲染与定位）。
 *
 * 调用方给的是**垂轴落点 cross** 与**沿轴中心 mainCenter**，剩下的由这里换算：
 * 沿轴要居中就得知道 panel 自己在那个方向上有多大，而成就形态的高度取决于当天实际
 * 加载出几行成就（标称 269，实测常是 229）——按标称算会让面板偏离它指着的那个时点
 * 半个差值。所以先量再定位，量的是**真实渲染尺寸**。夹进主体区同理，两个方向都要夹。
 * @param {{form:'game'|'achievement', cross:number, mainCenter:number, vertical:boolean}
 *          & Record<string, any>} opts
 */
export function show(opts) {
  clearTimeout(hideTimer);
  // 形态类要在建卡**之前**打上：它带着 min-height，决定了下面量到的是哪个高度。
  // 07§4.8 把两种形态的高度定成了常量（186 / 269），按定值预留不只是为了量得准——
  // 成就明细是异步到的，不预留的话面板会在光标底下自己长高一截，既抖又会挪走中心。
  panelEl.className = `hover-panel form-${opts.form}`;
  if (opts.form === 'game') buildGameCard(panelEl, opts);
  else buildAchievementCard(panelEl, opts);
  const host = panelEl.offsetParent;
  const vw = host?.clientWidth ?? window.innerWidth;
  const vh = host?.clientHeight ?? window.innerHeight;
  // 先无声地量一次：visibility:hidden 仍参与布局，量得到尺寸又不会闪一下
  panelEl.style.visibility = 'hidden';
  panelEl.classList.add('visible');
  const w = panelEl.offsetWidth || PANEL_W;
  const h = panelEl.offsetHeight || 0;
  const fit = (v, size, box) => Math.min(Math.max(8, v), Math.max(8, box - size - 8));
  const left = opts.vertical ? opts.cross : opts.mainCenter - w / 2;
  const top = opts.vertical ? opts.mainCenter - h / 2 : opts.cross;
  panelEl.style.left = `${fit(left, w, vw)}px`;
  panelEl.style.top = `${fit(top, h, vh)}px`;
  panelEl.style.visibility = '';
}

export function hide() {
  scheduleHide();
}

export function hideImmediately() {
  clearTimeout(hideTimer);
  if (!panelEl) return;
  panelEl.classList.remove('visible');
}
