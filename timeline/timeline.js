// 渲染层（07§4.2~§4.6 + §4.10）：轴 + 时点 unit + 引线 + 首玩封面 + 截图 + 边缘滚动 + 无档缩放。
//
// 三条贯穿全文的约定，先说清楚，后面就不再重复：
//
// 1. **位置只有一个真源**：沿轴坐标一律来自 `lib/scale.js`（05§1.2）。渲染层不推挤、不修正，
//    内容尺寸要影响间距就回灌成 `segment.minPx`，绝不在画完之后挪。
// 2. **沿轴 main / 垂轴 cross**：横排时 main=x、cross=y，竖排时对调（07§4.10）。所有几何
//    都用这两个词描述，方向切换只是这两个词换个绑定，规则本身不变。
// 3. **垂轴位置一律写成 `calc(var(--axis-c) ± N)`**：轴上下每个元素距轴线的偏移都是常量，
//    所以视口变化时只要改主体区上那一个 CSS 变量就完成重排，零 DOM 遍历（见 applyCrossMetrics）。

import {
  buildSegments, createScale, ZOOM_DEFAULT, zoomBy, clampZoom, gapDaysFor, tickSpecFor,
} from './lib/scale.js';
import {
  setOrient, isVertical, assignStems, groupMain, markOffset, markCross,
  layoutShotColumns, minWidthsBetween, shotsPerColumn, fpCoverScale, fpTileSize, fpCrossOf,
  panelChromeCross, shotPanelMain, SHOT_PANEL_MAX, SHOT_PANEL_MIN,
  panelGrid, panelTitleMain, panelCrossMin,
  achPerColumn, achCells, achShape, splitAchAcrossAxis, panelsMainOf,
  axisCrossFor, panelCrossPos, panelCrossPosBelow, unitCenters, STEM_BASE, FP_GAP, fpCrossMax,
  groupFootprint,
  SHOT_TOP_OFFSET,
  HIT_PAD, HIT_HEIGHT, GAME_PANEL_H, ACH_PANEL_H, PANEL_W,
} from './lib/layout.js';
import { svg, EVENT_ICON } from './lib/icons.js';
import {
  getHideNeverLaunched, getOrientPref, setOrientPref, getOverviewPref, setOverviewPref,
  getZoomPref, setZoomPref, getMinimalPref, setMinimalPref, getHideAchPref, setHideAchPref,
} from './lib/prefs.js';
import { coverVariants, lighten } from './lib/cover.js';
import { dedupeThemeColors, FALLBACK_COLOR } from './lib/theme-color.js';
import { shotImageUrl } from './lib/media.js';
import * as Lightbox from './lib/lightbox.js';
import * as Backdrop from './lib/backdrop.js';
import * as Overview from './lib/overview.js';
import { nodeToPng, fitScale, saveBlob } from './lib/raster.js';
import * as API from './api.js';
import * as Panel from './panel.js';
import * as ExportDialog from './export.js';

const EV_COLOR = { purchase: '#0E9E68', release: '#2F6BFF' }; // 必须与 styles.css 的 --ev-* 保持一致
const DAY = 86400;
const EDGE_BAND = 64;      // 05§1.1
const EDGE_DELAY = 150;    // 01§2A.4：120~200ms 微延时
const RESIZE_SETTLE = 160; // 视口停下多久后才做那次「贵」的重排（重建 DOM）
// ---- 中键自动滚动（07§4.6b）----
const AUTOSCROLL_DEAD = 14;   // 锚点周围的死区：手抖不该让轴动起来
const AUTOSCROLL_GAIN = 0.26; // 超出死区之后，每像素距离换多少 px/帧
const AUTOSCROLL_MAX = 42;    // 每帧上限，再快就看不清自己滚到哪了
/** 截图灯箱舞台：16:9，与缩略图同比例。封面走 lightbox.js 的 2:3 默认值。 */
const SHOT_STAGE = { w: 960, h: 540 };
/**
 * 轴的开头要为起点标（START）预留多长的沿轴距离。
 * 横排时标签是横躺的（约 120 宽），竖排时它只占自己那一行的高度——两个方向差一个数量级。
 * 这个预留走的是 `segment.minPx`，也就是**内容尺寸回灌坐标层**那条既有通道（05§1.2），
 * 不是渲染时硬挪：位置真源仍然只有 scale 一处。
 *
 * ⚠️ 这只是**标签自己**要的长度。它旁边那一组还要占地方，见 END_FLAG_CLEAR。
 */
const START_LEAD = { h: 152, v: 36 };
/**
 * 两端的标与**相邻那一组的内容边缘**之间的留白（07§4.2b v3.17）。
 *
 * 这两枚标都**横跨轴线**（垂轴方向居中于轴线），而封面在轴的一侧、截图面板在另一侧——
 * 也就是说沿轴方向一旦靠近，它们必然压在一起，没有「错开到另一侧」这条退路。竖排下尤其明显：
 * 标签横躺着有 120 宽，轴两侧各伸出 60，正好落在封面和面板的通道里。
 *
 * 所以让开的距离必须按**相邻那一组自己的沿轴长度**（groupFootprint）算，只留标签自己的长度
 * 是不够的——原来就是这么算的，于是第一组的封面盖住了起点标、最后一组的截图面板盖住了 TODAY 标。
 */
const END_FLAG_CLEAR = 12;
/**
 * 轴的**末端留白**（px），与 START_LEAD 同一套道理，但原来只有起点有。
 *
 * 尾段本来是「今天之后 10 天」，可 10 天折成多少像素取决于当前缩放：缩到最疏的一档时它只有
 * 十几 px，轴线画到今天就戛然而止，末端读起来像**被截断**而不是「到此为止」。而这一端恰恰
 * 是默认视窗停靠的地方（init 里 offset 落在 NOW 附近），是最常看到的一段。
 * 这里给它一个像素下限，同时也是「今天」标签的落脚处——横排的标签比竖排长，所以两个方向
 * 各给各的值。
 */
const END_LEAD = { h: 176, v: 56 };
/** 导航条（top/left 18 + 厚 56）之外还要留的呼吸；封面顶端进到这条线以内就把导航条收起来。 */
const RAIL_CLEAR = 18 + 56 + 8;
/**
 * 「封盘后重启」的判定间隔（天）。用的是 PRD §3 的沉寂阈值 `T_quiet = 45`，不另立一个数。
 *
 * ⚠️ 口径与后端的 `lifecycle` **不是同一件事**：后端按「最后一次**启动**时间」算，而轴上
 * 只看得见事件（首玩 / 成就解锁）。这里判的是「这款游戏在轴上的可见活动断了 45 天以上
 * 又出现了」——解锁成就必然意味着启动过，所以它是启动的下界近似，会漏掉「启动了但没解
 * 成就也没截图」的那些天。用户要的「一部分游戏」正是这个可见的子集。
 */
const RETURN_GAP_DAYS = 45;
/**
 * 刻度标签之间至少要留多少像素。横排要放得下 `2026-07-11` 那么长一串；
 * 竖排的标签是一行行叠着的，只要放得下一行字的高度。两个方向差一个数量级，
 * 用同一个值会让竖排的刻度稀得没法读。
 */
const TICK_MIN_SPACING = { h: 86, v: 26 };
/**
 * 轴上两枚标签之间至少留多少空隙（07§4.6c）。贴着边也读不清，6px 是「看得出是两枚」的下限。
 *
 * 这套防撞是**渲染层的视觉去重，不是坐标层的约束**：刻度与稀疏段标签都是叠在轨道上的绝对
 * 定位元素，不推挤任何东西，所以挤不下时少写几个字就行，绝不能反过来去改间距——
 * 间距归坐标层管（05§1.2）。
 */
const LABEL_GAP = 6;

/**
 * 一枚轴上标签沿轴占多宽。
 *
 * 等宽字体（JetBrains Mono），字符数 × 单字宽就够准：实测 `SEP 12 — OCT 03` 15 字 = 110px、
 * `2015.11` 7 字 = 54px，与 `offsetWidth` 分毫不差（10.5px + .10em 字距 → 7.35/字；
 * 12px + .04em → 7.7/字）。竖排下标签是**横放**的，沿轴占的是行高，与字数无关。
 *
 * 只用来决定**写不写字**。估偏一两个像素的后果最多是某一枚本可以写的标签没写出来，
 * 不会让任何东西移位——这也是它可以用估算、不必进 DOM 实测的原因。
 */
const TICK_CHAR_PX = { minor: 7.35, major: 7.7 };
const TICK_LINE_PX = 16;
function tickLabelMain(text, major) {
  return V() ? TICK_LINE_PX : text.length * TICK_CHAR_PX[major ? 'major' : 'minor'];
}

let els = {};
/** API.getTimeline() 的归一化结果：{ events, screenshots, games, gamesByAppid } */
let dataset = null;
let NOW = Math.floor(Date.now() / 1000);
let state = { orient: 'h', pxPerDay: ZOOM_DEFAULT, offset: 0 };
let showOverview = true;
/**
 * 精简模式（07§4.2e）：屏蔽成就图标与截图缩略图，轴上只留**事件图标 + 开局封面**。
 * 它不是「把元素藏起来」而是**不参与布局**——屏蔽掉的东西同时不再占沿轴长度，
 * 所以切过去的时候整条轴会明显收紧，那正是这个模式的用处。
 */
/**
 * 封面**跨轴交错**（07§4.2h）：相邻的开局封面一个在轴上、一个在轴下，**图标与引线一并跟着换边**。
 *
 * 只在**精简模式**下开——那时轴的对侧本来就空着（截图面板与成就簇都被屏蔽了），换过去正好
 * 把闲置的那半边用起来；同时一上一下的两组沿轴根本不会撞，间距约束只剩各自那一侧的长度，
 * 轴能实打实地压紧。对侧厚度不够（或封面已被迫缩小）时自动关掉：宁可不交错，也不能把封面顶出主体区。
 */
let stagger = false;
/**
 * 封面内沿**距轴线**的统一距离（07§4.2i）。
 *
 * 引线长度是逐组分档的（`assignStems` 为了错开命中区会把一部分组抬到 104 / 144 / 184），
 * 封面若跟着各自的引线走，一排封面就会高低不齐——同一件东西没有理由因为「它那天的图标被
 * 抬高了」而换个高度。所以封面统一钉在**最外那一组**的标记外沿上，与引线分档解耦：
 * 图标该抬还抬，封面始终成一条线，轴上下两侧用同一个值，看上去才是对称的。
 */
let coverPin = 0;
let minimal = false;
/**
 * 隐藏成就（07§4.2f）：成就事件**整类不进轴**——图标、`×N`、图标簇一起没有。
 * 与 `minimal` 的分工（v3.21 拆开）：那个只屏蔽**截图**（面板与缩略图），成就图标簇归这个管；
 * 这个屏蔽的是成就这一整类事件本身。口径与 07§4.9 的「隐藏从未启动」一致：
 * **不进轴，不是灰化**——留一个灰掉的图标既占地方又什么都没说。
 */
let hideAch = false;
/** 用户想要导航条、但当前空间放不下——按钮要说明白，不能点了没反应还不解释。 */
let railSuppressed = false;
let edgeTimer = null;
let edgeRaf = null;
let hoveringGroupKey = null;
/** 当前轴线在垂轴方向的位置（主体区内坐标）。 */
let axisCross = 385;
/**
 * 面板内的每列截图张数（重建时按可用厚度现算，渲染与间距共用同一份值）。
 * 轴下方 v3.5 起只剩面板一种东西，所以只需要这一个容量——标题栏吃掉的那截厚度已经折进去了。
 */
let panelCap = 5;
/** 成就簇一列叠几个（按标记侧可用厚度现算）。 */
let achCap = 3;
let coverScale = 1;
/** 粗粒度缩放下当前钉住的读数条（同一时刻只允许一个）。 */
let currentScale = null;
let currentSpec = { unit: 'month', step: 1 };
/** 本次渲染出来的时点组，供首屏成就图标的同步兜底用（见 fillTilesInView）。 */
let renderedGroups = [];

/** 一款游戏的主题色（事件图标、截图占位等沿用既有口径：取不到就兜底）。 */
const themeOf = (game) => game?.theme_color || FALLBACK_COLOR;

/**
 * 封面边框该用的颜色，**取不到就返回 null**（由 CSS 落到中性描边）。
 *
 * 与 themeOf 的区别就在这个 null：兜底紫不是这款游戏的颜色，只是「这次没取出来」的记号。
 * 事件图标上它还能当个占位（总得画个点），但拿它去描一整圈封面边框，几十款取色失败的
 * 游戏会连成一堵一模一样的紫边——看着像 bug，而且是在**冒充**信息。宁可画一道中性细边，
 * 明说这里没有颜色可用。
 *
 * 判据用后端的 `theme_color_source`：只有 `local` 才是真从这张封面里取到的。
 * （前端一度也做过一套画布取色，用的是同一套算法、同一张图，算不出更好的结果，
 * 却因为 Steam CDN 对部分资源不给 CORS 头而刷一屏报错——已删除，改在后端把
 * 近灰度门槛从 12% 放宽到 5%，实测把 29 款里的 19 款救了回来。）
 */
function ringOf(game) {
  return game?.theme_color && game.theme_color_source === 'local' ? game.theme_color : null;
}

const V = () => state.orient === 'v';
/** 主体区在沿轴 / 垂轴方向的尺寸。 */
const bodyMain = () => (V() ? els.body.clientHeight : els.body.clientWidth);
const bodyCross = () => (V() ? els.body.clientWidth : els.body.clientHeight);

/** 游戏显示名：中文优先、回退英文、再回退 appid（与 panel.js 同口径）。 */
const nameOfGame = (game, appid) => game?.name_zh || game?.name_en || `App ${appid ?? game?.appid}`;

/** 'YYYY-MM-DD' → 当日 0 点的 unix 秒（UTC，与坐标层同基准）。 */
const dayToTs = (d) => Date.parse(`${d}T00:00:00Z`) / 1000;

/* ---------------- 定位原语 ---------------- */

/**
 * 把「沿轴 p / 垂轴偏移 c」写成绝对定位。c 为负 = 标记侧（横排的上方 / 竖排的左侧），
 * 为正 = 截图侧。注意必须自己拼符号：`calc(var(--axis-c) + -8px)` 不是合法 CSS。
 */
function setPos(el, p, c) {
  const cross = `calc(var(--axis-c) ${c < 0 ? '-' : '+'} ${Math.abs(c)}px)`;
  if (V()) { el.style.top = `${p}px`; el.style.left = cross; }
  else { el.style.left = `${p}px`; el.style.top = cross; }
}

/** 沿轴长度 / 垂轴厚度 → width/height（方向一换就对调）。 */
function setSize(el, main, cross) {
  if (V()) { el.style.height = `${main}px`; el.style.width = `${cross}px`; }
  else { el.style.width = `${main}px`; el.style.height = `${cross}px`; }
}

/* ---------------- 数据折叠 ---------------- */

/**
 * 把后端形状的 events[] + screenshots[] 折成轴上的「时点组」（07§4.5：
 * 某天有任意事件或截图即为时点，仅有截图的日期同样是落点）。
 */
/** ISO 时刻串 → 当日第几分钟；取不出就 null（不拿 0 顶替，0 是「00:00」这个真值）。 */
function minuteOfIso(iso) {
  const hh = Number(String(iso ?? '').slice(11, 13));
  const mm = Number(String(iso ?? '').slice(14, 16));
  return Number.isFinite(hh) && Number.isFinite(mm) ? hh * 60 + mm : null;
}

