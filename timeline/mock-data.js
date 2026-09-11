// MOCK 数据层：**出参形状与后端逐字段对齐**（backend/app/schemas/calendar.py、game.py、achievement.py）。
//
// 这是「两套环境并行」的地基：mock 与 live 走同一套 api.js 门面、返回同一形状，
// 视图层（timeline.js / panel.js）对当前处于哪套环境完全无感知。
// 形状一旦与后端漂移，MOCK 下调通的东西到 LIVE 就会碎——所以这里宁可啰嗦也要照抄后端字段名：
//   TimelineEvent { date:'YYYY-MM-DD', type, count, theme_color, game:GameBrief }
//   ScreenshotOut { shot_id, appid, taken_at:ISO datetime, thumbnail_url, url, privacy, game }
//   GameOut       { appid, name_zh, name_en, cover_portrait, theme_color, lifecycle, shelved_at,
//                   launched_ever, play_days_count, ach_unlocked, ach_total, ... }
// ⚠️ 注意 TimelineEvent.date 只到「日」不含时刻——后端如此，mock 不得擅自加时刻字段。
// 事件行的时刻走 getDayDetail() 的 rows[].time（当日分钟数），与后端 /calendar/day/{date} 一致。

const NOW_ISO = '2026-08-27T09:12:00Z';
/** 数据基准「今天」（unix 秒，UTC）。对齐画板底栏 LAST SYNC 2026-08-27 09:12。 */
export const NOW = Date.parse(NOW_ISO) / 1000;

const DAY = 86400;
const START = Date.parse('2024-01-08T00:00:00Z') / 1000; // 数据起点：约两年八个月的跨度

// PRD §3 封盘判定阈值（后端是服务端常量，mock 照抄以保证 lifecycle 自洽）
const T_QUIET_DAYS = 45;
const T_TIME_MIN = 600;
const T_ACH_RATIO = 0.10;

/** 确定性 PRNG（mulberry32）：同一 seed 永远同一份数据，便于截图基线与回归比对。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isoDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const isoDateTime = (t) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
const dayFloor = (t) => Math.floor(t / DAY) * DAY;

/**
 * 游戏种子表：真实 appid + 中英文名 + 主题色（已按 05§3.4 规范化到浅底可读区间）+ 成就总数。
 * `seasons` 控制该游戏的活跃季，制造轴上的疏密对比（验证 07§4.3 变化坐标）。
 * `abbr` 是封面占位缩写（后端无此字段，前端派生；这里显式给出以免中文名派生出怪缩写）。
 */
