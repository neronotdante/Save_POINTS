// 数据访问门面：**视图层唯一取数入口**。
//
// 两套环境并行（MOCK / LIVE）在这里分流，方法名与出参形状对齐后端端点，
// 所以 timeline.js / panel.js / settings.js 完全不知道自己跑在哪套环境里——
// 这是把「测试模式」做成一个开关而不是一份分叉代码的关键。
//
// | 门面方法                          | 后端端点（backend/app/api/）                 |
// |----------------------------------|---------------------------------------------|
// | getTimeline()                    | GET  /calendar/timeline   （带 ETag）        |
// | getDayDetail(day)                | GET  /calendar/day/{day}                    |
// | getAchievementDetail(appid, day) | GET  /achievements/{appid}/{day}            |
// | getSyncStatus()                  | GET  /sync/status                           |
// | syncNow(onProgress)              | POST /sync                （SSE 进度流）     |
// | hasApikey() / submitApikey(k)    | GET|POST /auth/apikey                       |
// | deleteApikey()                   | DELETE /auth/apikey                         |
// | logout()                         | POST /auth/logout                           |
// | health()                         | GET  /health                                |
// | loginUrl()                       | GET  /auth/steam/openid/login?front=… （302 到 Steam）|

import * as Mock from './mock-data.js';

const MODE_KEY = 'gamec.timeline.mode';
const TOKEN_KEY = 'gamec.timeline.token';
const USER_KEY = 'gamec.timeline.userId';
const BASE_KEY = 'gamec.timeline.apiBase';

/**
 * 后端默认地址。前端有两种起法：
 *   · 由后端托管（http://127.0.0.1:8000/，`run.cmd` 的路径）——前后端同源，直接用页面自己的 origin；
 *   · serve.py 起在 5173 / 5174 的开发态——得指回后端。
 * 用户在「已有 token」页里改过的地址仍以 localStorage 为准（getApiBase）。
 */
const DEFAULT_BASE = (() => {
  const devPorts = new Set(['5173', '5174']);
  if (/^https?:$/.test(location.protocol) && !devPorts.has(location.port)) return location.origin;
  return 'http://127.0.0.1:8000';
})();

/** 申请 Steam Web API Key 的官方页面（首启页与设置页都要链过去）。 */
export const APIKEY_HELP_URL = 'https://steamcommunity.com/dev/apikey';

/** MOCK 同步的单阶段耗时（ms）。真实同步动辄几分钟，测试模式没有等待的理由。 */
const MOCK_SYNC_STEP_MS = 90;

/**
 * 后端 /sync SSE 的**采集**阶段序列，按 backend/app/services/sync_service.py 的实际推送顺序。
 * 用途有两个：首启页的阶段 chip、进度条的分母。
 *
 * ⚠️ 这个数组必须和后端的 `yield {"step": ...}` 保持一致。少列一个阶段的后果不是「少个格子」：
 * 收到未列入的 step 时 chip 不推进、状态文案会退化成裸英文的 step 名（`stepLabel` 的兜底），
 * 用户看到的是「进度条不动 + 一行看不懂的英文」——正是最像卡死的那种画面。
 *
 * 不在此列的三个 step 有各自的理由：
 *   · `sync`      —— 开工信号，不是采集阶段；
 *   · `lifecycle` —— 纯本地重算，秒级完成，给它一个 chip 只会在最后闪一下；
 *   · `done`      —— 终态。
 * 三者仍有中文文案（见 STEP_LABEL），只是不占 chip。
 */
export const SYNC_STEPS = [
  'owned_games', 'wishlist', 'purchase_history', 'recently_played', 'achievements', 'screenshots',
];

const STEP_LABEL = {
  sync: '正在准备同步',
  owned_games: '正在拉取游戏库',
  wishlist: '正在拉取愿望单',
  purchase_history: '正在拉取购买历史',
  recently_played: '正在拉取运行记录',
  achievements: '正在回填成就',
  screenshots: '正在拉取游戏截图',
  lifecycle: '正在重算游戏状态',
  done: '同步完成',
};
/** 把 SSE 的 step 翻成界面文案；未知 step 原样透出，不吞掉后端新增的阶段。 */
export const stepLabel = (step) => STEP_LABEL[step] ?? step;

