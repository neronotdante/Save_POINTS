/**
 * 生成 06 §10.1 要求的三张压力壁纸，供玻璃验收用。
 *   纯白      —— 05 §2 的红线：面板边界只剩外描边 + 投影，仍要一眼可辨
 *   深色照片  —— 自适应填充 + 对比度解耦（06 §13.4）的主战场
 *   高频花纹  —— 06 §7.1 的破绽：v1 靠颗粒打散，v2 靠真模糊
 *
 * 自己写 PNG 编码而不是拉依赖：只需要 IHDR/IDAT/IEND 三个块，
 * zlib 是 Node 内建的，二十行的事。
 *
 *   node scripts/make-stress-wallpapers.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 1920;
const H = 1080;
const OUT = path.join(__dirname, '..', 'assets', '压力壁纸');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {(x:number,y:number)=>[number,number,number]} shade */
function writePng(file, shade) {
  const raw = Buffer.alloc(H * (1 + W * 3));
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0;                      // 每行的 filter type，0 = None
    for (let x = 0; x < W; x++) {
      const [r, g, b] = shade(x, y);
      raw[p++] = r; raw[p++] = g; raw[p++] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type 2 = truecolor
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  console.log('written:', file, fs.statSync(file).size, 'bytes');
}

fs.mkdirSync(OUT, { recursive: true });

// ① 纯白：最难的一张，面板只剩一圈边
writePng(path.join(OUT, '纯白.png'), () => [255, 255, 255]);

// ② 深色「照片」：#13213D 附近的暗蓝，带一点大尺度明暗起伏和几个高光，
//    模拟真实夜景照片的动态范围 —— 纯色平涂验不出自适应填充的效果
writePng(path.join(OUT, '深色照片.png'), (x, y) => {
  const u = x / W;
  const v = y / H;
  const glow = Math.exp(-(((u - .28) ** 2) / .06 + ((v - .32) ** 2) / .05));
  const band = .5 + .5 * Math.sin(u * 6.0 + v * 2.2);
  const base = 0.10 + 0.16 * band * (1 - v * .5) + 0.55 * glow;
  return [
    Math.min(255, Math.round(19 + base * 90)),
    Math.min(255, Math.round(33 + base * 120)),
    Math.min(255, Math.round(61 + base * 165)),
  ];
});

// ③ 高频花纹：8px 周期的格子布 + 细斜纹。这是 backdrop-filter 最容易露馅的输入
writePng(path.join(OUT, '高频花纹.png'), (x, y) => {
  const grid = ((x % 8 < 4) !== (y % 8 < 4)) ? 232 : 42;
  const stripe = ((x + y) % 6 < 3) ? 18 : -18;
  const warm = ((x >> 6) + (y >> 6)) % 2 === 0 ? 26 : 0;
  const v = Math.max(0, Math.min(255, grid + stripe));
  return [Math.min(255, v + warm), v, Math.max(0, v - warm)];
});
