/**
 * 液态玻璃的运行期驱动 ——「液态玻璃实现文档」§15（定稿）。
 *
 * 两件事，按依赖顺序：
 *   1. 把壁纸贴成 L0。桌面在 DWM 的合成范畴里，Chromium 采样不到；取进页面
 *      之后 backdrop-filter 才有背景可采，模糊才是真的（§13.4）。
 *   2. 按面板下方那块壁纸的平均色，解出填充 alpha 与 --text-3 的 alpha，
 *      而不是用一个迁就最坏情况的常数（§13.4 / §14.4 ③）。
 *
 * 曾经有第三件（feDisplacementMap 折射，§13.5 P2）——**已按 §15.3 删除**。
 * 链路是对的，但位移必须限幅在「到边界的距离」以内（面板外是真透明，采过去
 * 就是透明像素），峰值只有 ~12px，作用在 blur(24px) 的场上等于没有：实测折射带
 * 的逐像素差 3.0，而中性区的重采样噪声地板就有 2.1。**别再加回来**，除非先放弃
 * 「面板外真透明」。边缘的玻璃感由 CSS 的 --glass-bezel 光学带承担。
 *
 * 任何一步失败都静默降级：不加 body class，CSS 原样回落到 v1 的取值。
 * 这是刻意的 —— 玻璃是装饰层，它坏掉不该让日历不可读。
 */