function buildGroups() {
  if (!dataset) return [];
  const hideNever = getHideNeverLaunched();
  const gameOf = (appid) => dataset.gamesByAppid.get(appid);
  const visible = (appid) => {
    const g = gameOf(appid);
    // 07§4.9：隐藏时该游戏全部事件（购买/发售）一并不进轴，不是灰化
    return g && !(hideNever && g.lifecycle === 'never_launched');
  };

  const byDay = new Map();
  const bucket = (day) => {
    if (!byDay.has(day)) byDay.set(day, { date: day, events: [], shots: [], panels: [] });
    return byDay.get(day);
  };
  for (const e of dataset.events) {
    if (!visible(e.game.appid)) continue;
    if (hideAch && e.type === 'achievement') continue;
    bucket(e.date).events.push(e);
  }
  // 截图分流（07§4.2d）：**只有同一款游戏同一天有事件时，截图才算「对得上轴」**。
  // 以前是按日期一刀切——game A 有成就的那天，game B 的截图也会被挂到 A 的时点下，
  // 说的是一件没发生过的事。实测真实库里两类各占一半。
  const eventKey = new Set();
  // 「封盘后重启」的判定必须从**未被显示开关过滤的**事件里算：它是数据属性
  // （这款游戏的可见活动断了 45 天又出现），不该因为「我把成就图标关掉了」而改变。
  // 早先它是从 unitsAll 推的，于是一开「隐藏成就」，回归封面会跟着全部消失。
  const activeDays = new Map();   // appid → 活动日（YYYY-MM-DD）集合
  for (const e of dataset.events) {
    if (!visible(e.game.appid)) continue;
    if (e.type === 'first_play' || e.type === 'achievement') {
      if (!activeDays.has(e.game.appid)) activeDays.set(e.game.appid, new Set());
      activeDays.get(e.game.appid).add(e.date);
    }
    if (hideAch && e.type === 'achievement') continue;   // 这条不在轴上了，截图也就对不上它
    eventKey.add(`${e.game.appid}|${e.date}`);
  }
  // appid|日期 → 这一天是「回归日」（上一次活动在 RETURN_GAP_DAYS 之前）
  const returnDays = new Set();
  for (const [appid, days] of activeDays) {
    const sorted = [...days].sort();
    for (let i = 1; i < sorted.length; i++) {
      if ((dayToTs(sorted[i]) - dayToTs(sorted[i - 1])) / DAY >= RETURN_GAP_DAYS) {
        returnDays.add(`${appid}|${sorted[i]}`);
      }
    }
  }
  const orphanByGame = new Map();
  // 截图在轴上原本没有自己的 unit（只在轴外侧铺缩略图）。给它加一个相机图标之后，
  // 「只有截图的那些日子」在精简模式下才不会整个从轴上消失。按 (日期, 游戏) 归并计数。
  // 存的是**截图本身**而不只是计数：点这个图标要能直接看细节（07§4.2g），
  // 精简模式下面板都藏了，图标是这批截图在轴上唯一的入口。
  const shotUnitShots = new Map();   // `日期|appid` → 该图标背后的截图
  const addShotUnit = (day, appid, shot) => {
    const key = `${day}|${appid}`;
    if (!shotUnitShots.has(key)) shotUnitShots.set(key, []);
    shotUnitShots.get(key).push(shot);
  };
  // 一款游戏的**全部**截图（按时间排）。相机图标点开的是这一份，不是它自己那一天的那几张。
  //
  // 图标是按 (日期, 游戏) 归并的，而实测中位数是「一天 3 张」——按天开灯箱，绝大多数点击
  // 换来的就是一两张图，翻两下就到头了。可这些截图本来就是**同一款游戏的一串**（69 款游戏
  // 分掉 334 张，最多的一款 29 张），一天一天切开只是轴上的排布需要，不是它们本身的边界。
  // 何况精简模式下轴下方的面板全藏了，这个图标是这批截图在轴上**唯一**的入口：入口只开
  // 一天的口子，等于把同一款游戏其余的截图锁死在一个当前视图里点不到的地方。
  // 所以灯箱装整款游戏，只是**从点中的那一天开始翻**——点击点仍然精确对应它所在的时点。
  const shotsByGame = new Map();     // appid → 该游戏全部截图（时间升序）
  const gameShotIndex = new Map();   // `shot_id` → 它在上面那条队列里的下标
  for (const raw of dataset.screenshots) {
    if (!visible(raw.appid)) continue;
    // 主题色（占位渐变要用）必须在**分流之前**补：两条路径共用同一份装饰过的对象。
    // 只在其中一条路上补的话，另一条拿到的 `__color` 是 undefined，渐变字符串里就会插进
    // 一个 "undefined" —— 那是**非法 CSS**，浏览器会把整条 background-image 连同上面那层
    // 真图一起丢掉，而且不报错。表现就是「这些截图全是空白格」。
    const shot = { ...raw, __color: themeOf(gameOf(raw.appid)) };
    const day = shot.taken_at.slice(0, 10);
    // 整款游戏的队列**在分流之前**收：对不对得上轴（下面两条分支）是排布问题，
    // 不改变「这张截图属于这款游戏」。两条路上的是同一个装饰过的对象，所以下标能通用。
    if (!shotsByGame.has(shot.appid)) shotsByGame.set(shot.appid, []);
    shotsByGame.get(shot.appid).push(shot);
    if (eventKey.has(`${shot.appid}|${day}`)) {
      bucket(day).shots.push(shot);
      addShotUnit(day, shot.appid, shot);
      continue;
    }
    if (!orphanByGame.has(shot.appid)) orphanByGame.set(shot.appid, []);
    orphanByGame.get(shot.appid).push(shot);
  }
  for (const list of shotsByGame.values()) {
    list.sort((a, b) => (a.taken_at < b.taken_at ? -1 : 1));
    list.forEach((s, i) => gameShotIndex.set(s.shot_id, i));
  }
  // 够量的按游戏收成面板，不够的老实按日期挂回轴上——一个带标题栏的容器比它装的三张
  // 缩略图还占地方，那时候单开面板是净亏（阈值来历见 lib/layout.js::SHOT_PANEL_MIN）
  const panelSpecs = [];
  for (const [appid, list] of orphanByGame) {
    if (list.length < SHOT_PANEL_MIN) {
      for (const s of list) bucket(s.taken_at.slice(0, 10)).shots.push(s);
      continue;
    }
    list.sort((a, b) => (a.taken_at < b.taken_at ? -1 : 1));
    // 锚在**中位日期**：这些截图没有对应事件，但仍有时间，锚在中间最能代表「那阵子」。
    // 不画跨度条——本范式不引入区间型数据（07§0）。
    const day = list[Math.floor(list.length / 2)].taken_at.slice(0, 10);
    panelSpecs.push({ appid, day, shots: list, game: gameOf(appid) });
    // 面板锚点那天也要有一个相机图标，否则精简模式下这一堆截图在轴上没有任何痕迹
    for (const shot of list) addShotUnit(day, appid, shot);
  }

  // 面板挂到它的锚点日上：那天可能本来就有时点（合并进去），也可能没有（bucket 现建一个）。
  // ⚠️ bucket **任何模式下都要建**：精简模式虽然不画面板，但那天的相机图标还得在，
  // 否则这一堆截图在轴上会连一点痕迹都不剩。只是不往里塞 panels 而已。
  for (const spec of panelSpecs) {
    const anchor = bucket(spec.day);
    if (minimal) continue;
    const title = nameOfGame(spec.game, spec.appid);
    anchor.panels.push({
      kind: 'game', appid: spec.appid, game: spec.game, title,
      shots: spec.shots, count: spec.shots.length,
      titleMain: titleMainOf(title, spec.shots.length),
    });
  }

  const groups = [];
  for (const p of byDay.values()) {
    const unitsAll = p.events.map((e) => {
      const game = gameOf(e.game.appid);
      const color = e.type === 'purchase' || e.type === 'release'
        ? EV_COLOR[e.type]
        : themeOf(game);
      // 封盘帽压在「最后活动时点」那款游戏的 unit 上（07§4.9）
      const shelved = game.lifecycle === 'shelved'
        && (game.shelved_at || '').slice(0, 10) === e.date;
      // `at` = 当日第几分钟（后端 TimelineEvent.minutes，成就簇取该日最早一次解锁）。
      // 没有它就没法说「当天第一件事是什么」——出参按 (date, type) 排序落到手里，
      // 同一天里的先后是字符串序 + 数据库扫描顺序，是个任意值。
      return { type: e.type, color, xn: e.count > 1 ? e.count : null, shelved, game, day: e.date,
               at: Number.isFinite(e.minutes) ? e.minutes : null };
    });
    // 同一时点内把「看起来一样」的主题色拉开（05§3.4 去重）。取色失败的游戏全部回退到同一个
    // #6D4AE0——同天两款游戏首玩时轴上就是两个一模一样的紫色 play 图标。只对用主题色的类型做
    // （成就 / 首玩）；购买与发售是系统固定色，按 05§3.3 不参与个性化。
    // 截图 unit：与事件 unit 同构，接在后面。xn 只在多于一张时出现（与 ×N 的既有口径一致）
    for (const [key, list] of shotUnitShots) {
      const [day, appidStr] = key.split('|');
      if (day !== p.date) continue;
      const game = gameOf(Number(appidStr));
      if (!game) continue;
      // shots = 这一天的（决定 ×N 与命中区标题）；allShots / startAt = 点开灯箱时装的那一份。
      const all = shotsByGame.get(game.appid) ?? list;
      unitsAll.push({
        type: 'screenshot', color: themeOf(game), xn: list.length > 1 ? list.length : null,
        shelved: false, game, day: p.date, shots: list,
        allShots: all, startAt: gameShotIndex.get(list[0]?.shot_id) ?? 0,
        // 「截图的启动时间」= 这一天这款游戏**最早**那张的时刻
        at: list.reduce((m, s) => {
          const t = minuteOfIso(s.taken_at);
          return t === null ? m : (m === null ? t : Math.min(m, t));
        }, null),
      });
    }
    const themed = unitsAll.filter(
      (u) => u.type === 'achievement' || u.type === 'first_play' || u.type === 'screenshot');
    if (themed.length > 1) {
      const spread = dedupeThemeColors(themed.map((u) => u.color));
      themed.forEach((u, i) => { u.color = spread[i]; });
    }

    // 截图在轴上**只表达一次**（v3.20）：面板在画的时候，相机图标就不画。
    //
    // 非精简模式下，每一张截图都已经在轴下方铺出来了——对得上轴的进那天的 `kind:'day'` 面板，
    // 对不上轴的进按游戏收的 `kind:'game'` 面板（见上面两处 addShotUnit 的调用点，它们和
    // 面板是**同一批截图**）。轴上再放一个相机图标，是同一件事说两遍（05§0 规则 2），而且
    // 说得更差：图标只告诉你「有几张」，面板直接把图给你看。
    //
    // 精简模式是唯一的例外，而且是**必须**的例外：那时面板全藏，相机图标是这批截图在轴上
    // 唯一的入口（同 addShotUnit 那段注释）。删掉它，这些截图在轴上会连一点痕迹都不剩。
    //
    // 过滤的是 `units`（要画的那份），不是 `unitsAll`：封面「跟内容走」要按截图的启动时刻
    // 挑代表游戏（§4.2k 的 leadAppid），成就图标簇也从 unitsAll 数——那些都还得看得见截图。
    const shown = minimal ? unitsAll : unitsAll.filter((u) => u.type !== 'screenshot');
    const units = shown.slice(0, 3);
    const plus = shown.length > 3 ? shown.length - 3 : 0;
    const shots = p.shots;   // 主题色已在分流时补过，这里不再重复装饰
    // 首玩封面取的是 unitsAll 而不是被 slice 过的 units——一天开了 4 款新游戏时轴上会折成
    // 「3 个 + N」，但那一天的意义恰恰是这 4 张封面，不该因为轴上放不下就跟着丢。同 appid 只留一张。
    const seen = new Set();
    const covers = [];
    for (const u of unitsAll) {
      if (u.type !== 'first_play' || seen.has(u.game.appid)) continue;
      seen.add(u.game.appid);
      covers.push({ game: u.game, kind: 'first' });
    }
    // 回归封面：这一天是某款游戏的回归日，且它今天确实在轴上露了面
    for (const [appid] of activeDays) {
      if (!returnDays.has(`${appid}|${p.date}`) || seen.has(appid)) continue;
      const game = gameOf(appid);
      if (game) { seen.add(appid); covers.push({ game, kind: 'return' }); }
    }

    // 轴上的成就图标（07§4.2c）：这里只记「该画几个、拿哪个 (appid, day) 去取」，
    // 明细本身不塞进这一层——它走懒加载路由（07§4.5），滚到跟前才拉。
    const achUnits = unitsAll.filter((u) => u.type === 'achievement');
    // 成就图标簇**不跟着精简模式一起消失**（v3.21）。精简屏蔽的是截图，成就该不该显示由
    // 「隐藏成就」那个开关单独管——两个开关各管一件事才是正交的。原来把两者绑在一起，
    // 打开精简就等于同时关掉了成就，轴下方只剩一排封面：用户要的是「少看点截图」，
    // 拿到的却是「连成就也一起没了」。
    const achTotal = achUnits.reduce((sum, u) => sum + (u.xn ?? 1), 0);
    const achSources = achUnits.map((u) => ({ appid: u.game.appid, day: p.date }));

    // 封面跟着**这个时点摆出来的内容**走（07§4.2k）。
    //
    // 原来封面只由「首玩 / 回归」决定，和旁边摆的是谁无关：实测 305 个有封面的时点里，
    // 49 个的封面和当天的成就不是同一款、6 个和截图不是同一款——一张《A》的封面挨着一簇
    // 《B》的成就图标，读起来就是「这天我在玩 A」，而那是假的。
    //
    // 优先级：**成就 > 截图**。成就簇和封面并排在同一条媒体带里（§4.2c），挨得最近的那个
    // 必须先对上；截图在轴的另一侧。这条优先级不必再判开关——隐藏成就时成就事件根本没进
    // unitsAll（见上面的 hideAch 过滤），自然落到截图；精简模式只关截图、不动成就（v3.21），
    // 于是仍按成就算，也就是「都不显示时同上」。
    // 「首个」按**时刻**取，不按数组顺序：后端 raw.sort 的键是 (date, type)，同一天里
    // 成就与成就之间只剩数据库扫描顺序，拿它当「首次成就」是拿一个任意值当依据。
    const byAt = (a, b) => (a.at ?? 1e9) - (b.at ?? 1e9);
    const leadAppid = ([...achUnits].sort(byAt)[0]
      ?? unitsAll.filter((u) => u.type === 'screenshot').sort(byAt)[0])?.game.appid ?? null;
    // ⚠️ **只在这个时点本来就有封面时**才生效，不给没有封面的时点补一张：1203 个时点里
    // 1173 个有成就，补下去等于几乎每个时点都长出一张封面，轴要长 3~4 倍，精简模式也不再
    // 精简。封面仍然是「值得留一张图」的日子才有，这条规则只管**那张图该是谁**。
    if (leadAppid !== null && covers.length) {
      const at = covers.findIndex((c) => c.game.appid === leadAppid);
      if (at >= 0) {
        // 本来就有，只是排在里侧——媒体带里封面在前、成就簇在后，所以**最后一张**才是
        // 紧贴成就的那张，「对不对得上」看的就是它
        covers.push(covers.splice(at, 1)[0]);
      } else {
        const lead = gameOf(leadAppid);
        // 换的时候**只顶 `first`，绝不顶 `return`**：首玩那天轴上还有一枚 play 图标顶着，
        // 封面没了这件事仍在；而「封盘后重启」在这条轴上**只由封面那圈墨线表达**，没有
        // 对应的事件图标——顶掉它等于把这个信息从页面上整个抹掉。
        // 全是 return 就保持原样：宁可这一天封面对不上成就，也不删掉一个只此一处的事实。
        const at2 = covers.map((c, i) => (c.kind === 'return' ? -1 : i)).filter((i) => i >= 0).pop();
        if (lead && at2 !== undefined) {
          covers[at2] = { game: lead, kind: 'play' };
          covers.push(covers.splice(at2, 1)[0]);   // 换上来的这张也要挪到贴着成就那一端
        }
      }
    }

    // 对得上轴的截图也包一层同样的面板外壳（07§4.2d v3.5）：轴下方只剩「面板」一种东西，
    // 一天的和一款游戏的长得一样，只是标题不同。标题一律是游戏名——日期由轴的位置表达，
    // 写在标题里是同一个信息出现两次（05§0 规则 2）。
    const panels = [...(p.panels ?? [])];
    if (!minimal && shots.length) {
      const appids = [...new Set(shots.map((s) => s.appid))];
      const dayTitle = appids.map((id) => nameOfGame(gameOf(id), id)).join(' · ');
      panels.unshift({
        kind: 'day', title: dayTitle, shots, count: shots.length,
        game: gameOf(appids[0]),
        titleMain: titleMainOf(dayTitle, shots.length),
      });
    }
    if (!units.length && !panels.length && !covers.length && !shots.length) continue;
    groups.push({
      date: p.date, ts: dayToTs(p.date), units, plus, shots, covers, panels,
      achTotal, achSources,
      achColor: achUnits[0]?.color || FALLBACK_COLOR,
    });
  }
  return groups.sort((a, b) => a.ts - b.ts);
}


