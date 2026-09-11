// 布局纯函数：引线长度分配（05§6 第3条 / D-3）、截图排布（07§4.2）、命中区与 panel 定位（07§4.8）。
//
// v3.2 起时间轴可以横排也可以竖排（07§4.10），所以这一层的几何量**不再叫「宽 / 高」，
// 一律按「沿轴 main / 垂轴 cross」表达**：
//   · main  = 时间流动的方向（横排 = x，竖排 = y）。时点间距、组占位、截图增列都发生在这个方向。
//   · cross = 垂直于时间轴的方向（横排 = y，竖排 = x）。引线长度、截图列容量、轴线位置在这个方向。
// 换个方向渲染时只是这两个词对调，规则本身一个字都不用改——这也是横竖两套能共用同一份布局的原因。
//
// 方向是**模块级设置**而不是每个函数的入参：整页永远只有一条轴，把它当参数传会让每个调用点
// 都多带一个永远相同的值。setOrient() 由渲染层在重建前调用一次。

export const AXIS_Y = 480;          // 1440×900 横排基准下的轴线 y（05§1.1）。是结果不是常量
export const HEADER_H = 96;
export const FOOTER_H = 34;

/** 'h' 横排（07§4.2）| 'v' 竖排（07§4.10）。 */
let ORIENT = 'h';
export const setOrient = (o) => { ORIENT = o === 'v' ? 'v' : 'h'; };
export const getOrient = () => ORIENT;
export const isVertical = () => ORIENT === 'v';

// ---- 引线长度分配（05§6 第3条，D-3 已关闭）----
export const STEM_BASE = 64;
export const STEM_STEP = 40;        // = 标记块高32 + 呼吸8
export const STEM_LEVELS = 4;       // 上限4档 → {64,104,144,184}

// ---- unit 与标记块 ----
const UNIT_W = 14;                   // 图标 14×14
const UNIT_W_XN = 30;                // 横排时带 ×N 的 unit 更长
// 竖排时 ×N 不加长而是加厚（往垂轴方向伸）。实测 9px 等宽字：「×10」16.2px、「×5」10.8px，
// 加图标与数字之间的 3px 间隙 ——「×999」这一档要 25px。原值 16 是按两位数估的，模型比实际
// 薄 3px，表现是竖排下封面与图标之间的净空从 8 掉到 5（07§4.2i）。
const XN_EXTRA = 25;
const UNIT_GAP = 12;
const PLUS_W = 16;
const PLUS_MAIN_V = 12;              // 竖排时 `+N` 占的沿轴长度
export const HIT_PAD = 16;           // 命中区 = 组沿轴长 + 16（07§4.8）
const MARK_C = 25;                   // 标记块厚度 = 图标14 + gap5 + 色点6

/** 一个 unit 沿轴占多长。横排时 ×N 把它拉长，竖排时 ×N 挂在图标侧面、不加长。 */
const unitMain = (u) => (ORIENT === 'v' ? UNIT_W : (u.xn ? UNIT_W_XN : UNIT_W));
/** `+N` 折叠标记沿轴占多长。 */
const plusMain = () => (ORIENT === 'v' ? PLUS_MAIN_V : PLUS_W);

/**
 * 一个时点组的**标记沿轴长度**（不含命中区留白）。
 * @param {{units: Array<{xn?: number}>, plus?: number}} group
 */
export function groupMain(group) {
  const w = group.units.reduce((sum, u) => sum + unitMain(u), 0)
    + UNIT_GAP * Math.max(0, group.units.length - 1);
  return group.plus ? w + UNIT_GAP + plusMain() : w;
}

/** 标记块的**厚度**（垂轴方向）。竖排时 ×N 挂在图标侧面，会把这一摞加厚。 */
export function markCross(group) {
  if (ORIENT !== 'v') return MARK_C;
  return MARK_C + (group?.units?.some((u) => u.xn) ? XN_EXTRA : 0);
}

/**
 * 组内各 unit 相对**组中心**的沿轴偏移（px）。粗粒度缩放下要把命中区下沉到单个 ICON
 * （07§4.8a），得先知道每个 ICON 落在组里的哪一格——排布规则与 groupMain 同源。
 * @param {{units: Array<{xn?: number}>}} group
 * @returns {number[]} 与 group.units 等长
 */
export function unitCenters(group) {
  const total = groupMain(group);
  const centers = [];
  let cursor = -total / 2;
  for (const u of group.units) {
    const w = unitMain(u);
    centers.push(cursor + w / 2);
    cursor += w + UNIT_GAP;
  }
  return centers;
}

/**
 * 按命中区重叠情况给一组时点分配引线长度（stem），逐级抬高、步进 STEM_STEP、上限 STEM_LEVELS 档。
 * 同一重叠簇超过上限档数时不再加高（交给 05§6 第2条的 +N 折叠处理，本函数不做折叠）。
 * @param {{p: number, units: Array<{xn?: number}>, plus?: number}[]} groups 未必按 p 排序
 * @returns {Array<typeof groups[number] & {stem: number, level: number}>} 按 p 升序、附带 stem/level
 */