// ---- 模式与凭据（localStorage 持久化，刷新后保持所处环境） ----

/**
 * 「导入本地备份」是**会话内**的临时环境：数据只在内存里，刷新即失效。
 * 所以它不写 localStorage，而是压在持久模式之上——否则刷新后模式还在、数据没了，
 * 界面会停在一个取不到数的死状态。
 */
let importedMode = null;
let importedDataset = null;

/** @returns {'mock'|'live'|'import'} */
export function getMode() {
  if (importedMode) return importedMode;
  return localStorage.getItem(MODE_KEY) === 'live' ? 'live' : 'mock';
}
export function setMode(mode) {
  importedMode = null;
  importedDataset = null;
  localStorage.setItem(MODE_KEY, mode === 'live' ? 'live' : 'mock');
}
export const isMock = () => getMode() === 'mock';
export const isImport = () => getMode() === 'import';

/**
 * 上次用的环境能不能**直接续上**（02§5.4：不必每次都过首启）。
 *
 * ⚠️ 不能直接拿 `getMode()` 判断：它在没存过任何东西时返回 `'mock'`（那是取数适配器的
 * 默认落点，不代表用户选过 MOCK）。全新用户会因此被静默丢进测试模式，看到一堆假数据
 * 还以为是自己的库。所以这里判的是 **localStorage 里到底有没有那一条记录**。
 * IMPORT 是会话内只读环境（不落盘），刷新后本来就该回到底层环境，故不参与。
 */
export function hasSession() {
  const raw = localStorage.getItem(MODE_KEY);
  if (raw === 'live') return !!getToken();   // token 被清过（登出 / 过期）就得重新登录
  return raw === 'mock';
}

/**
 * 载入一份导出的 JSON 备份并切到导入模式。
 * @param {{games?: any[], events?: any[], screenshots?: any[], achievements?: Record<string, any[]>}} raw
 * @throws {ApiError} 形状不对时抛，调用方把原因摆给用户看
 */
export function setImportedDataset(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.games)) {
    throw new ApiError('备份文件格式不对：缺少 games 数组');
  }
  if (!Array.isArray(raw.events) && !Array.isArray(raw.screenshots)) {
    throw new ApiError('备份文件格式不对：events 与 screenshots 至少要有一个');
  }
  importedDataset = {
    games: raw.games,
    events: raw.events ?? [],
    screenshots: raw.screenshots ?? [],
    achievements: raw.achievements ?? {},
    exported_at: raw.exported_at ?? null,
  };
  importedMode = 'import';
}

/** 退出导入模式，回到之前那套持久环境（MOCK/LIVE），不动 localStorage。 */
export function exitImport() {
  importedMode = null;
  importedDataset = null;
}

/**
 * 把当前环境的数据打成一份可再导入的备份。
 * 成就明细不在 timeline 出参里，导出时不逐款去拉——那会打上百个请求；
 * 备份里没有 achievements 字段时，导入方的成就面板会显示「当日无成就明细」。
 */
