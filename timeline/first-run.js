// 首启（05§8）：两个并行入口 —— MOCK 测试模式 / 真实 Steam 登录（LIVE 生产验证）。
//
// · MOCK：本地假数据，不碰网络，进度条走快进版（每阶段 90ms），用于交互与视觉验收。
// · LIVE：真实登录 + 全部后端接口，用于生产验证。
// 两条路走同一套视图层，区别只在 api.js 的 adapter（见 api.js 顶部对照表）。

import * as API from './api.js';
import { svg } from './lib/icons.js';

const PRODUCT_NAME = 'Save Point';

/** 同步阶段 → 首启页上的英文 chip。顺序由 API.SYNC_STEPS 决定，这里只管翻名字。 */
const STEP_CHIP = {
  owned_games: 'OWNED',
  wishlist: 'WISHLIST',
  purchase_history: 'PURCHASES',
  recently_played: 'PLAY_DAYS',
  achievements: 'ACHIEVEMENTS',
  screenshots: 'SCREENSHOTS',
};

const pad2 = (n) => String(n).padStart(2, '0');

let els = {};
let onDone = () => {};
let onOpenSettings = null;

function hero(children) {
  const el = document.createElement('div');
  el.className = 'hero';
  const title = document.createElement('div');
  title.className = 'product-name num';
  title.textContent = PRODUCT_NAME;
  el.appendChild(title);
  children.forEach((c) => el.appendChild(c));
  return el;
}

/** 首启页右下角也放设置入口：还没登录时也得能进去改后端地址（05§8）。 */
function gearButton() {
  const b = document.createElement('button');
  b.className = 'gear';
  b.setAttribute('aria-label', '打开设置');
  b.innerHTML = svg('gear', 19);
  b.addEventListener('click', () => onOpenSettings?.());
  return b;
}

/**
 * 换态转场（V1 原型）：登录态先淡出，再把同步态淡入——直接换 DOM 会「啪」地跳一下。
 * @param {() => void} render 淡出结束后执行的重绘
 */
function fadeTo(render) {
  const cur = els.root.querySelector('.hero');
  if (!cur) { render(); return; }
  cur.classList.add('fading');
  setTimeout(render, 220);
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---- 入口页：两套环境并列 ----

function renderEntry({ error } = {}) {
  els.root.innerHTML = '';

  const desc = el('div', 'desc',
    '登录 Steam 后，购买、首次启动、成就解锁与当时的截图会落在同一条时间轴上。'
    + '数据留在本机，仅首次需要全量同步。');

  // 登录失败（后端 302 回来带 #error=）或后端不可达时，把原因摆在入口上，不让人白点第二次
  const errEl = error ? el('div', 'entry-error mono caption', error) : null;

  // —— LIVE：真实登录 ——
  const liveActions = el('div', 'actions');
  const loginBtn = el('button', 'btn-primary', '登录 Steam');
  loginBtn.addEventListener('click', startLive);
  const importBtn = el('button', 'btn-secondary', '导入本地备份');
  importBtn.addEventListener('click', pickBackupFile);
  const tokenBtn = el('button', 'btn-secondary', '已有 token');
  tokenBtn.addEventListener('click', renderTokenEntry);
  liveActions.append(loginBtn, importBtn, tokenBtn);

  // MOCK 测试模式的入口 v1.8 起搬到「设置 → 环境」。首启页要回答的是「你是谁」，
  // 摆一张同等分量的测试模式卡片会让第一次来的人以为那是两个平级的正常选项。
  const meta = el('div', 'mono caption entry-meta', 'NO SIGNUP · DATA STAYS LOCAL');

  els.root.appendChild(hero([desc, ...(errEl ? [errEl] : []), liveActions, meta]));
  els.root.appendChild(gearButton());
}

// ---- 导入本地备份（只读会话，数据只在内存里）----

/**
 * 选一个由「设置 → 导出 JSON 备份」产出的文件，校验通过就直接进时间轴。
 * 刷新页面后导入态会丢——这是有意的：内存里放一份几十 MB 的库比塞进 storage 稳。
 */
function pickBackupFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      API.setImportedDataset(raw);      // 形状不对会在这里抛
      onDone();
    } catch (err) {
      renderEntry({ error: `导入失败：${err.message}` });
    }
  });
  input.click();
}