export function assignStems(groups) {
  const sorted = [...groups].sort((a, b) => a.p - b.p);
  const withLevel = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const used = new Set();
    for (let j = 0; j < i; j++) {
      const prev = withLevel[j];
      const threshold = (groupMain(cur) + groupMain(prev)) / 2 + HIT_PAD + 8;
      if (cur.p - prev.p < threshold) used.add(prev.level);
    }
    let level = STEM_LEVELS - 1;
    for (let l = 0; l < STEM_LEVELS; l++) {
      if (!used.has(l)) { level = l; break; }
    }
    withLevel.push({ ...cur, level, stem: STEM_BASE + level * STEM_STEP });
  }
  return withLevel;
}

// ---- 截图排布（07§4.2：垂轴方向每列最多5张，超过就沿轴增开一列，间距6）----
export const COL_MAX = 5;
export const SHOT_W = 96;
export const SHOT_H = 54;
export const SHOT_GAP = 6;
/** 截图组自轴外侧起排的距离（07§4.2）。 */
export const SHOT_TOP_OFFSET = 32;

/** 一张截图沿轴 / 垂轴各占多少。横排时竖着叠（垂轴 54）、竖排时横着排（垂轴 96）。 */
export const shotMain = () => (ORIENT === 'v' ? SHOT_H : SHOT_W);
export const shotCross = () => (ORIENT === 'v' ? SHOT_W : SHOT_H);

// ---- 开局封面（07§4.2 v3.1 引入，v3.2 移到轴的标记侧，v3.3 支持两种形态）----
//
// Steam 的封面素材有两种比例，**必须各按各的比例画**：
//   · portrait —— `cover_portrait` 600×900（2:3），画成 76 × 114；
//   · wide     —— `cover` / `header_image` 460×215（约 2.14:1），画成 136 × 114。
//
// **两种形态等高（v3.9）。** 之前横版是 136×64——按「等面积」定的（8664 / 8704），想让两者
// 视觉重量相当。可它们不是各自孤立的方块，而是**排在同一条带里**：一整条轴看过去，横版比竖版
// 矮 50px，内沿对齐之后外沿参差，横版看着像「没长齐」的那一档，而不是「另一种比例」。
// 混排不同比例的图，通行做法是**统一一条边**（Flickr / Google 相册的 justified 行都是等高变宽）。
// 这里统一的是厚度：横排时高都是 114，竖排时沿轴长都是 114——两个方向下对齐的都是那条
// 「该对齐的边」。
//
// 等高之后 136×114 的框（1.19:1）装不下 2.14:1 的头图，剩下的 50px 怎么办是关键：
//   · 按 `cover` 裁 —— 实测把 logo 切掉（「WATCH DOGS」只剩「WATCH DOG」），而 logo 正是
//     横版头图上唯一能认出游戏的东西，等于白留了高度；
//   · 留主题色空带 —— 图完整，但 44% 的面积是空的，看着像图没加载完；
//   · **同一张图放大模糊铺底 + 原图清晰居中叠在上面** —— 图完整、无空带、边缘自然，
//     这是最终采用的（见 styles.css 的 .fp-cover.wide::before / .fp-hdr）。
//
// 沿轴长度维持 136 不变：轴上稀缺的是时间方向的长度，等高不该拿它去换。
// 真按等高不裁（244×114）横版会占掉竖版 3.2 倍的沿轴长，一张封面压住三个时点。
//
// ⚠️ 竖排时厚度是宽（136 > 76），所以 fpCrossMax() 在两个方向取的不是同一种形态。
export const FP_W = 76;
export const FP_H = 114;
export const FP_WIDE_W = 136;
export const FP_WIDE_H = FP_H;   // 等高——理由见上
/** 横版头图自身的比例（Steam header 460×215）。清晰层按它定高。 */
export const FP_HDR_RATIO = 460 / 215;
export const FP_GAP = 8;             // 封面组与标记块之间的呼吸

const shapeBase = (shape) => (shape === 'wide'
  ? { w: FP_WIDE_W, h: FP_WIDE_H }
  : { w: FP_W, h: FP_H });

/** 两种形态里较厚的那个——留白与轴线位置按它算，否则横图会顶出去。 */
export const fpCrossMax = () => (ORIENT === 'v'
  ? Math.max(FP_W, FP_WIDE_W)
  : Math.max(FP_H, FP_WIDE_H));

/**
 * 当前可用厚度下封面该缩到多大（0.34 ~ 1 的等比系数）。
 * 封面 v3.2 起挂在轴的**标记侧**，所以约束它的是「标记块外沿到主体区边缘还剩多厚」，
 * 不再是截图那一侧的高度。窄到放不下就等比缩小，最小缩到 34%（再小就认不出是什么了）。
 * @param {number} crossAvail 标记块外沿再往外还剩多少厚度
 */
