// 设置页（05§8 / 02§4）：全屏替换，账号 / 同步 / 数据三组。
// 05§8 的三组结构不变；当前环境（MOCK/LIVE）并入「账号」组呈现——它是账号态的一部分，
// 不新开第四组（05 总则 2：界面上不多一个答不上用户故事的分区）。

import { svg } from './lib/icons.js';
import * as API from './api.js';
import { getHideNeverLaunched, setHideNeverLaunched } from './lib/prefs.js';

let els = {};
let handlers = {};
let dataset = null; // 供「隐藏从未启动」计数用

/** SteamID64 只露头 8 位与尾 2 位：设置页是给人确认「登的是不是我」，不是给人抄号的。 */
function maskSteamId(id) {
  const s = String(id || '');
  if (s.length < 12) return s || '—';
  return `${s.slice(0, 8)}${'•'.repeat(6)}${s.slice(-2)}`;
}

const fmtMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 触发一次本地下载。浏览器下载是同步动作，用完立刻回收 objectURL。 */
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function row(main, sub, right) {
  const el = document.createElement('div');
  el.className = 'list-row';
  const col = document.createElement('div');
  col.className = 'main-col';
  const mainEl = document.createElement('div');
  mainEl.className = 'body-text';
  mainEl.textContent = main;
  col.appendChild(mainEl);
  if (sub) {
    const subEl = document.createElement('div');
    subEl.className = 'mono caption';
    subEl.textContent = sub;
    col.appendChild(subEl);
  }
  el.appendChild(col);
  if (right) el.appendChild(right);
  return el;
}

function group(label, rows) {
  const el = document.createElement('div');
  el.className = 'settings-group';
  const labelEl = document.createElement('div');
  labelEl.className = 'label';
  labelEl.textContent = label;
  el.appendChild(labelEl);
  const rowsEl = document.createElement('div');
  rowsEl.className = 'rows';
  rows.forEach((r) => rowsEl.appendChild(r));
  el.appendChild(rowsEl);
  return el;
}

function toggleBtn(on, onChange) {
  const btn = document.createElement('button');
  btn.className = 'toggle' + (on ? ' on' : '');
  btn.setAttribute('aria-pressed', String(on));
  btn.addEventListener('click', () => {
    const next = !btn.classList.contains('on');
    btn.classList.toggle('on', next);
    btn.setAttribute('aria-pressed', String(next));
    onChange(next);
  });
  return btn;
}

const btn = (cls, text, onClick) => {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
};

/**
 * LIVE 下的「Steam Web API Key」行：绑定 / 更换 / 解绑。
 *
 * Key 本身永远不回显（后端也只回 has_key），这一行只回答两件事：绑没绑、怎么绑。
 * 首启页那一版是「登录之后必经的一步」，这里是事后想换 Key、或首启时点了「稍后再说」的人
 * 的入口——两处不能只留一处：没有设置页的入口，换了 Key 的人只能去翻 CLI。
 * @param {() => void} onChanged 绑定 / 解绑成功后的回调（同步行的文案要跟着变）
 */
function apikeyRow(onChanged) {
  const r = document.createElement('div');
  r.className = 'list-row';

  const col = document.createElement('div');
  col.className = 'main-col';
  const main = document.createElement('div');
  main.className = 'body-text';
  main.textContent = 'Steam Web API Key';
  const sub = document.createElement('div');
  sub.className = 'mono caption';
  sub.textContent = '…';
  col.append(main, sub);

  const form = document.createElement('div');
  form.className = 'apikey-form';
  const help = document.createElement('a');
  help.className = 'mono caption';
  help.href = API.APIKEY_HELP_URL;
  help.target = '_blank';
  help.rel = 'noopener';
  help.textContent = '申请 KEY ↗';
  const input = document.createElement('input');
  input.className = 'text-input compact mono';
  input.type = 'password';
  input.autocomplete = 'off';
  input.placeholder = '粘贴 32 位 Key';
  input.setAttribute('aria-label', 'Steam Web API Key');
  const bindBtn = btn('btn-secondary', '绑定', async () => {
    const key = input.value.trim();
    if (!key) { input.focus(); return; }
    bindBtn.disabled = true;
    sub.textContent = '正在校验…';
    try {
      await API.submitApikey(key);
      input.value = '';
      await refresh();
      onChanged();
    } catch (err) {
      sub.textContent = `绑定失败：${err.message}`;
    } finally {
      bindBtn.disabled = false;
    }
  });
  const unbindBtn = btn('btn-secondary', '解绑', async () => {
    // 解绑不删数据，只停同步——文案把这点说清楚，confirm 才有意义
    if (!window.confirm('解绑后不再同步，已采集的数据保留。继续？')) return;
    unbindBtn.disabled = true;
    try {
      await API.deleteApikey();
      await refresh();
      onChanged();
    } catch (err) {
      sub.textContent = `解绑失败：${err.message}`;
    } finally {
      unbindBtn.disabled = false;
    }
  });
  unbindBtn.hidden = true;
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') bindBtn.click(); });
  form.append(help, input, bindBtn, unbindBtn);

  async function refresh() {
    const { has_key: hasKey } = await API.hasApikey();
    sub.textContent = hasKey ? '已绑定 · 加密存储，不回显' : '未绑定 · 同步需要它';
    bindBtn.textContent = hasKey ? '更换' : '绑定';
    unbindBtn.hidden = !hasKey;
  }
  refresh().catch((err) => { sub.textContent = err.message; });

  r.append(col, form);
  return r;
}