(function () {
  'use strict';

  const PANEL_WIDTH = 668;
  const PANEL_HEIGHT = 768;
  const PANEL_RADIUS = 26;

  /* ===== 自适应填充区间（06 §15.2，定稿） =====
     **这两个数是实测倒推的，不是审美偏好，改之前先读 §15.1。**

     上限 .65：纯黑壁纸（最坏情况，自适应必然取到上限）下实测
       .65 → text-2 3.18 / text-3 3.00  PASS
       .62 → text-2 3.04 / text-3 2.92  FAIL
     再低一档，--text-3 的自适应撞上 .60 的层级上限（不能越过 --text-2 的 .62）
     之后就补不动了，--text-2 自己也跟着破线，两条同时失守。

     下限 .45：对应亮壁纸，此时面板等效底色就是纯白，对比度不受影响，
     所以下限只受观感约束，取到透光率 53.2% 这一档。 */
  const ALPHA_DARK = .65;
  const ALPHA_LIGHT = .45;

  const el = {
    l0: null,
  };

  let geometry = null;   // 面板此刻在屏幕上的位置（主进程推送）
  let wallpaper = null;  // 当前壁纸位图（主进程推送）
  let wallpaperImg = null;

  /* ================================================================
     壁纸映射：五种填充方式各算一遍（06 §13.6.2）

     全程在 DIP 空间里算 —— display.bounds 和窗口 bounds 都是 DIP，
     所以混合 DPI 的多显示器不需要额外一套换算。只有 center / tile 例外：
     Windows 那两种模式按**物理像素** 1:1 放图，要先除以 scaleFactor。
     ================================================================ */
  function computeLayout(mode, natural, target, scaleFactor) {
    const nw = natural.width;
    const nh = natural.height;
    const tw = target.width;
    const th = target.height;
    if (!nw || !nh || !tw || !th) return null;

    switch (mode) {
      case 'stretch': {
        return { w: tw, h: th, x: 0, y: 0, repeat: false };
      }
      case 'fit': {           // 适应 = contain，留白露出桌面背景色
        const s = Math.min(tw / nw, th / nh);
        const w = nw * s;
        const h = nh * s;
        return { w, h, x: (tw - w) / 2, y: (th - h) / 2, repeat: false };
      }
      case 'center': {        // 原尺寸居中，按物理像素 1:1
        const w = nw / scaleFactor;
        const h = nh / scaleFactor;
        return { w, h, x: (tw - w) / 2, y: (th - h) / 2, repeat: false };
      }
      case 'tile': {          // 从桌面原点起平铺，同样按物理像素 1:1
        const w = nw / scaleFactor;
        const h = nh / scaleFactor;
        return { w, h, x: 0, y: 0, repeat: true };
      }
      case 'fill':            // 填充 = cover
      case 'span':            // 跨区：target 换成所有显示器的联合矩形，算法同 cover
      default: {
        const s = Math.max(tw / nw, th / nh);
        const w = nw * s;
        const h = nh * s;
        return { w, h, x: (tw - w) / 2, y: (th - h) / 2, repeat: false };
      }
    }
  }

  /** 壁纸铺在哪个矩形里：span 铺满整个桌面，其余每块屏各铺一张 */
  function targetRect(mode, geo) {
    if (mode === 'span' && geo.desktop && Number.isFinite(geo.desktop.x)) {
      return {
        x: geo.desktop.x,
        y: geo.desktop.y,
        width: geo.desktop.right - geo.desktop.x,
        height: geo.desktop.bottom - geo.desktop.y,
      };
    }
    return geo.display;
  }

  /**
   * @returns 壁纸相对**面板左上角**的绘制矩形（CSS 像素），直接可写进
   *          background-size / background-position。
   */
  function panelLayout() {
    if (!wallpaper || !geometry || wallpaper.kind !== 'image') return null;

    const target = targetRect(wallpaper.mode, geometry);
    const layout = computeLayout(
      wallpaper.mode,
      { width: wallpaper.naturalWidth, height: wallpaper.naturalHeight },
      target,
      geometry.display.scaleFactor || 1
    );
    if (!layout) return null;

    return {
      w: layout.w,
      h: layout.h,
      // 壁纸原点在屏幕上的绝对坐标 → 换算成面板局部坐标
      x: target.x + layout.x - geometry.panel.x,
      y: target.y + layout.y - geometry.panel.y,
      repeat: layout.repeat,
    };
  }

  function applyWallpaper() {
    if (!el.l0) return;

    if (!wallpaper) {                      // 取不到 → 保持 v1 外观
      el.l0.style.backgroundImage = '';
      el.l0.style.backgroundColor = '';
      document.body.classList.remove('has-wallpaper');
      return;
    }

    if (wallpaper.kind === 'color') {
      // 纯色壁纸：没必要贴图，整条链路短路（06 §13.6.3）。
      // 但玻璃仍然要透 —— 有了这块纯色，backdrop-filter 依旧有东西可采。
      el.l0.style.backgroundImage = 'none';
      el.l0.style.backgroundColor = wallpaper.color;
      document.body.classList.add('has-wallpaper');
      applyAdaptiveTokens(hexToRgb(wallpaper.color));
      return;
    }

    const layout = panelLayout();
    if (!layout) return;

    el.l0.style.backgroundImage = 'url("' + wallpaper.dataUrl + '")';
    el.l0.style.backgroundColor = 'transparent';
    el.l0.style.backgroundRepeat = layout.repeat ? 'repeat' : 'no-repeat';
    el.l0.style.backgroundSize = layout.w.toFixed(2) + 'px ' + layout.h.toFixed(2) + 'px';
    el.l0.style.backgroundPosition = layout.x.toFixed(2) + 'px ' + layout.y.toFixed(2) + 'px';
    document.body.classList.add('has-wallpaper');
  }

  /* ================================================================
     自适应填充（06 §13.4）
     既然壁纸位图已经在手里，就没有理由再用一个迁就最坏情况的常数。
     ================================================================ */

  function srgbToLinear(c) {
    const v = c / 255;
    return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4);
  }

  /** WCAG 相对亮度。用它而不是感知亮度，因为下游要回答的正是「对比度够不够」 */
  function relativeLuminance(r, g, b) {
    return .2126 * srgbToLinear(r) + .7152 * srgbToLinear(g) + .0722 * srgbToLinear(b);
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return { r: 128, g: 128, b: 128 };
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  /*
   * 验收用的锁定开关。透光率是「同一布局下纯白壁纸与纯黑壁纸的面板均值之差」，
   * 而自适应恰恰会把这两端往中间拉 —— 不锁住 alpha 就量不到这条链路本身的
   * 透光能力，只会量到自适应曲线的斜率。
   */
  let alphaLocked = false;

  function contrastRatio(l1, l2) {
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + .05) / (lo + .05);
  }

  /* --text-1 / --text-2 / --text-3 共用的墨色，与 CSS 里的取值一致 */
  const INK = { r: 23, g: 32, b: 46 };

  /**
   * 求「压在 panel 底色上、刚好守住 target:1 的最小 alpha」。
   *
   * 为什么需要这一步：v1 的 --text-3 是常数 .50，那是按固定基准 --panel-ref
   * (#F2F4F8) 倒推出来的。v2 的面板底色不再固定 —— 深色壁纸下自适应会把
   * --glass-alpha 抬到 .72，等效底色掉到 ~#B8B8B8，.50 的 --text-3 实算只有
   * 2.42:1，低于 05 §6 的红线（那里只允许 --text-muted 破 3:1）。
   * 既然自适应机制已经在了，就把文字层也接进去，而不是留一条静默违规。
   *
   * 上限 .60 是硬的：--text-2 是 .62，越过去就没有层级可言了。
   */
  function solveTextAlpha(panel, target, lo, hi) {
    const lp = relativeLuminance(panel.r, panel.g, panel.b);
    const over = (a) => relativeLuminance(
      panel.r * (1 - a) + INK.r * a,
      panel.g * (1 - a) + INK.g * a,
      panel.b * (1 - a) + INK.b * a
    );
    if (contrastRatio(lp, over(lo)) >= target) return lo;   // 亮壁纸下 .50 本来就够
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (contrastRatio(lp, over(mid)) >= target) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  /**
   * 一次算完所有跟着壁纸走的取值。
   * @param {{r:number,g:number,b:number}} avg 面板下方那块壁纸的平均色
   */
  function applyAdaptiveTokens(avg) {
    if (alphaLocked) return;

    // 亮壁纸取低、暗壁纸取高
    const luminance = Math.max(0, Math.min(1, relativeLuminance(avg.r, avg.g, avg.b)));
    const a = ALPHA_DARK + (ALPHA_LIGHT - ALPHA_DARK) * luminance;
    document.documentElement.style.setProperty('--glass-alpha', a.toFixed(3));

    // 面板等效底色 = 白 alpha 压在壁纸均值上（--glass-l2-fill 的主体段）
    const panel = {
      r: 255 * a + avg.r * (1 - a),
      g: 255 * a + avg.g * (1 - a),
      b: 255 * a + avg.b * (1 - a),
    };
    const textAlpha = solveTextAlpha(panel, 3.0, .50, .60);
    document.documentElement.style.setProperty('--text-3-alpha', textAlpha.toFixed(3));

    panelBackdrop = panel;
    textAlphas = { text1: 1, text2: .62, text3: textAlpha };
  }

  let panelBackdrop = null;
  let textAlphas = null;

  /** 验收读这个：面板此刻的真实底色下，三级文字各自的实算对比度 */
  function measuredContrast() {
    if (!panelBackdrop || !textAlphas) return null;
    const lp = relativeLuminance(panelBackdrop.r, panelBackdrop.g, panelBackdrop.b);
    const out = { panelHex: rgbToHex(panelBackdrop) };
    for (const key of Object.keys(textAlphas)) {
      const a = textAlphas[key];
      out[key] = Number(contrastRatio(lp, relativeLuminance(
        panelBackdrop.r * (1 - a) + INK.r * a,
        panelBackdrop.g * (1 - a) + INK.g * a,
        panelBackdrop.b * (1 - a) + INK.b * a
      )).toFixed(2));
    }
    return out;
  }

  function rgbToHex(c) {
    return '#' + [c.r, c.g, c.b]
      .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'))
      .join('').toUpperCase();
  }

  /**
   * 把 L0 按最终布局重画一遍到一张 1/8 的小画布，直接量平均亮度。
   * 比「反推面板对应壁纸的哪几个像素」简单得多，也不会在 fit 模式的留白、
   * tile 模式的接缝上算错 —— 画出来是什么就量什么。
   */
  function measureLuminance() {
    if (!wallpaperImg || !wallpaper || wallpaper.kind !== 'image') return;
    const layout = panelLayout();
    if (!layout) return;

    const S = 8;
    const cw = Math.round(PANEL_WIDTH / S);
    const ch = Math.round(PANEL_HEIGHT / S);
    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    if (layout.repeat) {
      const tile = document.createElement('canvas');
      tile.width = Math.max(1, Math.round(layout.w / S));
      tile.height = Math.max(1, Math.round(layout.h / S));
      tile.getContext('2d').drawImage(wallpaperImg, 0, 0, tile.width, tile.height);
      const pattern = ctx.createPattern(tile, 'repeat');
      ctx.translate(layout.x / S, layout.y / S);
      ctx.fillStyle = pattern;
      ctx.fillRect(-layout.x / S, -layout.y / S, cw, ch);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      ctx.drawImage(wallpaperImg, layout.x / S, layout.y / S, layout.w / S, layout.h / S);
    }

    let data;
    try {
      data = ctx.getImageData(0, 0, cw, ch).data;
    } catch (err) {
      return; // data: URI 不该污染画布，真出事了就保持上一次的 alpha
    }

    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      // fit 模式的留白是透明像素，不该拉低平均值 —— 跳过
      if (data[i + 3] < 8) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2];
      n++;
    }
    if (n === 0) return;
    applyAdaptiveTokens({ r: r / n, g: g / n, b: b / n });
  }

  /* ================================================================
     生命周期
     ================================================================ */

  function loadWallpaperImage(next) {
    if (!next || next.kind !== 'image') {
      wallpaperImg = null;
      wallpaper = next;
      applyWallpaper();
      return;
    }
    const img = new Image();
    img.onload = function () {
      wallpaperImg = img;
      wallpaper = next;
      applyWallpaper();
      measureLuminance();
    };
    img.onerror = function () { /* 解不出来就维持现状，不降级已经生效的玻璃 */ };
    img.src = next.dataUrl;
  }

  function init() {
    el.l0 = document.getElementById('glass-l0');

    const api = window.gameCalendar;
    if (!api || !api.getWallpaper) return;   // 非 Electron / 旧 preload → 保持 v1

    api.getWallpaper()
      .then(function (res) {
        if (!res) return;
        geometry = res.geometry;
        loadWallpaperImage(res.wallpaper);
      })
      .catch(function () { /* 主进程那头出错就降级，不打断日历渲染 */ });

    if (api.onGeometry) {
      api.onGeometry(function (next) {
        geometry = next;
        applyWallpaper();     // 窗口移动只重算 position，不重新取图
        measureLuminance();   // 挪到亮 / 暗区域时填充跟着走
      });
    }

    if (api.onWallpaperChanged) {
      api.onWallpaperChanged(function (next) { loadWallpaperImage(next); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 冒烟自检要读这些（main.js 的 SHOT 分支）
  window.__glass = {
    get state() {
      return {
        kind: wallpaper ? wallpaper.kind : null,
        mode: wallpaper ? wallpaper.mode : null,
        alpha: getComputedStyle(document.documentElement).getPropertyValue('--glass-alpha').trim(),
        hasWallpaper: document.body.classList.contains('has-wallpaper'),
        textAlpha: getComputedStyle(document.documentElement).getPropertyValue('--text-3-alpha').trim(),
        contrast: measuredContrast(),
        layout: panelLayout(),
      };
    },
    computeLayout: computeLayout,
    /** 验收专用：钉死填充 alpha，让透光率量的是链路而不是自适应曲线 */
    lockAlpha: function (value) {
      alphaLocked = true;
      document.documentElement.style.setProperty('--glass-alpha', String(value));
    },
  };
})();
