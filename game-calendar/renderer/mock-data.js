/**
 * 演示数据（无后端 / 无数据接口阶段使用）。
 * 按「年 × 12 + 月」做种子，确定性生成发售 / 购买 / 首次游玩 / 成就簇四类事件，
 * 保证来回切换月份时日历保持稳定；主题色为预烘焙值（已按 UI 规范 §3.4 近似规范化）。
 */
(function (global) {
  'use strict';

  const RELEASE = '#2F6BFF';          // 发售（系统固定色）
  const PURCHASE = '#0E9E68';         // 购买（单独固定色）
  const ACHIEVE_FALLBACK = '#6D4AE0'; // 成就回退色

  const GAMES = [
    { zh: '艾尔登法环', en: 'Elden Ring', color: '#B0761A' },
    { zh: '空洞骑士', en: 'Hollow Knight', color: '#238A79' },
    { zh: '只狼：影逝二度', en: 'Sekiro', color: '#A8452F' },
    { zh: '哈迪斯', en: 'Hades', color: '#C77700' },
    { zh: '博德之门 3', en: "Baldur's Gate 3", color: '#2E6BB8' },
    { zh: '巫师 3：狂猎', en: 'The Witcher 3', color: '#6233C2' },
    { zh: '星露谷物语', en: 'Stardew Valley', color: '#3E8E4E' },
    { zh: '赛博朋克 2077', en: 'Cyberpunk 2077', color: '#C8A216' },
    { zh: '死亡细胞', en: 'Dead Cells', color: '#B23A48' },
    { zh: '雨中冒险 2', en: 'Risk of Rain 2', color: '#3B82C4' },
    { zh: '极乐迪斯科', en: 'Disco Elysium', color: '#8A5A2B' },
    { zh: '泰拉瑞亚', en: 'Terraria', color: '#5E8B3E' },
    { zh: '杀戮尖塔', en: 'Slay the Spire', color: '#7A4E9E' },
    { zh: '辐射 4', en: 'Fallout 4', color: '#4E7A3A' },
    { zh: '生化危机 4 重制版', en: 'Resident Evil 4', color: '#9E2B2B' },
    { zh: '地平线：零之曙光', en: 'Horizon Zero Dawn', color: '#2E7A9E' },
    { zh: '双人成行', en: 'It Takes Two', color: '#D66A2B' },
    { zh: '荒野大镖客：救赎 2', en: 'Red Dead Redemption 2', color: '#8B2F2F' },
  ];

  // mulberry32 确定性伪随机
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const cache = new Map();

  function getMonthGroups(year, monthIndex) {
    const key = year * 12 + monthIndex;
    if (cache.has(key)) return cache.get(key);

    const rand = mulberry32((key ^ 0x9E3779B9) * 2654435761);
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const map = new Map();
    const add = (day, group) => {
      if (!map.has(day)) map.set(day, []);
      map.get(day).push(group);
    };
    const rDay = () => 1 + Math.floor(rand() * daysInMonth);
    const pickGame = () => GAMES[Math.floor(rand() * GAMES.length)];

    // 发售：落在互不重复的日期上（唯一需要在格底加满宽色条的类型）
    const releaseDays = new Set();
    const releaseCount = 2 + Math.floor(rand() * 3); // 2 ~ 4
    while (releaseDays.size < releaseCount) releaseDays.add(rDay());
    for (const d of releaseDays) {
      add(d, { type: 'release', game: pickGame(), color: RELEASE, count: 1 });
    }

    // 购买
    const purchaseCount = 3 + Math.floor(rand() * 3); // 3 ~ 5
    for (let i = 0; i < purchaseCount; i++) {
      add(rDay(), { type: 'purchase', game: pickGame(), color: PURCHASE, count: 1 });
    }

    // 首次游玩
    const playCount = 4 + Math.floor(rand() * 4); // 4 ~ 7
    for (let i = 0; i < playCount; i++) {
      const g = pickGame();
      add(rDay(), { type: 'first_play', game: g, color: g.color, count: 1 });
    }

    // 成就簇（×N）
    const achCount = 8 + Math.floor(rand() * 6); // 8 ~ 13
    for (let i = 0; i < achCount; i++) {
      const g = pickGame();
      add(rDay(), { type: 'achievement', game: g, color: g.color, count: 1 + Math.floor(rand() * 29) });
    }

    // 保证每月至少一天出现 +N 折叠（4 组以上），让折叠样式可见
    const busyDay = Math.min(22, daysInMonth - 2);
    const existing = map.get(busyDay) || [];
    if (existing.length < 4) {
      existing.push(
        { type: 'achievement', game: GAMES[1], color: GAMES[1].color, count: 12 },
        { type: 'first_play', game: GAMES[7], color: GAMES[7].color, count: 1 },
        { type: 'purchase', game: GAMES[4], color: PURCHASE, count: 1 },
        { type: 'achievement', game: GAMES[2], color: GAMES[2].color, count: 5 },
      );
      map.set(busyDay, existing.slice(0, 5));
    }

    // 保证「今天」所在的当月总有事可看（确定性补两条）
    const now = new Date();
    if (year === now.getFullYear() && monthIndex === now.getMonth()) {
      const today = now.getDate();
      const groups = map.get(today) || [];
      if (!groups.some((g) => g.type === 'achievement')) {
        groups.push({ type: 'achievement', game: GAMES[0], color: GAMES[0].color, count: 9 });
      }
      if (!groups.some((g) => g.type === 'first_play')) {
        groups.push({ type: 'first_play', game: GAMES[3], color: GAMES[3].color, count: 1 });
      }
      map.set(today, groups);
    }

    cache.set(key, map);
    return map;
  }

  function getDayGroups(date) {
    const map = getMonthGroups(date.getFullYear(), date.getMonth());
    return map.get(date.getDate()) || [];
  }

  /**
   * 日详情浮层的数据（UI 规范 §8.2 / 前端功能文档 §3）。
   * 返回结构刻意对齐将来的后端接口 `get_day_detail`（客户端开发文档 §6），
   * 接上真实数据时整个函数替换掉即可，浮层渲染层不用动：
   *   { counts: { achievement, first_play, release },
   *     rows: [{ type, game, themeColor, count, time }] }
   *
   * - counts：成就按「解锁数量」累加，首玩 / 发售按「款数」计（购买不进计数，规范只列三项）。
   * - rows：一个事件组一行，成就行带 ×N；按时间戳升序（右侧就是时间戳，顺着读最自然）。
   * - 时间戳按「日期 + 序号」确定性生成，来回开合浮层不会变。
   */
  function getDayDetail(date) {
    const groups = getDayGroups(date);
    const counts = { achievement: 0, first_play: 0, release: 0 };

    const daySeed = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
    const rand = mulberry32((daySeed ^ 0x85EBCA6B) * 2246822519);

    const rows = groups.map((g) => {
      if (g.type === 'achievement') counts.achievement += g.count || 1;
      else if (g.type === 'first_play') counts.first_play += 1;
      else if (g.type === 'release') counts.release += 1;

      // 发售是「当天上架」，按 Steam 惯例落在 01:00；其余按活跃时段散开
      const hour = g.type === 'release' ? 1 : 10 + Math.floor(rand() * 14);
      const minute = g.type === 'release' ? 0 : Math.floor(rand() * 60);

      return {
        type: g.type,
        game: g.game,
        themeColor: g.game.color,   // 封面占位的双色渐变用（规范 §5：主题色唯一允许的填充用法）
        count: g.count || 1,
        time: hour * 60 + minute,   // 当日分钟数，渲染层格式化成 HH:MM
      };
    });

    rows.sort((a, b) => a.time - b.time);
    return { counts, rows };
  }

  global.MockData = { RELEASE, PURCHASE, ACHIEVE_FALLBACK, GAMES, getDayGroups, getDayDetail };
})(window);
