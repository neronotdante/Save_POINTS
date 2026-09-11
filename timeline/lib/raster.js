// DOM → PNG 光栅化（业务无关，谁都能用）。
//
// 路径是**唯一一条**：把一棵已经排好版的 DOM 塞进 `<svg><foreignObject>`，让浏览器自己
// 用同一套排版引擎把它画成位图，再 drawImage 到 canvas 上取 PNG。不另写一套 canvas 绘制
// 逻辑——那等于把 styles.css 里的每一条规则在 JS 里再实现一遍，两份实现从第二天起就会分叉。
// （这也不违反「不做全量 canvas 渲染」那条选型约束：那条说的是**主渲染路径**，
// 这里是一次性的导出，画完就丢。）
//
// 三个绕不开的坑，代码里各有对应注释，这里先给全貌：
//
// 1. **SVG image 里没有网络**。`<img src="…svg">` 是一个隔离的渲染上下文，里面的
//    `url(https://…)` 一律**不会**去加载，也不报错——所有封面 / 截图 / 成就图标会静默变成
//    空格子。所以每一张真图都得先 fetch 回来转成 data: URI 再塞进去（见 inlineImages）。
// 2. **canvas 污染**。跨域图片直接画进 canvas 会让 `toBlob` 抛 SecurityError。这里所有图片
//    都是**自己 fetch 到的 blob**（fetch 拿不到就等于没有这张图，根本进不来），blob 同源，
//    画进去不会污染。Steam 的几个图床（cdn.cloudflare.steamstatic.com /
//    images.steamusercontent.com / steamuserimages-*.akamaihd.net）实测都给
//    `Access-Control-Allow-Origin: *`，取得回来。
//    ⚠️ 但**装 DOM 的那张 SVG 只能走 data: URI**：Chrome 把 blob: 来的 SVG image 判成非同源，
//    一样会污染画布（位图走 blob: 则没事）。实测记录见 nodeToPng 里那段注释。
// 3. **尺寸上限**。长图动辄几万像素，一次画完会撞浏览器的位图上限，而且是**静默**画成空白。
//    所以沿长边切片，每片单独光栅再拼到同一张 canvas 上；canvas 本身也先探一次开不开得出来
//    （见 allocCanvas），开不出来就降倍率，而不是交出一张全白的图。

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** CSS 值里的一处 url()。 */
const URL_RE = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g;

/** 单张贴图内联时的像素上限。它只是天花板，真正的目标尺寸按元素在图上占多大算。 */
const IMG_MAX = 1600;

/** 同时在飞的图片请求数。几百张一次全发出去，浏览器自己会排队，还会拖垮同页的其它请求。 */
const FETCH_CONCURRENCY = 8;

/** 单片光栅的像素上限（宽或高）。超过它浏览器把 SVG 画成位图时会失败，且**不报错**。 */
const SLICE_PX = 16384;

/**
 * canvas 的公开硬上限，只用来**省掉注定失败的那几次分配**（真值仍以 allocCanvas 探到的为准）。
 *
 * 取**各家里最宽松的那个**（Chrome/Safari 的 65535 边长、Chrome 的 2^28 面积），不取最严的：
 * 这只是个「别去申请一张 17 万像素宽的画布」的闸，真限制小于它的浏览器（Firefox 边长
 * 32767）会在探测那一步自己失败并降档。取最严的话，Chrome 用户会平白被压到 Firefox 的档。
 */
const MAX_DIM = 65535;
const MAX_AREA = 268435456;

/* ---------------- 小工具 ---------------- */

/**
 * 按**顶层逗号**切开一个多层 CSS 值（`url(a), linear-gradient(b, c)` → 两层）。
 * 不能直接 `split(',')`：渐变自己的参数里全是逗号，切完就是一堆非法值，
 * 而非法的 background-image 会被浏览器整条丢掉——表现是「这些格子突然全空了」。
 */
export function splitLayers(value) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 限并发地跑一批异步任务，每完成一个回一次进度。 */
async function pool(items, limit, worker, onDone) {
  let cursor = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      try { await worker(item); } catch { /* 单张失败不该带倒整次导出 */ }
      onDone?.(++done, items.length);
    }
  });
  await Promise.all(runners);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('图片解码失败'));
    im.src = src;
  });
}

/**
 * 开一张 canvas，并**验证它真的开出来了**。
 *
 * 超限时浏览器不抛异常：Chrome 把 width/height 悄悄改成 0，Firefox 给一张画不进东西的画布。
 * 两种情况都表现为「导出成功，但图是全白的」——那比报错难查得多。所以这里画一个像素再读
 * 回来，读得到才算数。
 */
function allocCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  if (canvas.width !== w || canvas.height !== h) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 1, 1);
    if (ctx.getImageData(0, 0, 1, 1).data[3] === 0) return null;
  } catch {
    return null;
  }
  ctx.clearRect(0, 0, 1, 1);
  return { canvas, ctx };
}

/** 用完立刻把画布缩到 0：一张 6 万 ×900 的画布是 200MB 级的内存，不放连导两次就顶到上限。 */
function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * 这个尺寸在**当前浏览器**上最大能用多少倍率画出来。
 * 不写死上限常量：各家的位图上限不同（还随显存变），探一次比查表准。
 * @returns {number} 实际可用倍率（≤ 传入值）
 */
export function fitScale(width, height, wanted) {
  // 先按公开的硬上限算一刀，再去探。少这一步的话，一条 8 万像素长的轴会先申请一张
  // 「宽 17 万」的画布——那是必然失败的一次几百 MB 分配，而这个函数每开一次面板、
  // 每换一次方向都要跑。算得出来的东西不该拿分配去试。
  const long = Math.max(width, height);
  const cap = Math.min(
    wanted,
    long > 0 ? MAX_DIM / long : wanted,
    width * height > 0 ? Math.sqrt(MAX_AREA / (width * height)) : wanted,
  );
  for (let s = cap; s >= 0.2; s *= 0.75) {
    const probe = allocCanvas(Math.round(width * s), Math.round(height * s));
    // 只能**向下**取整：四舍五入会把 0.7658 报成 0.77，调用方按 0.77 去开画布，
    // 于是开的比刚刚探成功的那张还大——探测就白做了，而且失败得莫名其妙。
    if (probe) { releaseCanvas(probe.canvas); return Math.floor(s * 100) / 100; }
  }
  return 0.2;
}

/* ---------------- 图片内联 ---------------- */

/**
 * 取一张图并**按它在成图上真正占的大小缩好**，取不到就走 `proxy` 再试一次。
 *
 * 缩放不是可选的优化：一张 1920×1080 的截图在长图上只占 76×43，原样内联进去，
 * 三百多张就是几十 MB 的 base64 塞进一个字符串——序列化、光栅、编码每一步都要再吃一遍。
 * 按占位缩到 1.25 倍（留点余量给 2× 导出）之后，同一张只剩几 KB。
 *
 * @param {string} url
 * @param {number} maxPx 目标长边像素
 * @param {((url:string)=>Request|null)|null} proxy 同源兜底通道；没有就只试直取
 * @param {Map<string, number>} hopeless 主机 → 直取失败次数（同一批内共享）
 * @returns {Promise<string>} data: URI
 */
