// 坐标层——全页唯一坐标真源（07§4.3「变化坐标」/ 01§2A「A.3 坐标层」）。
// 纯函数、不碰 DOM、UTC 基准（Steam 时间戳是 unix 秒，本地时区只在格式化时套用）。
//
// 接口形状对齐 d3-scale：scale(t) → x，scale.invert(x) → t，scale.ticks(level) → number[]。
// 分段线性：把时间轴按数据密度切成若干段，每段一个 pxPerDay（密段展开、疏段压缩）。

const DAY_MS = 86400_000;

// ---- 无档缩放（07§4.6 v3.2：取消日 / 周 / 月三档，改为连续的 px/天）----
//
// 三档原本是「日 96 / 周 28 / 月 6」px/天。换成连续量之后这三个数不再是**档位**，
// 而是这条连续区间上的三个采样点——所有原来按档位查表的东西（稀疏阈值、刻度粒度、
// 平移步长、ICON 级读数的启用条件）都改成由 px/天现算，见下面几个函数。

/** px/天 的可用区间。1.5 → 十年约 5500px 一屏可览；160 → 一天占满大半屏，再放大没有信息增量。 */
export const ZOOM_MIN = 1.5;
export const ZOOM_MAX = 160;
/** 默认落点：原「月档」的 6 px/天，进来先看全局。 */
export const ZOOM_DEFAULT = 6;

/**
 * 把任意值夹进可用区间。**非有限数一律回落到默认值**——这个函数的入参来自 localStorage
 * （用户存过的偏好、可能被手改坏、也可能压根没存过），`Math.max(1.5, NaN)` 是 NaN，
 * 不拦在这里的话 NaN 会一路流进 scale、轨道长度、刻度，最后整条轴什么都不画。
 */
export const clampZoom = (v) => (Number.isFinite(v) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v)) : ZOOM_DEFAULT);

/**
 * 滚轮 / 按钮的一次缩放：**按比例**而不是按加法。
 * 加法在 6 px/天 时步子太大、在 96 px/天 时又太小；比例缩放在整个区间上手感一致，
 * 也是「无档」的应有之义——任何相邻两次操作之间没有跳变。
 * @param {number} pxPerDay 当前值
 * @param {number} notches 正数放大、负数缩小（一格滚轮≈1）
 */
export function zoomBy(pxPerDay, notches) {
  return clampZoom(pxPerDay * Math.pow(1.18, notches));
}

/**
 * 稀疏压缩的间隔阈值（天）。原来是按档位查表 {日:3, 周:14, 月:45}。
 *
 * **故意做成阶梯而不是连续函数**：这个值决定轴被切成哪些段，连续变化会让分段结构在缩放
 * 过程中不停重组，视觉上是整条轴在抖。阶梯让它只在几个明确的门槛上换一次结构。
 * 三个台阶的取值就是原来那三档的值，所以原有观感不变。
 */
export function gapDaysFor(pxPerDay) {
  if (pxPerDay >= 48) return 3;
  if (pxPerDay >= 16) return 7;
  if (pxPerDay >= 4) return 14;
  return 45;
}

/**
 * 「一个像素跨了好几天」——07§4.8a 的 ICON 级日期读数就是为这种密度存在的。
 * 原条件是 `level === 'month'`，即 6 px/天；这里取 12 px/天作门槛（一天不到 12px 时，
 * 一簇 ICON 的组级面板已经读不出单个事件到底是哪天）。
 */
export const isCoarse = (pxPerDay) => pxPerDay < 12;

/**
 * 刻度粒度阶梯。选**第一个**「一格宽度 ≥ 最小标签间距」的档，
 * 所以缩放时刻度会自己从逐日退到逐周、逐月、逐年，不需要用户换档。
 */
const TICK_STEPS = [
  { unit: 'day', step: 1, days: 1 },
  { unit: 'day', step: 2, days: 2 },
  { unit: 'week', step: 1, days: 7 },
  { unit: 'week', step: 2, days: 14 },
  { unit: 'month', step: 1, days: 30.4 },
  { unit: 'month', step: 3, days: 91 },
  { unit: 'month', step: 6, days: 183 },
  { unit: 'year', step: 1, days: 365 },
  { unit: 'year', step: 2, days: 730 },
  { unit: 'year', step: 5, days: 1826 },
];

/**
 * 当前密度下该用哪一档刻度。
 * @param {number} pxPerDay
 * @param {number} minSpacing 相邻两个标签之间至少要留多少像素（横向要放得下 `2026-07-11`，
 *   纵向标签是叠着排的，只需要放得下一行字，所以两个方向传的值不一样）
 */