export function fpCoverScale(crossAvail) {
  return Math.min(1, Math.max(0.34, crossAvail / fpCrossMax()));
}

/**
 * 一张封面的实际像素尺寸。
 * @param {'portrait'|'wide'} shape
 * @param {number} k fpCoverScale() 的结果
 */
export function fpTileSize(shape, k) {
  const b = shapeBase(shape);
  return { w: Math.round(b.w * k), h: Math.round(b.h * k) };
}

// ---- 轴上的成就图标（07§4.2c，v3.6 改为二维簇）----
// 32 与 05§5 成就行里的图标同尺寸、同圆角（6）——轴上和面板里是同一件东西，不另立一套。
export const ACH_TILE = 32;
/**
 * 一个时点最多摆几个成就图标（含 `+N` 那一格），超出折成 `+N`。
 *
 * v3.6 由 3 提到 9，同时从**排成一行**改为**堆成一簇**（先沿垂轴叠满 ACH_PER_COL 个，
 * 再沿时间轴增开一列）。这一改是为了**给轴增密**：
 *   · 排成一行时 3 个占沿轴 108；堆成簇后 9 个也是 108（3 列），而 **1~3 个只占 32**。
 *   · 实测真实库 1172 个有成就的日子里，中位数是 2、69% 在 3 个以内——绝大多数时点的
 *     沿轴占位因此从 108 掉到 32，相邻时点能挨得更近，一屏装得下更多。
 *   · 顺带露出率从 63% 提到 92%（上限 3 → 9），信息还变多了。
 * 换句话说：轴上方的**厚度是富余的、沿轴长度是稀缺的**，把成就从长的那一维挪到厚的那一维。
 */
export const ACH_TILE_MAX = 9;
/** 一列最多叠几个。再高就会盖过旁边的封面，簇本身也读不出「一小堆」的形。 */
export const ACH_PER_COL = 3;

/**
 * 定形表（07§4.2c v3.7）：1~9 各手工定一个形，数组是「每列摆几个」，列沿时间轴排开。
 *
 * 为什么值得逐个摆：格子总数封顶就是 9，一共只有九种情况。逐个定形能让**数量本身变得可读**
 * ——7 是 2-3-2 的菱形、8 是 3-2-3 的沙漏，一眼能分开；而机械切列时 7 和 8 长得几乎一样。
 * 之前试过给规整网格加随机偏移来求「有机感」，效果反而像没排好：**没有规律的不齐读作失误**。
 */
const ACH_SHAPES = {
  1: [1], 2: [2], 3: [3],
  4: [2, 2], 5: [3, 2], 6: [3, 3],
  7: [2, 3, 2], 8: [3, 2, 3], 9: [3, 3, 3],
};

/** 当前可用厚度下，成就簇一列能叠几个。 */
export function achPerColumn(crossAvail) {
  const fit = Math.floor((crossAvail + SHOT_GAP) / (ACH_TILE + SHOT_GAP));
  return Math.max(1, Math.min(ACH_PER_COL, fit));
}

/**
 * 一个簇的「每列几个」。厚度够就用定形表，不够就退回机械切列——**形状让位于放得下**。
 * @param {number} cells 这一簇有几格（含 `+N` 那一格）
 * @param {number} perColumn 当前厚度允许一列叠几个
 */
export function achShape(cells, perColumn = ACH_PER_COL) {
  if (cells <= 0) return [];
  if (perColumn >= ACH_PER_COL && ACH_SHAPES[cells]) return ACH_SHAPES[cells];
  const out = [];
  let left = cells;
  while (left > 0) { out.push(Math.min(perColumn, left)); left -= perColumn; }
  return out;
}

/** 一个簇的沿轴长度（列数决定，与形状无关）。 */
export function achMainOf(cells, perColumn) {
  const cols = achShape(cells, perColumn).length;
  return cols ? cols * ACH_TILE + (cols - 1) * SHOT_GAP : 0;
}

/**
 * 成就簇的格子划分。`+N` **占一格**、不额外加长——它和图标一样大，挤在簇尾正合适。
 * @param {number} count 该时点成就总数
 * @returns {{shown:number, more:number, cells:number}}
 */
export function achCells(count) {
  if (count <= ACH_TILE_MAX) return { shown: count, more: 0, cells: count };
  return { shown: ACH_TILE_MAX - 1, more: count - (ACH_TILE_MAX - 1), cells: ACH_TILE_MAX };
}