export async function exportDataset() {
  const d = await getTimeline();
  return {
    format: 'game_c.timeline.v1',
    exported_at: new Date().toISOString(),
    games: d.games.map(({ __abbr, ...g }) => g),
    events: d.events,
    screenshots: d.screenshots,
  };
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** 登录回跳带回来的 SteamID64，设置页拿它显示账号身份（打码后展示，不外发）。 */
export const getUserId = () => localStorage.getItem(USER_KEY) || '';
export function setUserId(id) {
  if (id) localStorage.setItem(USER_KEY, id);
  else localStorage.removeItem(USER_KEY);
}

export function getApiBase() {
  return localStorage.getItem(BASE_KEY) || DEFAULT_BASE;
}
export function setApiBase(base) {
  localStorage.setItem(BASE_KEY, (base || DEFAULT_BASE).replace(/\/+$/, ''));
}

/**
 * LIVE 登录入口：整页跳到后端，由后端 302 去 Steam OpenID。
 * `front` 报上本页的源：后端只认 CORS 白名单里的源，登录完成后按它 302 回来——
 * 所以托管在 8000 还是 serve.py 起在 5173，都能回到发起登录的那一页。
 */
export const loginUrl = () =>
  `${getApiBase()}/auth/steam/openid/login?front=${encodeURIComponent(location.origin)}`;

/**
 * 消费登录回调带回的 URL fragment（`#token=...&user_id=...` 或 `#error=...`）。
 * 后端验签成功后 302 回本页并把 token 放在 fragment 里（fragment 不进服务端日志/Referer）。
 * 取到后立即用 replaceState 清掉 hash——token 不该留在地址栏和浏览器历史里。
 * @returns {{token?: string, userId?: string, error?: string} | null}
 */
export function consumeLoginCallback() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (!hash) return null;
  const p = new URLSearchParams(hash);
  const token = p.get('token');
  const error = p.get('error');
  if (!token && !error) return null;

  history.replaceState(null, '', location.pathname + location.search);
  if (token) {
    setMode('live');
    setToken(token);
    const userId = p.get('user_id') || '';
    setUserId(userId);
    return { token, userId: userId || undefined };
  }
  return { error };
}

// ---- HTTP 基建 ----