// ---- MOCK 流程 ----

/** 从设置页进测试模式时用：走同一条快进版载入，保证观感与 LIVE 首次同步同构（02§5.2）。 */
export function enterMock() {
  API.setMode('mock');
  fadeTo(() => renderSyncing({ live: false }));
}

// ---- LIVE 流程 ----

/**
 * 真实登录：**整页跳转**到后端 → 后端 302 去 Steam OpenID → 用户授权 →
 * 后端验签后 302 回本页并在 fragment 里带 token（由 app.js 启动时消费）。
 *
 * 不用 `window.open`：它会被弹窗拦截器拦；在嵌入式 / CEF 浏览器里还会降级成当前页导航，
 * 两种情况都会把用户丢在 Steam 页上回不来。整页跳转的行为在所有环境里一致。
 */
async function startLive() {
  API.setMode('live');
  // 先探一次后端：后端没起时跳过去只会得到「无法访问此页面」，那时用户已经离开应用、
  // 看不到任何解释。宁可在跳转前就把话说清楚。
  try {
    await API.health();
  } catch (err) {
    renderEntry({ error: `${err.message}\n请先运行仓库根目录的 run.cmd（开发态：backend/run.cmd）` });
    return;
  }
  location.href = API.loginUrl();
}

// ---- 绑定 API Key（登录之后、同步之前的必经一步）----

/**
 * 同步只吃用户自己的 Steam Web API Key，登录本身给不了它。没有这一页时，新用户登录后
 * 会直接撞上「同步失败 400」和一个「跳过」按钮，不知道下一步是什么——这正是这页要堵的洞。
 * @param {{error?: string, hint?: string}} [opts]
 */
function renderApikeyEntry({ error, hint } = {}) {
  els.root.innerHTML = '';

  const desc = el('div', 'desc', hint
    || '登录成功。同步游戏库、运行记录与成就需要你自己的 Steam Web API Key：'
    + '用当前账号去 Steam 申请一把（域名随便填，例如 localhost），复制回来粘贴到下面。'
    + 'Key 只加密存放在你本机的后端里，不回显、不外发。');

  const link = el('a', 'btn-secondary', '去 Steam 申请 API Key ↗');
  link.href = API.APIKEY_HELP_URL;
  link.target = '_blank';
  link.rel = 'noopener';

  const form = el('div', 'token-form');
  const input = el('input', 'text-input mono');
  input.type = 'password';           // 它是密钥：不回显，也别让屏幕录制带走
  input.autocomplete = 'off';
  input.placeholder = '粘贴 32 位 API Key';
  input.setAttribute('aria-label', 'Steam Web API Key');
  form.appendChild(input);

  const errEl = error ? el('div', 'entry-error mono caption', error) : null;

  const actions = el('div', 'actions');
  const go = el('button', 'btn-primary', '绑定并开始同步');
  const skip = el('button', 'btn-secondary', '稍后再说，先进去看看');
  skip.addEventListener('click', onDone);
  actions.append(go, skip);

  // 终端路径仍然保留：不想在浏览器里粘 Key 的人可以走 CLI（README「绑定 API Key」）
  const meta = el('div', 'mono caption entry-meta',
    '也可以在终端执行 game-calendar-bind-apikey 绑定（见 README）');

  const submit = async () => {
    const key = input.value.trim();
    if (!key) { input.focus(); return; }
    go.disabled = true;
    go.textContent = '正在校验…';
    try {
      await API.submitApikey(key);      // 后端会先拿这把 Key 查一次本人资料，无效直接 400
      fadeTo(() => renderSyncing({ live: true }));
    } catch (err) {
      renderApikeyEntry({ error: `绑定失败：${err.message}` });
    }
  };
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });

  els.root.appendChild(hero([desc, link, form, ...(errEl ? [errEl] : []), actions, meta]));
  els.root.appendChild(gearButton());
  input.focus();
}