/**
 * 把一个时点的成就格子分到轴的两侧（07§4.2c v3.7）。
 *
 * 判据只有一条：**选让两侧最长边最短的那个分法**（即最小化 `max(上侧, 下侧)`）。
 * 它同时把两件事一并解决了，不需要另设「截图算不算多」的阈值：
 *   · 轴下方已经有截图面板时，往下挪只会让下侧更长 → 最优解自然是全留在上面；
 *   · 轴下方是空的时（真实库里九成时点如此）→ 最优解自然是匀一半下去，两侧都不空；
 *   · 而 `max(上,下)` 正是这个时点的沿轴占位（groupFootprint），所以**最平衡的分法
 *     同时也是最省地方的分法**——不是拿密度换观感，两者是一件事。
 * 格子数封顶 9，穷举 10 种分法即可，谈不上代价。
 *
 * @param {{units:any[], plus?:number, covers?:any[], panels?:{count:number}[]}} group
 * @param {number} cells 该时点的成就格子总数
 * @param {number} perColumn 一列叠几个
 * @param {number} panelsMain 轴下方截图面板已占的沿轴长度
 * @returns {{above:number, below:number, aboveMain:number, belowMain:number}}
 */
export function splitAchAcrossAxis(group, cells, perColumn, panelsMain) {
  const markMain = groupMain(group) + HIT_PAD;
  const covers = coversMain(group);   // 与 aboveMain 共用同一份口径，别在这里再算一遍
  const join = (a, b) => (a && b ? a + SHOT_GAP + b : a + b);

  let best = null;
  for (let k = 0; k <= cells; k++) {
    const aboveMain = Math.max(markMain, join(covers, achMainOf(k, perColumn)));
    const belowMain = join(panelsMain, achMainOf(cells - k, perColumn));
    const score = Math.max(aboveMain, belowMain);
    // 平手很常见（一格到三格都只占一列，怎么分都是 32），此时**优先对半分**：
    // 用户要的是「分配一部分下去」，不是「整摞搬下去」——整摞搬走只是把空的那一侧换成另一侧。
    // 再平手就把多的那一个放下面，因为下侧本来就是空的那一边。
    const gap = Math.abs(k - (cells - k));
    if (!best || score < best.score || (score === best.score && gap < best.gap)) {
      best = { score, gap, above: k, below: cells - k, aboveMain, belowMain };
    }
  }
  return best ?? { above: 0, below: 0, aboveMain: 0, belowMain: 0 };
}

/** 一个尺寸在当前方向下的沿轴长度 / 厚度。 */
export const fpMainOf = (size) => (ORIENT === 'v' ? size.h : size.w);
export const fpCrossOf = (size) => (ORIENT === 'v' ? size.w : size.h);

/**
 * 当前垂轴可用厚度下每列能放几张截图。
 *
 * 07§4.2 的「每列最多 5 张」是 **1440×900 横排基准**下的值：轴下剩 385，5 张 = 294，放得下。
 * 视口一矮（或者换成竖排、轴右侧只剩几百像素宽）这个 5 就会把截图捅出边界。
 * 所以列容量按可用厚度现算、5 只作上限——列数本来就是弹性的（「超过就增开一列」），
 * 把溢出转成沿轴增列正是规则本来的意思。返回值恒 ≥ 1：再窄也要能看见一张。
 * @param {number} crossAvail 轴到主体区外沿的可用厚度
 */
export function shotsPerColumn(crossAvail) {
  const item = shotCross();
  const fit = Math.floor((crossAvail - SHOT_TOP_OFFSET + SHOT_GAP) / (item + SHOT_GAP));
  // 竖排下「一列」就是屏幕上横着的**一排**（见 SHOTS_PER_ROW_MAX），封在 4；
  // 横排下它是竖着叠的那一摞，不是一排，仍按 COL_MAX 封在 5。
  const cap = ORIENT === 'v' ? SHOTS_PER_ROW_MAX : COL_MAX;
  return Math.max(1, Math.min(cap, fit));
}

/**
 * 把一个时点的截图切成多列，并给出整组的**沿轴长度**（供间距约束用）。
 * @param {unknown[]} shots
 * @param {number} [perColumn=COL_MAX] 每列张数，由 shotsPerColumn() 按可用厚度算出
 */
/**
 * 一组缩略图切成列。
 * @param {number} perColumn 一列最多几张（垂轴容量）
 * @param {number} [cols] 指定切成几列——标题把面板撑宽之后，图要**摊开去占满那个宽度**，
 *   而不是缩在一列里、旁边留一大片空。不给就按容量自然切。
 */
export function layoutShotColumns(shots, perColumn = COL_MAX, cols = 0) {
  if (!shots?.length) return { columns: [], main: 0 };
  const cap = cols > 0
    ? Math.max(1, Math.ceil(shots.length / cols))   // 摊平：每列尽量一样多
    : Math.max(1, perColumn);
  const columns = [];
  for (let i = 0; i < shots.length; i += cap) columns.push(shots.slice(i, i + cap));
  const main = columns.length * shotMain() + (columns.length - 1) * SHOT_GAP;
  return { columns, main };
}