export function tickSpecFor(pxPerDay, minSpacing) {
  return TICK_STEPS.find((t) => t.days * pxPerDay >= minSpacing) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

/** 稀疏段压缩后的固定像素宽（07§4.3：一格=一周，退到周级甚至月级），与画板斜纹带宽度量级一致。 */
const SPARSE_SEGMENT_PX = 96;

/**
 * 把一组事件时间戳（unix 秒）按密度切分为 dense/sparse 段。
 * 相邻事件（含今天）时间间隔 > gapDays 视为稀疏段，压缩为固定宽度；否则按 pxPerDay 展开。
 * 分段阈值是 PRD §8 未决项，先给可调参数，交 spike 6b 定（01§9）。
 * @param {number[]} timestamps 已排序或未排序的 unix 秒时间戳（至少含数据首尾与今天）
 * @param {number} pxPerDay 密段的 px/天
 * @param {number} [gapDays=10] 触发稀疏压缩的间隔天数阈值
 * @returns {{t0:number, t1:number, pxPerDay:number, sparse:boolean}[]} 按时间升序的分段列表
 */
export function buildSegments(timestamps, pxPerDay, gapDays = 10) {
  const ts = Array.from(new Set(timestamps)).sort((a, b) => a - b);
  if (ts.length < 2) {
    const t = ts[0] ?? Math.floor(Date.now() / 1000);
    return [{ t0: t - DAY_MS / 1000, t1: t + DAY_MS / 1000, pxPerDay, sparse: false }];
  }
  const segments = [];
  for (let i = 0; i < ts.length - 1; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    const gapInDays = (t1 - t0) / (DAY_MS / 1000);
    segments.push({ t0, t1, pxPerDay, sparse: gapInDays > gapDays });
  }
  return segments;
}

/**
 * 由分段列表构造 scale。
 * @param {{t0:number, t1:number, pxPerDay:number, sparse:boolean}[]} segments
 * @returns {{
 *   (t:number): number,
 *   invert(x:number): number,
 *   ticks(spec:{unit:string, step:number}): number[],
 *   domain(): [number, number],
 * }}
 */
export function createScale(segments) {
  if (!segments.length) throw new Error('createScale: at least one segment required');

  // 预计算每段起点的累计像素偏移，稀疏段用固定宽度而不是 pxPerDay 展开。
  // `seg.minPx`（可选）是内容宽度约束——相邻时点的标记 / 截图组不得重叠（05§1.2）。
  // 它必须在**这一层**生效：坐标层是全页唯一位置真源，渲染层事后推挤会让 scale 与实际
  // 位置脱钩，invert / 缩放锚点 / 头部月份随之全错。
  const boundaries = [0];
  for (const seg of segments) {
    const days = (seg.t1 - seg.t0) / (DAY_MS / 1000);
    const natural = seg.sparse ? SPARSE_SEGMENT_PX : days * seg.pxPerDay;
    const width = Math.max(natural, seg.minPx ?? 0);
    boundaries.push(boundaries[boundaries.length - 1] + width);
  }

  function segmentIndexForTime(t) {
    if (t <= segments[0].t0) return 0;
    for (let i = 0; i < segments.length; i++) {
      if (t <= segments[i].t1) return i;
    }
    return segments.length - 1;
  }

  function scale(t) {
    const i = segmentIndexForTime(t);
    const seg = segments[i];
    const span = seg.t1 - seg.t0;
    const frac = span > 0 ? Math.min(1, Math.max(0, (t - seg.t0) / span)) : 0;
    return boundaries[i] + frac * (boundaries[i + 1] - boundaries[i]);
  }

  function invert(x) {
    if (x <= boundaries[0]) return segments[0].t0;
    let i = 0;
    for (; i < segments.length; i++) {
      if (x <= boundaries[i + 1]) break;
    }
    i = Math.min(i, segments.length - 1);
    const seg = segments[i];
    const segPxWidth = boundaries[i + 1] - boundaries[i];
    const frac = segPxWidth > 0 ? (x - boundaries[i]) / segPxWidth : 0;
    return seg.t0 + frac * (seg.t1 - seg.t0);
  }

  function domain() {
    return [segments[0].t0, segments[segments.length - 1].t1];
  }

  /**
   * 按 tickSpecFor() 选出的粒度出刻度（UTC 基准）。
   * @param {{unit:'day'|'week'|'month'|'year', step:number}} spec
   */
  function ticks(spec) {
    const [d0, d1] = domain();
    const start = new Date(d0 * 1000);
    const out = [];
    const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    if (spec.unit === 'week') {
      const dow = (cur.getUTCDay() + 6) % 7; // 周一为一周首（05/07 通篇口径）
      cur.setUTCDate(cur.getUTCDate() - dow);
    } else if (spec.unit === 'month') {
      cur.setUTCDate(1);
      // 对齐到 step 的整数倍月份，缩放时刻度不会左右横跳
      cur.setUTCMonth(Math.floor(cur.getUTCMonth() / spec.step) * spec.step);
    } else if (spec.unit === 'year') {
      cur.setUTCMonth(0, 1);
      cur.setUTCFullYear(Math.floor(cur.getUTCFullYear() / spec.step) * spec.step);
    }
    let guard = 0;
    while (cur.getTime() / 1000 <= d1 && guard++ < 20000) {
      const t = Math.floor(cur.getTime() / 1000);
      if (t >= d0) out.push(t);
      if (spec.unit === 'day') cur.setUTCDate(cur.getUTCDate() + spec.step);
      else if (spec.unit === 'week') cur.setUTCDate(cur.getUTCDate() + 7 * spec.step);
      else if (spec.unit === 'month') cur.setUTCMonth(cur.getUTCMonth() + spec.step);
      else cur.setUTCFullYear(cur.getUTCFullYear() + spec.step);
    }
    return out;
  }

  scale.invert = invert;
  scale.ticks = ticks;
  scale.domain = domain;
  return scale;
}
