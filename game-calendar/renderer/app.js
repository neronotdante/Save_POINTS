/**
 * 主日历渲染与交互（无后端，事件来自 MockData，同步状态为演示态）。
 */
(function () {
  'use strict';

  const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const WEEKDAYS_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const PILL_RANGE = 18; // 月份条前后各展 18 个月

  /**
   * 类型图标：一律内联 SVG 描边、24 视口、stroke-width 1.8、round 端点（UI 规范 §5）。
   * 首玩 = play，购买 = 购物车，成就 = 钥匙，发售 = 日历（§8.2 原记「待定」，本次定为日历）。
   */
  const ICONS = {
    first_play: '<path d="M7 4.6v14.8L19.4 12 7 4.6z"/>',
    purchase: '<circle cx="9.2" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/>'
      + '<path d="M2.6 3.2h2.7l2.4 12.1a1.6 1.6 0 0 0 1.6 1.3h8.6a1.6 1.6 0 0 0 1.6-1.3L21.4 7H6.1"/>',
    achievement: '<circle cx="8.4" cy="8.4" r="4.6"/><path d="M11.7 11.7 20.6 20.6"/>'
      + '<path d="M17.4 17.4 20 14.8"/><path d="M14.5 14.5 17.1 11.9"/>',
    release: '<rect x="3.4" y="5" width="17.2" height="15.6" rx="2.6"/><path d="M3.4 10.1h17.2"/>'
      + '<path d="M8 3v4"/><path d="M16 3v4"/>',
  };

  // 事件色（UI 规范 §8.2：首玩 / 成就用主题色，购买 / 发售用系统固定色）
  function eventColor(row) {
    if (row.type === 'purchase') return 'var(--ev-purchase)';
    if (row.type === 'release') return 'var(--ev-release)';
    return row.themeColor || 'var(--ev-achieve-fallback)';
  }

  const el = {
    monthNum: document.getElementById('month-num'),
    monthYear: document.getElementById('month-year'),
    btnPrev: document.getElementById('btn-prev'),
    btnNext: document.getElementById('btn-next'),
    pills: document.getElementById('pills'),
    strip: document.querySelector('.month-strip'),
    weekdays: document.getElementById('weekdays'),
    grid: document.getElementById('grid'),
    syncDot: document.getElementById('sync-dot'),
    syncLabel: document.getElementById('sync-label'),
    sheetLayer: document.getElementById('sheet-layer'),
    sheet: document.getElementById('sheet'),
    sheetMask: document.getElementById('sheet-mask'),
    sheetDateNum: document.getElementById('sheet-date-num'),
    sheetDateCap: document.getElementById('sheet-date-cap'),
    sheetMetrics: document.getElementById('sheet-metrics'),
    sheetRows: document.getElementById('sheet-rows'),
  };

  const now = new Date();
  let focus = { year: now.getFullYear(), month: now.getMonth() }; // month 0 基

  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtStamp(d) {
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderWeekdays() {
    el.weekdays.innerHTML = WEEKDAYS.map((w) => '<div class="wd">' + w + '</div>').join('');
  }

  function renderHeader() {
    el.monthNum.textContent = focus.month + 1;
    el.monthYear.textContent = focus.year;
  }

  function renderStrip() {
    const start = focus.year * 12 + focus.month - PILL_RANGE;
    const end = focus.year * 12 + focus.month + PILL_RANGE;
    let html = '';
    for (let m = start; m <= end; m++) {
      const y = Math.floor(m / 12);
      const mo = m - y * 12;
      const active = y === focus.year && mo === focus.month;
      html += '<button class="pill' + (active ? ' active' : '') + '" type="button"'
        + ' data-y="' + y + '" data-m="' + mo + '"'
        + ' title="' + y + '年' + (mo + 1) + '月">' + (mo + 1) + '月</button>';
    }
    el.pills.innerHTML = html;

    // 居中显示当前月
    requestAnimationFrame(() => {
      const active = el.pills.querySelector('.pill.active');
      if (active) {
        el.strip.scrollLeft = active.offsetLeft - (el.strip.clientWidth - active.offsetWidth) / 2;
      }
    });
  }

  function eventDots(groups) {
    const order = { release: 0, purchase: 1, first_play: 2, achievement: 3 };
    const sorted = groups.slice().sort((a, b) => order[a.type] - order[b.type] || (b.count || 1) - (a.count || 1));
    const visible = sorted.slice(0, 3);
    const hidden = sorted.slice(3);

    let html = '';
    for (const g of visible) {
      html += '<span class="evdot" style="background:' + g.color + '"></span>';
      if (g.count > 1) {
        const c = g.type === 'achievement' ? g.color : 'var(--text-3)';
        html += '<span class="evcount" style="color:' + c + '">&times;' + g.count + '</span>';
      }
    }
    if (hidden.length > 0) {
      html += '<span class="evfold">+' + hidden.length + '</span>';
    }
    return html;
  }

  function renderCell(cell) {
    const groups = MockData.getDayGroups(cell.date);
    const hasRelease = groups.some((g) => g.type === 'release');

    const cls = ['cell'];
    if (!cell.inMonth) cls.push('off-month');
    if (cell.isToday) cls.push('today');
    // 无事件的日期不响应点击：规范禁止空状态插画与解释性文案，弹一个空浮层没有意义
    if (groups.length > 0) cls.push('has-ev');

    const dayHtml = cell.isToday
      ? '<span class="daynum today-num">' + cell.day + '</span>'
      : '<span class="daynum">' + cell.day + '</span>';
    const dotsHtml = eventDots(groups);
    const barHtml = hasRelease && cell.inMonth ? '<span class="release-bar"></span>' : '';

    return '<div class="' + cls.join(' ') + '" data-date="' + cell.year + '-' + pad(cell.month + 1) + '-' + pad(cell.day) + '">'
      + dayHtml
      + '<div class="dots">' + dotsHtml + '</div>'
      + barHtml
      + '</div>';
  }

  function renderGrid(dir) {
    const cells = Calendar.buildCells(focus.year, focus.month);
    el.grid.innerHTML = cells.map(renderCell).join('');

    if (dir) {
      el.grid.classList.remove('anim-prev', 'anim-next');
      void el.grid.offsetWidth; // 触发重排以重启动画
      el.grid.classList.add(dir === 'prev' ? 'anim-prev' : 'anim-next');
    }
  }

  function goTo(year, month, dir) {
    closeSheet();          // 切月即收浮层：浮层是「某一天」的详情，跨月留着没有意义
    focus = { year, month };
    renderHeader();
    renderStrip();
    renderGrid(dir);
  }

  function shiftMonth(delta) {
    const m = focus.year * 12 + focus.month + delta;
    goTo(Math.floor(m / 12), m - Math.floor(m / 12) * 12, delta < 0 ? 'prev' : 'next');
  }

  /* ================================================================
     日详情浮层（UI 规范 §8.2 / 前端功能文档 §3）
     数据来自 MockData.getDayDetail，结构对齐将来的 get_day_detail 接口。
     ================================================================ */

  const METRIC_DEFS = [
    { key: 'achievement', label: '成就解锁' },
    { key: 'first_play', label: '首次启动' },
    { key: 'release', label: '发售' },
  ];

  let sheetDate = null;

  function fmtTime(minutes) {
    return pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60);
  }

  // 无封面时的 2~3 字母缩写（UI 规范 §5 封面占位）
  function abbr(en) {
    const words = String(en).replace(/['’]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (words.length >= 2) return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
    return (words[0] || '??').slice(0, 3).toUpperCase();
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderMetrics(counts) {
    // 计数为 0 的块不显示；三项皆为 0 时整行不出现（当日仅有购买事件时即如此）
    const blocks = METRIC_DEFS.filter((d) => counts[d.key] > 0);
    el.sheetMetrics.innerHTML = blocks.map((d) =>
      '<div class="metric"><span class="n">' + counts[d.key] + '</span>'
      + '<span class="l">' + d.label + '</span></div>').join('');
    el.sheetMetrics.hidden = blocks.length === 0;
  }

  function renderRow(row) {
    const color = eventColor(row);
    const xn = row.type === 'achievement' && row.count > 1
      ? '<span class="xn">&times;' + row.count + '</span>' : '';
    const cover = 'linear-gradient(150deg, ' + row.themeColor
      + ', color-mix(in srgb, ' + row.themeColor + ' 58%, #17202E))';

    return '<div class="evrow">'
      + '<span class="kind" style="color:' + color + '">'
      + '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[row.type] + '</svg>' + xn
      + '</span>'
      + '<span class="cover" style="background:' + cover + '"><span>' + esc(abbr(row.game.en)) + '</span></span>'
      + '<span class="name" title="' + esc(row.game.zh) + '">' + esc(row.game.zh) + '</span>'
      + '<span class="stamp">' + fmtTime(row.time) + '</span>'
      + '</div>';
  }

  function openSheet(date) {
    const detail = MockData.getDayDetail(date);
    if (detail.rows.length === 0) return;

    sheetDate = date;
    el.sheetDateNum.textContent = date.getDate();
    el.sheetDateCap.textContent = WEEKDAYS_ZH[Calendar.mondayIndex(date.getDay())]
      + ' · ' + date.getFullYear() + ' 年 ' + (date.getMonth() + 1) + ' 月';
    renderMetrics(detail.counts);
    el.sheetRows.innerHTML = detail.rows.map(renderRow).join('');
    el.sheetRows.scrollTop = 0;

    el.sheetLayer.classList.add('open');
    el.sheetLayer.setAttribute('aria-hidden', 'false');
    el.sheet.focus({ preventScroll: true });
  }

  function closeSheet() {
    if (!sheetDate) return;
    sheetDate = null;
    el.sheetLayer.classList.remove('open');
    el.sheetLayer.setAttribute('aria-hidden', 'true');
  }

  function isSheetOpen() { return sheetDate !== null; }

  function setSync(state) {
    if (state === 'syncing') {
      el.syncDot.style.background = 'var(--accent)';
      el.syncLabel.textContent = '同步中…';
    } else {
      el.syncDot.style.background = 'var(--ev-purchase)';
      el.syncLabel.textContent = '上次同步 ' + fmtStamp(new Date());
    }
  }

  function bindEvents() {
    el.btnPrev.addEventListener('click', () => shiftMonth(-1));
    el.btnNext.addEventListener('click', () => shiftMonth(1));

    el.pills.addEventListener('click', (e) => {
      const pill = e.target.closest('.pill');
      if (!pill) return;
      const y = Number(pill.dataset.y);
      const m = Number(pill.dataset.m);
      if (y === focus.year && m === focus.month) return;
      const delta = (y * 12 + m) - (focus.year * 12 + focus.month);
      goTo(y, m, delta < 0 ? 'prev' : 'next');
    });

    // 点某日升起浮层；再点同一天收起（无事件的日期没有 has-ev，不响应）
    el.grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cell.has-ev');
      if (!cell) return;
      const [y, m, d] = cell.dataset.date.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      if (isSheetOpen() && Calendar.isSameDay(date, sheetDate)) closeSheet();
      else openSheet(date);
    });

    // 收起：点遮罩 / ESC。浮层内不放关闭按钮 —— 规范总则 2，能靠既有手势完成的入口一律不加
    el.sheetMask.addEventListener('click', closeSheet);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeSheet(); return; }
      if (isSheetOpen()) return;       // 浮层是模态，开着时不切月
      if (e.key === 'ArrowLeft') shiftMonth(-1);
      else if (e.key === 'ArrowRight') shiftMonth(1);
    });

    // 横向滚轮 / 触摸左右滑动切月
    let wheelLock = false;
    el.grid.addEventListener('wheel', (e) => {
      if (isSheetOpen()) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !wheelLock) {
        e.preventDefault();
        wheelLock = true;
        shiftMonth(e.deltaX > 0 ? 1 : -1);
        setTimeout(() => { wheelLock = false; }, 260);
      }
    }, { passive: false });

    let touchX = null;
    el.grid.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
    el.grid.addEventListener('touchend', (e) => {
      if (touchX == null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 40) shiftMonth(dx < 0 ? 1 : -1);
      touchX = null;
    }, { passive: true });

    // 托盘「立即同步」→ 演示同步态
    if (window.gameCalendar && window.gameCalendar.onSyncNow) {
      window.gameCalendar.onSyncNow(() => {
        setSync('syncing');
        setTimeout(() => setSync('idle'), 1400);
      });
    }
  }

  /**
   * 透明区鼠标穿透（UI 规范 v0.3 §1.1 / 06 §6，阻塞级）
   *
   * 窗口 764 × 864、面板 668 × 768，面板外那一圈投影空间虽然看不见，
   * 但默认仍然接收鼠标事件，会挡住底下的桌面图标。指针不在面板内
   * （含圆角外的四个小三角）时，通知主进程放行。
   */
  function bindPassthrough() {
    const api = window.gameCalendar;
    if (!api || !api.setPointerInside) return;

    const panel = document.querySelector('.glass-l2');
    if (!panel) return;

    const RADIUS = 26; // 面板圆角，须与 CSS 的 border-radius 一致
    let rect = panel.getBoundingClientRect();
    let last = null;

    window.addEventListener('resize', () => { rect = panel.getBoundingClientRect(); });

    function isInside(x, y) {
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
      // 只有同时落在横竖两个圆角带里，才需要按圆算；否则矩形内即命中
      const cx = x < rect.left + RADIUS ? rect.left + RADIUS
        : x > rect.right - RADIUS ? rect.right - RADIUS : null;
      const cy = y < rect.top + RADIUS ? rect.top + RADIUS
        : y > rect.bottom - RADIUS ? rect.bottom - RADIUS : null;
      if (cx === null || cy === null) return true;
      const dx = x - cx;
      const dy = y - cy;
      return dx * dx + dy * dy <= RADIUS * RADIUS;
    }

    function push(inside) {
      if (inside === last) return;
      last = inside;
      api.setPointerInside(inside);
    }

    window.addEventListener('mousemove', (e) => push(isInside(e.clientX, e.clientY)));
    // 指针快速划出窗口时补一次放行，避免停在「接管」状态
    document.addEventListener('mouseleave', () => push(false));
  }

  function init() {
    renderWeekdays();
    renderHeader();
    renderStrip();
    renderGrid();
    setSync('idle');
    bindEvents();
    bindPassthrough();

    // 托盘显隐的淡入 + scale(.98→1)（UI 规范 §7），不做位移
    document.body.classList.add('appearing');
    setTimeout(() => document.body.classList.remove('appearing'), 240);
  }

  init();
})();
