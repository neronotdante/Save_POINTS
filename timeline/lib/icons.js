// 图标词汇表（05§5 / 05§6 第6条）：内联 SVG 描边图标，24 视口，stroke-width 1.8~2，round 端点。
// 与 GAMEC/canvas/范式B/build_timeline.py 的 ICON 表一一对应，保证画板与实现视觉一致。

const PATHS = {
  play: '<path d="M8 5.4 19 12 8 18.6Z"/>',
  cart: '<circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17.5" cy="19.5" r="1.3"/><path d="M2.8 4h2.4l2.4 11.1a1.6 1.6 0 0 0 1.6 1.3h7.7a1.6 1.6 0 0 0 1.6-1.3L20.6 8.2H6"/>',
  key: '<circle cx="7.8" cy="12" r="3.7"/><path d="M11.5 12H21"/><path d="M17.6 12v3.1"/><path d="M20.4 12v2.1"/>',
  cal: '<rect x="3.5" y="5.2" width="17" height="15.3" rx="2.6"/><path d="M3.5 10.2h17M8 3.4v3.4M16 3.4v3.4"/>',
  // 截图 = 相机。轴上原本没有截图这一类 unit（截图只在轴外侧铺缩略图），
  // 屏蔽掉缩略图之后「只有截图的那些日子」会整个从轴上消失，所以得给它一个自己的图标。
  camera: '<path d="M3 8.4a2 2 0 0 1 2-2h2.1l1.2-2h7.4l1.2 2H19a2 2 0 0 1 2 2v9.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.8" r="3.4"/>',
  // 隐藏成就开关：钥匙 + 斜杠（与 imagesOff 同一个「划掉」语汇）
  keyOff: '<circle cx="7.8" cy="12" r="3.7"/><path d="M11.5 12H21"/><path d="M17.6 12v3.1"/><path d="M20.4 12v2.1"/><path d="M3.6 20.4 20.4 3.6"/>',
  // 屏蔽开关：一张被斜杠划掉的图片
  imagesOff: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.6"/><path d="M3.8 16.4 8.6 11.8l3.2 3M15.4 13.2l1.6-1.5 3.2 3"/><circle cx="9.1" cy="9.1" r="1.2"/><path d="M4 20 20 4"/>',
  chevL: '<path d="M14.6 6.4 9 12l5.6 5.6"/>',
  chevR: '<path d="M9.4 6.4 15 12l-5.6 5.6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  // 全景导航条开关：一排高低不齐的柱子，和条上画的东西同构
  chart: '<path d="M4 20V11M9.5 20V5M15 20v-7M20.5 20v-3"/>',
  // 方向切换：当前形态画什么就是什么——横排一条横轴带三根刺，竖排转 90°
  layoutH: '<path d="M3 12h18"/><path d="M7.5 12V7.5M12 12V6M16.5 12V9"/>',
  layoutV: '<path d="M12 3v18"/><path d="M12 7.5H7.5M12 12H6M12 16.5H9"/>',
  download: '<path d="M12 3.6v10.8M7.8 10.6 12 14.8l4.2-4.2"/><path d="M4.6 16.4v2.2a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-2.2"/>',
  // 齿轮用连续齿廓路径（V1 原型同款）：44px 浮动按钮下短齿画法会糊成一团
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};

/** 事件类型 → 图标名（05§6 第6条：首玩=play、成就=key、发售=cal、购买=cart）。 */
export const EVENT_ICON = {
  first_play: 'play',
  achievement: 'key',
  release: 'cal',
  purchase: 'cart',
  screenshot: 'camera',
};

/**
 * 渲染一个内联 SVG 图标字符串。
 * @param {keyof typeof PATHS} name
 * @param {number} [size=14]
 * @param {number} [strokeWidth=1.8]
 * @returns {string}
 */
export function svg(name, size = 14, strokeWidth = 1.8) {
  const path = PATHS[name];
  if (!path) throw new Error(`unknown icon: ${name}`);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