const GAME_SEEDS = [
  // —— 设计稿同款六款：保留原 appid / 配色，保证画板对照仍然成立 ——
  { appid: 1245620, zh: '艾尔登法环', en: 'ELDEN RING', abbr: 'ER', color: '#9A6B1F', achTotal: 42, seasons: [[2026, 3], [2026, 7]], intensity: 3 },
  { appid: 1145360, zh: '哈迪斯', en: 'Hades', abbr: 'HAD', color: '#A33055', achTotal: 50, seasons: [[2026, 5]], intensity: 3 },
  { appid: 367520, zh: '空洞骑士', en: 'Hollow Knight', abbr: 'HK', color: '#2E5E8A', achTotal: 63, seasons: [[2026, 4], [2026, 8]], intensity: 2 },
  { appid: 413150, zh: '星露谷物语', en: 'Stardew Valley', abbr: 'SV', color: '#3E7A34', achTotal: 40, seasons: [[2025, 9], [2026, 5]], intensity: 3 },
  { appid: 504230, zh: '蔚蓝', en: 'Celeste', abbr: 'CEL', color: '#7A3E8F', achTotal: 32, seasons: [[2026, 7]], intensity: 2 },
  { appid: 427520, zh: '异星工厂', en: 'Factorio', abbr: 'FAC', color: '#B05A1E', achTotal: 55, seasons: [[2026, 6]], intensity: 3 },
  // —— 补量：撑开时间跨度与密度，覆盖四种 lifecycle ——
  { appid: 1086940, zh: '博德之门3', en: "Baldur's Gate 3", abbr: 'BG3', color: '#8C3B2E', achTotal: 54, seasons: [[2025, 11], [2026, 1]], intensity: 4 },
  { appid: 292030, zh: '巫师3：狂猎', en: 'The Witcher 3', abbr: 'W3', color: '#7A5A2E', achTotal: 78, seasons: [[2024, 4]], intensity: 3 },
  { appid: 1091500, zh: '赛博朋克2077', en: 'Cyberpunk 2077', abbr: 'CP', color: '#8A7A1E', achTotal: 45, seasons: [[2024, 7], [2025, 3]], intensity: 3 },
  { appid: 275850, zh: '无人深空', en: "No Man's Sky", abbr: 'NMS', color: '#2E6B7A', achTotal: 27, seasons: [[2024, 10]], intensity: 2 },
  { appid: 632360, zh: '雨中冒险2', en: 'Risk of Rain 2', abbr: 'ROR', color: '#5A6B2E', achTotal: 38, seasons: [[2025, 1]], intensity: 2 },
  { appid: 646570, zh: '杀戮尖塔', en: 'Slay the Spire', abbr: 'STS', color: '#8A4A2E', achTotal: 46, seasons: [[2024, 2], [2025, 6]], intensity: 3 },
  { appid: 1174180, zh: '荒野大镖客2', en: 'Red Dead Redemption 2', abbr: 'RDR', color: '#7A3E2E', achTotal: 51, seasons: [[2024, 12]], intensity: 3 },
  { appid: 105600, zh: '泰拉瑞亚', en: 'Terraria', abbr: 'TER', color: '#2E7A5E', achTotal: 88, seasons: [[2025, 4]], intensity: 2 },
  { appid: 620, zh: '传送门2', en: 'Portal 2', abbr: 'P2', color: '#2E5A8A', achTotal: 51, seasons: [[2024, 6]], intensity: 1 },
  { appid: 1237970, zh: '泰坦陨落2', en: 'Titanfall 2', abbr: 'TF2', color: '#6B4A8A', achTotal: 31, seasons: [[2025, 8]], intensity: 2 },
  { appid: 322170, zh: '风之旅人', en: 'Journey', abbr: 'JRN', color: '#8A6B2E', achTotal: 18, seasons: [[2025, 2]], intensity: 1 },
  { appid: 391540, zh: '传说之下', en: 'Undertale', abbr: 'UT', color: '#7A2E5A', achTotal: 0, seasons: [[2024, 9]], intensity: 1 },
  { appid: 268910, zh: '铲子骑士', en: 'Shovel Knight', abbr: 'SK', color: '#2E4A8A', achTotal: 45, seasons: [[2024, 5]], intensity: 1 },
  { appid: 553850, zh: '深岩银河', en: 'Deep Rock Galactic', abbr: 'DRG', color: '#8A5A1E', achTotal: 60, seasons: [[2025, 10], [2026, 2]], intensity: 3 },
  { appid: 1517290, zh: '战地2042', en: 'Battlefield 2042', abbr: 'BF', color: '#4A6B8A', achTotal: 33, seasons: [[2025, 5]], intensity: 1 },
  { appid: 236850, zh: '欧陆风云4', en: 'Europa Universalis IV', abbr: 'EU4', color: '#5A4A8A', achTotal: 0, seasons: [[2024, 11]], intensity: 2 },
  { appid: 570, zh: 'Dota 2', en: 'Dota 2', abbr: 'D2', color: '#8A3E2E', achTotal: 0, seasons: [[2024, 3]], intensity: 2 },
  { appid: 1030300, zh: '地狱之刃2', en: 'Hellblade II', abbr: 'HB2', color: '#6B2E4A', achTotal: 22, seasons: [[2026, 6]], intensity: 2 },
  // —— 从未启动（P-14 隐藏开关的验证样本，默认被隐藏） ——
  { appid: 1794680, zh: '吸血鬼幸存者', en: 'Vampire Survivors', abbr: 'VS', color: '#6D4AE0', achTotal: 0, seasons: [], intensity: 0 },
  { appid: 1966720, zh: '雷霆一号', en: 'Lethal Company', abbr: 'LC', color: '#6D4AE0', achTotal: 0, seasons: [], intensity: 0 },
  { appid: 1811260, zh: 'EA FC 24', en: 'EA SPORTS FC 24', abbr: 'FC', color: '#6D4AE0', achTotal: 0, seasons: [], intensity: 0 },
  { appid: 2138710, zh: '幽灵行者2', en: 'Ghostrunner 2', abbr: 'GR2', color: '#6D4AE0', achTotal: 0, seasons: [], intensity: 0 },
];