/* ---------------- 灯箱 ---------------- */

/** 一簇成就的沿轴长度（列数 × 32 + 间距）。 */
function achMainCells(cells) {
  const cols = achShape(cells, achCap).length;
  return cols ? cols * 32 + (cols - 1) * 6 : 0;
}

/** 一张截图 → 灯箱幻灯片。真图地址走 media.js 判断（`url` 字段并不保证是图片）。 */
function shotSlide(shot) {
  const color = shot.__color || FALLBACK_COLOR;
  const tint = `linear-gradient(135deg, ${lighten(color)}, ${color})`;
  return {
    key: `shot:${shot.shot_id}`,
    background: tint,
    tint,                       // 截图的 background 本来就只有底色，图全在 image 里
    image: shotImageUrl(shot),
    aspect: 16 / 9,
  };
}

/** 打开素材灯箱（截图 16:9 / 封面按素材比例），并挂上「设为页面背景」。 */
function openMedia(slides, index, stage, returnFocusTo, fit) {
  Lightbox.open({ slides, index, stage, returnFocusTo, fit, actions: [Backdrop.lightboxAction()] });
}

/* ---------------- 轴上方：unit / 封面 / 命中区 ---------------- */

function unitEl(u) {
  const wrap = document.createElement('div');
  wrap.className = 'event-unit';
  if (u.shelved) {
    const cap = document.createElement('div');
    cap.className = 'shelved-cap';
    wrap.appendChild(cap);
  }
  const iconRow = document.createElement('div');
  iconRow.className = 'icon-row';
  iconRow.style.color = u.color;
  iconRow.innerHTML = svg(EVENT_ICON[u.type]);
  if (u.xn) {
    const x = document.createElement('span');
    x.className = 'mono xn';
    x.style.color = u.color;
    x.textContent = `×${u.xn}`;
    iconRow.appendChild(x);
  }
  wrap.appendChild(iconRow);
  const dot = document.createElement('div');
  dot.className = 'dot';
  dot.style.background = u.color;
  wrap.appendChild(dot);
  return wrap;
}

const EVENT_LABEL = {
  purchase: '购买入库', first_play: '首次游玩', achievement: '成就解锁', release: '发售',
  screenshot: '截图',
};

/**
 * 轴标记侧的「媒体带」：开局封面 + 成就图标，并排成一条（07§4.2c）。
 * 两者共用一条带子而不是各挂各的，是因为它们回答的是同一个问题——**这一天留下了什么**。
 */
function renderMedia(g) {
  if (!g.covers?.length && !g.achAboveCells) return null;
  const band = document.createElement('div');
  band.className = 'media-band';
  if (g.covers?.length) {
    const cov = document.createElement('div');
    cov.className = 'fp-covers';
    g.covers.forEach((c) => cov.appendChild(fpCoverEl(c)));
    band.appendChild(cov);
  }
  if (g.achAboveCells) band.appendChild(achTilesEl(g, g.achAboveCells, 0, g.__achTiles));
  return band;
}

/**
 * 开局封面（07§4.2c）。两种 kind 共用一张封面，只用边框区分：
 *   · `first`  —— 首次游玩；
 *   · `return` —— 封盘后重启（粗深色边框）。
 * 都是「这条线在这里重新开始」，所以是同一种东西的两次发生，不该做成两个控件。
 *
 * v3.3 按要求去掉了封面上的游戏名缩写与左上角 play 角标：真封面本身就认得出是哪款游戏，
 * 角标和缩写在一张 76×114 的图上是纯噪声。没有真图时仍是主题色渐变，身份靠 title / aria。
 */
/**
 * 封面加载不出来时，**退到下一个变体**，而不是把主题色渐变当结果。
 *
 * `background-image` 加载失败是**静默**的：浏览器不报错、也没有 onerror，页面上只剩底下那层
 * 渐变，看着就像「这游戏没封面」。实测真实库 334 个竖版地址里 32 个（9.6%）是 404——它们是
 * 按 appid 拼的模板地址，而并非每个 app 都上传过 library capsule（未发售的新作和 2019 库改版
 * 之前的老游戏是两个重灾区）；这 32 款的横版 header_image **全部可用**，就在旁边没被用上。
 *
 * 根子在后端（`sync_service._resolve_cover_portrait` 已改成存之前先 HEAD，并有
 * `scripts/verify_cover_portrait.py` 回填既有数据）。这里是兜底：CDN 抖一下、或者哪天又冒出
 * 一个模板地址失效，也不至于悄悄退化成一块纯色。
 *
 * 换的只是**贴图**，不换尺寸——形态是坐标层算间距时就定死的输入（05§1.2），这时候改它会把
 * 整条轴的间距弄错。所以横版素材会被 `background-size: cover` 裁进竖版的框里：
 * 裁一张真图，也好过一块什么都没有的纯色。
 */
function fallbackWhenBroken(btn, variants) {
  const urls = variants.map((v) => v.image).filter(Boolean);
  if (urls.length < 2) return;   // 没有备胎就别费这个事
  let i = 0;
  const tryNext = () => {
    if (++i >= urls.length) return;   // 都挂了，剩下的渐变就是最后的结果
    const probe = new Image();
    probe.onload = () => {
      const v = variants.find((x) => x.image === urls[i]);
      btn.style.background = v.background;
      // 横版那一层看的是 --fp-img 而不是 background，换贴图时两处都得跟上
      if (btn.classList.contains('wide')) btn.style.setProperty('--fp-img', `url("${v.image}")`);
    };
    probe.onerror = tryNext;
    probe.src = urls[i];
  };
  const first = new Image();
  first.onerror = tryNext;
  first.src = urls[0];
}

/**
 * 把游戏名写进一张**没有任何真实素材**的封面格子里。
 *
 * 字号跟着格子高度走而不是写死：封面在窄视口下会等比缩到 34%（fpCoverScale），
 * 一个固定 10px 的字到那时会溢出格子、被 overflow:hidden 切成半行——比不写更糟。
 * 缩到装不下两行（约 6px 字）时干脆不写：一格 26×39 上的字已经不是信息，是脏点。
 *
 * @param {number} h 这一格的实际像素高（cover.h，已含缩放）
 */
const FP_NAME_MIN_H = 56;   // 低于这个高度就不写字了（≈ 76×114 缩到 50%）

function appendCoverName(btn, name, h) {
  if (!(h >= FP_NAME_MIN_H)) return;
  const box = document.createElement('span');
  box.className = 'fp-name';
  const text = document.createElement('span');
  // 11px 是 114px 高的格子上舒服的字号，缩放时等比跟着走，下限 8px 保证还认得出笔画
  text.style.fontSize = `${Math.max(8, Math.round(h * 0.097))}px`;
  text.textContent = name;
  box.appendChild(text);
  btn.appendChild(box);
}

function fpCoverEl(cover) {
  const { game, kind, shape } = cover;
  const variants = coverVariants(game);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `fp-cover ${shape === 'wide' ? 'wide' : 'portrait'}`
    + (kind === 'return' ? ' return' : '');
  // 尺寸按**这张素材自己的比例**来（见 lib/layout.js 的两种形态），所以 background-size:cover
  // 裁掉的只是几个像素的边，而不是把一张 460×215 的头图切成中间一条
  btn.style.cssText = `width:${cover.w}px;height:${cover.h}px;background:${variants[0].background};`;
  // 横版真图走「模糊底 + 清晰头图」的三层结构（见 styles.css .fp-cover.wide）：
  // 图交给 CSS 变量，两层都引它，换图时只改这一处。元素自身的 background 保留主题色渐变，
  // 是图加载完之前的底，和竖版一致。
  if (shape === 'wide' && variants[0].image) {
    btn.style.setProperty('--fp-img', `url("${variants[0].image}")`);
    const hdr = document.createElement('span');
    hdr.className = 'fp-hdr';
    btn.appendChild(hdr);
  }
  fallbackWhenBroken(btn, variants);
  // 边框用**这款游戏自己的主题色**（05§3.4）。后端没取到色时前端现算一次，算完就把这一枚
  // 的边框换过去（只动一个 CSS 变量，不重排）；同一张图只算一次，结果进缓存，
  // 下一次重建时连轴上的图标、截图占位一起用上（见 themeOf）。
  // 只接受 #RRGGBB：非法值写进 CSS 会被静默丢弃、边框悄悄回落到默认灰，且一行报错都没有
  const ring = ringOf(game);
  if (typeof ring === 'string' && /^#[0-9a-fA-F]{6}$/.test(ring)) {
    btn.style.setProperty('--fp-ring', ring);
  }
  const name = game.name_zh || game.name_en || `App ${game.appid}`;
  // 一张真图都没有 → 把游戏名写上去（样式与理由见 styles.css 的 .fp-cover .fp-name）。
  // 判据是 `real`：它由 coverVariants 决定，也就是「这一格现在是渐变还是图」的同一处真源。
  if (!variants[0].real) appendCoverName(btn, name, cover.h);
  // `play` = 这一天在玩（有成就 / 截图），不是首玩——**说法必须分开**，不然一张封面在替
  // 「首次游玩」作证，而那天根本没首玩。视觉上三种 kind 共用同一圈主题色环（那圈环表达的是
  // 「这款游戏的颜色」，不是 kind，见 07§4.2 v3.5），只有 `return` 额外加墨线。
  const what = kind === 'return'
    ? `封盘后重启（沉寂 ${RETURN_GAP_DAYS} 天以上后再次活动）`
    : (kind === 'play' ? '这一天在玩' : '首次游玩');
  btn.title = `${what} · ${name}`;
  btn.setAttribute('aria-label', `${what}：${name}，点击放大封面`);
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // 一款游戏的多张变体可能横竖混在一起（竖版海报 + 头图）。舞台按第一张的比例开，
    // 混合时用 contain 而不是 cover：封面是要看全的东西，宁可留黑边也不能裁掉一半。
    const mixed = new Set(variants.map((v) => v.shape)).size > 1;
    const stage = variants[0].shape === 'wide' ? { w: 720, h: 337 } : undefined;
    openMedia(variants, 0, stage, btn, mixed ? 'contain' : 'cover');
  });
  return btn;
}

/* ---- 轴上的成就图标（07§4.2c）---- */

let achTip = null;

const achPlaceholder = (color) => `linear-gradient(150deg, ${lighten(color, 0.3)}, ${color})`;

/**
 * 一个时点的成就图标组。**先建占位、不取数**——一屏几十个时点，进来就把成就明细全拉一遍
 * 会把懒加载路由（07§4.5 之所以把明细拆出去的理由）重新变成全量请求。
 * 真正的取数由 IntersectionObserver 在它进入视窗附近时触发。
 */
/**
 * 一簇成就图标，按**定形表**摆（07§4.2c v3.7）。
 * @param {object} g 时点组
 * @param {number} cells 这一簇几格
 * @param {number} from 这一簇的第一格在整个时点里的序号（上下两簇要接着编号）
 * @param {HTMLElement[]} sink 收集图标元素，供懒加载按序回填
 */
function achTilesEl(g, cells, from, sink) {
  const wrap = document.createElement('div');
  wrap.className = 'ach-tiles';
  const ph = achPlaceholder(g.achColor);
  let i = 0;
  for (const cnt of achShape(cells, achCap)) {
    const col = document.createElement('div');
    col.className = 'ach-col';
    for (let k = 0; k < cnt; k++, i++) {
      // `+N` 永远是整个时点的最后一格
      const last = g.achMore && from + i === g.achCells - 1;
      const t = document.createElement(last ? 'span' : 'div');
      t.className = last ? 'mono ach-more' : 'ach-tile';
      if (last) t.textContent = `+${g.achMore}`;
      // ⚠️ 只能写 backgroundImage，**不能写 background 简写**：简写会把 .ach-tile 里的
      // `background-size: cover` 和 `background-position: center` 一并重置成 auto / 0% 0%，
      // 而且是写在**行内**，之后再怎么改 backgroundImage 都盖不回来。64×64 的成就图于是
      // 按原尺寸铺在 32×32 的格子里、左上角对齐——页面上看到的是每张图的**左上四分之一**。
      // 一行报错都没有，图也确实「显示」了，只是显示的是一角（见 docs/前端开发规范 §4b-3）。
      else { t.style.backgroundImage = ph; sink.push(t); }
      col.appendChild(t);
    }
    wrap.appendChild(col);
  }
  return wrap;
}

async function fillAchTiles(g, tiles, ph) {
  let lists;
  try {
    lists = await Promise.all(g.achSources.map((s) => Panel.loadAchievements(s.appid, s.day)));
  } catch {
    return;   // 明细拉不到就保持占位色块：轴上少一张图标，不值得为它弹错
  }
  if (!tiles[0]?.isConnected) return;   // 期间重建过，这批节点已作废
  const all = lists.flat();
  tiles.forEach((t, i) => {
    const a = all[i];
    if (!a) return;
    // 真图叠在占位色块上（用 backgroundImage 而不是 background 简写，否则会把 size:cover 重置掉）
    if (a.icon_url) t.style.backgroundImage = `url("${a.icon_url}"), ${ph}`;
    t.classList.add('ready');
    t.addEventListener('mouseenter', () => showAchTip(t, a));
    t.addEventListener('mouseleave', hideAchTip);
    t.title = a.display_name || a.achievement_id;
  });
}

