/**
 * 玻璃验收跑批 ——「液态玻璃实现文档」§15.5 的验收口径。
 *
 *   node scripts/glass-acceptance.js
 *
 * 每一档启动一次 Electron，用 SHOT= 截图并读回 main.js 打的量化行。
 * 透光率的定义：同一布局下，纯白壁纸与纯黑壁纸的面板均值之差 ÷ 255。
 * 它直接回答「背景有多少能量真的透过来了」—— v1 是 7.6%。
 *
 * 验不了的三条（需要真机人工过）：
 *   §10.6   面板外 48px 能点到桌面图标 —— 点击穿透，截图看不出来
 *   §10.4   125% / 150% 缩放下 1px 描边不发虚 —— 需要肉眼
 *   §15.7.2 五种壁纸填充方式的真图映射 —— 需要一台壁纸文件没失联的机器
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WP = path.join(ROOT, 'assets', '压力壁纸');
const OUT = path.join(ROOT, 'assets', '玻璃验收_v2');
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron.cmd');

fs.mkdirSync(OUT, { recursive: true });

/** 纯黑壁纸只在透光率测量里用一次，不值得进压力壁纸目录 */
function ensureBlack() {
  const file = path.join(OUT, '_纯黑.png');
  if (fs.existsSync(file)) return file;
  const zlib = require('zlib');
  const W = 64, H = 64;
  const raw = Buffer.alloc(H * (1 + W * 3));   // 全 0 = 黑，filter 也是 0
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = 0xffffffff;
    for (let i = 0; i < body.length; i++) crc = crcTable[(crc ^ body[i]) & 0xff] ^ (crc >>> 8);
    const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
  return file;
}