export class ApiError extends Error {
  constructor(message, { status = 0, cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.cause = cause;
  }
}

async function request(path, { method = 'GET', body, auth = true, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getToken();
    if (!token) throw new ApiError('尚未登录（缺少 token）', { status: 401 });
    headers.Authorization = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      method, headers, signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // fetch 只在网络层失败时 reject：后端没起、端口不通、CORS 预检被拒都走这里
    throw new ApiError(`无法连接后端 ${getApiBase()}（后端未启动或 CORS 未放行）`, { cause: err });
  }
  if (res.status === 401) {
    throw new ApiError('登录态失效，请重新登录', { status: 401 });
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.detail ?? ''; } catch { /* 非 JSON 错误体 */ }
    throw new ApiError(detail || `${method} ${path} 失败（HTTP ${res.status}）`, { status: res.status });
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---- 出参归一化：补齐后端没有、但视图层要用的派生字段 ----

/** 封面占位缩写（05§5：无封面时用主题色渐变 + 2~3 字母缩写）。后端不出这个字段，前端派生。 */
function deriveAbbr(game) {
  if (game.__abbr) return game.__abbr;
  const en = (game.name_en || '').trim();
  if (en) {
    const words = en.split(/[\s:_-]+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return en.slice(0, 3).toUpperCase();
  }
  return String(game.appid).slice(0, 3);
}

/** 统一 timeline 出参：补 __abbr、保证 games 可按 appid 索引。mock 与 live 都过这一道。 */
function normalizeTimeline(payload) {
  const games = (payload.games ?? []).map((g) => ({ ...g, __abbr: deriveAbbr(g) }));
  return {
    events: payload.events ?? [],
    screenshots: payload.screenshots ?? [],
    games,
    gamesByAppid: new Map(games.map((g) => [g.appid, g])),
  };
}

// ---- MOCK adapter ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mockAdapter = {
  async health() { return { status: 'ok', mode: 'mock' }; },
  async getTimeline() { return normalizeTimeline(Mock.getTimeline()); },
  async getDayDetail(day) { return Mock.getDayDetail(day); },
  async getAchievementDetail(appid, day) {
    await sleep(40); // 保留一点点延时，让 panel 的 loading 分支在测试模式下也走得到
    return Mock.getAchievementDetail(appid, day);
  },
  async getSyncStatus() {
    return { status: 'idle', last_sync_at: new Date(Mock.NOW * 1000).toISOString(), last_error: null, has_key: true };
  },
  async hasApikey() { return { has_key: true }; },
  async submitApikey() { return null; },
  async deleteApikey() { return null; },
  async logout() { return null; },
  /**
   * 快进版同步：**阶段序列与 LIVE 逐个对齐**，只是每阶段 90ms——测试模式不该把时间花在等进度条上。
   * 序列一致是硬要求：MOCK 下验收过的进度态，到 LIVE 必须原样成立（02§5.2）。
   */
  async syncNow(onProgress) {
    const s = Mock.stats();
    const totals = {
      owned_games: s.games,
      wishlist: Math.max(1, Math.round(s.games * 0.1)),
      purchase_history: s.games,
      recently_played: s.timepoints,
      achievements: s.events,
      screenshots: s.screenshots,
    };
    onProgress?.({ step: 'sync' });
    for (const step of SYNC_STEPS) {
      const total = totals[step] ?? 1;
      for (const frac of [0.34, 0.72, 1]) {
        onProgress?.({ step, processed: Math.round(total * frac), total });
        await sleep(MOCK_SYNC_STEP_MS / 3);
      }
    }
    onProgress?.({ step: 'lifecycle' });
    await sleep(MOCK_SYNC_STEP_MS / 3);
    onProgress?.({ step: 'done' });
    return { ok: true };
  },
};

// ---- 导入备份 adapter ----
// 只读：所有出参都从内存里那份 JSON 现算，不碰网络也不碰 mock。

const importAdapter = {
  async health() { return { status: 'ok', mode: 'import' }; },
  async getTimeline() { return normalizeTimeline(importedDataset); },
  async getDayDetail(day) {
    const rows = importedDataset.events
      .filter((e) => e.date === day)
      // 备份里没有时刻（timeline 出参本来就只到日），给 null 让 panel 的时间戳位留空
      .map((e) => ({ type: e.type, game: e.game, theme_color: e.theme_color, count: e.count, time: null }));
    return { rows, screenshots: importedDataset.screenshots.filter((s) => s.taken_at.slice(0, 10) === day) };
  },
  async getAchievementDetail(appid, day) {
    return importedDataset.achievements?.[`${appid}|${day}`] ?? [];
  },
  async getSyncStatus() {
    return { status: 'unconfigured', last_sync_at: importedDataset.exported_at, last_error: null, has_key: false };
  },
  async hasApikey() { return { has_key: false }; },
  async submitApikey() { throw new ApiError('导入模式为只读，不能绑定 API Key'); },
  async deleteApikey() { throw new ApiError('导入模式为只读，没有可解绑的 API Key'); },
  async logout() { return null; },
  async syncNow() { throw new ApiError('导入模式为只读，无法同步'); },
};

// ---- LIVE adapter ----

let timelineEtag = null;
let timelineCache = null;

const liveAdapter = {
  async health() { return request('/health', { auth: false }); },

  /** 带 ETag：两次同步之间数据不变，命中 304 直接复用缓存（后端 calendar.py 已实现指纹）。 */
  async getTimeline() {
    const headers = { Authorization: `Bearer ${getToken()}` };
    if (timelineEtag) headers['If-None-Match'] = timelineEtag;
    let res;
    try {
      res = await fetch(`${getApiBase()}/calendar/timeline`, { headers });
    } catch (err) {
      throw new ApiError(`无法连接后端 ${getApiBase()}（后端未启动或 CORS 未放行）`, { cause: err });
    }
    if (res.status === 304 && timelineCache) return timelineCache;
    if (res.status === 401) throw new ApiError('登录态失效，请重新登录', { status: 401 });
    if (!res.ok) throw new ApiError(`拉取时间轴失败（HTTP ${res.status}）`, { status: res.status });
    timelineEtag = res.headers.get('ETag');
    timelineCache = normalizeTimeline(await res.json());
    return timelineCache;
  },

  async getDayDetail(day) { return request(`/calendar/day/${day}`); },
  async getAchievementDetail(appid, day) { return request(`/achievements/${appid}/${day}`); },
  async getSyncStatus() { return request('/sync/status'); },
  async hasApikey() { return request('/auth/apikey'); },
  async submitApikey(apikey) { return request('/auth/apikey', { method: 'POST', body: { apikey } }); },
  async deleteApikey() { return request('/auth/apikey', { method: 'DELETE' }); },
  async logout() {
    try { await request('/auth/logout', { method: 'POST' }); } finally { setToken(''); setUserId(''); }
    return null;
  },

  /**
   * 手动同步：POST /sync 返回 SSE 流。
   * 用 fetch 而非 EventSource——EventSource 不能带 Authorization 头，而后端要 Bearer。
   */
  async syncNow(onProgress) {
    const token = getToken();
    if (!token) throw new ApiError('尚未登录（缺少 token）', { status: 401 });
    let res;
    try {
      res = await fetch(`${getApiBase()}/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new ApiError(`无法连接后端 ${getApiBase()}`, { cause: err });
    }
    if (res.status === 401) throw new ApiError('登录态失效，请重新登录 Steam', { status: 401 });
    if (res.status === 409) throw new ApiError('同步正在进行中（后端已有一轮在跑）', { status: 409 });
    if (res.status === 400) throw new ApiError('尚未绑定 API Key，无法同步', { status: 400 });
    if (!res.ok) throw new ApiError(`触发同步失败（HTTP ${res.status}）`, { status: res.status });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastError = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE 帧以空行分隔；不足一帧的残片留在 buf 里等下一次 read
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) {
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (event === 'error') lastError = payload?.message || '同步失败';
        onProgress?.({ step: event, ...payload });
      }
    }
    timelineEtag = null; // 同步后数据必然变了，作废 ETag 缓存
    timelineCache = null;
    if (lastError) throw new ApiError(lastError);
    return { ok: true };
  },
};

// ---- 门面：按当前模式分流 ----

const ADAPTERS = { mock: mockAdapter, live: liveAdapter, import: importAdapter };
const adapter = () => ADAPTERS[getMode()];

export const health = () => adapter().health();
export const getTimeline = () => adapter().getTimeline();
export const getDayDetail = (day) => adapter().getDayDetail(day);
export const getAchievementDetail = (appid, day) => adapter().getAchievementDetail(appid, day);
export const getSyncStatus = () => adapter().getSyncStatus();
export const hasApikey = () => adapter().hasApikey();
export const submitApikey = (k) => adapter().submitApikey(k);
export const deleteApikey = () => adapter().deleteApikey();
export const logout = () => adapter().logout();
export const syncNow = (onProgress) => adapter().syncNow(onProgress);

/**
 * MOCK 数据集的规模摘要——描述的是那份假数据本身，与当前处于哪套环境无关，
 * 所以在 LIVE 下也照常返回：首启页要用它介绍「进测试模式能看到什么」。
 */
export const mockStats = () => Mock.stats();

/**
 * 「今天」的 unix 秒——决定轴上 accent 今日刻度的位置（05§6 第7条）。
 * MOCK 用数据基准日（否则假数据全在"过去"、今日刻度飘到轴外）；LIVE 用真实当前时间。
 */
export const now = () => (isMock() ? Mock.NOW : Math.floor(Date.now() / 1000));

/**
 * 素材直取：把一张 Steam 图床上的图片**换成一个走后端的同源请求**（导出长图专用）。
 *
 * 为什么不是前端自己 fetch：导出长图要把图画进 canvas 再取 PNG，跨域图片会污染画布让
 * `toBlob` 直接抛错。Steam 的封面 / 截图图床给了 `Access-Control-Allow-Origin: *`，
 * 前端自己取得回来；唯独**成就图标**那个域（steamcdn-a.akamaihd.net 的
 * /steamcommunity/public/images/）不给，只能借后端的 `/media/image` 转一手。
 * 这条通道的白名单与边界写在 backend/app/api/media.py。
 *
 * @param {string} url 图片原址
 * @returns {Request|null} 可直接喂给 fetch 的请求；当前环境没有后端会话时返回 null
 *   （MOCK 没有真图，IMPORT 只有一份离线 JSON，两者都没有「借后端转一手」这回事）
 */
export function mediaRequest(url) {
  if (getMode() !== 'live') return null;
  const token = getToken();
  if (!token) return null;
  return new Request(`${getApiBase()}/media/image?url=${encodeURIComponent(url)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** 导入备份的规模摘要（首启页与设置页展示用）；非导入模式返回 null。 */
export function importStats() {
  if (!isImport()) return null;
  return {
    games: importedDataset.games.length,
    events: importedDataset.events.length,
    screenshots: importedDataset.screenshots.length,
    exported_at: importedDataset.exported_at,
  };
}