async function fetchScaled(url, maxPx, proxy, hopeless) {
  const host = (() => { try { return new URL(url, location.href).host; } catch { return ''; } })();
  // 同一个主机连着失败几次，就别再对它抱希望：成就图标那个域有三千多张图，
  // 每张都先撞一次 CORS 再走代理 = 三千多个注定失败的请求，白等半分钟。
  const direct = !(proxy && hopeless.get(host) >= 3);
  let res = null;
  if (direct) {
    // credentials: 'omit'——图床不需要 cookie，带上反而会让部分 CDN 收回 `ACAO: *`
    try {
      res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      hopeless.set(host, (hopeless.get(host) ?? 0) + 1);
      res = null;
      if (!proxy) throw err;
    }
  }
  if (!res) {
    const req = proxy?.(url);
    if (!req) throw new Error('取不回来，且当前环境没有可用的代理');
    res = await fetch(req);
    if (!res.ok) throw new Error(`代理 HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const im = await loadImage(objectUrl);
    const long = Math.max(im.naturalWidth, im.naturalHeight) || 1;
    const k = Math.min(1, Math.max(16, Math.min(maxPx, IMG_MAX)) / long);
    const w = Math.max(1, Math.round(im.naturalWidth * k));
    const h = Math.max(1, Math.round(im.naturalHeight * k));
    const slot = allocCanvas(w, h);
    if (!slot) throw new Error('缩图画布开不出来');
    slot.ctx.drawImage(im, 0, 0, w, h);
    // 源是 PNG 就仍出 PNG：成就图标里有透明底，转成 JPEG 会把透明填成黑块。
    // 其余（封面、截图，全是 JPEG）走 JPEG，体积差着一个数量级。
    const out = blob.type === 'image/png'
      ? slot.canvas.toDataURL('image/png')
      : slot.canvas.toDataURL('image/jpeg', 0.86);
    releaseCanvas(slot.canvas);
    return out;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * 把克隆体里所有指向网络的贴图换成 data: URI。
 *
 * 只扫**行内样式**：本项目的真图全部由 JS 写在 `style` 上（封面 / 截图 / 成就图标三处），
 * styles.css 里一个 `url(` 都没有。真要改成扫 computed style，代价是上万次样式查询——
 * 等 CSS 里出现第一处 url() 再说。
 * 目标尺寸取**原件的实际盒子**，所以克隆体必须与原件同构：调用方要删减节点，得在内联之后。
 *
 * @param {Array<[Element, Element]>} pairs [原件, 克隆件]，索引一一对应
 * @param {number} scale 导出倍率
 * @param {((url:string)=>Request|null)|null} proxy 直取失败时的兜底通道（见 fetchScaled）
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{total:number, failed:number}>}
 */
async function inlineImages(pairs, scale, proxy, onProgress) {
  /** url → 这张图在成图上最大要多少像素 */
  const want = new Map();
  /** 需要改写的位置：{ el, prop, value } */
  const slots = [];

  for (const [orig, copy] of pairs) {
    const inline = copy.getAttribute('style');
    if (!inline || !inline.includes('url(')) continue;
    const box = orig.getBoundingClientRect();
    // 模糊底（.fp-cover.wide::before）会把同一张图往外铺 14px，1.25 的余量一并覆盖掉
    const need = Math.ceil(Math.max(box.width, box.height, 32) * scale * 1.25);
    for (const prop of ['background-image', 'background', '--fp-img']) {
      const value = copy.style.getPropertyValue(prop);
      if (!value || !value.includes('url(')) continue;
      slots.push({ el: copy, prop, value });
      for (const m of value.matchAll(URL_RE)) {
        const u = m[2];
        if (/^(data|blob):/i.test(u)) continue;   // 已经是内联的，不用管
        want.set(u, Math.max(want.get(u) ?? 0, need));
      }
    }
  }

  const urls = [...want.keys()];
  const inlined = new Map();
  const hopeless = new Map();   // 主机 → 直取失败次数（见 fetchScaled）
  await pool(urls, FETCH_CONCURRENCY, async (u) => {
    inlined.set(u, await fetchScaled(u, want.get(u), proxy, hopeless));
  }, onProgress);

  for (const slot of slots) {
    // 逐层处理：取回来的换成 data:，取不回来的**整层删掉**。
    // 只把 url() 抹空是不行的——留下的 `, linear-gradient(…)` 是非法值，浏览器会把整条声明
    // 连同底下那层占位渐变一起丢掉，格子会比没图更糟（纯白，连主题色都没了）。
    const kept = [];
    for (const layer of splitLayers(slot.value)) {
      const urlsIn = [...layer.matchAll(URL_RE)].map((m) => m[2]);
      if (!urlsIn.length) { kept.push(layer); continue; }
      if (urlsIn.some((u) => !/^(data|blob):/i.test(u) && !inlined.has(u))) continue;
      kept.push(layer.replace(URL_RE, (whole, _q, u) => (
        inlined.has(u) ? `url("${inlined.get(u)}")` : whole)));
    }
    slot.el.style.setProperty(slot.prop, kept.length ? kept.join(', ') : 'none');
  }

  return { total: urls.length, failed: urls.length - inlined.size };
}

/* ---------------- 光栅 ---------------- */

/**
 * 把 CSS 文本里所有 `:root { … }` 的内容改挂到导出根节点上。
 *
 * `:root` 在 SVG 文档里匹配的是 `<svg>`，自定义属性照理会继承进 foreignObject。
 * 但这条链路上「照理」不值钱（各家实现有出入，一旦不继承就是满屏 `var()` 落空、
 * 颜色全黑），多写一份挂在根 div 上的兜底只花几十字节。
 */
function rootTokensFor(css, selector) {
  const out = [];
  for (const m of css.matchAll(/:root\s*\{([^}]*)\}/g)) out.push(m[1]);
  return out.length ? `${selector}{${out.join('')}}` : '';
}

/**
 * 把一棵 DOM 画成 PNG。
 *
 * @param {Element} node 要画的节点（**已脱离文档**的克隆体，尺寸靠 width/height 传）
 * @param {object} opts
 * @param {number} opts.width  CSS 像素宽
 * @param {number} opts.height CSS 像素高
 * @param {number} [opts.scale] 倍率（会先按浏览器上限夹一次）
 * @param {string} [opts.background] 底色
 * @param {string} [opts.css] 要一并生效的样式表文本
 * @param {string} [opts.rootClass] 导出根节点的 class（承接 :root 变量与基础字体）
 * @param {Array<[Element,Element]>} [opts.pairs] [原件, 克隆件] 对照表，供贴图内联量尺寸
 * @param {((url:string)=>Request|null)} [opts.proxy] 跨域取不回来的贴图走这条同源通道
 * @param {{axis:'x'|'y', from:number, to:number}} [opts.crop] 只画沿 axis 的 [from, to) 这一段
 *   （CSS 像素，在 node 自己的坐标里）。不传就画整个 node。
 * @param {(stage:string, done:number, total:number)=>void} [opts.onProgress]
 * @returns {Promise<{blob: Blob, width:number, height:number, scale:number, images:object}>}
 */
export async function nodeToPng(node, opts) {
  const {
    width, height, scale = 1, background = '#FFFFFF', css = '',
    rootClass = 'gc-export-root', pairs = [], proxy = null, crop = null, onProgress = () => {},
  } = opts;

  onProgress('images', 0, 1);
  const images = await inlineImages(pairs, scale, proxy, (d, t) => onProgress('images', d, t));

  // 切片沿哪条边走、走哪一段：有 crop 就听它的，没有就沿长边画全长。
  // 成图尺寸按**这一段**算，画布外面的内容一个像素都不占。
  const alongX = crop ? crop.axis === 'x' : width >= height;
  const from = crop ? crop.from : 0;
  const to = crop ? crop.to : (alongX ? width : height);
  const span = to - from;
  const cropW = alongX ? span : width;
  const cropH = alongX ? height : span;

  const used = fitScale(cropW, cropH, scale);
  const outW = Math.round(cropW * used);
  const outH = Math.round(cropH * used);
  const slot = allocCanvas(outW, outH);
  if (!slot) throw new Error(`画布开不出来（${outW}×${outH}）`);
  slot.ctx.fillStyle = background;
  slot.ctx.fillRect(0, 0, outW, outH);

  // 样式表挂在 <svg> 上而不是塞进被序列化的那棵树里：`<style>` 的内容一旦过 XMLSerializer
  // 就要考虑转义（`>`、`&` 在 CSS 里满地都是），包进 CDATA 交给自己拼的头部字符串最省心。
  // 三段式拼接（头 + 正文 + 尾）还有个好处——正文只序列化一次，每一片切图直接复用同一个
  // 字符串，不用把几 MB 的正文再拼 N 遍。
  node.setAttribute('xmlns', XHTML_NS);
  // ⚠️ **必须是 data: URI，不能用 blob:**。Chrome 把 blob: 来的 SVG image 判成「非同源」，
  // 画进 canvas 就污染，最后 toBlob 抛 SecurityError——而且是在整个流程跑完（这里是两分钟
  // 之后）才炸，前面所有工作全白做。blob 省一次编码，代价是整条路走不通，不划算。
  // 正文只编一次，每片切图直接接在头尾之间，不用把几十 MB 的正文反复 encode。
  const body = encodeURIComponent(new XMLSerializer().serializeToString(node));
  const sheet = `${css}\n${rootTokensFor(css, `.${rootClass}`)}`;

  // 沿切片轴分片。片长按倍率折算，保证**光栅出来的位图**不越界（越界是静默的，见 SLICE_PX）
  const step = Math.max(64, Math.floor(SLICE_PX / used));
  const count = Math.ceil(span / step);

  try {
    for (let i = 0; i < count; i++) {
      const at = from + i * step;
      const len = Math.min(step, to - at);
      // viewBox 落在 node 自己的坐标里（带着 crop 起点），画到画布上时再减掉起点
      const vx = alongX ? at : 0;
      const vy = alongX ? 0 : at;
      const vw = alongX ? len : width;
      const vh = alongX ? height : len;
      const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(vw * used)}"`
        + ` height="${Math.round(vh * used)}" viewBox="${vx} ${vy} ${vw} ${vh}">`
        + `<style>/*<![CDATA[*/${sheet}/*]]>*/</style>`
        + `<foreignObject x="0" y="0" width="${width}" height="${height}">`;
      const tail = '</foreignObject></svg>';
      const url = 'data:image/svg+xml;charset=utf-8,'
        + encodeURIComponent(head) + body + encodeURIComponent(tail);
      const img = await loadImage(url);
      slot.ctx.drawImage(
        img,
        Math.round((alongX ? vx - from : vx) * used),
        Math.round((alongX ? vy : vy - from) * used),
      );
      onProgress('draw', i + 1, count);
    }

    onProgress('encode', 0, 1);
    const blob = await new Promise((resolve, reject) => {
      slot.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png');
    });
    onProgress('encode', 1, 1);
    return { blob, width: outW, height: outH, scale: used, images };
  } finally {
    releaseCanvas(slot.canvas);
  }
}

/** 触发一次本地下载（浏览器下载是同步动作，用完立刻回收 objectURL）。 */
export function saveBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