// ---- 游戏截图面板（07§4.2d）----
//
// 截图分两类：**能对上轴的**（同一款游戏同一天有事件——购买 / 首玩 / 成就 / 发售）挂在那个
// 时点下；**对不上的**按游戏归堆。真实库实测 332 张里两类各占一半，对不上的散在 35 款游戏上。
// 把这 166 张全按日期铺到轴上，等于凭空多出上百个只有截图的时点，轴会被撑得又长又碎，
// 而它们本来就说不出「那天发生了什么」——它们只说得出「我玩这款游戏时截了这些」。
// 所以够量的按游戏收成一个面板，标题写游戏名。
export const SHOT_PANEL_HEAD = 22;    // 标题行
export const SHOT_PANEL_PAD = 10;
export const SHOT_PANEL_GAP = 6;      // 标题行与缩略图网格之间（CSS 里 .shot-panel 的 gap）

/**
 * 标题最多能把面板撑多宽（07§4.2j）。
 *
 * 实测真实库：单游戏标题最宽 326（`The Witcher 2: Assassins of Kings Enhanced Edition`），
 * 中位数 157。330 覆盖了全部单游戏名。**日面板**的标题是把当天所有游戏名串起来的一串
 * （中位 298、最长 1528），那不是一个名字而是一份清单，撑到 1528 宽毫无意义——它会撞上这个
 * 上限，照常省略号。
 */
export const PANEL_TITLE_MAX = 330;
const SP_HEAD_GAP = 8;   // 标题与张数按钮之间（CSS .sp-head 的 gap）
const SP_HEAD_PAD = 2;   // .sp-head 左右各 2

/**
 * 标题要占多长（沿着标题排字的那个方向）。
 * 张数按钮在的时候两侧各留一份等宽的量——标题是**居中**的，右边占多少左边就得留多少。
 */
export function panelTitleMain(titleWidth, countWidth = 0) {
  // ⚠️ 两条 gap 是**恒定**的：CSS Grid 的 gap 在轨道之间照样占位，哪怕两侧那两栏是空的。
  // 漏掉它们，面板会正好短 16px——表现是「明明加宽了，标题还是省略号」。
  const inner = Math.min(titleWidth, PANEL_TITLE_MAX)
    + SP_HEAD_GAP * 2 + countWidth * 2 + SP_HEAD_PAD * 2;
  return inner + SHOT_PANEL_PAD * 2;
}
export const SHOT_PANEL_MAX = 12;     // 面板里最多摆几张，超出折成 `+N`（点开进灯箱看全部）
/**
 * 面板里**屏幕上横着一排**最多摆几张（07§4.2d v3.20）。
 *
 * ⚠️ 这一条是全文少见的、真正按「屏幕的横向」定的约束，不是 main / cross。两个方向下它落在
 * **不同的变量**上，别搞反：
 *   · 横排：一排 = `cols`（列与列横着排，列内的图竖着叠）→ 夹 `cols`，见 panelGrid；
 *   · 竖排：一排 = `perColumn`（一个 .shot-column 内部横着排）→ 夹 `shotsPerColumn` 的返回值。
 *     竖排的 `cols` 是**竖直方向的行数**，限制它没有意义。
 *
 * 横排原来没有上限，列数有两条路能顶上去：一条是标题撑宽后横着能多摆几列（`fit`，实测封顶
 * 在 4），另一条是 `minCols = ceil(shown / perColumn)` —— 每列能叠几张由**轴下方的厚度**
 * 决定，窗口矮到一列只叠得下 2 张时，12 张就要排成 6 列。第二条才是真正会跑宽的那条：面板
 * 横着越拉越长，相邻时点被推开，轴跟着变长，而每一列只有两张图。
 * 竖排那侧原来封在 `COL_MAX`（5），是一排 5 张。
 */
export const SHOTS_PER_ROW_MAX = 4;
/**
 * 少于这么多张就不值得单开面板——一个带标题栏的容器比它装的三张缩略图还占地方，
 * 那时候老老实实按日期挂回轴上更划算。5 是在真实库上量出来的：阈值 5 时 14 款游戏成面板、
 * 收走对不上轴的 69%，剩下 52 张零散的仍按日期上轴。
 */
export const SHOT_PANEL_MIN = 5;
/**
 * 横排时标题在上方吃的是**垂轴**空间，会挤掉截图的行数；竖排时它吃的是沿轴，不影响列容量。
 *
 * ⚠️ v3.15 补上了标题与网格之间那 6px（CSS 里 `.shot-panel` 的 `gap`）。原来漏算，
 * 模型比实际薄——列容量因此可能多算一行，最后一行会顶出面板。这类「模型少算了一段 CSS 里
 * 真实存在的间距」是这套布局最容易出的错，因为溢出是静默的，只是看着挤。
 */
