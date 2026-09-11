// 封面轮播组件（07 V1）：面板里那块可滚的封面。
//
// 两种用法共用同一实现：
//   · 游戏形态（96×144）——轨道里是**同一款游戏的多张封面**，下方配圆点；
//   · 成就形态（46×69）——轨道里是**同一时点的多款游戏**，右上角配 N/M 计数 chip，
//     切换时由调用方在 onSlide 里换掉面板正文。
// 交互：滚轮/方向键切页，点击（或 Enter/空格）进灯箱，灯箱里的翻页会回灌到这里。

import * as Lightbox from './lightbox.js';
import { lightboxAction } from './backdrop.js';

const WHEEL_THRESHOLD = 28;   // 攒够多少像素走一格
const WHEEL_COOLDOWN = 260;   // 或者距上次多久之后放行一格

/**
 * @param {{slides: Array<{background:string,label?:string}>, width:number, height:number,
 *          radius?:number, dots?:boolean, chip?:boolean, labelSize?:number,
 *          ariaLabel?:string, onSlide?:(i:number)=>void}} opts
 * @returns {{frame: HTMLElement, dots: HTMLElement|null, index: () => number, destroy: () => void}}
 */
export function createCarousel(opts) {
  const {
    slides, width, height, radius = 10, dots = false, chip = false,
    labelSize = width > 60 ? 13 : 11, ariaLabel, onSlide,
  } = opts;

  let index = 0;
  let acc = 0;
  let lastStep = 0;

  const frame = document.createElement('div');
  frame.className = 'cover-frame';
  frame.tabIndex = 0;
  frame.setAttribute('role', 'button');
  frame.style.cssText = `width:${width}px;height:${height}px;border-radius:${radius}px;`;
  const many = slides.length > 1;
  frame.title = many ? '滚轮切换 · 点击放大' : '点击放大';
  frame.setAttribute('aria-label',
    ariaLabel ?? (many ? `封面，共 ${slides.length} 张：滚轮切换，点击放大` : '封面：点击放大'));

  const track = document.createElement('div');
  track.className = 'cover-track';
  track.style.width = `${width}px`;
  for (const s of slides) {
    const el = document.createElement('div');
    el.className = 'cover-slide';
    el.style.cssText = `width:${width}px;background:${s.background};padding-bottom:${width > 60 ? 6 : 4}px;`;
    if (s.label) {
      const t = document.createElement('span');
      t.className = 'num';
      t.style.fontSize = `${labelSize}px`;
      t.textContent = s.label;
      el.appendChild(t);
    }
    track.appendChild(el);
  }
  frame.appendChild(track);

  let chipEl = null;
  if (chip && many) {
    chipEl = document.createElement('span');
    chipEl.className = 'cover-chip';
    frame.appendChild(chipEl);
  }

  let dotsEl = null;
  if (dots && many) {
    dotsEl = document.createElement('div');
    dotsEl.className = 'cover-dots';
    for (let i = 0; i < slides.length; i++) {
      const d = document.createElement('span');
      d.className = 'cdot' + (i === 0 ? ' on' : '');
      dotsEl.appendChild(d);
    }
  }

  function paint() {
    track.style.transform = `translateX(${-index * width}px)`;
    if (chipEl) chipEl.textContent = `${index + 1}/${slides.length}`;
    if (dotsEl) [...dotsEl.children].forEach((d, i) => d.classList.toggle('on', i === index));
  }
  paint();

  function goto(next, notify = true) {
    if (!many) return;
    index = (next + slides.length) % slides.length;
    paint();
    if (notify) onSlide?.(index);
  }

  function onWheel(ev) {
    if (!many) return;
    ev.preventDefault();
    ev.stopPropagation();   // 别把滚轮透给时间轴，否则切封面顺带把轴也平移了
    const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    acc += d;
    if (Math.abs(acc) >= WHEEL_THRESHOLD || (acc !== 0 && Date.now() - lastStep >= WHEEL_COOLDOWN)) {
      const dir = acc > 0 ? 1 : -1;
      acc = 0;
      lastStep = Date.now();
      goto(index + dir);
    }
  }

  function openLightbox() {
    Lightbox.open({
      slides, index, returnFocusTo: frame,
      // 封面在灯箱里也能一键钉成整页壁纸（与轴下方的截图 / 首玩封面同一颗按钮）
      actions: slides[0]?.key ? [lightboxAction()] : [],
      // 灯箱里翻页时把小图也带过去，关掉后两边停在同一张
      onIndex: (i) => goto(i),
    });
  }

  frame.addEventListener('wheel', onWheel, { passive: false });
  frame.addEventListener('click', openLightbox);
  frame.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') { ev.preventDefault(); goto(index + 1); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') { ev.preventDefault(); goto(index - 1); }
    else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openLightbox(); }
  });

  return {
    frame,
    dots: dotsEl,
    index: () => index,
    destroy() { frame.removeEventListener('wheel', onWheel); },
  };
}
