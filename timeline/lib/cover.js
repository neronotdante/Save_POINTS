// 封面素材派生（05§5 / 07 V1 封面轮播）。
//
// 后端 GameOut 目前只稳定给一张竖版封面（cover_portrait），MOCK 下更是 null。
// 但 V1 原型的面板封面是一条**多张**的轨道，所以这里统一出「封面变体数组」：
//   · 有真实图 → 按 竖版封面 / 通用封面 / 头图 的顺序取，有几张给几张；
//   · 没有真实图 → 按主题色派生 3 张不同打光方向的渐变占位（与原型的三张同构）。
// 视图层只认这个数组，不关心当前有没有真图——将来后端补上多图字段，只需改这一处。

/** 成就兜底紫（05§3.3）——取色失败 / 压根没取过色时的那一档。 */
const FALLBACK_HEX = '#6D4AE0';

/**
 * 任何输入 → 一个**一定能写进 CSS 的** #RRGGBB。
 *
 * 这一步不是洁癖。后端 `GameOut.theme_color` 是可空的：没跑过 enrich 的游戏（本库 348 款里
 * 14 款，全是 appdetails 拿不到数据的下架 / 未发售条目）给的就是 `null`。而下面的渐变是把
 * 颜色**原样插进模板字符串**的，`null` 插进去就是 `linear-gradient(150deg, rgb(...), null)`
 * —— 那是**非法 CSS**，浏览器会静默丢掉整条 `background` 声明，一个字的报错都没有。
 * 表现就是这 14 款游戏的封面格子是**纯白的**：不是「图没加载出来」（那样至少还剩底色），
 * 是连占位渐变都没了。
 *
 * 所以入口只留这一处：`lighten` / `darken` 走 parseHex 早就是安全的，漏的一直是**原色本身**。
 */
export function normHex(hex) {
  const c = String(hex ?? '').replace('#', '');
  return /^[0-9a-fA-F]{6}$/.test(c) ? `#${c}` : FALLBACK_HEX;
}

/** #RRGGBB → {r,g,b}；非法输入回落到成就兜底紫（05§3.3）。 */
function parseHex(hex) {
  const c = normHex(hex).slice(1);
  return {
    r: parseInt(c.slice(0, 2), 16),
    g: parseInt(c.slice(2, 4), 16),
    b: parseInt(c.slice(4, 6), 16),
  };
}

/** 朝白色插值，amt 为 0~1。 */
export function lighten(hex, amt = 0.38) {
  const { r, g, b } = parseHex(hex);
  const f = (v) => Math.round(v + (255 - v) * amt);
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

/** 朝黑色插值，amt 为 0~1。 */
export function darken(hex, amt = 0.32) {
  const { r, g, b } = parseHex(hex);
  const f = (v) => Math.round(v * (1 - amt));
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

/**
 * 主题色 → 3 张渐变占位（对齐 V1 原型：平涂斜向 / 左上打光 / 右下打光）。
 * @param {string} color
 * @returns {string[]} 可直接塞进 CSS `background` 的值
 */
export function gradientVariants(raw) {
  // ⚠️ 下面每一处 `${color}` 都是**原样插进 CSS 的**，所以这里必须先过一遍 normHex——
  // 见它的注释：一个 null 就能让整条 background 声明被静默丢掉。
  const color = normHex(raw);
  const hi = lighten(color, 0.38);
  const hi2 = lighten(color, 0.52);
  const lo = darken(color, 0.30);
  const lo2 = darken(color, 0.48);
  return [
    `linear-gradient(150deg, ${hi}, ${color})`,
    `radial-gradient(120px 96px at 20% 12%, rgba(255,255,255,.26), rgba(255,255,255,0) 62%),`
      + ` linear-gradient(120deg, ${hi2} 0%, ${color} 52%, ${lo} 100%)`,
    `radial-gradient(110px 88px at 88% 86%, rgba(255,255,255,.20), rgba(255,255,255,0) 60%),`
      + ` linear-gradient(205deg, ${hi} 0%, ${color} 50%, ${lo2} 100%)`,
  ];
}

/**
 * 一款游戏的封面变体列表。
 * @param {{cover_portrait?: string|null, cover?: string|null, header_image?: string|null,
 *          theme_color: string, __abbr?: string}} game
 * @returns {Array<{key:string, background:string, image?:string, label:string,
 *                     real:boolean, shape:'portrait'|'wide'}>} 至少 1 项
 *   · `key`   —— 这张素材的稳定身份，供「设为页面背景」判断当前选中的是不是它（lib/backdrop.js）。
 *   · `shape` —— **素材的比例**。Steam 给的封面有两种：竖版海报 `cover_portrait`（600×900，2:3）
 *     和横版头图 `cover` / `header_image`（460×215，约 2.14:1）。两者差了近 5 倍的宽高比，
 *     一律按 2:3 的框去 `cover` 裁，横图就只剩正中间窄窄一条，看不出是哪款游戏。
 *     比例是**由它来自哪个字段决定的，可以同步知道**，不必等图加载完再量——所以在这里就标上。
 */
export function coverVariants(game) {
  // 有真图时**不写标签**：图本身就认得出是哪款游戏，压一行字上去是重复信息（同 05§5 v3.3
  // 去掉轴上封面缩写的理由）。没有真图时才写，且写**完整游戏名**而不是 2 字母缩写——
  // 「OA」（Ori and the Blind Forest）、「177」（appid 前三位，天国：拯救2）这种既读不出
  // 是什么游戏，也读不出「这里没取到封面」，只是把「认不出」换了个更精致的形式。
  const name = game.name_zh || game.name_en || `App ${game.appid}`;
  const sources = [
    [game.cover_portrait, 'portrait'],
    [game.cover, 'wide'],
    [game.header_image, 'wide'],
  ].filter(([u]) => typeof u === 'string' && u);
  // 同一张图重复给（后端偶尔 cover 与 cover_portrait 同值）时去重，否则轮播会「切了但没变」
  const seen = new Set();
  const unique = sources.filter(([u]) => !seen.has(u) && seen.add(u));
  if (unique.length) {
    // background 只留一层主题色占位，真图走 image 交给灯箱预载——直接写进 background
    // 的话，图挂了就是一片空白，和「还在加载」分不清（同 lib/lightbox.js::ensureLoaded）
    const ph = gradientVariants(game.theme_color)[0];
    return unique.map(([u, shape], i) => ({
      key: `cover:${game.appid}:${i}`,
      background: `url("${u}") center / cover no-repeat, ${ph}`,
      // `tint` 是**剥掉图之后的那层底色**。整页背景（lib/backdrop.js）要自己决定图怎么铺
      // （cover 还是 contain），没法沿用上面那条已经把 center/cover 焊死的简写，只能拿到
      // 底色自己重新组装。给它一个字段，比让下游去解析简写字符串可靠得多。
      tint: ph,
      image: u, label: '', real: true, shape,
      // 灯箱按它换舞台比例：竖版海报 600×900，横版头图 460×215
      aspect: shape === 'wide' ? 460 / 215 : 2 / 3,
    }));
  }
  return gradientVariants(game.theme_color).map((bg, i) => ({
    key: `cover:${game.appid}:g${i}`, background: bg, label: name, real: false, shape: 'portrait',
  }));
}