/** 未来发售（F-1：愿望单里尚未发售的，进轴画发售点）。 */
const UPCOMING = [
  { appid: 2358720, zh: '黑神话：悟空', en: 'Black Myth: Wukong', abbr: 'BMW', color: '#8A5A2E', releaseAt: Date.parse('2026-09-20T00:00:00Z') / 1000 },
  { appid: 1903340, zh: '恶意不息', en: 'No Rest for the Wicked', abbr: 'NRW', color: '#4A6B5A', releaseAt: Date.parse('2026-10-08T00:00:00Z') / 1000 },
];

const ACH_NAMES = [
  '初次登顶', '无死亡通关', '集齐草莓', '救出泰奥', '水晶之心', '百层挑战', '速通达成',
  '全图探索', '收藏家', '不屈意志', '深渊归来', '最后一舞', '黎明之前', '孤身启程',
  '满级工匠', '万物归一', '静水流深', '风暴之眼', '归乡之路', '终局之战',
];

/** 生成一份确定性的全量数据集（模块加载时跑一次）。 */
function build() {
  const games = [];
  const events = [];
  const screenshots = [];
  const achByGameDay = new Map(); // `${appid}|${YYYY-MM-DD}` → AchievementDetail[]
  const rand = rng(20260827);

  for (const seed of GAME_SEEDS) {
    const brief = {
      appid: seed.appid,
      name_zh: seed.zh,
      name_en: seed.en,
      cover: null,
      cover_portrait: null, // mock 无图，前端按 05§5 用主题色渐变 + 缩写占位
      theme_color: seed.color,
    };

    // 购买日：第一个活跃季前 10~90 天；从未启动的散布在全区间
    const launched = seed.seasons.length > 0;
    let purchaseAt;
    if (launched) {
      const [y, m] = seed.seasons[0];
      const seasonStart = Date.parse(`${y}-${String(m).padStart(2, '0')}-01T00:00:00Z`) / 1000;
      purchaseAt = dayFloor(seasonStart - (10 + Math.floor(rand() * 80)) * DAY);
    } else {
      purchaseAt = dayFloor(START + Math.floor(rand() * (NOW - START)));
    }
    if (purchaseAt < START) purchaseAt = START + Math.floor(rand() * 30) * DAY;

    // `minutes` = 当日第几分钟，**必须与后端 TimelineEvent 逐字段对齐**（02 前端功能文档 §8）：
    // 前端拿它挑「当天第一件事」。这里不能调 rand()——多消耗一次随机数会把后面整份 mock
    // 重新洗牌，同一颗种子每次生成的库就不一样了。用 appid 现算一个稳定值。
    events.push({ date: isoDay(purchaseAt), type: 'purchase', count: 1,
      minutes: (seed.appid * 37) % 1440, theme_color: null, game: brief });

    const playDays = new Set();
    let achUnlocked = 0;
    let firstPlayAt = null;
    let lastActiveAt = null;

    for (const [y, m] of seed.seasons) {
      const seasonStart = Date.parse(`${y}-${String(m).padStart(2, '0')}-01T00:00:00Z`) / 1000;
      // 每季 3~10 个活跃日，聚在 5 周内
      const dayCount = 3 + Math.floor(rand() * (seed.intensity * 2 + 2));
      for (let i = 0; i < dayCount; i++) {
        const at = dayFloor(seasonStart + Math.floor(rand() * 35) * DAY);
        if (at > NOW) continue;
        playDays.add(at);
        if (firstPlayAt === null || at < firstPlayAt) firstPlayAt = at;
        if (lastActiveAt === null || at > lastActiveAt) lastActiveAt = at;
      }
    }

    if (firstPlayAt !== null) {
      // 首玩 / 发售没有精确时间戳，按后端的惯例值给（12:00 / 01:00）
      events.push({ date: isoDay(firstPlayAt), type: 'first_play', count: 1,
        minutes: 720, theme_color: seed.color, game: brief });
    }

    // 成就簇：活跃日里挑一部分解锁若干成就
    const sortedDays = [...playDays].sort((a, b) => a - b);
    for (const at of sortedDays) {
      if (seed.achTotal > 0 && rand() < 0.62 && achUnlocked < seed.achTotal) {
        const n = Math.min(seed.achTotal - achUnlocked, 1 + Math.floor(rand() * (seed.intensity * 3)));
        if (n > 0) {
          achUnlocked += n;
          const achEvent = { date: isoDay(at), type: 'achievement', count: n,
            minutes: null, theme_color: seed.color, game: brief };
          events.push(achEvent);
          // 当日成就明细（懒加载路由的数据源）
          const detail = [];
          for (let k = 0; k < n; k++) {
            detail.push({
              achievement_id: `ACH_${seed.appid}_${isoDay(at)}_${k}`,
              display_name: ACH_NAMES[(achUnlocked + k) % ACH_NAMES.length],
              icon_url: null,
              global_percent: Math.round((0.8 + rand() * 60) * 10) / 10,
              unlocktime: isoDateTime(at + (9 + Math.floor(rand() * 12)) * 3600 + Math.floor(rand() * 3600)),
            });
          }
          // 成就簇的时刻 = 该日**最早**一次解锁，与后端 cluster_first 同口径
          achEvent.minutes = detail.reduce((m, a) => {
            const t = Number(a.unlocktime.slice(11, 13)) * 60 + Number(a.unlocktime.slice(14, 16));
            return m === null ? t : Math.min(m, t);
          }, null);
          achByGameDay.set(`${seed.appid}|${isoDay(at)}`, detail);
        }
      }
      // 截图：活跃日里约六成有截图，1~9 张（跨列布局的验证样本）
      if (rand() < 0.60) {
        const shots = 1 + Math.floor(rand() * 9);
        for (let s = 0; s < shots; s++) {
          screenshots.push({
            shot_id: `${seed.appid}-${isoDay(at)}-${s}`,
            appid: seed.appid,
            taken_at: isoDateTime(at + (10 + Math.floor(rand() * 11)) * 3600 + s * 137),
            thumbnail_url: null,
            url: null,
            privacy: 0,
            game: brief,
          });
        }
      }
    }

    // 生命状态（PRD §3，与后端同一套阈值现算，保证 mock 自洽）
    const playtimeMin = playDays.size * (40 + Math.floor(rand() * 120));
    let lifecycle = 'never_launched';
    let shelvedAt = null;
    if (playDays.size > 0 && lastActiveAt !== null) {
      const quietDays = (NOW - lastActiveAt) / DAY;
      if (quietDays < T_QUIET_DAYS) {
        lifecycle = 'active';
      } else {
        const enough = playtimeMin >= T_TIME_MIN
          || (seed.achTotal > 0 && achUnlocked / seed.achTotal >= T_ACH_RATIO);
        lifecycle = enough ? 'shelved' : 'dormant';
        if (lifecycle === 'shelved') shelvedAt = isoDateTime(lastActiveAt + 22 * 3600);
      }
    }

    games.push({
      appid: seed.appid,
      name_zh: seed.zh,
      name_en: seed.en,
      cover: null,
      cover_portrait: null,
      developer: null,
      release_date: null,
      status: playDays.size > 0 ? 'played' : 'owned',
      theme_color: seed.color,
      // MOCK 的颜色是给每款游戏刻意分配的、不是兜底——如实标 local。
      // 不标的话封面边框在测试模式下会全部落到中性灰（见 timeline.js::ringOf），
      // 这个设计就验不出来了。
      theme_color_source: 'local',
      play_days_count: playDays.size,
      first_play_date: firstPlayAt === null ? null : isoDay(firstPlayAt),
      purchase_date: isoDateTime(purchaseAt),
      review: null,
      lifecycle,
      shelved_at: shelvedAt,
      launched_ever: playDays.size > 0,
      ach_unlocked: achUnlocked,
      ach_total: seed.achTotal,
      __abbr: seed.abbr, // 前端占位封面用；后端无此字段，api.js 对 live 数据会派生补上
    });
  }

  // 未来发售（愿望单，F-1）
  for (const up of UPCOMING) {
    const brief = {
      appid: up.appid, name_zh: up.zh, name_en: up.en,
      cover: null, cover_portrait: null, theme_color: up.color,
    };
    events.push({ date: isoDay(up.releaseAt), type: 'release', count: 1,
      minutes: 60, theme_color: null, game: brief });
    games.push({
      appid: up.appid, name_zh: up.zh, name_en: up.en, cover: null, cover_portrait: null,
      developer: null, release_date: isoDay(up.releaseAt), status: 'wishlist',
      theme_color: up.color, theme_color_source: 'local', play_days_count: 0, first_play_date: null, purchase_date: null,
      review: null, lifecycle: 'never_launched', shelved_at: null, launched_ever: false,
      ach_unlocked: 0, ach_total: 0, __abbr: up.abbr,
    });
  }

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  screenshots.sort((a, b) => (a.taken_at < b.taken_at ? -1 : 1));
  return { games, events, screenshots, achByGameDay };
}