/** 悬停读数：成就名 + 解锁时刻（+ 全球解锁率）。 */
function showAchTip(el, a) {
  if (!achTip) {
    achTip = document.createElement('div');
    achTip.className = 'ach-tip';
    els.body.appendChild(achTip);
  }
  achTip.innerHTML = '';
  const name = document.createElement('div');
  name.className = 'n';
  name.textContent = a.display_name || a.achievement_id;
  const meta = document.createElement('div');
  meta.className = 'mono m';
  const when = String(a.unlocktime).replace('T', ' ').slice(0, 16);
  meta.textContent = when
    + (typeof a.global_percent === 'number' ? ` · 全球 ${a.global_percent.toFixed(1)}%` : '');
  achTip.append(name, meta);
  achTip.hidden = false;

  const r = el.getBoundingClientRect();
  const b = els.body.getBoundingClientRect();
  const w = achTip.offsetWidth;
  const h = achTip.offsetHeight;
  let top = r.top - b.top - h - 8;
  if (top < 4) top = r.bottom - b.top + 8;          // 顶不下就翻到下面
  const left = r.left - b.left + r.width / 2 - w / 2;
  achTip.style.left = `${Math.min(Math.max(4, left), els.body.clientWidth - w - 4)}px`;
  achTip.style.top = `${top}px`;
}

function hideAchTip() {
  if (achTip) achTip.hidden = true;
}

/* ---------------- 时点组 ---------------- */

function renderGroup(g) {
  const p = g.p;
  const off = markOffset(g.stem, g);
  // 上下两簇的图标要按同一串序号回填明细，所以收集器建在这里、两边共用
  g.__achTiles = [];
  // 返回那次取数的 promise（视窗内的懒加载不管它，导出长图要**等它落地**才能开拍）
  g.__fill = () => {
    if (g.__done || !g.__achTiles.length) return null;
    g.__done = true;
    return fillAchTiles(g, g.__achTiles, achPlaceholder(g.achColor));
  };

  // 组本身锚在**轴线上**、朝标记侧长出去（CSS 里 translate(-100%)），所以不需要知道
  // 它连封面在内一共有多高——加不加封面、封面多大都不影响这一句。
  const el = document.createElement('div');
  el.className = 'event-group';
  // 换边整块交给 CSS：反向 flex + 反向 transform，DOM 顺序一个字都不用改（07§4.2h）
  if (g.side) el.dataset.side = '1';
  setPos(el, p, 0);

  const media = renderMedia(g);
  if (media) {
    // 有封面的组，媒体带**脱离标记块的流**，直接钉在距轴 coverPin + 8 处（07§4.2i）。
    // 跟着流走的话，引线分档、×N 实际字宽这些与封面无关的东西都会把它顶歪。
    if (g.covers?.length) {
      media.classList.add('pinned');
      media.style.setProperty('--fp-pin', `${coverPin + FP_GAP}px`);
    }
    el.appendChild(media);
  }

  const unitsRow = document.createElement('div');
  unitsRow.className = 'event-units';
  g.units.forEach((u) => unitsRow.appendChild(unitEl(u)));
  if (g.plus) {
    const plus = document.createElement('span');
    plus.className = 'mono event-plus';
    plus.textContent = `+${g.plus}`;
    unitsRow.appendChild(plus);
  }
  el.appendChild(unitsRow);

  const stem = document.createElement('div');
  stem.className = 'stem-line';
  if (V()) stem.style.width = `${g.stem}px`;
  else stem.style.height = `${g.stem}px`;
  el.appendChild(stem);

  const gm = groupMain(g);
  const hit = document.createElement('div');
  // 有 unit 的组，悬浮交给**逐 ICON 的格子**（见下），命中区自己不再整块变色；
  // 只有截图面板锚点这种「轴上没有 unit」的组才退回整块响应。
  hit.className = 'hit-region' + (g.units.length ? '' : ' whole');
  // 命中区跟着组走：换过边就把这段区间关于轴线镜像过去
  setPos(hit, p, g.side ? off + 8 - HIT_HEIGHT : -(off + 8));
  setSize(hit, gm + HIT_PAD, HIT_HEIGHT);
  // 离开整条命中区才收 panel：格子之间来回移动不算离开，否则每换一个 ICON 都要闪一下
  hit.addEventListener('mouseleave', () => Panel.hide());
  if (!g.units.length) hit.addEventListener('mouseenter', () => onHoverGroup(g));
  els.track.appendChild(hit);

  // 逐 ICON 的命中格（07§4.8 v3.14）。一格对一个 unit，**沿轴按中点切分、铺满整条命中区**：
  //   · 悬浮——只有指针底下那一格变色，panel 也只说那一款游戏。原先是整条命中区一起变色、
  //     内容也是整天，一天三个 ICON 就三个一起亮，可用户想指的只有一个：看到的和能操作
  //     的对不上（05§0 规则 3：界面上出现的每一个反馈都要能对应到一个具体对象）。
  //   · 点击——只有截图格有（07§4.2g）：精简模式下轴下方的面板全藏了，相机图标是那批截图
  //     在轴上唯一的入口，不给它点击等于把内容锁死。其余格子只管悬浮，光标保持默认。
  //
  // 按中点切分，不给各自固定宽度：固定宽度要么互相压住（瞄左边那个的右缘却命中右边的，
  // 表现就是「hover / 点击不响应」），要么留下缝隙——缝隙里既不高亮也不出 panel，
  // 是一块解释不清的死区。切分后每一个像素都恰好属于一个 ICON。
  //
  // v3.9 去掉了粗粒度缩放下的「点 ICON 出日期读数」。它当初的理由是「组级面板读不出单个
  // 事件是哪天」，但**时点组本来就是按天分的**——一组里所有 ICON 同属一天，读数条写的
  // `group.date` 和悬浮面板写的是同一个日期，封面也是同一张。也就是说它给的信息是悬浮
  // 面板的真子集，却自带一条引线：那条线和这一组本来的 `.stem-line` 并排画在一起，
  // 同一个时点被两条线指着，读起来像是两件事。同一件事只留一个说法（05§0 规则 2）。
  // df-hit 作为 hit-region 的**子元素**，这样格子之间移动不会被判成离开整组。
  if (g.units.length) {
    const centers = unitCenters(g);
    const span = gm + HIT_PAD;
    const inGroup = centers.map((c) => c + span / 2);
    const edges = [0, ...inGroup.slice(1).map((c, i) => (inGroup[i] + c) / 2), span];
    g.units.forEach((u, i) => {
      const isShot = u.type === 'screenshot' && u.shots?.length > 0;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'df-hit' + (isShot ? ' shot-hit' : ' hover-only');
      const cellMain = edges[i + 1] - edges[i];
      const cellCenter = (edges[i] + edges[i + 1]) / 2;
      if (V()) { btn.style.top = `${cellCenter}px`; btn.style.left = '2px'; btn.style.height = `${cellMain}px`; }
      else { btn.style.left = `${cellCenter}px`; btn.style.top = '2px'; btn.style.width = `${cellMain}px`; }
      // 这一格在轨道坐标系里的沿轴中心：hit 的左边缘是 `g.p - span/2`（它带 translate(-50%)），
      // cellCenter 是格心相对那条边的偏移。panel 就落在这里。
      const cellAt = g.p - span / 2 + cellCenter;
      btn.addEventListener('mouseenter', () => onHoverUnit(g, u, cellAt));
      const name = u.game.name_zh || u.game.name_en || `App ${u.game.appid}`;

      if (!isShot) {
        btn.title = `${name} · ${EVENT_LABEL[u.type] ?? u.type} · ${g.date}`;
        btn.setAttribute('aria-label', btn.title);
        hit.appendChild(btn);
        return;
      }
      // 灯箱装整款游戏的全部截图（见 buildGroups 里 shotsByGame 的注释），所以提示得说清
      // 「点开会看到多少」——不然点一个写着「1 张」的图标却翻出 29 张，是提示在骗人。
      const all = u.allShots ?? u.shots;
      const more = all.length > u.shots.length ? ` / 全部 ${all.length} 张` : '';
      btn.title = `${name} · ${g.date} ${u.shots.length} 张${more}｜点击查看`;
      btn.setAttribute('aria-label',
        `${name} ${g.date} 的 ${u.shots.length} 张截图${more ? `，可翻看该游戏全部 ${all.length} 张` : ''}，点击查看`);
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        Panel.hideImmediately();
        openMedia(all.map(shotSlide), u.startAt ?? 0, SHOT_STAGE, btn);
      });
      hit.appendChild(btn);
    });
  }

  const below = renderBelow(g);
  if (below) els.track.appendChild(below);
  return el;
}

/**
 * 量一段文字有多宽（07§4.2j-2）。
 *
 * 面板要「宽到能把标题写全」，而这个宽度是**坐标层算间距的输入**（05§1.2），所以必须在渲染
 * 之前就知道——不能等 DOM 出来再量，那时间距已经定死了。canvas 的 measureText 不进 DOM、
 * 不触发排版，字体串与 CSS 里那两条**逐字段对齐**（对不上就会量出一个和实际不符的宽度，
 * 而这种偏差是静默的：只表现为标题偶尔多一个省略号或者面板莫名宽一截）。
 */
const TEXT_FONT = {
  title: '500 13.5px "Noto Sans SC", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif',
  count: '400 11px "JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
};
const textCache = new Map();
let textCtx = null;
function measureText(text, kind) {
  const key = `${kind}|${text}`;
  const hit = textCache.get(key);
  if (hit !== undefined) return hit;
  if (!textCtx) textCtx = document.createElement('canvas').getContext('2d');
  textCtx.font = TEXT_FONT[kind];
  const w = Math.ceil(textCtx.measureText(text).width);
  textCache.set(key, w);
  return w;
}

/** 一块面板的标题要求它至少多长（张数按钮在的话，两侧要留等宽的量，标题才居中）。 */
function titleMainOf(title, count) {
  const countW = count > SHOT_PANEL_MAX ? measureText(`${count} 张`, 'count') + 8 : 0;
  return panelTitleMain(measureText(title, 'title'), countW);
}

/** 轴**截图侧**：当日截图列 + 截图面板，整块以时点为中心沿轴居中（07§4.2 / §4.2d）。 */
function renderBelow(g) {
  if (!g.panels?.length && !g.achBelowCells) return null;
  const wrap = document.createElement('div');
  wrap.className = 'below-stack';
  setPos(wrap, g.p, SHOT_TOP_OFFSET);
  // 成就簇排在面板之前：它离时点中心更近，读起来仍是「这一天的事」
  if (g.achBelowCells) {
    wrap.appendChild(achTilesEl(g, g.achBelowCells, g.achAboveCells, g.__achTiles));
  }
  for (const p of g.panels ?? []) wrap.appendChild(shotPanelEl(p));
  return wrap;
}

/** 一组缩略图切成列。列内沿垂轴叠、列间沿时间轴排（方向由 CSS 决定）。 */
function shotColumnsEl(shots, cap, all = shots, cols = 0) {
  const frag = document.createElement('div');
  frag.className = 'shot-cols';
  const { columns } = layoutShotColumns(shots, cap, cols);
  let flat = 0;
  for (const col of columns) {
    const colEl = document.createElement('div');
    colEl.className = 'shot-column';
    for (const shot of col) {
      colEl.appendChild(shotEl(shot, all, all.indexOf(shot)));
      flat += 1;
    }
    frag.appendChild(colEl);
  }
  void flat;
  return frag;
}

/**
 * 游戏截图面板（07§4.2d）：对不上轴、但数量够多的那些截图，按游戏收成一块，标题写游戏名。
 *
 * 它仍然是**时点**（锚在这些截图的中位日期上），只是内容从「那天的截图」换成
 * 「这款游戏这些说不出对应事件的截图」——所以标题必须是游戏名而不是日期，
 * 副标题给跨度和张数，把「这不是某一天的事」说清楚。
 */
function shotPanelEl(p) {
  const wrap = document.createElement('div');
  wrap.className = 'shot-panel';
  const name = p.title ?? nameOfGame(p.game, p.appid);
  const from = p.shots[0].taken_at.slice(0, 10);
  const to = p.shots[p.shots.length - 1].taken_at.slice(0, 10);

  // 沿轴尺寸**写死成 layout 算出来的那个值**：标题是游戏名，长度不可控，让它撑开容器
  // 就会和喂给坐标层的占位对不上，相邻时点随之压到一起。标题超出宽度就省略号。
  // 角标用游戏主题色；日面板取当天第一款游戏的色（标题里它也排在第一个）。
  // 只接受 #RRGGBB：非法值写进 CSS 会被静默丢弃，角标悄悄回落到默认灰且一行报错都没有。
  const ring = ringOf(p.game);
  if (typeof ring === 'string' && /^#[0-9a-fA-F]{6}$/.test(ring)) {
    wrap.style.setProperty('--sp-ring', ring);
  }
  const titleMain = p.titleMain ?? 0;
  const { cols, main, shown } = panelGrid(p.count, panelCap, titleMain);
  // 摆得下几张由 panelGrid 说了算（它同时夹了列上限与垂轴容量），这里不再自己算一遍。
  // ⚠️ 标题那侧的 countW 判据（titleMainOf）用的仍是 `count > SHOT_PANEL_MAX`：它在
  // buildGroups 里算，那时 panelCap 还没测出来，拿不到 shown。窗口矮到 shown < 12 时，
  // 张数按钮会出现而标题没给它预留位置——代价是标题早一点变省略号，不是溢出。
  const hidden = p.count - shown;
  // 竖排下标题横在垂轴上：那个方向不进坐标层的间距约束，够写就行，夹进剩下的厚度里
  if (V()) {
    const need = panelCrossMin(titleMain, bodyCross() - axisCross);
    if (need > 0) wrap.style.minWidth = `${need}px`;
  }
  if (V()) wrap.style.height = `${main}px`;
  else wrap.style.width = `${main}px`;

  const head = document.createElement('div');
  head.className = 'sp-head';
  const title = document.createElement('span');
  title.className = 'sp-title';
  title.textContent = name;
  title.title = name;
  head.appendChild(title);
  // 张数按钮**只在装不下时才出**：它的作用是「看全部」，全都摆在眼前时它没有信息，
  // 只会把本来就窄的标题再挤掉一截。
  if (hidden > 0) {
    const count = document.createElement('button');
    count.type = 'button';
    count.className = 'mono sp-count';
    count.textContent = `${p.count} 张`;
    count.title = `${name} · ${from} → ${to}｜点击看全部 ${p.count} 张`;
    count.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openMedia(p.shots.map(shotSlide), 0, SHOT_STAGE, count);
    });
    head.appendChild(count);
    // 左侧塞一个同字的隐形替身，两侧那格就一样宽，标题才是真的居中（见 styles.css .sp-head）
    const ghost = document.createElement('span');
    ghost.className = 'mono sp-count sp-count-ghost';
    ghost.textContent = count.textContent;
    ghost.setAttribute('aria-hidden', 'true');
    head.insertBefore(ghost, head.firstChild);
  }
  head.title = p.kind === 'game'
    ? `${name} · ${p.count} 张 · ${from} → ${to}｜这些截图在轴上找不到对应事件，按游戏归到一起`
    : `${name} · ${p.count} 张 · ${from}`;
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'sp-body';
  body.appendChild(shotColumnsEl(p.shots.slice(0, shown), panelCap, p.shots, cols));
  wrap.appendChild(body);
  return wrap;
}