export const panelChromeCross = () => {
  // 竖排下标题吃的是沿轴，不占厚度；但**面板自己的内边距两侧都要减**，
  // 原来这一支直接返回 0，列容量因此按「整个厚度都能摆图」算，多算了 pad*2。
  const box = SHOT_PANEL_PAD * 2;
  return ORIENT === 'v' ? box : SHOT_PANEL_HEAD + SHOT_PANEL_GAP + box;
};
const PANEL_MIN_MAIN_H = 120;         // 横排下保证标题有最小可读宽度（约 7 个汉字）

/**
 * 一个截图面板的沿轴占位。
 * @param {number} count 该游戏对不上轴的截图总数
 * @param {number} perColumn 面板内每列张数（用 panelChromeCross() 折算过的可用厚度算出来的）
 */
/**
 * 面板的网格摆几列、整块沿轴多长（07§4.2j-2）。
 *
 * **横排**下标题和缩略图排在同一个方向上，一张图的面板只有 96 宽，而一个游戏名动辄 160~330——
 * 标题只能省略号，看到的是「红色沙漠：增…」。所以横排先按标题定下最小宽度，
 * 再**把图横着摊开去占满这个宽度**（`cols` 变大、行数变少），实在摊不满的才留白，
 * 由 CSS 居中。竖排下标题横在垂轴上，与沿轴长度无关，这里不掺和（见 panelCrossMin）。
 *
 * @param {number} titleMain 标题要求的最小沿轴长度，来自 panelTitleMain()；竖排传 0
 * @returns {{cols:number, grid:number, main:number}}
 */
export function panelGrid(count, perColumn, titleMain = 0) {
  const per = Math.max(1, perColumn);
  // 竖排不设上限：那个方向的「列」是沿时间轴排的，限制它等于改变竖排整块面板的形状。
  const colsMax = ORIENT === 'v' ? Infinity : SHOTS_PER_ROW_MAX;
  // ⚠️ 张数**必须跟着列上限一起夹**，只夹 cols 是不够的：摊平算法（layoutShotColumns 收到
  // cols > 0 时）会把 12 张硬塞进 4 列 —— 每列 3 张，而每列能叠几张是**垂轴空间**定死的
  // （perColumn）。窗口矮到 perColumn=2 时，那第 3 张就直接顶出面板，而且是静默的：
  // 不报错、不裁切，只是看着挤。夹住 shown，多出来的老实折进 `+N`。
  const shown = Math.min(count, SHOT_PANEL_MAX, colsMax * per);
  const minCols = Math.ceil(shown / per);
  const floorMain = ORIENT === 'v'
    ? 0
    : Math.max(PANEL_MIN_MAIN_H + SHOT_PANEL_PAD * 2, titleMain);
  // 这个宽度里横着能摆下几列——只增不减，绝不会因为标题短就把图挤成更少的列
  const fit = Math.floor((floorMain - SHOT_PANEL_PAD * 2 + SHOT_GAP) / (shotMain() + SHOT_GAP));
  const cols = Math.min(colsMax, Math.max(minCols, Math.min(shown, fit)));
  const grid = cols * shotMain() + (cols - 1) * SHOT_GAP;
  const main = ORIENT === 'v'
    ? SHOT_PANEL_HEAD + SHOT_PANEL_GAP + grid + SHOT_PANEL_PAD * 2
    : Math.max(grid + SHOT_PANEL_PAD * 2, floorMain);
  // `shown` 要交出去：渲染侧得按**同一个数**去 slice 和算 `+N`，各算各的就会一边摆 12 张、
  // 一边按 8 张算格子（05§1.2 的同一条：尺寸只能有一个真源）。
  return { cols, grid, main, shown };
}

export function shotPanelMain(count, perColumn, titleMain = 0) {
  return panelGrid(count, perColumn, titleMain).main;
}

/**
 * 竖排下面板至少要多宽（垂轴）。标题横在垂轴上，而垂轴不进坐标层的间距约束，
 * 所以这里只是「够宽到能把标题写全」，再夹进主体区剩下的厚度里——超出就还是省略号。
 */
export function panelCrossMin(titleCross, crossAvail) {
  return Math.min(titleCross, Math.max(0, crossAvail - SHOT_TOP_OFFSET));
}

/**
 * 轴**标记侧**的沿轴占位：标记命中区与首玩封面组取较大者。
 * v3.2 起封面在这一侧，它的长度也得进间距约束——少算这一截，相邻时点的封面就会互相压。
 * @param {{units:any[], plus?:number, covers?:any[]}} group
 * @param {number} [coverMain] 单张封面的沿轴长度
 */
/** 一组封面自己的沿轴长度。形态不同长度就不同，不能拿一个统一值乘个数。 */
export function coversMain(group) {
  const cs = group.covers ?? [];
  if (!cs.length) return 0;
  return cs.reduce((sum, c) => sum + (ORIENT === 'v' ? (c.h ?? FP_H) : (c.w ?? FP_W)), 0)
    + (cs.length - 1) * SHOT_GAP;
}

