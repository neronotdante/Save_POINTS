/**
 * 生成系统托盘图标 assets/tray.png（32×32 圆角方块 + 白色网格）。
 * 纯 Node 实现，无外部依赖。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * stride + 1 + x * 4;
      raw[dst] = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
      raw[dst + 3] = rgba[src + 3];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- 绘制 32×32 图标 ----
const SIZE = 32;
const R = 7; // 圆角半径
const rgba = Buffer.alloc(SIZE * SIZE * 4);

function insideRoundedRect(x, y) {
  const px = x + 0.5;
  const py = y + 0.5;
  const rx = Math.min(Math.max(px, R), SIZE - R);
  const ry = Math.min(Math.max(py, R), SIZE - R);
  const dx = px - rx;
  const dy = py - ry;
  return dx * dx + dy * dy <= R * R;
}

const DOTS = [[11, 18], [21, 18], [11, 25], [21, 25]];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    if (!insideRoundedRect(x, y)) {
      rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 0;
      continue;
    }
    let r = 0x2F, g = 0x6B, b = 0xFF; // --accent
    // 顶部白条
    if (y >= 9 && y <= 12 && x >= 8 && x <= 23) { r = 0xFF; g = 0xFF; b = 0xFF; }
    // 四个白点（日历格）
    for (const [dx, dy] of DOTS) {
      const ddx = (x + 0.5) - dx;
      const ddy = (y + 0.5) - dy;
      if (ddx * ddx + ddy * ddy <= 2.6 * 2.6) { r = 0xFF; g = 0xFF; b = 0xFF; }
    }
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  }
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const png = encodePNG(SIZE, SIZE, rgba);
const outPath = path.join(outDir, 'tray.png');
fs.writeFileSync(outPath, png);
console.log('generated', outPath, '(' + png.length + ' bytes)');