/** 一张缩略图：点击进灯箱看大图（P-12「看更多与原图」），灯箱里可钉成整页背景。 */
function shotEl(shot, allShots, index) {
  const s = document.createElement('button');
  s.type = 'button';
  s.className = 'shot';
  // 主题色渐变是**占位**（05§5 封面占位规则），真图叠在它上面。
  // 用 backgroundImage 而不是 background 简写——后者会把 CSS 里的 background-size:cover
  // 一并重置成 auto，图会按原始尺寸平铺。
  const color = shot.__color || FALLBACK_COLOR;
  const placeholder = `linear-gradient(135deg, ${lighten(color)}, ${color})`;
  const thumb = shotImageUrl(shot);
  s.style.backgroundImage = thumb ? `url("${thumb}"), ${placeholder}` : placeholder;
  const game = dataset?.gamesByAppid.get(shot.appid);
  const name = game?.name_zh || game?.name_en || `App ${shot.appid}`;
  const when = String(shot.taken_at).replace('T', ' ').slice(0, 16);
  s.title = shot.caption ? `${name} · ${when}\n${shot.caption}` : `${name} · ${when}`;
  s.setAttribute('aria-label', `截图：${name} ${when}，点击放大`);
  s.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openMedia(allShots.map(shotSlide), index, SHOT_STAGE, s);
  });
  return s;
}

/**
 * 轴的起点标（07§4.2b）：在最早的那个时点上立一道横跨轴线的短帽，旁边挂一枚
 * 「START · YYYY-MM-DD」的牌子。
 *
 * 文案与排版**跟 TODAY 标同一套**（v3.17）：两端是同一件东西的两头，一头写中文「首次使用」、
 * 另一头写记号体的 TODAY，读起来像两个不相干的部件。改成同形之后，区分它们的只剩颜色——
 * 而颜色本来就是这条轴上「今天」的专属语汇（05§6 第 7 条）。日期的口径写在 title 里。
 *
 * 口径说明（写在这里是因为容易被误解）：这个日期是**轴上最早的一条记录**，通常是第一笔
 * 购买入库或第一次游玩，**不是 Steam 账号创建日**——后者要 `GetPlayerSummaries.timecreated`，
 * 后端目前不取，库里的 `users.created_at` 是「本应用首次同步该用户」的时间，不能拿来充数。
 * 它也会随「隐藏从未启动的游戏」开关变化，因为那开关本来就会改变轴上有哪些点（07§4.9）。
 *
 * 牌子挂在**起点之前**的留白里，让开的是第一组**内容的沿轴边缘**（不是它的中心）：
 * 牌子横跨轴线，轴两侧的封面和面板它都躲不开，只能沿轴退到整组之外（见 END_FLAG_CLEAR）。
 * 那段留白由 START_LEAD + 该组占位一起通过 minPx 预留出来。
 */
function renderStartMark(g) {
  // 端帽：横跨轴线的一道短竖线，像尺子上的「0」。**不用圆点**——圆点在这条轴上是事件色点
  // 的语汇（.dot），拿来当起点会读成「这天有个事件」。
  const cap = document.createElement('div');
  cap.className = 'start-cap';
  setPos(cap, g.p, -10);
  setSize(cap, 2, 20);
  els.track.appendChild(cap);

  // 标签落在**轴线的延长线上**（垂轴方向居中于轴线、沿轴方向排在端帽之前），
  // 于是它读起来是「这条线从这里开始」，而不是「轴边上贴了张便签」。
  // 两个方向都是同一条规则，竖排下也就不会再歪到一侧去。
  const flag = document.createElement('div');
  flag.className = 'start-flag';
  setPos(flag, g.p, 0);
  const label = document.createElement('span');
  label.className = 'sf-label';
  label.textContent = 'START';
  const date = document.createElement('span');
  date.className = 'mono sf-date';
  date.textContent = g.date;
  flag.append(label, date);
  els.track.appendChild(flag);
  // 沿轴方向的落点**量完真实宽度再定**，并夹在轨道原点之内。
  // 靠 translate(-100%) 的话，位置全看 START_LEAD 猜得准不准——日期格式一变长、
  // 换个字体、换种语言，标签就会被轨道起点裁掉半截，而且是静默的。
  const size = V() ? flag.offsetHeight : flag.offsetWidth;
  // 退到**第一组内容的边缘**之外，而不是它的中心：那一组的封面 / 面板沿轴伸出去半个身位，
  // 只让开 12px 的话，竖排下牌子正好压在封面上（横跨轴线，没有「挪到另一侧」这条退路）。
  const edge = g.p - groupFootprint(g, panelCap) / 2;
  const pos = Math.max(4, edge - END_FLAG_CLEAR - size);
  if (V()) flag.style.top = `${pos}px`;
  else flag.style.left = `${pos}px`;
  const kinds = [...new Set(g.units.map((u) => EVENT_LABEL[u.type] ?? u.type))];
  flag.title = `起点 — 轴上最早的一条记录：${g.date}`
    + (kinds.length ? `（${kinds.join(' · ')}）` : '（仅截图）')
    + '\n不是 Steam 账号创建日';
}

/**
 * 「今天」标。与起点标（renderStartMark）是**同一件东西的另一端**，所以用同一套构造：
 * 一道跨轴线的端帽 + 一枚落在轴线延长线上的标签，只是颜色换成 accent、方向朝末端。
 *
 * 原来轴上根本没有「今天」——只有当某个刻度**恰好落在今天那一天**时，那枚刻度才会染成
 * accent（`.tick-mark.today`）。而刻度是按月 / 按周落的，绝大多数时候今天不在刻度上，
 * 于是整条轴没有任何地方说明「现在在哪」：末端那一截空白既可能是今天，也可能只是没数据。
 * 而这条轴的默认视窗就停在这一端，是最常看的一段。
 */
function renderNowMark(totalMain, groups = []) {
  const p = currentScale(NOW);
  const cap = document.createElement('div');
  cap.className = 'now-cap';
  setPos(cap, p, -10);
  setSize(cap, 2, 20);
  els.track.appendChild(cap);

  const flag = document.createElement('div');
  flag.className = 'now-flag';
  setPos(flag, p, 0);
  const label = document.createElement('span');
  label.className = 'nf-label';
  label.textContent = 'TODAY';
  const date = document.createElement('span');
  date.className = 'mono nf-date';
  // 与 dayToTs / isToday 同基准（UTC 日），否则跨时区时标签写的日期会和它钉住的位置差一天
  date.textContent = new Date(NOW * 1000).toISOString().slice(0, 10);
  flag.append(label, date);
  flag.title = `今天：${date.textContent}`;
  els.track.appendChild(flag);
  // 标签排在端帽**之后**（朝轴的末端），位置由 END_LEAD 预留出来。
  // 落点量完真实尺寸再定并**夹在轨道末端之内**，理由同 renderStartMark：不靠 translate 猜。
  // 日期格式一变长、换个字体，标签就会被轨道末端裁掉半截，而且是静默的。
  const size = V() ? flag.offsetHeight : flag.offsetWidth;
  // 同 renderStartMark：让开的是**内容的边缘**。只看今天之前的那些组——今天之后也可能有组
  // （未来的发售日），拿它去推 TODAY 标会把标推离它自己指的那一天。
  const before = groups.filter((g) => g.p <= p);
  const edge = before.length
    ? Math.max(p, ...before.map((g) => g.p + groupFootprint(g, panelCap) / 2))
    : p;
  const pos = Math.min(edge + END_FLAG_CLEAR, Math.max(p, totalMain - size - 6));
  if (V()) flag.style.top = `${pos}px`;
  else flag.style.left = `${pos}px`;
}

/**
 * 悬浮一个 ICON（07§4.8 v3.14）。
 *
 * 收敛到**这一款游戏在这一天**：指针指着谁就说谁。原先无论指哪个 ICON 都出整天的 panel，
 * 而整条命中区又一起变色——一天三个 ICON 时三个一起亮、内容也是三款混在一起，
 * 「我指的到底是哪一个」这件事在界面上根本没有答案。
 *
 * 同一款游戏那天的**其它事件仍然一起列出**（购买 + 首玩常在同一天）：一格代表的是一款游戏，
 * 不是一条事件，把同一款的另一条藏起来只会让人以为它没发生。
 *
 * 但**用哪种形态**由指针底下那一格自己决定（v3.18）：指着成就就出成就明细。见 onHoverGroup。
 */
function onHoverUnit(g, u, mainAt) {
  const appid = u.game?.appid;
  const same = g.units.filter((x) => x.game?.appid === appid);
  onHoverGroup(g, same.length ? same : [u], `${g.date}|${appid ?? 'x'}`, u, mainAt);
}

/**
 * @param {object} [hovered] 指针底下那一个 unit（逐 ICON 悬浮时给）。**形态由它决定**，
 *   不由这一组的构成决定——见下面 isPureAch 的注释。
 * @param {number} [mainAt] 指针那一格在轨道坐标系里的沿轴中心。**panel 的落点由它决定**
 *   （v3.20）：一天三个 ICON 时，panel 原来一律弹在整组中心——指第三格却在中间冒出来，
 *   「看到的和指的对不上」。取的是**那一格的中心**而不是指针的精确像素：mouseenter 只在
 *   跨进边界那一刻触发一次，用鼠标坐标的话，同一格从左边进和从右边进会差半格宽，panel
 *   跟着左右跳。不给就退回整组中心（`.hit-region.whole` 那种分不出格子的组）。
 */
function onHoverGroup(g, units = g.units, key = g.date, hovered = null, mainAt = null) {
  hoveringGroupKey = key;
  setTimeout(() => {
    if (hoveringGroupKey !== key) return; // 120ms 内已移开，取消渲染（07§4.8）
    // 成就形态用于「纯成就簇」：组内每个 unit 都是成就且都未封盘。封盘游戏即便当时只有成就
    // 事件，也仍用游戏形态展示封盘标 + 判定依据（07§4.9 / D-16）。
    //
    // ⚠️ 逐 ICON 悬浮时（v3.18）形态**必须由指针底下那一格定**，不能由这一组的构成定：
    // 同一天同一款游戏既首玩又解了成就时，`units` 里两条都在，「全是成就」不成立，于是指着
    // 成就图标弹出来的是首玩信息——**看到的和指的不是一件事**（同 §4.8 那条逐 ICON 的理由）。
    // 一格代表一款游戏，所以另一条事件仍列在游戏形态的事件行里；但指成就就得给成就明细。
    const achUnits = units.filter((u) => u.type === 'achievement' && !u.shelved);
    const isPureAch = hovered
      ? hovered.type === 'achievement' && !hovered.shelved
      : units.length > 0 && achUnits.length === units.length;
    // panel 在垂轴方向要占多厚：横排是它的高（内容决定），竖排是它的宽（恒 320）。
    // 只用来给它让位，沿轴的居中交给 Panel.show() 按实测尺寸算——成就形态的高度取决于
    // 当天实际加载出几行，标称值算出来会偏。
    const panelCross = V() ? PANEL_W : (isPureAch ? ACH_PANEL_H : GAME_PANEL_H);
    // panel 要贴在这一组**最外侧**内容之外——有封面时最外侧是封面，不是图标
    // 同一天可能既有竖版又有横版封面，让位要按**最厚的那张**算
    // 封面已经统一对齐到 coverPin，让位就得按那条线算，不能再按这一组自己的引线算
    const outer = g.covers?.length
      ? Math.max(coverPin, markOffset(g.stem, g)) + FP_GAP
        + Math.max(...g.covers.map((c) => fpCrossOf(c)))
      : markOffset(g.stem, g);
    // 换过边的组，panel 也要跟到对侧去，否则会压在标记侧的内容上
    const cross = g.side
      ? panelCrossPosBelow(outer, axisCross, bodyCross(), panelCross)
      : panelCrossPos(outer, axisCross, panelCross);
    // panel 挂在 #panel-root（不随轨道平移）上，沿轴锚点必须换算成视口内坐标。
    // 沿轴落在**指针那一格**上（v3.20，见 mainAt）；垂轴仍按整组最外侧内容让位——
    // panel 可以跟着指针走，但不能因此压到它正在解释的那些封面和图标上。
    const place = { cross, mainCenter: (mainAt ?? g.p) - state.offset, vertical: V() };

    if (isPureAch) {
      Panel.show({
        form: 'achievement', ...place,
        games: achUnits.map((u) => ({ game: u.game, xn: u.xn ?? 1 })),
        date: g.date, day: g.date,
      });
    } else {
      // 07§4.5：仅有截图的日期同样是时点，轴上方没有 unit——此时游戏取自截图，事件行为空
      const primary = units[0];
      const game = primary?.game
        ?? dataset?.gamesByAppid.get(g.shots[0]?.appid)
        ?? g.panels?.[0]?.game;
      if (!game) return;
      const shelfInfo = primary?.shelved
        ? { days: game.play_days_count, unlocked: game.ach_unlocked, total: game.ach_total }
        : null;
      Panel.show({
        form: 'game', ...place, game, date: g.date, day: g.date,
        // 事件行的时刻不在 /calendar/timeline 出参里（date 只到日），由 panel 懒加载
        // /calendar/day/{date} 的 rows[].time 补齐——三套环境同一路径。
        rows: units.map((x) => ({ type: x.type, color: x.color, xn: x.xn, appid: x.game.appid })),
        shelfInfo,
      });
    }
  }, 120);
}

/* ---------------- 刻度文案 ---------------- */

const MON = (d) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
const pad = (n) => String(n).padStart(2, '0');