function renderTokenEntry({ hint } = {}) {
  API.setMode('live');
  els.root.innerHTML = '';

  const desc = el('div', 'desc', hint
    || '粘贴后端签发的 opaque token（登录回调页 JSON 里的 token 字段）。');

  const form = el('div', 'token-form');
  const baseInput = el('input', 'text-input mono');
  baseInput.type = 'text';
  baseInput.value = API.getApiBase();
  baseInput.setAttribute('aria-label', '后端地址');
  const tokenInput = el('input', 'text-input mono');
  tokenInput.type = 'text';
  tokenInput.placeholder = 'token';
  tokenInput.value = API.getToken();
  tokenInput.setAttribute('aria-label', 'token');

  const actions = el('div', 'actions');
  const goBtn = el('button', 'btn-primary', '连接后端');
  const backBtn = el('button', 'btn-secondary', '返回');
  backBtn.addEventListener('click', renderEntry);
  const loginAgain = el('button', 'btn-secondary', '重新登录');
  loginAgain.addEventListener('click', startLive);
  actions.append(goBtn, loginAgain, backBtn);

  const status = el('div', 'mono caption');
  form.append(baseInput, tokenInput);

  goBtn.addEventListener('click', async () => {
    API.setApiBase(baseInput.value.trim());
    API.setToken(tokenInput.value.trim());
    status.textContent = '正在校验…';
    goBtn.disabled = true;
    try {
      await API.health();                 // 后端可达？
      const key = await API.hasApikey();   // token 有效？（401 会在这里抛）
      if (!key.has_key) {
        renderApikeyEntry({ hint: '连接成功，但这个账号还没绑定 Steam Web API Key。同步需要它——先绑上再进。' });
        return;
      }
      status.textContent = '连接成功，正在拉取数据…';
      await new Promise((r) => setTimeout(r, 300));
      onDone();
    } catch (err) {
      status.textContent = `连接失败：${err.message}`;
      goBtn.disabled = false;
    }
  });

  els.root.appendChild(hero([desc, form, actions, status]));
}

// ---- 同步进度态（两套环境共用同一套 UI，只是节奏不同）----

/**
 * @param {{live: boolean}} opts live=true 时跑真实 /sync SSE；false 跑 MOCK 快进版。
 */
