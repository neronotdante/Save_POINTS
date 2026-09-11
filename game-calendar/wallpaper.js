/**
 * 壁纸取样（主进程）——「液态玻璃实现文档」§13.4 的 L0 层数据源。
 *
 * 为什么要这一层：`transparent: true` 的窗口背后是 Windows 桌面，属于 DWM 的合成
 * 范畴，不在 Chromium 的合成树里，`backdrop-filter` 采样不到它（06 §1.1）。
 * 把壁纸**取进页面当背景**之后，真模糊与 SVG 折射立刻重新可用，而透明悬浮窗、
 * 26 圆角、自绘投影全部保住 —— 这是 v2 的全部立足点。
 *
 * 明确不做（06 §13.6.4）：desktopCapturer 实时轮询。抓屏会把我们自己的窗口也抓
 * 进去形成反馈，且成本远高于收益。
 *
 * 已知破绽（06 §13.6.1）：面板底下真压着别的窗口时，透出来的是壁纸而不是那个
 * 窗口。对一个常驻桌面的日历，这是被接受的取舍。
 */
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { nativeImage } = require('electron');

/**
 * 缩略图长边上限。
 * 取 1280 而不是更小：面板 668 宽在 1920 的屏幕上占 35%，缩到 1280 后对应
 * 约 445 源像素，贴回 668 只放大 1.5 倍，再经 backdrop-filter 的 blur(24) 完全
 * 看不出降采样。再小就会在纯色大面积区域出现可见的块状。
 *
 * 注意这里**不做预模糊**：06 §13.4 把 `blur(24px)` 写在 L2 的 backdrop-filter 里，
 * 折射 `url(#refract)` 也必须挂在同一条滤镜链上。两处都糊等于糊两次。
 * 代价是运行期多一个 backdrop-filter —— 而那条 backdrop-filter 本来就要有。
 */
const MAX_EDGE = 1280;

/** WallpaperStyle 注册表值 → 填充方式（06 §13.6.2：五种各要算一遍映射） */
const STYLE_MAP = {
  0: 'center',   // 配合 TileWallpaper=1 时是 tile
  1: 'tile',
  2: 'stretch',  // 拉伸，不保比例
  3: 'fit',      // 适应 = contain
  4: 'fill',     // 填充 = cover
  5: 'span',     // 跨区（多显示器拼一张）
  6: 'fit',
  10: 'fill',
  22: 'span',
};

/**
 * 用 PowerShell 读注册表，而不是 `reg query`：
 * reg.exe 的输出走 OEM 代码页（简中是 936），Node 没有内建 GBK 解码，
 * 壁纸路径里只要有一个中文字符就会变成乱码，文件读取随即失败。
 * PowerShell 可以强制 UTF-8 输出。用 -EncodedCommand 传脚本，免掉引号转义。
 */
function readDesktopKeys() {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$d = Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop'
$c = Get-ItemProperty -Path 'HKCU:\Control Panel\Colors'
$o = @{
  path  = [string]$d.WallPaper
  style = [string]$d.WallpaperStyle
  tile  = [string]$d.TileWallpaper
  bg    = [string]$c.Background
}
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $o))
`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 8000, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(String(stdout).trim()));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * Windows 把当前壁纸转码缓存在这里。路径全 ASCII，且注册表指向的原图被删 /
 * 挂在断开的网络盘 / 是 .heic 之类读不动的格式时，它仍然在。作为兜底。
 */
function transcodedPath() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
}

/** "12 34 56" → "#0C2238"，纯色壁纸时整条贴图链路被短路（06 §13.6.3） */
function parseBgColor(raw) {
  const parts = String(raw || '').trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const hex = parts.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
  return '#' + hex;
}

/** 读图 → 按长边缩放 → JPEG data URI。失败返回 null，调用方负责降级。 */
function loadThumb(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }

  // createFromBuffer 只嗅探 PNG / JPEG。老式 .bmp 壁纸会在这里落空，
  // 由调用方回退到 TranscodedWallpaper（它一律是 JPEG）。
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;

  const natural = img.getSize();
  if (!natural.width || !natural.height) return null;

  const scale = Math.min(1, MAX_EDGE / Math.max(natural.width, natural.height));
  const thumb = scale < 1
    ? img.resize({
        width: Math.round(natural.width * scale),
        height: Math.round(natural.height * scale),
        quality: 'better',
      })
    : img;

  const jpeg = thumb.toJPEG(82);
  if (!jpeg || !jpeg.length) return null;

  return {
    dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
    naturalWidth: natural.width,
    naturalHeight: natural.height,
  };
}

/**
 * @returns {Promise<null | {
 *   kind: 'image' | 'color',
 *   dataUrl?: string, naturalWidth?: number, naturalHeight?: number,
 *   color?: string, mode: string, signature: string
 * }>}
 * null = 取不到，渲染层降级回 v1 的不透明填充。
 */
async function readWallpaper() {
  /*
   * 压力壁纸测试钩子（06 §10.1 要求纯白 / 深色 / 高频花纹三张各截一图验收）。
   * 用环境变量而不是去改用户的壁纸设置 —— 验收不该有副作用。
   *   WALLPAPER=<图片路径> WALLPAPER_MODE=fill|fit|stretch|center|tile|span
   * 与已有的 SHOT= 同一套路子。
   */
  const override = process.env.WALLPAPER;
  if (override === 'none') return null;   // 强制走降级链路，验收 §13 的「坏掉也不该不可读」
  if (override) {
    const thumb = loadThumb(override);
    if (thumb) {
      return {
        kind: 'image',
        dataUrl: thumb.dataUrl,
        naturalWidth: thumb.naturalWidth,
        naturalHeight: thumb.naturalHeight,
        mode: STYLE_MAP[Number(process.env.WALLPAPER_MODE)] || process.env.WALLPAPER_MODE || 'fill',
        signature: 'override|' + override + '|' + (process.env.WALLPAPER_MODE || 'fill'),
      };
    }
  }

  if (process.platform !== 'win32') return null;

  const keys = await readDesktopKeys();
  const bgColor = parseBgColor(keys && keys.bg) || '#000000';

  const styleNum = Number((keys && keys.style) || 10);
  const tiled = String((keys && keys.tile) || '0') === '1';
  const mode = tiled && styleNum === 0 ? 'tile' : (STYLE_MAP[styleNum] || 'fill');

  const candidates = [];
  if (keys && keys.path) candidates.push(keys.path);
  candidates.push(transcodedPath());

  for (const candidate of candidates) {
    const thumb = loadThumb(candidate);
    if (!thumb) continue;
    let mtime = 0;
    try { mtime = fs.statSync(candidate).mtimeMs; } catch { /* 拿不到就用 0，不影响正确性 */ }
    return {
      kind: 'image',
      dataUrl: thumb.dataUrl,
      naturalWidth: thumb.naturalWidth,
      naturalHeight: thumb.naturalHeight,
      mode,
      // 用来判断「壁纸换了没有」，避免每次轮询都把几百 KB 的 base64 推给渲染层
      signature: candidate + '|' + mtime + '|' + mode,
    };
  }

  // 纯色壁纸：没有图可贴，但玻璃仍然要透 —— 直接给颜色，短路掉整条贴图链路
  return { kind: 'color', color: bgColor, mode: 'fill', signature: 'color|' + bgColor };
}

module.exports = { readWallpaper };