/**
 * @param {HTMLElement} root
 * @param {{onBack:()=>void, onHideToggle:(v:boolean)=>void, onEnterMock:()=>void,
 *          onSwitchEnv:()=>void, onSynced:()=>Promise<void>}} h
 */
export function mount(root, h) {
  els.root = root;
  handlers = h;
  render();
}

/**
 * MOCK 环境的进出按钮。
 *
 * ⚠️ 判「在不在 MOCK」不能只看 `API.isMock()`：它在什么都没存过时也返回 true（那是取数
 * 适配器的默认落点，不代表用户选过）。全新用户打开设置页会看到一个「退出测试模式」，
 * 而他根本没进去过。所以要 `isMock() && hasSession()` 两个条件一起看。
 *
 * 退出分两种情况——手里还有 token 就直接切回 LIVE，没有就只能回首启重新登录；
 * 两者都叫「退出」而落点不同，按钮上就得说清楚。
 */
function mockEnvButton(inMock, imported) {
  if (!inMock || imported) {
    return btn('btn-secondary', '进入测试模式', () => handlers.onEnterMock());
  }
  if (API.getToken()) {
    return btn('btn-secondary', '退出并回到 LIVE', () => {
      API.setMode('live');
      handlers.onEnterMock(true);   // 复用同一条「换完环境重进时间轴」的路径
    });
  }
  return btn('btn-secondary', '去登录 Steam', () => handlers.onSwitchEnv());
}