function renderSyncing({ live }) {
  els.root.innerHTML = '';

  const wrap = el('div', 'sync-wrap');
  const syncRow = el('div', 'sync-row');
  const label = el('div', 'body-text', live ? '正在同步…' : '正在载入测试数据…');
  label.style.flex = '1 1 auto';
  const countEl = el('div', 'mono caption');
  syncRow.append(label, countEl);

  // 进度条 = 已完成的宽度（fill）+ 一个跟着走的推进头（head）。
  // 两者都在 CSS 里带循环动画，只要没加 .stalled 就一直在动——见 styles.css「同步活跃指示」。
  const bar = el('div', 'sync-bar');
  const fill = el('div', 'fill');
  fill.style.width = '0%';
  const head = el('div', 'head');
  head.style.left = '0%';
  bar.append(fill, head);

  /** 同时挪 fill 与 head，避免两者各写一处、以后改动漏一个。 */
  const setProgress = (ratio) => {
    const pct = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    fill.style.width = pct;
    head.style.left = pct;
  };

  const stagesRow = el('div', 'sync-stages');
  const stageEls = new Map();
  for (const step of API.SYNC_STEPS) {
    const s = el('div', 'label pending', STEP_CHIP[step] ?? step.toUpperCase());
    stagesRow.appendChild(s);
    stageEls.set(step, s);
  }

  // ELAPSED：每秒走一格的墙钟。它和「具体进度」无关，回答的是另一个问题——
  // 后端静默的那几分钟里，用户想知道的其实是「这东西还活着吗」。
  // 它也是 prefers-reduced-motion 下唯一还在动的东西（文字变化不是动画）。
  const elapsedEl = el('div', 'mono caption sync-elapsed', 'ELAPSED 00:00');
  const startedAt = Date.now();
  const tick = setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    elapsedEl.textContent = `ELAPSED ${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
  }, 1000);

  const meta = el('div', 'sync-meta');
  meta.append(stagesRow, elapsedEl);

  const status = el('div', 'mono caption');
  wrap.append(syncRow, bar, meta, status);
  els.root.appendChild(hero([wrap]));
  els.root.appendChild(gearButton());

  /** 长时间同步期间的出口：数据分批入库，先看已有的不影响后台继续同步。 */
  function leaveActions() {
    const actions = el('div', 'actions');
    const go = el('button', 'btn-secondary', '先查看已有数据');
    go.addEventListener('click', onDone);
    actions.appendChild(go);
    return actions;
  }

  let seen = 0;
  let hintShown = false;
  const totalSteps = API.SYNC_STEPS.length; // SYNC_STEPS 只含采集阶段，sync/lifecycle/done 不占格

  const onProgress = (ev) => {
    const step = ev.step;
    if (step === 'done' || step === 'error') return;

    // 首次同步要逐款打 Store API 补元数据 + 下封面（上游限速，串行 1~2s/款），
    // 几百款的库就是几十分钟。不明说的话，进度条动得极慢和「卡死」在观感上没区别。
    if (ev.first_run && !hintShown) {
      hintShown = true;
      status.textContent = '首次同步要逐款拉取游戏元数据，几百款的库可能需要几十分钟。'
        + '已拉取的部分会随时入库，可以先去看，同步在后台继续。';
      wrap.appendChild(leaveActions());
    }
    if (stageEls.has(step) && !stageEls.get(step).dataset.started) {
      stageEls.get(step).dataset.started = '1';
      seen++;
      // 前面的阶段一律标记完成（SSE 是顺序推进的）
      let hit = false;
      for (const [k, node] of stageEls) {
        if (k === step) { hit = true; node.className = 'label'; continue; }
        node.className = hit ? 'label pending' : 'label done';
      }
    }
    label.textContent = API.stepLabel(step);
    if (typeof ev.processed === 'number' && typeof ev.total === 'number' && ev.total > 0) {
      countEl.textContent = `${ev.processed} / ${ev.total}`;
      const within = Math.min(1, ev.processed / ev.total);
      setProgress((seen - 1 + within) / totalSteps);
    } else {
      countEl.textContent = '';
      setProgress(seen / totalSteps);
    }
  };

  API.syncNow(onProgress).then(() => {
    clearInterval(tick);
    for (const node of stageEls.values()) node.className = 'label done';
    setProgress(1);
    label.textContent = '同步完成';
    setTimeout(onDone, live ? 300 : 120);
  }).catch((err) => {
    // 停掉活跃指示：这两个动画的意义全在于「会停」——一直转下去等于骗人说还在拉
    clearInterval(tick);
    bar.classList.add('stalled');
    label.textContent = '同步中断';
    status.textContent = `同步失败：${err.message}`;
    // LIVE 同步失败不该把人堵在首启页——已有数据仍然可看（PRD 优雅降级）
    const actions = el('div', 'actions');
    const noKey = live && err.status === 400;   // 后端：尚未绑定 API Key
    if (noKey) {
      // 400 只有一个含义：没 Key。把下一步直接摆在面前，而不是让人对着「跳过」猜
      status.textContent = '同步失败：这个账号还没绑定 Steam Web API Key。';
      const bind = el('button', 'btn-primary', '绑定 API Key');
      bind.addEventListener('click', () => renderApikeyEntry());
      actions.appendChild(bind);
    }
    const skip = el('button', noKey ? 'btn-secondary' : 'btn-primary', '跳过，直接查看已有数据');
    skip.addEventListener('click', onDone);
    const back = el('button', 'btn-secondary', '返回');
    back.addEventListener('click', renderEntry);
    actions.append(skip, back);
    els.root.querySelector('.hero').appendChild(actions);
  });
}

/**
 * @param {HTMLElement} root
 * @param {{onDone: () => void, onOpenSettings?: () => void}} handlers
 */
export function mount(root, handlers) {
  els.root = root;
  onDone = handlers.onDone;
  onOpenSettings = handlers.onOpenSettings ?? null;
  renderEntry();
}

/** 从设置页「切换环境」回到首启入口时用；也用于登录失败后带原因回到入口。 */
export function showEntry(opts) {
  renderEntry(opts);
}

/**
 * 登录回跳成功后的落点：已绑 Key 直接进同步态；没绑先进 Key 页。
 * 探活失败（后端刚好挂了）就直接进同步——那边会把错误原因说清楚，不在这里多加一层判断。
 */
export async function startSyncAfterLogin() {
  let hasKey = true;
  try {
    hasKey = (await API.hasApikey()).has_key;
  } catch { /* 交给 renderSyncing 报错 */ }
  if (!hasKey) {
    fadeTo(() => renderApikeyEntry());
    return;
  }
  fadeTo(() => renderSyncing({ live: true }));
}
