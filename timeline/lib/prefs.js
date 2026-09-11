// 本地持久化偏好（02§4.1：隐藏从未启动的游戏——存 localStorage，后端不存，不做跨设备同步）。

const KEY = 'gamec.timeline.hideNeverLaunched';

/** @returns {boolean} 默认开（02§4.1：囤而未玩的购买点会淹没真正玩过的记录）。 */
export function getHideNeverLaunched() {
  const v = localStorage.getItem(KEY);
  return v === null ? true : v === 'true';
}

/** @param {boolean} value */
export function setHideNeverLaunched(value) {
  localStorage.setItem(KEY, String(value));
}

// ---- 页面背景（05§3.1 v1.4：把任意一张截图 / 封面钉成整页壁纸）----
// 存的是**可直接塞进 CSS background 的值**加一个身份 key，不是 URL：
// 截图缺原图时用的是主题色渐变占位（05§5），那张「图」本来就不是 URL，
// 只认 URL 会让 MOCK 环境根本用不了这个功能。

const BG_KEY = 'gamec.timeline.pageBackground';

/** @returns {{key: string, background: string, label?: string}|null} */
export function getPageBackground() {
  try {
    const raw = localStorage.getItem(BG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;   // 手改坏了 / 旧格式：当没设过，不让一条偏好把整页拖崩
  }
}

/** @param {{key: string, background: string, label?: string}|null} value 传 null 即取消背景 */
export function setPageBackground(value) {
  if (value) localStorage.setItem(BG_KEY, JSON.stringify(value));
  else localStorage.removeItem(BG_KEY);
}

// ---- 视图偏好（07§4.6 / §4.10）：方向、缩放、导航条开关 ----
// 都存 localStorage、都不上后端：它们是「这台机器上我习惯怎么看」，不是账号数据。

const ORIENT_KEY = 'gamec.timeline.orient';
const MINIMAL_KEY = 'gamec.timeline.minimal';
const HIDE_ACH_KEY = 'gamec.timeline.hideAchievements';
const OVERVIEW_KEY = 'gamec.timeline.overview';
const ZOOM_KEY = 'gamec.timeline.pxPerDay';

/** @returns {'h'|'v'} 默认横排（07§4.2 的基准形态）。 */
export function getOrientPref() {
  return localStorage.getItem(ORIENT_KEY) === 'v' ? 'v' : 'h';
}
export function setOrientPref(v) { localStorage.setItem(ORIENT_KEY, v === 'v' ? 'v' : 'h'); }

/**
 * 精简模式：屏蔽成就图标与截图缩略图，轴上只留事件图标与开局封面。
 * @returns {boolean} 默认关——第一次来的人应该先看到全部内容，再自己决定要不要收起来。
 */
export function getMinimalPref() {
  return localStorage.getItem(MINIMAL_KEY) === 'on';
}
export function setMinimalPref(on) { localStorage.setItem(MINIMAL_KEY, on ? 'on' : 'off'); }

/**
 * 隐藏成就：成就事件整类不进轴（图标、`×N`、图标簇一起不出现）。
 *
 * 与「精简模式」是两件事，别混：精简屏蔽的是**图像内容**（成就图标簇 + 截图面板），
 * 事件图标照留；这个开关屏蔽的是**成就这一整类事件**。真实库里成就占了绝大多数时点，
 * 关掉它之后轴上剩下的就是购买 / 首玩 / 发售 / 截图这几条主线。
 * @returns {boolean} 默认关。
 */
export function getHideAchPref() {
  return localStorage.getItem(HIDE_ACH_KEY) === 'on';
}
export function setHideAchPref(on) { localStorage.setItem(HIDE_ACH_KEY, on ? 'on' : 'off'); }

/** @returns {boolean} 全景导航条默认开。 */
export function getOverviewPref() {
  return localStorage.getItem(OVERVIEW_KEY) !== 'off';
}
export function setOverviewPref(on) { localStorage.setItem(OVERVIEW_KEY, on ? 'on' : 'off'); }

/** @returns {number} 上次的 px/天；没存过时返回 NaN，交给调用方夹到默认值。 */
export function getZoomPref() {
  return Number(localStorage.getItem(ZOOM_KEY)) || NaN;
}
export function setZoomPref(v) { localStorage.setItem(ZOOM_KEY, String(v)); }