/** 可重复调用：每次进入设置页都按当前环境与数据重绘。 */
export function render() {
  els.root.innerHTML = '';
  const mock = API.isMock();
  const imported = API.isImport();

  const topbar = document.createElement('div');
  topbar.className = 'page-topbar';
  const back = document.createElement('button');
  back.className = 'iconbtn';
  back.innerHTML = svg('chevL');
  back.addEventListener('click', handlers.onBack);
  const title = document.createElement('div');
  title.className = 'heading';
  title.textContent = '设置';
  topbar.appendChild(back);
  topbar.appendChild(title);

  const col = document.createElement('div');
  col.className = 'page-col';
  col.style.top = '136px';

  // —— 账号（含当前环境）——
  const envBadge = document.createElement('span');
  envBadge.className = 'mode-badge' + (mock || imported ? ' mock' : '');
  envBadge.textContent = imported ? 'IMPORT' : (mock ? 'MOCK' : 'LIVE');

  const accountRight = document.createElement('div');
  accountRight.style.cssText = 'display:flex;align-items:center;gap:12px;';
  accountRight.appendChild(envBadge);
  accountRight.appendChild(btn('btn-secondary', mock || imported ? '切换环境' : '退出登录', async () => {
    if (imported) API.exitImport();          // 只读会话到此为止，回到底层那套持久环境
    else if (!mock) {
      try { await API.logout(); } catch { /* 本地 token 已清，后端失败不阻塞 */ }
    }
    handlers.onSwitchEnv();
  }));

  const accountRow = document.createElement('div');
  accountRow.className = 'list-row';
  accountRow.style.minHeight = '76px';
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  const accountCol = document.createElement('div');
  accountCol.className = 'main-col';
  const accountMain = document.createElement('div');
  accountMain.className = 'body-text';
  accountMain.textContent = imported ? '导入的本地备份（只读）'
    : (mock ? 'MOCK 测试模式（本地假数据）' : '已连接 Steam');
  const accountSub = document.createElement('div');
  accountSub.className = 'mono caption';
  accountSub.textContent = imported ? '会话内有效 · 刷新后需要重新导入'
    : (mock ? '不访问后端 · 数据仅供交互与视觉验收' : maskSteamId(API.getUserId()));
  accountCol.append(accountMain, accountSub);
  // LIVE 下副标是「SteamID · N GAMES」，游戏数要等 timeline 回来才知道
  if (!mock && !imported) {
    API.getTimeline()
      .then((d) => { accountSub.textContent = `${maskSteamId(API.getUserId())} · ${d.games.length} GAMES`; })
      .catch(() => { accountSub.textContent = maskSteamId(API.getUserId()); });
  }
  accountRow.append(avatar, accountCol, accountRight);

  // —— 同步 ——
  const syncStamp = document.createElement('div');
  syncStamp.className = 'mono caption';
  syncStamp.textContent = '…';
  const syncBtn = btn('btn-primary', '同步', async () => {
    syncBtn.disabled = true;
    syncStamp.textContent = '同步中…';
    try {
      await API.syncNow((ev) => {
        if (ev.step && ev.step !== 'done') syncStamp.textContent = API.stepLabel(ev.step);
      });
      syncStamp.textContent = '同步完成';
      await handlers.onSynced();
    } catch (err) {
      syncStamp.textContent = `同步失败：${err.message}`;
    } finally {
      syncBtn.disabled = false;
    }
  });
  const syncRight = document.createElement('div');
  syncRight.style.cssText = 'display:flex;align-items:center;gap:12px;';
  syncRight.append(syncStamp, syncBtn);

  if (imported) {
    syncBtn.disabled = true;
    syncStamp.textContent = '导入模式为只读，无法同步';
  }

  const refreshSyncStamp = () => API.getSyncStatus()
    .then((s) => {
      if (syncBtn.disabled) return; // 正在同步（或只读模式），别用状态覆盖当前文案
      syncStamp.textContent = s.last_sync_at
        ? `LAST SYNC ${String(s.last_sync_at).replace('T', ' ').slice(0, 16)}`
        : (s.has_key ? 'NEVER SYNCED' : '未绑定 API KEY');
    })
    .catch((err) => { syncStamp.textContent = err.message; });
  refreshSyncStamp();

  // —— 数据 ——
  const countEl = document.createElement('div');
  countEl.className = 'mono caption';
  countEl.textContent = dataset ? `${dataset} 款` : '…';
  API.getTimeline()
    .then((d) => {
      dataset = d.games.filter((g) => g.lifecycle === 'never_launched').length;
      countEl.textContent = `${dataset} 款`;
    })
    .catch(() => { countEl.textContent = '—'; });

  const hideRight = document.createElement('div');
  hideRight.style.cssText = 'display:flex;align-items:center;gap:12px;';
  hideRight.append(countEl, toggleBtn(getHideNeverLaunched(), (v) => {
    setHideNeverLaunched(v);
    handlers.onHideToggle(v);
  }));

  const chevRight = (icon = 'chevR') => {
    const d = document.createElement('div');
    d.style.cssText = 'color:var(--text-3);display:flex;';
    d.innerHTML = svg(icon, 16);
    return d;
  };

  // —— 导出：先把备份打出来算体积，点行就下载同一份 ——
  const exportRow = row('导出 JSON 备份', 'JSON · 计算中…', chevRight('download'));
  exportRow.style.cursor = 'pointer';
  exportRow.setAttribute('role', 'button');
  exportRow.tabIndex = 0;
  const exportSub = exportRow.querySelector('.caption');
  let exportText = null;
  API.exportDataset()
    .then((payload) => {
      exportText = JSON.stringify(payload);
      // Blob 按 UTF-8 字节算，中文游戏名下和 string.length 差着一截，用 Blob 才是真实体积
      exportSub.textContent = `JSON · ${fmtMB(new Blob([exportText]).size)}`;
    })
    .catch((err) => { exportSub.textContent = `导出不可用：${err.message}`; });
  const doExport = () => {
    if (!exportText) return;
    download(`save-point-backup-${new Date().toISOString().slice(0, 10)}.json`, exportText);
  };
  exportRow.addEventListener('click', doExport);
  exportRow.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); doExport(); }
  });

  // —— 环境：MOCK 测试模式的唯一入口（v1.8 由首启页搬来）——
  // 「在 MOCK 里」= 既是 mock 适配器、又确实选过（见 mockEnvButton 的 ⚠️）
  const inMock = mock && API.hasSession();
  // 标题跟着状态走：已经在测试模式里时，上面那行账号行已经写着「MOCK 测试模式」了，
  // 这里再写一遍就是同一信息在一屏出现两次（05§0 规则 2）。所以进去之后改说「怎么出来」。
  const ms = API.mockStats();
  const mockRow = inMock
    ? row('退出测试模式', '回到真实 Steam 数据', mockEnvButton(inMock, imported))
    : row('MOCK 测试模式',
      ms ? `${ms.games} 款游戏 · ${ms.timepoints} 个时点 · ${ms.screenshots} 张截图 · ${ms.from} → ${ms.to}`
        : '本地假数据，不连后端，不动真实库',
      mockEnvButton(inMock, imported));

  // API Key 只在 LIVE 下有意义：MOCK 没有后端，IMPORT 是只读会话
  const accountRows = (mock || imported)
    ? [accountRow, mockRow]
    : [accountRow, apikeyRow(refreshSyncStamp), mockRow];
  col.appendChild(group('ACCOUNT', accountRows));
  col.appendChild(group('SYNC', [
    row('立即同步', null, syncRight),
    row('启动时自动同步', null, toggleBtn(true, () => {})),
  ]));
  col.appendChild(group('DATA', [
    row('隐藏从未启动的游戏', null, hideRight),
    exportRow,
    row('打开数据目录', null, chevRight()),
  ]));

  els.root.appendChild(topbar);
  els.root.appendChild(col);
}
