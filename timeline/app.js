// 入口引导：三个互斥全屏视图（首启 / 时间轴 / 设置）之间的最小路由，无框架。
// 各视图模块自己管 mount()（只跑一次）/ render()（可重复调用），本文件只负责显隐切换与接线。

import * as Timeline from './timeline.js';
import * as Settings from './settings.js';
import * as FirstRun from './first-run.js';
import * as API from './api.js';
import { svg } from './lib/icons.js';
import * as Backdrop from './lib/backdrop.js';

// 整页背景在最早一刻就恢复（05§3.1）：它是**页面**的底，首启 / 时间轴 / 设置三个视图共享，
// 放进 Timeline.mount 里会变成「只有进过时间轴才看得见」。
Backdrop.init();

const viewFirstRun = document.getElementById('view-first-run');
const viewTimeline = document.getElementById('view-timeline');
const viewSettings = document.getElementById('view-settings');
const modeBadge = document.getElementById('mode-badge');

let settingsMounted = false;
let timelineMounted = false;
/** 设置页是全屏替换，返回时得回到「进来之前那一页」——从首启进的不能回时间轴。 */
let backFromSettings = () => showTimeline();

// 图标一律内联 SVG（05§5），HTML 里只留空壳，避免把 path 抄成两份
document.getElementById('prev-btn').innerHTML = svg('chevL');
document.getElementById('next-btn').innerHTML = svg('chevR');
document.getElementById('toggle-overview').innerHTML = svg('chart', 17);
document.getElementById('toggle-minimal').innerHTML = svg('imagesOff', 17);
document.getElementById('toggle-ach').innerHTML = svg('keyOff', 17);
document.getElementById('export-btn').innerHTML = svg('download', 17);
document.getElementById('open-settings').innerHTML = svg('gear', 19);
// #toggle-orient 的图标由 Timeline.paintToggles() 按当前方向画（横竖两个图形不一样）

function showView(name) {
  viewFirstRun.hidden = name !== 'first-run';
  viewTimeline.hidden = name !== 'timeline';
  viewSettings.hidden = name !== 'settings';
}

/** 底栏环境标识：非 LIVE 时必须一眼可辨，避免把测试/备份数据当成真实数据看。 */
function renderModeBadge() {
  const mode = API.getMode();
  modeBadge.textContent = { mock: 'MOCK', import: 'IMPORT', live: 'LIVE' }[mode];
  modeBadge.classList.toggle('mock', mode !== 'live');
  modeBadge.hidden = false;
}

async function showTimeline() {
  showView('timeline');
  backFromSettings = showTimeline;
  renderModeBadge();
  try {
    // mount 内部只绑定一次事件；每次进入都重新拉数据（切换环境后必须重拉）
    await Timeline.mount({
      header: document.getElementById('timeline-header'),
      body: document.getElementById('timeline-body'),
      track: document.getElementById('timeline-track'),
      clock: document.getElementById('timeline-clock'),
      prevBtn: document.getElementById('prev-btn'),
      nextBtn: document.getElementById('next-btn'),
      ovBtn: document.getElementById('toggle-overview'),
      minimalBtn: document.getElementById('toggle-minimal'),
      achBtn: document.getElementById('toggle-ach'),
      orientBtn: document.getElementById('toggle-orient'),
      exportBtn: document.getElementById('export-btn'),
      panelRoot: document.getElementById('panel-root'),
    });
    timelineMounted = true;
    await refreshSyncStatus();
  } catch (err) {
    // 取数失败（LIVE 常见：后端没起 / token 过期）退回首启，把原因说清楚
    console.error('[timeline] 拉取数据失败', err);
    // 失败原因直接摆在首启页上，不用 alert——alert 会挡住页面且带不走上下文
    showFirstRun({ error: `拉取数据失败：${err.message}` });
  }
}

/** 底栏同步状态（05§8.1 三态：正常 --text-1 / 同步中 --accent / 未登录 --text-3）。 */
async function refreshSyncStatus() {
  const dot = document.getElementById('sync-dot');
  const stamp = document.getElementById('sync-stamp');
  try {
    const s = await API.getSyncStatus();
    const color = s.status === 'syncing' ? 'var(--accent)'
      : s.status === 'unconfigured' ? 'var(--text-3)'
      : 'var(--text-1)';
    dot.style.background = color;
    stamp.textContent = s.last_sync_at
      ? `LAST SYNC ${String(s.last_sync_at).replace('T', ' ').slice(0, 16)}`
      : 'NEVER SYNCED';
  } catch {
    dot.style.background = 'var(--text-3)';
    stamp.textContent = 'SYNC STATUS UNAVAILABLE';
  }
}

function showSettings() {
  showView('settings');
  if (!settingsMounted) {
    settingsMounted = true;
    Settings.mount(viewSettings, {
      onBack: () => backFromSettings(),
      onHideToggle: () => { if (timelineMounted) Timeline.refresh(); },
      onSwitchEnv: () => {           // 回首启重新选环境
        backFromSettings = showFirstRun;
        showFirstRun();
      },
      /**
       * 设置页里换环境（进 / 出 MOCK）。
       * @param {boolean} [direct] true = 已经切好模式了，直接重进时间轴；
       *   false/省略 = 走首启那条快进版载入动画（第一次进测试模式时才需要那点仪式感）
       */
      onEnterMock: (direct) => {
        if (direct) { showTimeline(); return; }
        backFromSettings = showTimeline;
        showView('first-run');
        FirstRun.enterMock();
      },
      onSynced: async () => {         // 设置页里点了「立即同步」，同步完重拉时间轴
        if (!timelineMounted) return; // 从首启进的设置页，时间轴还没挂，没什么可重拉
        await Timeline.reload();
        await refreshSyncStatus();
      },
    });
  } else {
    Settings.render();
  }
}

function showFirstRun(opts) {
  showView('first-run');
  backFromSettings = () => showFirstRun();
  FirstRun.showEntry(opts);
}

document.getElementById('open-settings').addEventListener('click', showSettings);

FirstRun.mount(viewFirstRun, {
  onDone: showTimeline,
  onOpenSettings: () => { backFromSettings = () => showFirstRun(); showSettings(); },
});

// Steam 登录回跳：后端验签后 302 回本页，token 在 URL fragment 里。
// 必须在 FirstRun.mount 之后消费——mount 会先渲染入口页，这里再按回调结果覆盖。
const callback = API.consumeLoginCallback();
if (callback?.token) {
  FirstRun.startSyncAfterLogin();   // 已拿到 token，直接进同步态
} else if (callback?.error) {
  showFirstRun({ error: `Steam 登录失败：${callback.error}` });
} else if (API.hasSession()) {
  // 上次用的环境还在，直接进时间轴（02§5.4）。首启页是「你是谁」的一次性问题，
  // 每次刷新都重问一遍毫无意义。取数失败（后端没起 / token 过期）时 showTimeline()
  // 自己会带着原因退回首启，所以这里不必先探活。
  showTimeline();
}