const DATA = build();

/** `GET /calendar/timeline` 的 mock 等价物。 */
export function getTimeline() {
  return {
    events: DATA.events.map((e) => ({ ...e })),
    screenshots: DATA.screenshots.map((s) => ({ ...s })),
    games: DATA.games.map((g) => ({ ...g })),
  };
}

/** `GET /achievements/{appid}/{date}` 的 mock 等价物。 */
export function getAchievementDetail(appid, day) {
  return (DATA.achByGameDay.get(`${appid}|${day}`) ?? []).map((a) => ({ ...a }));
}

/** `GET /calendar/day/{date}` 的 mock 等价物：三项计数 + 事件行（time = 当日分钟数，升序）。 */
export function getDayDetail(day) {
  const counts = { achievement: 0, first_play: 0, release: 0 };
  const rows = [];
  for (const e of DATA.events) {
    if (e.date !== day) continue;
    if (e.type in counts) counts[e.type] += e.type === 'achievement' ? e.count : 1;
    // 时刻：成就取当日首条解锁时间，其余按类型给一个稳定的当日分钟数
    let minutes;
    if (e.type === 'achievement') {
      const detail = DATA.achByGameDay.get(`${e.game.appid}|${day}`) ?? [];
      const t = detail.length ? new Date(detail[0].unlocktime) : null;
      minutes = t ? t.getUTCHours() * 60 + t.getUTCMinutes() : 13 * 60;
    } else {
      minutes = { purchase: 12 * 60 + 30, first_play: 9 * 60 + 12, release: 0 }[e.type] ?? 0;
    }
    rows.push({ type: e.type, game: e.game, theme_color: e.theme_color, count: e.count, time: minutes });
  }
  rows.sort((a, b) => a.time - b.time);
  return { counts, rows, screenshots: DATA.screenshots.filter((s) => s.taken_at.slice(0, 10) === day) };
}

/** 数据规模摘要（首页 MOCK 入口上展示，让人一眼知道这套假数据有多大）。 */
export function stats() {
  const days = new Set(DATA.events.map((e) => e.date));
  for (const s of DATA.screenshots) days.add(s.taken_at.slice(0, 10));
  return {
    games: DATA.games.length,
    events: DATA.events.length,
    screenshots: DATA.screenshots.length,
    timepoints: days.size,
    from: DATA.events[0]?.date ?? null,
    to: isoDay(NOW),
  };
}