function monthLabel(t) {
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}`;
}

/**
 * 主刻度：月首 / 年首那几枚（07§4.6 v3.19「刻度分主次」）。
 *
 * 主刻度**不从次刻度里挑**，而是单独生成。周粒度下刻度落在周一，「进入 8 月的第一枚刻度」
 * 是 8 月 1 日之后的某个周一，跟着周对齐左右漂最多 6 天；单独生成就正好落在 1 号——这条线
 * 说的是「8 月从这里开始」，那它就该在 8 月开始的地方。全景导航条的年分隔线也是这么生成的。
 *
 * 文案一律写全年份。轴上原来只有 1 月那枚才带年（`AUG` / `AUG 24` 是多数），滚到十年中间
 * 根本读不出是哪一年——头部读数报的是**视窗中点**，不是你正指着的这一处。
 * @param {{unit:string, step:number}} spec 当前次刻度粒度，决定主刻度退到月还是退到年
 * @returns {{t:number, text:string}[]} 已按时间升序
 */
function majorTicks(spec, d0, d1) {
  const out = [];
  const byYear = spec.unit === 'month' || spec.unit === 'year';
  const y0 = new Date(d0 * 1000).getUTCFullYear();
  const y1 = new Date(d1 * 1000).getUTCFullYear();
  for (let y = y0; y <= y1; y++) {
    if (byYear) out.push({ t: Date.UTC(y, 0, 1) / 1000, text: String(y) });
    else for (let m = 0; m < 12; m++) out.push({ t: Date.UTC(y, m, 1) / 1000, text: `${y}.${pad(m + 1)}` });
  }
  return out.filter((x) => x.t >= d0 && x.t <= d1);
}

/** 刻度文案跟着**粒度**走，不跟着档位走——档位已经没有了（07§4.6 v3.2）。 */
function tickText(t, spec) {
  const d = new Date(t * 1000);
  if (spec.unit === 'day') return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (spec.unit === 'week') return `${MON(d)} ${pad(d.getUTCDate())}`;
  // 月粒度下 1 月直接写年份：跨年是这个尺度上唯一需要一眼认出的边界
  if (spec.unit === 'month') return d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : MON(d);
  return String(d.getUTCFullYear());
}

/* ---------------- 度量与重建 ---------------- */

/**
 * 重算垂轴度量并把轴线位置写进主体区的 `--axis-c`。
 *
 * 这是「视口变化时重新排布」的整个机制：轴线在垂轴方向居中（05§1.1），而轴两侧的标记、
 * 引线、封面、读数条、截图**距轴线的偏移都是常量**，所以它们一律用 `calc(var(--axis-c) ± N)`
 * 定位——改这一个变量就等于整页重排，零 DOM 遍历、零重建。
 *
 * 唯一改这个变量还不够的情况是**每列截图张数或封面尺寸变了**：它们决定组的沿轴占位，
 * 而占位是坐标层的间距输入（05§1.2），那才需要走一次完整重建。所以这里只**返回**新值，
 * 由调用方判断有没有变，别顺手在这里赋值。
 * @returns {{cap:number, cover:{w:number,h:number}}}
 */
function measureCross() {
  const cross = bodyCross();
  axisCross = axisCrossFor(cross);
  els.body.style.setProperty('--axis-c', `${axisCross}px`);

  // 导航条是 chrome，首玩封面是内容，**空间不够时让 chrome 走**。
  // v3.2 把封面挪到轴的标记侧之后，标记侧要占 引线64 + 7 + 标记25 + 8 + 封面114 = 218；
  // 1440×900 基准下轴线在 385，封面顶端落在 167，离导航条下沿（18+56）还有 93px 的空。
  // 但窗口一矮（620 高时轴线只有 245），封面顶端会顶到 27，整块压进导航条那一带——
  // 靠 z-index 让封面画在上面只是遮住问题，看着仍是一团。所以够不到才显示它。
  const outerFull = markOffset(STEM_BASE, { units: [] }) + FP_GAP + fpCrossMax();
  railSuppressed = axisCross - outerFull < RAIL_CLEAR;
  Overview.setVisible(showOverview && !railSuppressed && cross >= 340 && bodyMain() >= 420);
  paintOverviewBtn();

  const belowAvail = cross - axisCross;
  const bandAvail = axisCross - markOffset(STEM_BASE, { units: [] }) - FP_GAP - 8;
  return {
    panelCap: shotsPerColumn(belowAvail - panelChromeCross()),
    achCap: achPerColumn(bandAvail),
    // 封面能有多大，看的是「标记块外沿到主体区边缘还剩多厚」
    scale: fpCoverScale(bandAvail),
    // 跨轴交错只在精简模式下开，且要求封面还是原尺寸、对侧真的放得下一整组（引线+图标+封面）。
    // 视口一挤就该老老实实排一侧，不能为了交错把封面缩了或顶出主体区。
    // 交错（07§4.2h）要求**对侧真的空着**：它把整组连封面一起挪过去，靠的是那边没有别的东西。
    // v3.21 起精简模式不再关掉成就簇，而成就簇有一部分就落在对侧（splitAchAcrossAxis），
    // 所以换边的前提改成「两个开关都开」——只开精简时对侧还站着成就，不能再当它是空的。
    stagger: minimal && hideAch && fpCoverScale(bandAvail) === 1 && belowAvail >= flipNeedCross(),
  };
}

/** 换到对侧的一组要占多厚：引线 + 图标 + 间隙 + 封面。 */
function flipNeedCross() {
  return markOffset(STEM_BASE, { units: [] }) + FP_GAP + fpCrossMax();
}

/**
 * 一排封面共用的内沿距离：取**有封面的那些组里最外的标记外沿**，让每张封面都落在同一条线上。
 *
 * 取最大值而不是取基准档，是因为封面必须在它自己那组的图标之外——比基准档更靠里就会压住图标。
 * 再夹一次可用厚度：交错时两侧都要放得下，取窄的那一侧。夹到之后若比某一组自己的外沿还小，
 * 那一组就保持原位（`padOf` 不给负数），宁可它一个不齐，也不能把封面顶出主体区。
 */
function computeCoverPin(groups) {
  const withCover = groups.filter((g) => g.covers?.length);
  if (!withCover.length) return 0;
  const want = Math.max(...withCover.map((g) => markOffset(g.stem, g)));
  const coverCross = Math.max(...withCover.flatMap((g) => g.covers.map((c) => fpCrossOf(c))));
  const room = stagger ? Math.min(axisCross, bodyCross() - axisCross) : axisCross;
  return Math.min(want, room - 8 - FP_GAP - coverCross);
}



/**
 * 给媒体带里的东西算出各自的实际占位，**写回 group 上**。
 *
 * 必须在 minWidthsBetween 之前做：它们的沿轴长度是坐标层的间距输入（05§1.2）。
 *   · 封面——横版比竖版长近一倍（136 vs 76）。按竖版算间距、按横版渲染就会压到隔壁去，
 *     这正是「双封面时第二张不对劲」的另一半原因。
 *   · 成就簇——列数取决于当前厚度放得下几个，1 列和 3 列差着 76px。
 */
function sizeMedia(groups) {
  // 换边在**有封面的组之间**按时间顺序轮转：相邻两张封面必然一上一下。只有封面组参与，
  // 纯图标的日子一律留在标记侧——让整条图标脊线跟着抖是噪声，交错要跟着的是「封面」这件事。
  // 按序号轮转而不是按位置，是为了缩放 / 换向之后同一张封面仍落在同一侧，不会一动就跳。
  let flip = 0;
  for (const g of groups) {
    g.side = stagger && g.covers?.length ? flip++ % 2 : 0;
  }
  for (const g of groups) {
    for (const c of g.covers ?? []) {
      c.shape = coverVariants(c.game)[0].shape;
      const size = fpTileSize(c.shape, coverScale);
      c.w = size.w;
      c.h = size.h;
    }
    // 分法必须在封面尺寸之后算：它要拿上侧已经占了多少（标记 + 封面）去权衡
    const { shown, more, cells } = achCells(g.achTotal ?? 0);
    g.achShown = shown;
    g.achMore = more;
    g.achCells = cells;
    const split = splitAchAcrossAxis(g, cells, achCap, panelsMainOf(g, panelCap));
    g.achAboveCells = split.above;
    g.achBelowCells = split.below;
    g.achAboveMain = achMainCells(split.above);
    g.achBelowMain = achMainCells(split.below);
  }
}

function rebuildScaleAndRender() {
  Panel.hideImmediately(); // 重建 DOM 前先收起 panel，避免锚点元素被替换后残留悬浮态
  hideAchTip();
  setOrient(state.orient);
  els.body.dataset.orient = state.orient;

  const groupsRaw = buildGroups();
  const allDates = groupsRaw.map((g) => g.ts).concat([NOW]);
  const min = Math.min(...allDates) - 14 * DAY;
  const max = Math.max(...allDates, NOW) + 10 * DAY;
  const segments = buildSegments(
    [min, ...allDates, max], state.pxPerDay, gapDaysFor(state.pxPerDay));

  // 列容量与封面尺寸按当前可用厚度现算，**必须在算间距之前定**：它们决定组有多长，
  // 而组长是坐标层的间距输入（05§1.2）。先渲染后调整会让间距与实际尺寸对不上。
  const m = measureCross();
  panelCap = m.panelCap;
  stagger = m.stagger;
  coverScale = m.scale;
  achCap = m.achCap;
  sizeMedia(groupsRaw);

  // 内容尺寸回灌坐标层：相邻时点的标记 / 封面 / 截图组不得重叠（05§1.2）。
  // 注入到 scale 之前，位置真源始终只有 scale 一处。
  const minWidths = minWidthsBetween(groupsRaw, 8, panelCap);
  for (const seg of segments) {
    const mw = minWidths.get(seg.t0);
    if (mw) seg.minPx = mw;
  }
  // 首尾两段是留白（首个时点前 14 天 / 今天后 10 天），不是数据——两端的标就住在这里。
  // 预留 = **标签自己的长度** + **紧挨着的那一组占的长度**：标横跨轴线，躲不到另一侧去，
  // 只能沿轴让开（见 END_FLAG_CLEAR）。这仍然走 segment.minPx，位置真源还是只有 scale 一处。
  const firstTs = groupsRaw[0]?.ts ?? null;
  const byTs = new Map(groupsRaw.map((g) => [g.ts, g]));
  const halfAt = (ts) => {
    const g = byTs.get(ts);
    return g ? groupFootprint(g, panelCap) / 2 : 0;
  };
  if (firstTs !== null && segments.length) {
    segments[0].minPx = Math.max(segments[0].minPx ?? 0,
      START_LEAD[state.orient] + END_FLAG_CLEAR + halfAt(segments[0].t1));
  }
  // 「今天」两侧各有一条约束：左边那段要让最后一组的封面 / 面板退到 TODAY 标之外，
  // 右边那段（末端留白）要放得下标签本身——末端不该在「今天」上戛然而止（见 END_LEAD）。
  // NOW 一定是某个段界：它被塞进了 buildSegments 的时间戳表里。
  const iNow = segments.findIndex((s) => s.t1 === NOW);
  if (iNow > 0) {
    segments[iNow].minPx = Math.max(segments[iNow].minPx ?? 0,
      halfAt(segments[iNow].t0) + END_FLAG_CLEAR);
  }
  const tail = segments[iNow + 1] ?? segments[segments.length - 1];
  if (tail) {
    // 尾段右端也可能站着一组（未来的发售日就在今天之后），同样要让开
    tail.minPx = Math.max(tail.minPx ?? 0,
      END_LEAD[state.orient] + END_FLAG_CLEAR + halfAt(tail.t1));
  }
  currentScale = createScale(segments);

  const withP = groupsRaw.map((g) => ({ ...g, p: currentScale(g.ts) }));
  const groups = assignStems(withP);

  coverPin = computeCoverPin(groups);

  els.track.innerHTML = '';
  const [d0, d1] = currentScale.domain();
  // 位置真源只有 scale：轨道长度直接由 domain 两端算出，不受渲染层影响
  const totalMain = currentScale(d1) - currentScale(d0);
  if (V()) { els.track.style.height = `${totalMain}px`; els.track.style.width = '100%'; }
  else { els.track.style.width = `${totalMain}px`; els.track.style.height = '100%'; }

  // 刻度粒度由当前 px/天 现算（07§4.6 v3.2）。**必须算在稀疏段标签之前**：那行「起 — 止」
  // 的文案也跟着这个粒度走，放在后面算等于用上一帧的粒度写这一帧的字（缩放后第一帧对不上，
  // 而且第一次 render 时它还是 undefined）。
  currentSpec = tickSpecFor(state.pxPerDay, TICK_MIN_SPACING[state.orient]);
  const insideSparse = (t) => segments.some((s) => s.sparse && t >= s.t0 && t <= s.t1);
  // 起点之前没有数据，刻度画在那儿只会压住起点标；恰好落在今天的那枚也不画——renderNowMark
  // 已经在同一个位置放了端帽和 TODAY 标签，再叠一枚就是同一件事说两遍（05§0 规则 2）。
  const skipTick = (t) => insideSparse(t)
    || (firstTs !== null && t < firstTs)
    || Math.floor(t / DAY) === Math.floor(NOW / DAY);

  // 轴上所有写字的标签共用**一条防撞链**（v3.19b）。主刻度的年月和稀疏段的「起 — 止」
  // 落在同一条线上、抢同一段空间，各画各的就会互相压：实测横排 6 处重叠，其中 5 处是两个
  // 相邻稀疏段互相压（段被压成固定 96px，而标签 110px，每边溢出 7px），1 处是主标签压在
  // 稀疏段标签上。谁先落位谁留下，**主刻度先落**——它是轴上唯一的年份锚点，而稀疏段那行
  // 让掉之后斜纹带还在，跨度改由 `title` 说。
  const placed = [];
  /** 抢下 [p ± main/2] 这段；抢不到返回 false（调用方据此决定不写字）。 */
  const claim = (p, main) => {
    const a = p - main / 2;
    const b = p + main / 2;
    if (placed.some(([x, y]) => a < y + LABEL_GAP && x - LABEL_GAP < b)) return false;
    placed.push([a, b]);
    return true;
  };

  // 主刻度（月首 / 年首）：先占位，元素稍后再建——它得比稀疏段标签先抢到地方
  const majors = [];
  for (const { t, text } of majorTicks(currentSpec, d0, d1)) {
    if (skipTick(t)) continue;
    const p = currentScale(t);
    majors.push({ p, text, withLabel: claim(p, tickLabelMain(text, true)) });
  }

  // 稀疏段斜纹带（07§4.3）。首尾两段是 domain 的**留白**（首个时点前 14 天 / 今天后 10 天），
  // 不是「这段时间没在玩」——给它们画斜纹带并配一个跨度标签，说的是一件不存在的事。
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (!seg.sparse || si === 0 || si === segments.length - 1) continue;
    const a = currentScale(seg.t0), b = currentScale(seg.t1);
    const span = `${tickText(seg.t0, currentSpec)} — ${tickText(seg.t1, currentSpec)}`;
    const band = document.createElement('div');
    band.className = 'sparse-band';
    setPos(band, a, -6);
    if (V()) band.style.height = `${b - a}px`;
    else band.style.width = `${b - a}px`;
    // 带子自己也报跨度：文案被防撞挤掉时，这段仍然读得到「压缩了多久」
    band.title = `${span} · 这段没有记录，轴上按固定宽度压缩`;
    els.track.appendChild(band);
    const mid = (a + b) / 2;
    if (!claim(mid, tickLabelMain(span, false))) continue;
    const label = document.createElement('div');
    label.className = 'label tick-label';
    setPos(label, mid, 0);
    label.textContent = span;
    els.track.appendChild(label);
  }

  // 次刻度（v3.19 起不写字）：一排等距的淡线，只表达「尺子的格」。
  // 原来每一格都压一行 10.5px 的等宽小字，密、淡、还多半读不出年份——字多不等于读得出来。
  for (const t of currentScale.ticks(currentSpec)) {
    if (skipTick(t)) continue;
    const mark = document.createElement('div');
    mark.className = 'tick-mark';
    setPos(mark, currentScale(t), 0);
    setSize(mark, 1, 4);
    els.track.appendChild(mark);
  }

  // 主刻度：横跨轴线的一道分界 + 写全年份的标签（写不写在上面的防撞链里已经定了）
  for (const { p, text, withLabel } of majors) {
    const mark = document.createElement('div');
    mark.className = 'tick-mark major';
    setPos(mark, p, -4);      // 跨过轴线：它是「这里换月/换年了」的分界，不是更长的刻度
    setSize(mark, 1, 12);
    mark.title = text;        // 挤掉文案的那几枚，线还在，指上去仍读得到是哪个月
    els.track.appendChild(mark);
    if (!withLabel) continue;
    const label = document.createElement('div');
    label.className = 'label tick-label major';
    setPos(label, p, 0);
    label.textContent = text;
    els.track.appendChild(label);
  }

  renderedGroups = groups;
  for (const g of groups) els.track.appendChild(renderGroup(g));
  if (groups.length) renderStartMark(groups[0]);
  renderNowMark(totalMain, groups);

  // 轴线**从第一个时点开始画**，不从 domain 最左端起（07§4.2b v3.8）。
  // 起点之前那段是留白（首个时点前 14 天），本来就没有刻度、没有斜纹带；再画一截轴线过去，
  // 「起点」就只能退化成挂在轴旁边的一枚标签。线从这里起，起点才是结构上的起点。
  const axisFrom = groups.length ? groups[0].p : 0;
  const axis = document.createElement('div');
  axis.className = 'axis-line';
  if (V()) { axis.style.top = `${axisFrom}px`; axis.style.height = `${totalMain - axisFrom}px`; }
  else { axis.style.left = `${axisFrom}px`; axis.style.width = `${totalMain - axisFrom}px`; }
  els.track.appendChild(axis);

  // 全景导航条（07§4.2a）：位置口径全部由 scale 换算成比例，不另起一套映射
  Overview.setOrient(state.orient);
  Overview.setModel({ groups, scale: currentScale, totalMain, now: NOW });

  clampAndApplyOffset();
  updateHeaderClock();
}

/**
 * 成就明细的懒加载触发：只拉**当前视窗范围内**那几组的明细（07§4.5 的懒加载口径）。
 *
 * 一开始用的是 IntersectionObserver，换掉了：它和 rAF 一样挂在渲染生命周期上，页签在后台
 * 时一次都不派发——「后台打开、切回前台」会先看到一屏没有图标的占位色块。而这里要判的
 * 本来就只是「g.p 在不在 [offset, offset+视窗] 里」，坐标层已经把这个数算好了，
 * 用不着让浏览器再帮我算一遍交叉。纯整数比较、不碰 DOM、不触发布局，
 * 挂在 clampAndApplyOffset（所有位移的唯一出口）上，滚到哪拉到哪。
 */
function fillTilesInView() {
  const from = state.offset - 200;
  const to = state.offset + bodyMain() + 200;
  for (const g of renderedGroups) {
    if (g.p >= from && g.p <= to) g.__fill?.();
  }
}

function clampAndApplyOffset() {
  // 位移是所有位置的公共分母：一旦被写进一个 NaN（除零、坏偏好、坐标层异常），
  // 后面每一处都会静默失效——transform 变成非法值被浏览器忽略、头部读数变 NaN、
  // 视窗框消失，而控制台一声不吭。所有位移的唯一出口就在这里，兜在这里最省。
  if (!Number.isFinite(state.offset)) state.offset = 0;
  const view = bodyMain();
  const total = V()
    ? parseFloat(els.track.style.height || '0')
    : parseFloat(els.track.style.width || '0');
  state.offset = Math.min(Math.max(0, total - view), Math.max(0, state.offset));
  els.track.style.transform = V()
    ? `translate3d(0, ${-state.offset}px, 0)`
    : `translate3d(${-state.offset}px, 0, 0)`;
  Overview.setViewport(state.offset, view);
  fillTilesInView();
}

/** 头部时间读数：年份弱化在前、当前视窗所在月份放大。 */
function updateHeaderClock() {
  if (!currentScale) return;
  const centerT = currentScale.invert(state.offset + bodyMain() / 2);
  const [year, month] = monthLabel(centerT).split('.');
  els.clockCtx.textContent = year;
  els.clockHit.textContent = month;
  els.clock.setAttribute('aria-label', `当前视窗 ${year} 年 ${month} 月`);
}

const centerOffsetForTime = (t) => currentScale(t) - bodyMain() / 2;

/* ---------------- 缩放 / 平移 ---------------- */

/**
 * 无档缩放（07§4.6 v3.2）。锚点是关键：不锚的话每缩放一次视窗都会往轴的起点漂，
 * 用户得反复把内容拖回来。锚在指针（或视窗中心）上，指哪缩哪。
 * @param {number} next 目标 px/天
 * @param {number} [anchorMain] 视窗内的沿轴锚点，默认视窗中心
 */
function zoomTo(next, anchorMain) {
  const value = clampZoom(next);
  if (Math.abs(value - state.pxPerDay) < 1e-6) return;
  const a = anchorMain ?? bodyMain() / 2;
  const anchorT = currentScale ? currentScale.invert(state.offset + a) : NOW;
  state.pxPerDay = value;
  setZoomPref(value);
  dismissOverlays();
  rebuildScaleAndRender();
  state.offset = currentScale(anchorT) - a;
  clampAndApplyOffset();
  updateHeaderClock();
}

/** 平移时把悬浮 / 钉住的浮层收掉：它们锚在某个时点上，轴一动就不再指向原来的东西。 */
function dismissOverlays() {
  Panel.hideImmediately();
  hideAchTip();
}

function panBy(dir) {
  dismissOverlays();
  state.offset += dir * bodyMain() * 0.8;   // 一次翻八成屏，留两成重叠好接续
  clampAndApplyOffset();
  updateHeaderClock();
}

/** 导航条上点 / 拖的落点（轨道像素）→ 把它移到视窗正中。 */
function seekToMain(centerMain) {
  dismissOverlays();
  state.offset = centerMain - bodyMain() / 2;
  clampAndApplyOffset();
  updateHeaderClock();
}

function startEdgeScroll(direction) {
  if (edgeRaf || autoAnchor) return;   // 自动滚动进行中，别让边缘带再插一脚
  dismissOverlays();
  // 速度跟着缩放走：密的时候慢、疏的时候快，否则 1.5 px/天 下边缘滚动像没动
  const step = Math.max(4, Math.min(24, 900 / state.pxPerDay));
  const tick = () => {
    state.offset += direction * step;
    clampAndApplyOffset();
    updateHeaderClock();
    edgeRaf = requestAnimationFrame(tick);
  };
  edgeRaf = requestAnimationFrame(tick);
}

function stopEdgeScroll() {
  clearTimeout(edgeTimer);
  edgeTimer = null;
  if (edgeRaf) cancelAnimationFrame(edgeRaf);
  edgeRaf = null;
}

function onBodyMouseMove(ev) {
  // 导航条压在主体区一角，不排掉它，鼠标一挪上去就会触发边缘滚动
  if (ev.target.closest?.('.ov-rail')) { stopEdgeScroll(); return; }
  const rect = els.body.getBoundingClientRect();
  const inMain = V() ? ev.clientY - rect.top : ev.clientX - rect.left;
  const size = V() ? rect.height : rect.width;
  const nearStart = inMain < EDGE_BAND;
  const nearEnd = inMain > size - EDGE_BAND;
  if (!nearStart && !nearEnd) { stopEdgeScroll(); return; }
  if (edgeRaf || edgeTimer) return; // 已在延时或已启动
  const direction = nearStart ? -1 : 1;
  edgeTimer = setTimeout(() => { edgeTimer = null; startEdgeScroll(direction); }, EDGE_DELAY);
}

/* ---------------- 中键自动滚动（07§4.6b）----------------
 *
 * 浏览器自带的中键自动滚动只对**真正会滚的页面**生效。这条轴是用 transform 平移的虚拟
 * 滚动，`#timeline-body` 是 `overflow:hidden`，原生那套无从下手——按下去只会出现一个
 * 滚不动的锚点图标。所以自己实现一份：锚点、按距离给速度、点一下退出，行为与原生一致。
 */
