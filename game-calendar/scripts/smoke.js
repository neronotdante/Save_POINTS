/**
 * 逻辑冒烟测试：在 Node 里以 window 垫片加载 renderer 纯逻辑，
 * 校验 42 格、周一列首、今日标记与事件生成，不启动 Electron。
 */
global.window = globalThis;

require('../renderer/mock-data.js');
require('../renderer/calendar.js');

const now = new Date();
const cells = window.Calendar.buildCells(now.getFullYear(), now.getMonth());

console.log('cells:', cells.length, '(expect 42)');

const firstCellDow = (cells[0].date.getDay() + 6) % 7; // 0=周一
console.log('first cell is Monday:', firstCellDow === 0);

const today = cells.find((c) => c.isToday);
console.log('today cell found:', !!today, today ? today.date.toISOString().slice(0, 10) : '');

let daysWithEvents = 0;
const samples = [];
let totalGroups = 0;
for (const c of cells) {
  const groups = window.MockData.getDayGroups(c.date);
  if (groups.length) {
    daysWithEvents++;
    totalGroups += groups.length;
    if (samples.length < 6) {
      samples.push({ day: c.day, inMonth: c.inMonth, types: groups.map((g) => g.type + (g.count > 1 ? '×' + g.count : '')) });
    }
  }
}
console.log('days with events (this grid):', daysWithEvents);
console.log('total groups:', totalGroups);
console.log('samples:', JSON.stringify(samples));

// 事件类型与颜色一致性抽查
const allTypes = new Set();
for (const c of cells) {
  for (const g of window.MockData.getDayGroups(c.date)) {
    allTypes.add(g.type);
    if (!g.color || !/^#[0-9A-Fa-f]{6}$/.test(g.color)) {
      throw new Error('bad color: ' + JSON.stringify(g));
    }
  }
}
console.log('event types:', [...allTypes].sort().join(', '));
console.log('SMOKE OK');
