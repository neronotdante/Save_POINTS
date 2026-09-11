// 游戏主题色规范化与对比度验算（05§3.4）。纯函数，供 mock-data.js 生成数据、以及未来后端同步期复用逻辑参考。

export const PANEL_REF = '#F2F4F8';           // 对比度计算基准（05§3.1）
export const FALLBACK_COLOR = '#6D4AE0';      // --ev-achieve-fallback（05§3.3）
const MIN_CONTRAST = 3;

function hexToRgb(hex) {
  const c = hex.replace('#', '');
  return {
    r: parseInt(c.slice(0, 2), 16),
    g: parseInt(c.slice(2, 4), 16),
    b: parseInt(c.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  const h = (n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  return { h: h * 60, s, l };
}

function hslToRgb({ h, s, l }) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = l * 255; return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: hue2rgb(h + 1 / 3) * 255,
    g: hue2rgb(h) * 255,
    b: hue2rgb(h - 1 / 3) * 255,
  };
}

function relativeLuminance({ r, g, b }) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 对比度（1~21）。 */
export function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexToRgb(hexA));
  const lb = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * 规范化封面主色（05§3.4「规范化」1~4条）：保持色相，钳制饱和度35~85%、亮度32~50%，
 * 对 PANEL_REF 验算对比度不足 3:1 时以4%步长降亮度（下限24%），仍不足则回退。
 * @param {string} hex 输入的原始主色（#RRGGBB）
 * @returns {{ color: string, source: 'api'|'local', usedFallback: boolean }}
 */
export function normalizeThemeColor(hex) {
  const hsl = rgbToHsl(hexToRgb(hex));
  let s = clamp(hsl.s, 0.35, 0.85);
  let l = clamp(hsl.l, 0.32, 0.50);
  let color = rgbToHex(hslToRgb({ h: hsl.h, s, l }));

  while (contrastRatio(color, PANEL_REF) < MIN_CONTRAST && l > 0.24) {
    l = Math.max(0.24, l - 0.04);
    color = rgbToHex(hslToRgb({ h: hsl.h, s, l }));
  }

  if (contrastRatio(color, PANEL_REF) < MIN_CONTRAST) {
    return { color: FALLBACK_COLOR, source: 'local', usedFallback: true };
  }
  return { color, source: 'local', usedFallback: false };
}

/** 两个颜色在轴上「看起来是同一个」：色相接近**且**明度也接近。 */
function looksSame(hexA, hexB) {
  const a = rgbToHsl(hexToRgb(hexA) ?? { r: 0, g: 0, b: 0 });
  const b = rgbToHsl(hexToRgb(hexB) ?? { r: 0, g: 0, b: 0 });
  const dh = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h));
  // 只看色相不够：拉开明度之后色相仍然相同，那时它们已经能分辨了，不该再判成冲突
  return dh < 20 && Math.abs(a.l - b.l) < 0.06;
}

/**
 * 同一时点内多款游戏的颜色去重（05§3.4「去重」）。
 *
 * 为什么必须做：取色失败的游戏**全部回退到同一个 `#6D4AE0`**。同一天两款游戏首玩时，
 * 轴上就是两个一模一样的紫色 play 图标——看起来像「同一个游戏画了两次」，
 * 而 05 总则 6「颜色只有一处个性化」的辨识作用完全失效。
 *
 * 与原规则的两点出入，都是原文在实际数据下不成立才改的：
 * 1. **逐级累进**降 L，不是每次都从原色减 8%——三个同色时后两个会被调成同一个值；
 * 2. 冲突判据加上明度：降过 L 之后色相当然还一样，但已经能分辨了，不该再算冲突。
 *    原文「仍冲突则第二个改用回退色」在「两个本来就都是回退色」时无解，故不采用。
 *
 * @param {string[]} colors 按出现顺序（同组内的 unit 顺序）
 * @returns {string[]} 等长，逐个拉开后的颜色
 */
export function dedupeThemeColors(colors) {
  const result = [];
  for (const raw of colors) {
    const rgb = hexToRgb(raw);
    if (!rgb) { result.push(FALLBACK_COLOR); continue; }
    const base = rgbToHsl(rgb);
    let l = base.l;
    let candidate = raw;
    // 下限 24%（05§3.4 的 L 下限）；降 L 只会提高对浅底的对比度，不必再验对比度
    while (result.some((c) => looksSame(c, candidate)) && l > 0.24) {
      l = Math.max(0.24, l - 0.08);
      candidate = rgbToHex(hslToRgb({ h: base.h, s: base.s, l }));
    }
    result.push(candidate);
  }
  return result;
}