let autoAnchor = null;   // { x, y, el }
let autoPointer = { x: 0, y: 0 };
let autoRaf = null;

function startAutoScroll(ev) {
  if (autoAnchor) { stopAutoScroll(); return; }   // 再按一次 = 退出，与原生一致
  const rect = els.body.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'autoscroll-anchor';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `${svg('chevL', 11, 2)}<i></i>${svg('chevR', 11, 2)}`;
  el.style.left = `${ev.clientX - rect.left}px`;
  el.style.top = `${ev.clientY - rect.top}px`;
  els.body.appendChild(el);
  autoAnchor = { x: ev.clientX, y: ev.clientY, el };
  autoPointer = { x: ev.clientX, y: ev.clientY };
  els.body.classList.add('autoscrolling');
  dismissOverlays();

  const step = () => {
    if (!autoAnchor) return;
    // 只取**沿轴**那一维：这条轴只有一个方向，把另一维也算进来只会让斜向移动的方向忽左忽右
    const d = V() ? autoPointer.y - autoAnchor.y : autoPointer.x - autoAnchor.x;
    const mag = Math.abs(d) - AUTOSCROLL_DEAD;
    if (mag > 0) {
      state.offset += Math.sign(d) * Math.min(AUTOSCROLL_MAX, mag * AUTOSCROLL_GAIN);
      clampAndApplyOffset();
      updateHeaderClock();
    }
    autoRaf = requestAnimationFrame(step);
  };
  autoRaf = requestAnimationFrame(step);
}

function stopAutoScroll() {
  if (!autoAnchor) return;
  autoAnchor.el.remove();
  autoAnchor = null;
  els.body.classList.remove('autoscrolling');
  if (autoRaf) cancelAnimationFrame(autoRaf);
  autoRaf = null;
}

function onWheel(ev) {
  const rect = els.body.getBoundingClientRect();
  if (ev.ctrlKey) {
    ev.preventDefault();
    const anchor = V() ? ev.clientY - rect.top : ev.clientX - rect.left;
    zoomTo(zoomBy(state.pxPerDay, ev.deltaY < 0 ? 1 : -1), anchor);
    return;
  }
  // 普通滚轮 / 触控板直接平移（不必按修饰键）：取 deltaX/deltaY 中量更大的一轴，
  // 竖排时纵向滚轮天然就是沿轴方向。封面轮播会在自己身上 stopPropagation。
  ev.preventDefault();
  dismissOverlays();
  const delta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
  state.offset += delta;
  clampAndApplyOffset();
  updateHeaderClock();
}

/* ---------------- 视口变化 ---------------- */

let resizeSettle = null;

/**
 * 分两条路走，因为两者代价差三个数量级：
 *   · **便宜路**（每次都走）——只改 `--axis-c` 一个变量，轴线连同所有锚在它上面的元素由
 *     浏览器一次重排带走。故意**不套 requestAnimationFrame**：页签切到后台时 rAF 会被
 *     节流甚至完全不派发，那样「回到前台发现布局还停在旧尺寸」。这条路本身就够便宜。
 *   · **贵路**（停下来之后才走）——只有列容量或封面尺寸真的变了才重建 DOM（600+ 个绝对
 *     定位节点，一次重建约 2.6s，拖窗口时每帧来一发等于把页面焊死）。
 */
function onResize() {
  if (!currentScale || bodyCross() < 40) return;
  measureCross();
  clampAndApplyOffset();
  updateHeaderClock();
  clearTimeout(resizeSettle);
  resizeSettle = setTimeout(settleResize, RESIZE_SETTLE);
}

function settleResize() {
  if (!currentScale || bodyCross() < 40) return;
  const m = measureCross();
  // 交错的开关也要算进来：视口一变可能只有它翻了面，那同样要重排（漏了它就是「拉窗口后交错不见了」）
  if (m.panelCap === panelCap && m.achCap === achCap && m.scale === coverScale
    && m.stagger === stagger) return; // 占位没变，DOM 不用动
  // 重建会改变整条轨道的长度（列数 / 封面变了 → 间距变），锚点必须**在重建之前**取
  const anchorT = currentScale.invert(state.offset + bodyMain() / 2);
  dismissOverlays();
  rebuildScaleAndRender();
  state.offset = centerOffsetForTime(anchorT);
  clampAndApplyOffset();
  updateHeaderClock();
}

/* ---------------- 方向与导航条开关 ---------------- */

function setOrientation(orient) {
  if (orient === state.orient) return;
  const anchorT = currentScale ? currentScale.invert(state.offset + bodyMain() / 2) : NOW;
  state.orient = orient;
  setOrientPref(orient);
  dismissOverlays();
  rebuildScaleAndRender();
  state.offset = centerOffsetForTime(anchorT);
  clampAndApplyOffset();
  updateHeaderClock();
  paintToggles();
}

/** 换一个「什么进轴」的开关之后，重建并把视窗锚回原处——否则内容一少，视窗就漂了。 */
function reflowKeepingAnchor() {
  const anchorT = currentScale ? currentScale.invert(state.offset + bodyMain() / 2) : NOW;
  dismissOverlays();
  rebuildScaleAndRender();
  state.offset = centerOffsetForTime(anchorT);
  clampAndApplyOffset();
  updateHeaderClock();
  paintToggles();
}

function setHideAch(on) {
  hideAch = on;
  setHideAchPref(on);
  reflowKeepingAnchor();
}

function setMinimal(on) {
  minimal = on;
  setMinimalPref(on);
  reflowKeepingAnchor();        // 屏蔽的东西同时退出布局，整条轴会收紧
}

function setOverviewVisible(on) {
  showOverview = on;
  setOverviewPref(on);
  measureCross();
  paintToggles();
}

function paintToggles() {
  els.orientBtn.classList.toggle('on', V());
  els.orientBtn.innerHTML = svg(V() ? 'layoutV' : 'layoutH', 18);
  els.orientBtn.setAttribute('aria-pressed', String(V()));
  els.orientBtn.title = V() ? '纵向时间轴（点击切回横向）' : '横向时间轴（点击切为纵向）';
  paintOverviewBtn();
  els.minimalBtn.classList.toggle('on', minimal);
  els.minimalBtn.setAttribute('aria-pressed', String(minimal));
  els.minimalBtn.title = minimal
    ? '已屏蔽截图（缩略图与面板都不画，事件图标、成就簇与开局封面照留），点击恢复'
    : '屏蔽截图：缩略图与面板都不画，事件图标、成就簇与开局封面照留';
  els.achBtn.classList.toggle('on', hideAch);
  els.achBtn.setAttribute('aria-pressed', String(hideAch));
  els.achBtn.title = hideAch
    ? '已隐藏成就（整类不进轴），点击恢复'
    : '隐藏成就：成就事件整类不进轴，只留购买 / 首玩 / 发售 / 截图';
}

function paintOverviewBtn() {
  if (!els.ovBtn) return;
  els.ovBtn.classList.toggle('on', showOverview && !railSuppressed);
  els.ovBtn.setAttribute('aria-pressed', String(showOverview));
  els.ovBtn.title = railSuppressed
    ? '全景导航条：窗口太小放不下，已自动收起'
    : (showOverview ? '隐藏全景导航条' : '显示全景导航条');
}

/* ---------------- 导出长图 ---------------- */

/**
 * 导出的是**当前这条轴的全长**，一个像素都不多，也不另立一套口径：
 *   · 过滤规则完全沿用主页面（隐藏从未启动 / 隐藏成就 / 精简模式）——它们改变的是
 *     `buildGroups()` 的产物，也就是「轴上有什么」，导出没有自己的开关；
 *   · 缩放也沿用主页面的 px/天：它决定轴有多长、疏密怎么分段，换个值导出的就是另一条轴；
 *   · 方向由导出时选，选完**同步应用到主页面**（见 setDirection）——所见即所得，不留
 *     「屏幕上是横的、导出来是竖的」这种对不上的状态。
 *
 * 一句话：导出 = 把主体区那块视口撑到轨道全长，然后照一张相。所以下面没有任何绘制代码，
 * 只有「把视口的那几处限制拆掉」和「把懒加载的内容补齐」。
 */

/** 只在交互时才有意义的东西，不进图。 */
const EXPORT_STRIP = [
  '.ov-rail',            // 全景导航条：它是导航控件，而长图本身就是全景
  '.mid-guide', '.edge-hint', '.autoscroll-anchor',
  '#panel-root', '.hover-panel', '.ach-tip',
  '.hit-region',         // 命中区连同里面的 .df-hit：纯交互层，静态图里没有「指针」这回事
];

/** 导出根节点上的补丁样式：页面上的字体与颜色挂在 <body> 上，而导出树里没有 body。 */
const EXPORT_CSS = `
.gc-export-root {
  font-family: 'Noto Sans SC', 'Microsoft YaHei UI', 'Segoe UI', system-ui, sans-serif;
  color: var(--text-1);
  -webkit-font-smoothing: antialiased;
}
.gc-export-root * { transition: none !important; animation: none !important; }
`;