export function aboveMain(group) {
  const covers = coversMain(group);
  // achAboveMain 由渲染层在算间距之前写进来（与封面尺寸同一个套路：占位与渲染共用同一份值）
  const ach = group.achAboveMain ?? 0;
  // 封面组与成就图标组并排成一条「媒体带」，两者都有时中间隔一个 SHOT_GAP
  const media = covers && ach ? covers + SHOT_GAP + ach : covers + ach;
  return Math.max(groupMain(group) + HIT_PAD, media);
}

/**
 * 轴**截图侧**的沿轴占位。v3.5 起轴下方**一律是面板**——对得上轴的按天成一块、
 * 对不上的按游戏成一块，两者同一套外壳，所以这里只需要把面板加起来。
 * @param {{panels?:{count:number}[]}} group
 * @param {number} panelPerColumn 面板内每列张数（横排下标题吃掉一截厚度，比裸列少）
 */
export function belowMain(group, panelPerColumn = COL_MAX) {
  const panels = panelsMainOf(group, panelPerColumn);
  const ach = group.achBelowMain ?? 0;
  return panels && ach ? panels + SHOT_GAP + ach : panels + ach;
}

/** 轴下方**只算截图面板**的沿轴长度（分成就时要先知道这一侧已经占了多少）。 */
export function panelsMainOf(group, panelPerColumn = COL_MAX) {
  const ps = group.panels ?? [];
  if (!ps.length) return 0;
  // 每块面板的标题长度不同、因此宽度不同：`titleMain` 由渲染层量好写在 panel 上（05§1.2）
  return ps.reduce(
    (sum, p) => sum + shotPanelMain(p.count, panelPerColumn, p.titleMain ?? 0), 0)
    + (ps.length - 1) * SHOT_GAP;
}

/** 一个时点组的沿轴总占位（05§1.2：内容尺寸是坐标层的输入约束，不是渲染层的事后补救）。 */
export function groupFootprint(group, panelPerColumn = COL_MAX) {
  return Math.max(aboveMain(group), belowMain(group, panelPerColumn));
}

/**
 * 由相邻时点的占位算出各段所需的最小像素长度，喂给坐标层（05§1.2）。
 * @param {{ts:number, units:any[], plus?:number, shots?:any[], covers?:any[]}[]} groups 按时间升序
 * @param {number} [minGap=8] 组间最小留白
 * @param {number} [perColumn=COL_MAX] 每列截图张数——**必须与渲染时用的是同一个值**，
 *   否则算间距按 5 张一列、实际渲染成更多列（更长），截图组又会重叠回去。
 * @returns {Map<number, number>} 段起点时间戳 → 该段最小长度（px）
 *   ⚠️ 调用前必须先把每张封面的实际尺寸写进 `group.covers[].w/h`（渲染时用的是同一份），
 *   否则算间距按默认竖版、实际画出横版（更长），封面又会互相压回去。
 */
/**
 * 一组在轴的**某一侧**占多长（0 = 标记侧，1 = 对侧）。
 *
 * 交错（07§4.2h）是整组换边——封面连同它的图标、引线一起挪到轴的另一边——所以占位也整块
 * 跟着换边：换过边的组在标记侧长度为 0，它的全部长度记在对侧。
 * 换边只在精简模式下发生，那时对侧的截图面板与成就簇都不存在，`Math.max` 不会把两块叠一起算。
 */
export function mainOnSide(group, side, panelPerColumn = COL_MAX) {
  const flipped = group.side === 1;
  if (side === 0) return flipped ? 0 : aboveMain(group);
  return flipped
    ? Math.max(aboveMain(group), belowMain(group, panelPerColumn))
    : belowMain(group, panelPerColumn);
}

/**
 * 相邻两组之间至少要留多宽。
 *
 * 谁都没换边时沿用老口径（`groupFootprint`），**不去改非交错模式下的疏密**；一旦有一方换了边，
 * 轴上下就是两条互不相干的通道，约束必须**分侧**算——这正是交错能把轴压紧的来源：
 * 一上一下的两组根本不会撞，间距只受各自那一侧的长度约束。
 */
function pairGap(a, b, minGap, ppc) {
  if (!a.side && !b.side) {
    return (groupFootprint(a, ppc) + groupFootprint(b, ppc)) / 2 + minGap;
  }
  let need = 0;
  for (const s of [0, 1]) {
    const ma = mainOnSide(a, s, ppc);
    const mb = mainOnSide(b, s, ppc);
    if (!ma && !mb) continue;
    need = Math.max(need, (ma + mb) / 2 + minGap);
  }
  return need;
}

