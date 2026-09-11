// 截图素材的 URL 归一（07§4.2「点击看原图」）。
//
// 后端 ScreenshotOut 有 `url` 与 `thumbnail_url` 两个字段，但**并不保证 `url` 是图片**：
// 走官方 GetUserFiles 时它是 `file_url`（确实是图片），走社区页 HTML 兜底解析时塞进去的却是
//   https://steamcommunity.com/sharedfiles/filedetails/?id=<shot_id>
// ——一个**网页地址**。把它当 background-image 加载，浏览器不会报错，只会画一片空白。
// 实测库里 332 张截图有 150 张是这种页面地址、182 张为 NULL，**没有一张**是图片地址。
//
// 所以取图不能按字段名信任，得按**长相**判断；页面地址单独留出来，供「在 Steam 上打开」用。

/** Steam 的 UGC 图片都在 images.steamusercontent.com / steamuserimages-*.akamaihd.net 上。 */
const PAGE_URL_RE = /\/sharedfiles\/filedetails/i;

/** 看起来是不是一张能直接加载的图片地址。 */
export function isImageUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u) && !PAGE_URL_RE.test(u);
}

/**
 * 一张截图的可加载大图地址；没有就返回 null（调用方退到主题色占位）。
 * `thumbnail_url` 那个 UGC 路径本身不带 imw/imh 缩放参数，Steam 在该路径上给的就是原图，
 * 所以它既是缩略图也是大图——`url` 不可用时用它并不是「降级看小图」。
 */
export function shotImageUrl(shot) {
  return [shot?.url, shot?.thumbnail_url].find(isImageUrl) ?? null;
}

/** 这张截图在 Steam 上的详情页（可能没有）。 */
export function shotPageUrl(shot) {
  for (const u of [shot?.url, shot?.page_url]) {
    if (typeof u === 'string' && PAGE_URL_RE.test(u)) return u;
  }
  return shot?.shot_id
    ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${shot.shot_id}`
    : null;
}