let cssTextCache = null;

/** 整张 styles.css 的文本。导出树是个独立的渲染上下文，样式得跟着一起进去。 */
async function exportStylesheet() {
  if (cssTextCache === null) {
    const res = await fetch(new URL('./styles.css', import.meta.url));
    if (!res.ok) throw new Error(`样式表读不到（HTTP ${res.status}）`);
    cssTextCache = await res.text();
  }
  return `${cssTextCache}\n${EXPORT_CSS}`;
}

/** 轨道全长（沿轴）。与 clampAndApplyOffset 同一个真源：位置只由坐标层说了算。 */
function trackMain() {
  return V()
    ? parseFloat(els.track.style.height || '0')
    : parseFloat(els.track.style.width || '0');
}

/**
 * 按年导出时，一段最多跨几年。
 *
 * 整条轴一次导出的根本问题是**画布上限**（Chrome 单边 65 535 px）：十年的库一条轴 8～9 万像素，
 * 只能整体降到 0.7× 出图，全糊。按年切开就是为了让每张图在 1×、乃至 2× 下都落在上限之内。
 * 两年是按真实库的密度估出来的：最密的年份一年约 1.5 万 px，两年 3 万 × 2 倍率 = 6 万，
 * 刚好压着上限；再多一年 2× 就又要降档，切开的意义就没了。
 */
const EXPORT_MAX_YEARS = 2;

/**
 * 年份边界两侧各多留多少 px。年份刻度的标签是**居中钉在刻度上**的（translate -50%），
 * 正好切在 1 月 1 日就会把「2024」拦腰切成两半——图的头尾各露半个字，读起来像是坏了。
 */
const YEAR_CROP_PAD = 56;

/** 轴上有记录的年份区间：[最早时点的年, 今天的年]。没有数据时两头都是今年。 */
function yearSpan() {
  const first = renderedGroups[0]?.ts ?? NOW;
  return [new Date(first * 1000).getUTCFullYear(), new Date(NOW * 1000).getUTCFullYear()];
}

/**
 * 把「fromYear 年初 → toYear 年末」折成轨道上的沿轴像素区间，夹在轨道之内。
 * 年份跨度先按 EXPORT_MAX_YEARS 与实际数据夹一次：面板传什么进来都不该导出一张超范围的图。
 * @returns {{fromYear:number, toYear:number, from:number, to:number}}
 */
function yearRange(fromYear, toYear) {
  const [minY, maxY] = yearSpan();
  const a = Math.min(Math.max(Number(fromYear) || minY, minY), maxY);
  const b = Math.min(Math.max(Number(toYear) || a, a), a + EXPORT_MAX_YEARS - 1, maxY);
  const total = trackMain();
  if (!currentScale) return { fromYear: a, toYear: b, from: 0, to: total };
  const [d0, d1] = currentScale.domain();
  const t0 = Math.max(Date.UTC(a, 0, 1) / 1000, d0);
  const t1 = Math.min(Date.UTC(b + 1, 0, 1) / 1000, d1);
  return {
    fromYear: a,
    toYear: b,
    from: Math.max(0, Math.floor(currentScale(t0) - YEAR_CROP_PAD)),
    to: Math.min(total, Math.ceil(currentScale(t1) + YEAR_CROP_PAD)),
  };
}

/**
 * 导出面板要显示的那几行：方向、过滤规则、年份范围、成图尺寸。
 * `scale` 是**申请**的倍率，回来的 `scale` 是浏览器上限夹过之后**真能用**的那个。
 * @param {{scale?:number, range?:{fromYear:number, toYear:number}|null}} [opts]
 *   range 为 null = 整条轴；否则只导这几年（会被夹到 EXPORT_MAX_YEARS 以内）
 */
export function exportContext({ scale = 1, range = null } = {}) {
  const main = Math.round(trackMain());
  const cross = Math.round(bodyCross());
  const r = range ? yearRange(range.fromYear, range.toYear) : null;
  const len = r ? r.to - r.from : main;
  const width = V() ? cross : len;
  const height = V() ? len : cross;
  return {
    orient: state.orient,
    width,
    height,
    wanted: scale,
    scale: width > 0 && height > 0 ? fitScale(width, height, scale) : scale,
    range: r,
    years: yearSpan(),
    maxYears: EXPORT_MAX_YEARS,
    filters: {
      hideNeverLaunched: getHideNeverLaunched(),
      hideAch,
      minimal,
      pxPerDay: state.pxPerDay,
    },
    groups: r
      ? renderedGroups.filter((g) => g.p >= r.from && g.p <= r.to).length
      : renderedGroups.length,
  };
}

/** 导出面板里的方向切换：直接走主页面那条路，不另开一套状态（见上面的所见即所得）。 */
export function setDirection(orient) {
  setOrientation(orient);
}

/**
 * 把**整条轴**的成就图标明细补齐。
 *
 * 平时这批取数是懒加载的（07§4.5：滚到跟前才拉），视窗之外的成就格子是主题色占位。
 * 导出要的是整条轴，占位色块印在图上就是一片没有内容的马赛克——所以这里必须全量补，
 * 这也是导出比「截个屏」慢的唯一原因。
 * 明细走 Panel.loadAchievements 的缓存，同一个 (appid, day) 只会真发一次请求；仍然限并发，
 * 几百个时点一次全发出去会把后端和浏览器的连接池一起打满。
 */
async function fillAllAchTiles(onProgress, within = null) {
  // 只导某几年时，别的年份的明细拉了也进不了图；范围两侧各放宽一点，压在边界上的簇不能漏
  const inRange = (g) => !within || (g.p >= within.from - 200 && g.p <= within.to + 200);
  const pending = renderedGroups.filter((g) => !g.__done && g.__achTiles?.length && inRange(g));
  onProgress?.(0, pending.length);
  for (let i = 0; i < pending.length; i += 6) {
    await Promise.all(pending.slice(i, i + 6).map((g) => g.__fill()));
    onProgress?.(Math.min(pending.length, i + 6), pending.length);
  }
}

/**
 * 拍一张长图：整条轴，或只拍 range 指定的那几年。
 * @param {{scale?:number, range?:{fromYear:number,toYear:number}|null,
 *          onProgress?:(stage:string,done:number,total:number)=>void}} [opts]
 */
export async function captureLongImage({ scale = 1, range = null, onProgress = () => {} } = {}) {
  dismissOverlays();
  hideAchTip();
  Panel.hideImmediately();

  const pre = exportContext({ scale, range });
  await fillAllAchTiles((d, t) => onProgress('achievements', d, t), pre.range);
  // 回填是异步写 DOM 的，让它落进布局再去量尺寸 / 克隆。
  // ⚠️ 不能只等 requestAnimationFrame：页签切到后台时 rAF **一帧都不派发**，导出会永远卡在
  // 这一行——而「点了导出然后去干别的」恰恰是这个功能最常见的用法（整条轴要跑一两分钟）。
  // 所以与定时器赛跑，谁先到算谁。
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 60);
    requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
  });

  const ctx = exportContext({ scale, range });
  if (!(ctx.width > 0 && ctx.height > 0)) throw new Error('轴上还没有内容可导出');
  const css = await exportStylesheet();

  // 克隆体的尺寸是**整条轨道**（不是裁出来那一段）：所有元素的沿轴坐标都是相对轨道原点的
  // 绝对定位，缩小容器只会把后半截裁掉，而不会把它们挪过来。裁哪一段交给光栅器的 crop。
  const main = Math.round(trackMain());
  const cross = Math.round(bodyCross());
  const fullW = V() ? cross : main;
  const fullH = V() ? main : cross;

  // 克隆**整个主体区**而不是只克隆轨道：方向（data-orient）与轴线位置（--axis-c）都写在
  // 主体区上，而轴两侧每个元素的垂轴定位都是 `calc(var(--axis-c) ± N)`。只搬轨道，
  // 这两个条件一起丢，整张图会塌成一堆挤在左上角的方块。
  const clone = els.body.cloneNode(true);
  // 贴图内联要按元素在图上的实际大小缩图，得能从克隆件找回原件——两棵树同构时索引即对应，
  // 所以**先配对、后删减**。
  const origAll = els.body.querySelectorAll('*');
  const copyAll = clone.querySelectorAll('*');
  let pairs = [];
  for (let i = 0; i < origAll.length; i++) pairs.push([origAll[i], copyAll[i]]);

  const track = clone.querySelector('#timeline-track');
  if (ctx.range && track) {
    // 只导几年时，把范围之外的轨道子节点从克隆体里**摘掉**。不摘也画得对（crop 会裁），
    // 但序列化、光栅、贴图内联三步都是按克隆体的体量付费的：十年的轴摘到剩两年，
    // 这三步一起快五倍，几千张范围外的成就图标也不用再去取。
    // 位置量的是原件（带着轨道的平移一起量，再减掉轨道自己的位置就是轨道内坐标）。
    const trackRect = els.track.getBoundingClientRect();
    const origKids = [...els.track.children];
    const copyKids = [...track.children];
    const lo = ctx.range.from - 40;
    const hi = ctx.range.to + 40;
    origKids.forEach((o, i) => {
      const r = o.getBoundingClientRect();
      const a = V() ? r.top - trackRect.top : r.left - trackRect.left;
      const b = a + (V() ? r.height : r.width);
      if (b < lo || a > hi) copyKids[i]?.remove();
    });
    pairs = pairs.filter(([, c]) => clone.contains(c));
  }

  for (const sel of EXPORT_STRIP) clone.querySelectorAll(sel).forEach((el) => el.remove());
  // 主体区在页面上是一块绝对定位的视口（top: 头部 / bottom: 页脚），导出时它就是整张图本身
  clone.style.position = 'relative';
  clone.style.inset = 'auto';
  clone.style.width = `${fullW}px`;
  clone.style.height = `${fullH}px`;
  clone.style.overflow = 'hidden';
  // 轨道的平移量就是「现在看到哪一段」，导出要的是全长，从头画起
  if (track) track.style.transform = 'none';

  const root = document.createElement('div');
  root.className = 'gc-export-root';
  root.style.cssText = `position:relative;width:${fullW}px;height:${fullH}px;`;
  root.appendChild(clone);

  const out = await nodeToPng(root, {
    width: fullW,
    height: fullH,
    scale,
    crop: ctx.range ? { axis: V() ? 'y' : 'x', from: ctx.range.from, to: ctx.range.to } : null,
    // 整页壁纸（Backdrop）不入图：它是按视口铺的一张图，横着拉到几万像素只会糊成色带。
    // 用它洗白之后的等效底色，也就是 token 里那个「系统不支持透明时的实心兜底」。
    background: getComputedStyle(document.documentElement)
      .getPropertyValue('--bg-fallback').trim() || '#EEF1F6',
    css,
    pairs,
    // 成就图标那个图床不给 CORS 头，前端自己取回来的图画进画布会污染它——借后端转一手
    // （口径与边界见 api.js::mediaRequest / backend/app/api/media.py）
    proxy: API.mediaRequest,
    onProgress,
  });
  return { ...out, context: ctx };
}

/**
 * 拍完直接落盘。文件名带方向，再带年份（按年导）或导出日期（整条轴）——
 * 同一条轴横竖各导一次、逐年导一遍，都不该互相覆盖。
 */
export async function exportLongImage(opts) {
  const out = await captureLongImage(opts);
  const { orient, range } = out.context;
  const span = range
    ? (range.fromYear === range.toYear ? `${range.fromYear}` : `${range.fromYear}-${range.toYear}`)
    : new Date(NOW * 1000).toISOString().slice(0, 10);
  saveBlob(`save-point-timeline-${orient === 'v' ? 'v' : 'h'}-${span}.png`, out.blob);
  return out;
}

/* ---------------- 挂载 ---------------- */

let bound = false;

/**
 * 挂载主视图：绑定只做一次，取数与渲染每次进入都做（切换环境后要重新拉）。
 */
export async function mount(refs) {
  els = refs;
  els.clockCtx = els.clock.querySelector('.ctx');
  els.clockHit = els.clock.querySelector('.hit');
  state.orient = getOrientPref();
  state.pxPerDay = clampZoom(getZoomPref());
  showOverview = getOverviewPref();
  minimal = getMinimalPref();
  hideAch = getHideAchPref();

  if (!bound) {
    bound = true;
    Overview.mount(els.body, { onSeek: seekToMain });
    Panel.mount(els.panelRoot);

    els.orientBtn.addEventListener('click', () => setOrientation(V() ? 'h' : 'v'));
    els.minimalBtn.addEventListener('click', () => setMinimal(!minimal));
    els.achBtn.addEventListener('click', () => setHideAch(!hideAch));
    els.ovBtn.addEventListener('click', () => setOverviewVisible(!showOverview));
    els.exportBtn?.addEventListener('click', () => ExportDialog.open({
      read: exportContext,
      setOrient: setDirection,
      run: exportLongImage,
    }));
    els.prevBtn.addEventListener('click', () => panBy(-1));
    els.nextBtn.addEventListener('click', () => panBy(1));
    els.body.addEventListener('mousemove', onBodyMouseMove);
    // 中键：preventDefault 挡掉原生那个滚不动的锚点，改用自己的一套
    els.body.addEventListener('mousedown', (ev) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      startAutoScroll(ev);                     // 再按一次中键 = 退出（startAutoScroll 内部判）
    });
    // 「按任意其它键退出」挂在 window 上而不是主体区：自动滚动期间去点头部的开关也该退出，
    // 挂在主体区上的话点到外面就停不下来了。中键留给上面那条，否则会自起自停。
    window.addEventListener('mousedown', (ev) => {
      if (ev.button !== 1 && autoAnchor) stopAutoScroll();
    });
    els.body.addEventListener('auxclick', (ev) => { if (ev.button === 1) ev.preventDefault(); });
    window.addEventListener('mousemove', (ev) => {
      if (autoAnchor) { autoPointer = { x: ev.clientX, y: ev.clientY }; }
    });
    window.addEventListener('blur', stopAutoScroll);
    els.body.addEventListener('mouseleave', stopEdgeScroll);
    els.body.addEventListener('wheel', onWheel, { passive: false });
    // 用 ResizeObserver 而不是只用 window.resize：主体区尺寸不只被窗口大小决定
    // （devtools 停靠、浏览器缩放、以后可能加的侧栏都会改它），观察容器本身才不会漏。
    new ResizeObserver(onResize).observe(els.body);
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (autoAnchor) stopAutoScroll();
    });
  }
  paintToggles();
  await reload();
}

/** 从门面拉全量数据并重绘。切换 MOCK/LIVE/IMPORT、同步完成后都走这里。 */
export async function reload() {
  dataset = await API.getTimeline();
  NOW = API.now();
  rebuildScaleAndRender();
  // 初始视窗落在「今天」附近（轴的末端），而不是十年前的起点。
  // 「今天」之后要留够 END_LEAD：原来固定留 10% 视宽，窄视口下只有 60 多 px，
  // TODAY 标签会被右边缘切掉半截——轨道其实有那段留白（END_LEAD 已经预留），
  // 只是默认视窗没把它带进来。
  const tail = Math.max(END_LEAD[state.orient] + 16, bodyMain() * 0.1);
  state.offset = currentScale ? currentScale(NOW) - (bodyMain() - tail) : 0;
  clampAndApplyOffset();
  updateHeaderClock();
}

/** 隐藏「从未启动的游戏」开关变化时调用：本地重算，不重新请求（02§4.1）。 */
export function refresh() {
  rebuildScaleAndRender();
}