export function minWidthsBetween(groups, minGap = 8, panelPerColumn = COL_MAX) {
  const out = new Map();
  const sorted = [...groups].sort((a, b) => a.ts - b.ts);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    out.set(prev.ts, pairGap(prev, cur, minGap, panelPerColumn));
  }

  // 交错留下的一个洞：**隔一个**的两组落在同一侧（A上 / B下 / C上），中间那两段都被放松过，
  // A 与 C 仍会在那一侧撞上。间距只能表达在相邻段上，所以把这条约束**均摊到中间两段**。
  for (let i = 2; i < sorted.length; i++) {
    const [a, b, c] = [sorted[i - 2], sorted[i - 1], sorted[i]];
    if (a.side !== c.side || a.side === b.side) continue;   // 不是「同侧隔一个」这种情形
    const s = a.side ? 1 : 0;
    const need = (mainOnSide(a, s, panelPerColumn) + mainOnSide(c, s, panelPerColumn)) / 2 + minGap;
    const have = out.get(a.ts) + out.get(b.ts);
    if (have >= need) continue;
    const add = (need - have) / 2;
    out.set(a.ts, out.get(a.ts) + add);
    out.set(b.ts, out.get(b.ts) + add);
  }
  return out;
}

// ---- 轴线位置（05§1.1）----

/** 媒体带（封面 / 成就图标）在垂轴方向的厚度：以最厚的那个为准，也就是封面。 */
/** 标记侧至少要留的厚度：基准引线 + 呼吸 + 标记块 + 封面 + 8。 */
export const minCrossBeforeAxis = () => STEM_BASE + 7 + MARK_C + FP_GAP + fpCrossMax() + 8;
/** 截图侧至少要放得下一列截图。 */
export const minCrossAfterAxis = () => SHOT_TOP_OFFSET + shotCross();

/**
 * 当前主体区厚度下轴线该落在哪（05§1.1）。
 *
 * 规则仍然是「**垂轴方向居中**」。只有再窄下去、居中会把标记侧顶出主体区时才按需推开：
 * 那时候「居中」和「看得见」二选一，选看得见。窄到连夹都夹不住就退回居中——
 * 反正怎么放都装不下，至少别把轴挪到一个更没道理的位置上。
 *
 * ⚠️ 这里用的是**基准引线 64** 而不是最高档 184：minPx 已经保证相邻时点不重叠，实测绝大多数
 * 组的 stem 就停在 64，按 184 去夹会在正常视口下白白把轴推歪 120px。极窄视口下偶发的高档组
 * 会被裁掉一点顶——那是拿「常态不歪」换来的。
 * @param {number} bodyCross 主体区在垂轴方向的尺寸（横排 = 高，竖排 = 宽）
 */
export function axisCrossFor(bodyCross) {
  const center = Math.round(bodyCross / 2);
  const before = minCrossBeforeAxis();
  const after = minCrossAfterAxis();
  if (bodyCross < before + after) return center;
  return Math.min(Math.max(center, before), bodyCross - after);
}

// ---- 命中区与 panel 定位（07§4.8）----
const ANCHOR_GAP = 10;           // panel 外边距标记
export const PANEL_EDGE_MIN = 8; // 不越过主体区内沿 8px（07§4.8 v2.1 补）
export const HIT_HEIGHT = 44;
export const HIT_RADIUS = 14;

/** 标记块外沿**距轴线**的距离——命中区、读数条用 calc(var(--axis-c) ∓ N) 定位时要的就是它。 */
export function markOffset(stem, group) {
  return stem + 7 + markCross(group);
}

/** 首玩封面外沿距轴线的距离。 */
export function coverOffset(stem, group, coverCross) {
  return markOffset(stem, group) + FP_GAP + coverCross;
}

/**
 * 悬浮 panel 在垂轴方向的落点：贴在这一组最外侧内容之外，再收敛到主体区内沿。
 * @param {number} outerOffset 该组最外侧内容距轴线的距离（有封面就是 coverOffset）
 * @param {number} axisCross 当前轴线位置
 * @param {number} panelCross panel 在垂轴方向的尺寸
 */
/** 换到轴**对侧**的那些组，panel 也要跟到对侧去，否则会压在原来那一侧的内容上。 */
export function panelCrossPosBelow(outerOffset, axisCross, bodyCross, panelCross) {
  return Math.min(bodyCross - PANEL_EDGE_MIN - panelCross,
    axisCross + outerOffset + ANCHOR_GAP);
}

export function panelCrossPos(outerOffset, axisCross, panelCross) {
  return Math.max(PANEL_EDGE_MIN, axisCross - outerOffset - ANCHOR_GAP - panelCross);
}

// ---- 悬浮 panel 尺寸定案值（07§4.8）----
export const GAME_PANEL_H = 186;      // 14 + 封面144 + 8 + 圆点6 + 14
export const ACH_PANEL_H = 269;       // 3行 + "+N"（v2.1 实算，4行放不下）
export const ACH_ROWS_MAX = 3;
export const PANEL_W = 320;
export const COVER_W = 96;            // panel 内的封面（07§4.8），与首玩封面 FP_* 不是一回事
export const COVER_H = 144;
export const ACH_COVER_W = 46;
export const ACH_COVER_H = 69;        // D-12：46×69 是 2:3
