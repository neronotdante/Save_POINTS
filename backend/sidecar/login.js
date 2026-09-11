/**
 * Steam 登录侧车（Node + steam-session）。
 *
 * 用 DoctorMcKay 的 steam-session 完成登录（扫码 QR 或 账号密码 + Steam Guard），
 * 登录成功后 getWebCookies() 导出 sessionid / steamLoginSecure / refreshToken 给
 * Python 后端。密码只在内存中流转，不落盘、不写日志、不转发第三方。
 *
 * 接口（本地 HTTP，默认 127.0.0.1:8765）：
 *   POST /qr      -> {status:"qr", qrDataUri}        开始扫码登录，返回二维码 data URI
 *   POST /login   {username,password} -> {status:"guard"|"pending"|"error"}
 *   POST /guard   {code}               -> {status:"pending"|"error"}
 *   GET  /poll    -> {status:"pending"|"success",...}  轮询登录结果（QR 与密码共用）
 *   GET  /health  -> {ok:true}
 */
'use strict';

const http = require('http');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
const QRCode = require('qrcode');

const PORT = Number(process.env.SIDE_CAR_PORT || 8765);
const HOST = process.env.SIDE_CAR_HOST || '127.0.0.1';

// 单实例：同一时间只处理一个登录流程（本地自用，够用）。
let pending = null; // { session, mode, state, error }

function cookieValue(cookies, name) {
  for (const c of (cookies || [])) {
    const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    if (m) return m[1];
  }
  return null;
}

function steamid64(session) {
  const sid = session.steamID;
  return sid && typeof sid.getSteamID64 === 'function' ? sid.getSteamID64() : String(sid);
}

async function finishSuccess(session, respond) {
  try {
    const cookies = await session.getWebCookies();
    const result = {
      status: 'success',
      steamid: steamid64(session),
      sessionid: cookieValue(cookies, 'sessionid'),
      steamLoginSecure: cookieValue(cookies, 'steamLoginSecure'),
      refreshToken: session.refreshToken,
    };
    pending = null;
    respond(result);
  } catch (err) {
    pending = null;
    respond({ status: 'error', message: '获取 web 会话失败: ' + String(err && err.message || err) });
  }
}

function wire(session) {
  session.on('error', (err) => {
    if (pending && pending.session === session) {
      pending.state = 'error';
      pending.error = String(err && err.message || err);
    }
  });
  session.on('remoteInteraction', () => {
    if (pending && pending.session === session && pending.state !== 'authenticated') {
      pending.state = 'scanned'; // 已扫码，等待在手机端确认
    }
  });
  session.on('authenticated', () => {
    if (pending && pending.session === session) pending.state = 'authenticated';
  });
}

async function startQR(respond) {
  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
  pending = { session, mode: 'qr', state: 'qr', error: null };
  wire(session);
  try {
    const result = await session.startWithQR();
    const qrDataUri = await QRCode.toDataURL(result.qrChallengeUrl, { margin: 1, width: 240 });
    respond({ status: 'qr', qrDataUri });
  } catch (err) {
    pending = null;
    respond({ status: 'error', message: String(err && err.message || err) });
  }
}

async function startPassword(username, password, respond) {
  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
  pending = { session, mode: 'password', state: 'guard', error: null };
  wire(session);
  try {
    const result = await session.startWithCredentials({ accountName: username, password });
    if (result.actionRequired) {
      respond({
        status: 'guard',
        actions: (result.validActions || []).map((a) => a.type),
      });
    } else {
      pending.state = 'polling';
      respond({ status: 'pending' });
    }
  } catch (err) {
    pending = null;
    respond({ status: 'error', message: String(err && err.message || err) });
  }
}

async function submitGuard(code, respond) {
  if (!pending || pending.mode !== 'password') {
    return respond({ status: 'error', message: '无待处理的登录流程' });
  }
  try {
    await pending.session.submitSteamGuardCode(code);
    pending.state = 'polling';
    respond({ status: 'pending' });
  } catch (err) {
    pending = null;
    respond({ status: 'error', message: String(err && err.message || err) });
  }
}

async function pollResult(respond) {
  if (!pending) return respond({ status: 'error', message: '无待处理的登录流程' });
  if (pending.state === 'error') {
    const msg = pending.error;
    pending = null;
    return respond({ status: 'error', message: msg });
  }
  if (pending.state === 'authenticated') {
    return finishSuccess(pending.session, respond);
  }
  respond({ status: pending.state === 'scanned' ? 'scanned' : 'pending' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, statusCode, obj) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '';
  try {
    if (req.method === 'GET' && url.startsWith('/health')) return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.startsWith('/poll')) return pollResult((o) => send(res, 200, o));
    if (req.method === 'POST' && url.startsWith('/qr')) return startQR((o) => send(res, 200, o));

    if (req.method === 'POST' && url.startsWith('/login')) {
      const body = await readBody(req);
      if (!body.username || !body.password) return send(res, 400, { status: 'error', message: '缺少 username / password' });
      return startPassword(String(body.username), String(body.password), (o) => send(res, 200, o));
    }
    if (req.method === 'POST' && url.startsWith('/guard')) {
      const body = await readBody(req);
      if (!body.code) return send(res, 400, { status: 'error', message: '缺少 code' });
      return submitGuard(String(body.code), (o) => send(res, 200, o));
    }
    send(res, 404, { status: 'error', message: 'not found' });
  } catch (e) {
    send(res, 400, { status: 'error', message: String(e && e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[sidecar] Steam 登录侧车已启动 http://${HOST}:${PORT}`);
});
