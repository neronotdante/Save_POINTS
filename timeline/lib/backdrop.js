// 整页背景层（05§3.1 v1.4）：把某一张截图 / 封面钉成整个页面的壁纸。
//
// 为什么这是**恢复**而不是新增：05§3.1 里 `--bg-fallback` 的说明一直是「系统不支持
// 透明时的**实心兜底**」，`--panel-ref` 更直接写着「L2 玻璃在**浅壁纸**上的等效底色」，
// §3.3 也留着「换成深色壁纸，固定色事件点的对比度会掉，轮廓只能靠压边」。
// 也就是说整套对比度体系从一开始就是按「底下有一张壁纸」算的，只是 V0.1 改浏览器基准
// 之后没人把壁纸落地。这里落地它。
//
// ⚠️ 洗白层的 .88 是**算出来的，不是调出来的**：底图最坏情况是一张纯黑图，
// 洗白后等效底色 = 0.12×0 + 0.88×242 ≈ 213（#D5D5D5）。`--accent` #2F6BFF 在它上面
// 实算 3.07:1，压着 05§3.4 的「≥ 3:1」护栏过线。**调低这个值 = 直接作废 §3.4 的全部验算**。
// 取值与验算写在 styles.css 的 `#page-backdrop` 一段，要改先回 05§3.1 重算最坏情况。

import { getPageBackground, setPageBackground } from './prefs.js';

let root = null;
let baseEl = null;
let imgEl = null;
let current = null;
const subs = new Set();

/**
 * `cover` 最多允许浪费多少（放大倍数之比）。
 *
 * 1.5 = 「裁掉三分之一以内还算居中，超过就不是了」。这个档不是随手定的：
 *   · 截图 16:9 铺进 16:10 的屏 → 1.11，cover，铺满且几乎不损失；
 *   · 竖版封面 2:3 铺进 16:10 的屏 → 2.4，要放大 2.64 倍才能填满宽度，看得见的只剩原图
 *     正中那 42% 的高度——游戏名和主视觉全裁在框外。几何上它**确实**是居中的
 *     （background-position 实测 50% 50%），看上去却完全不像，因为能看到的那一条并不是
 *     这张图的中心内容。这种时候 contain 才是「居中」这个词的意思。
 */
const COVER_WASTE_MAX = 1.5;

/** @param {number|undefined} aspect 素材自身宽高比 @returns {'cover'|'contain'} */
function fitOf(aspect) {
  if (!(aspect > 0)) return 'cover';        // 老存档没有这个字段，维持原行为
  const view = (window.innerWidth || 1) / (window.innerHeight || 1);
  return Math.max(aspect / view, view / aspect) > COVER_WASTE_MAX ? 'contain' : 'cover';
}

function build() {
  if (root) return;
  root = document.createElement('div');
  root.id = 'page-backdrop';
  root.setAttribute('aria-hidden', 'true');
  // 底色层与图层分开：contain 时四周露出来的是**同一张图放大糊掉的样子**（播放器填黑边的
  // 老办法），不是一整片高饱和的主题色——主题色那版实测太抢，一张竖封面会把整页染成粉红
  baseEl = document.createElement('div');
  baseEl.className = 'bd-base';
  imgEl = document.createElement('div');
  imgEl.className = 'bd-img';
  const wash = document.createElement('div');
  wash.className = 'bd-wash';
  root.append(baseEl, imgEl, wash);
  // 插到最前面：它是**页面的底**，不是浮在内容上的遮罩
  document.body.insertBefore(root, document.body.firstChild);
  // 铺法取决于视口比例，拉窗口就得重算（只改一个属性，不必节流）
  window.addEventListener('resize', () => {
    if (current) imgEl.style.backgroundSize = fitOf(current.aspect);
  });
}

function paint() {
  build();
  if (current) {
    // 真图走 `image`：截图素材的 `background` 只是一层主题色渐变（真图在 image 里，见
    // timeline.js::shotSlide）——只铺 background 的话，「设为页面背景」把一张截图钉上去，
    // 铺出来的是**一块纯色**，一个像素的截图都没有，而且不报错。
    // 底层 = 同一张图铺满（cover）+ 主题色兜底；两层都由样式表统一 cover / center。
    // 图挂了就只剩底色，和之前一样，不会变成一块空白。
    const tint = current.tint || current.background || '';
    baseEl.style.backgroundImage = current.image
      ? (tint ? `url("${current.image}"), ${tint}` : `url("${current.image}")`)
      : tint;
    // ⚠️ backgroundImage，不是 background 简写：简写会把样式表里的 position / repeat
    // 一并重置，而且写在行内盖不回来（同 panel.js 的 .hp-bg、timeline.js 的成就图标）。
    imgEl.style.backgroundImage = current.image ? `url("${current.image}")` : '';
    imgEl.style.backgroundSize = fitOf(current.aspect);
    root.classList.add('on');
  } else {
    baseEl.style.backgroundImage = '';
    imgEl.style.backgroundImage = '';
    root.classList.remove('on');
  }
  subs.forEach((fn) => fn(current));
}

/** 进程启动时恢复上次设过的背景（偏好在 localStorage，不跨设备）。 */
export function init() {
  current = getPageBackground();
  paint();
}

/** @returns {{key:string, background:string, tint?:string, image?:string,
 *              aspect?:number, label?:string}|null} */
export function get() {
  return current;
}

/** @param {string} key @returns {boolean} 该素材是不是当前背景 */
export function isCurrent(key) {
  return !!current && current.key === key;
}

/**
 * 设为整页背景；传 null 取消。
 * @param {{key:string, background:string, tint?:string, image?:string,
 *          aspect?:number, label?:string}|null} value
 */
export function set(value) {
  current = value ?? null;
  setPageBackground(current);
  paint();
}

/** 已是当前背景就取消，否则设上——「设为背景」按钮的开关语义。 */
export function toggle(value) {
  set(isCurrent(value.key) ? null : value);
}

/** @param {(bg: any) => void} fn @returns {() => void} 取消订阅 */
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/**
 * 灯箱里那颗「设为页面背景」按钮的定义（lib/lightbox.js 的 actions 形状）。
 * 放在这里而不是各调用方各写一份：它的两态文案与判定跟背景状态是同一件事。
 * @returns {{label:(s:any)=>string, active:(s:any)=>boolean, onClick:(s:any)=>void}}
 */
export function lightboxAction() {
  return {
    label: (s) => (isCurrent(s?.key) ? '取消页面背景' : '设为页面背景'),
    active: (s) => isCurrent(s?.key),
    // 整张素材都要带走：`image` 是真图（不带它就只铺到底色），`aspect` 决定铺法（见 fitOf），
    // `tint` 是 contain 时四周那圈底色。只带 background 的那版正是「截图设成背景后没有图」的来源。
    onClick: (s) => {
      if (!s?.key) return;
      toggle({
        key: s.key, background: s.background, tint: s.tint,
        image: s.image, aspect: s.aspect, label: s.label,
      });
    },
  };
}