function run(label, env) {
  const shot = path.join(OUT, label + '.png');
  const res = spawnSync(ELECTRON, ['.'], {
    cwd: ROOT,
    env: { ...process.env, SHOT: shot, ...env },
    encoding: 'utf8',
    shell: true,
    timeout: 90000,
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const pick = (key) => {
    const m = new RegExp('^' + key + ': (.+)$', 'm').exec(out);
    try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
  };
  const errors = out.split('\n').filter((l) => /\[renderer\].*(Error|error)/.test(l));
  return { label, shot, panel: pick('panel'), dom: pick('dom'), errors, raw: out };
}

const BLACK = ensureBlack();
const WHITE = path.join(WP, '纯白.png');

/* 观感验收：走完整自适应链路（06 §10.1 / §15.5 第 2、3 条）。
   「纯黑最坏」是自适应必然取到区间上限 .65 的一档 —— 对比度红线就是在
   这一档上倒推出来的（§15.1），所以它必须在验收里，不能只看三张压力壁纸。 */
const cases = [
  { label: '壁纸_纯白', env: { WALLPAPER: WHITE } },
  { label: '壁纸_深色照片', env: { WALLPAPER: path.join(WP, '深色照片.png') } },
  { label: '壁纸_高频花纹', env: { WALLPAPER: path.join(WP, '高频花纹.png') } },
  { label: '壁纸_纯黑最坏', env: { WALLPAPER: BLACK } },
  { label: '降级_无壁纸', env: { WALLPAPER: 'none' } },
];

/* 透光率：必须钉死 alpha。自适应会把纯白 / 纯黑两端往中间拉，
   不锁的话量到的是自适应曲线的斜率，不是这条链路的透光能力。 */
const ALPHA_PROBES = [
  { alpha: '.45', label: '亮壁纸档（区间下限）', min: .50 },
  { alpha: '.65', label: '暗壁纸档（区间上限）', min: .30 },
  { alpha: '.88', label: 'v1 基线，仅对照', min: null },
];

const results = [];
for (const c of cases) {
  process.stdout.write('running ' + c.label + ' … ');
  const r = run(c.label, c.env);
  results.push(r);
  console.log(r.panel ? 'mean=' + r.panel.mean + ' std=' + r.panel.std : 'NO DATA');
}

const transmittance = [];
for (const probe of ALPHA_PROBES) {
  process.stdout.write('透光率 @ alpha=' + probe.alpha + ' … ');
  const w = run('_透光_白_' + probe.alpha, { WALLPAPER: WHITE, GLASS_ALPHA: probe.alpha });
  const b = run('_透光_黑_' + probe.alpha, { WALLPAPER: BLACK, GLASS_ALPHA: probe.alpha });
  if (!w.panel || !b.panel) { console.log('NO DATA'); continue; }
  const t = (w.panel.mean - b.panel.mean) / 255;
  transmittance.push(Object.assign({ t, white: w.panel.mean, black: b.panel.mean }, probe));
  console.log((t * 100).toFixed(1) + '%');
}

console.log('\n================ 验收结果 ================');
const byLabel = Object.fromEntries(results.map((r) => [r.label, r]));

/* 判据是**分档**给的。别再用 §13.5 那个单一门槛 —— 那个数出自 §13.3 的 spike
   （量的是 .48 档），与后来写定的自适应区间自相矛盾（§14.4 ①）。 */
console.log('\n【透光率】v1 基线 7.6%（判据见 06 §15.5 第 1 条）');
for (const row of transmittance) {
  console.log('  alpha=' + row.alpha.padEnd(5)
    + '透光率 ' + (row.t * 100).toFixed(1).padStart(5) + '%'
    + (row.min === null ? '  门槛 ----  ' : '  门槛 ' + (row.min * 100).toFixed(0) + '%   ')
    + row.label.padEnd(22)
    + (row.min === null ? '' : (row.t >= row.min ? 'PASS' : 'FAIL')));
}

console.log('\n【三张压力壁纸 + 降级】');
for (const r of results) {
  if (!r.dom) { console.log(r.label + ': 没拿到 dom 自检'); continue; }
  const g = r.dom.glass || {};
  console.log([
    r.label.padEnd(16),
    'alpha=' + (g.alpha || '-'),
    'kind=' + (g.kind || '-'),
    'blur=' + (r.dom.backdropFilter === 'none' ? 'none' : 'on'),
    'std=' + (r.panel ? r.panel.std : '-'),
    'cells=' + r.dom.cells,
    r.errors.length ? 'ERRORS(' + r.errors.length + ')' : '零报错',
  ].join('  '));
}

/* 05 §6 的红线：除 --text-muted 外，前景不得低于 3:1。
   面板底色随壁纸浮动，所以这一条每张壁纸都要重算一遍。
   「纯黑最坏」那一行是决定自适应上限只能到 .65 的那一档（§15.1）。 */
console.log('\n【文字对比度】红线 ≥ 3:1（--text-muted 除外）');
for (const r of results) {
  const c = r.dom && r.dom.glass && r.dom.glass.contrast;
  if (!c) { console.log('  ' + r.label.padEnd(16) + '（降级档，底色固定，沿用 v0.3 实算）'); continue; }
  const worst = Math.min(c.text1, c.text2, c.text3);
  console.log('  ' + r.label.padEnd(16)
    + '面板底 ' + c.panelHex
    + '  text-1 ' + String(c.text1).padStart(5)
    + '  text-2 ' + String(c.text2).padStart(5)
    + '  text-3 ' + String(c.text3).padStart(5)
    + '  (α=' + r.dom.glass.textAlpha + ')'
    + '  ' + (worst >= 3 ? 'PASS' : 'FAIL'));
}

/* 切月帧率（06 §15.5 第 5 条）。壁纸取样把一个 backdrop-filter 加了回来，
   而 v1 删 blur 的理由之一就是它的合成成本 —— 拿降级档（没有 backdrop-filter）
   做对照，才能回答「这一个滤镜到底值多少帧」。 */
console.log('\n【切月帧率】判据：稳态掉帧 0');
const perfCases = [
  ['壁纸档（有 backdrop-filter）', { WALLPAPER: path.join(WP, '深色照片.png'), PERF: '1' }],
  ['降级档（无 backdrop-filter）', { WALLPAPER: 'none', PERF: '1' }],
];
for (const [label, env] of perfCases) {
  const r = run('_perf', env);
  const m = r.raw && /^perf: (.+)$/m.exec(r.raw);
  if (!m) { console.log('  ' + label.padEnd(28) + 'NO DATA'); continue; }
  const p = JSON.parse(m[1]);
  /* 判的是**稳态**。前 5 帧里的掉帧是 backdrop-filter 首次建合成层的
     一次性成本（实测只出现在 index 1，三次里复现一次，max 20.2ms =
     正好两个 100Hz 周期），与切月动画无关；中段掉帧才是真扛不住。 */
  const steady = (p.dropAt || []).filter((i) => i >= 5).length;
  console.log('  ' + label.padEnd(28)
    + 'p50 ' + String(p.p50).padStart(6) + 'ms'
    + '  p95 ' + String(p.p95).padStart(6) + 'ms'
    + '  稳态掉帧 ' + steady
    + (p.dropped > steady ? '（首帧建层 ' + (p.dropped - steady) + '，一次性）' : '')
    + '  ' + (steady === 0 ? 'PASS' : 'FAIL'));
}

const degraded = byLabel['降级_无壁纸'];
if (degraded && degraded.dom) {
  /* 降级只剩两条可断言：没有 backdrop-filter（没 L0 可采，写了是空转），
     以及填充回到 v1 的 .88。颗粒层已整体移除（06 §16），不再是降级的区分点。 */
  const g = degraded.dom.glass || {};
  const ok = degraded.dom.backdropFilter === 'none' && g.alpha === '.88';
  console.log('\n降级链路（取不到壁纸应原样回到 v1 的不透明档）: ' + (ok ? 'PASS' : 'FAIL — '
    + JSON.stringify({ backdrop: degraded.dom.backdropFilter, alpha: g.alpha })));
}

console.log('\n截图: ' + OUT);
