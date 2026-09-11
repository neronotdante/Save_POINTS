/**
 * 日历网格纯函数：周一为列首，固定 6 行 × 7 列（42 格）。
 */
(function (global) {
  'use strict';

  // JS getDay() 0=周日…6=周六 → 转为 0=周一…6=周日
  function mondayIndex(jsDay) {
    return (jsDay + 6) % 7;
  }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  /**
   * 生成某月完整网格（42 格，含上月尾 / 下月头）。
   * @param {number} year
   * @param {number} monthIndex 0~11
   */
  function buildCells(year, monthIndex) {
    const first = new Date(year, monthIndex, 1);
    const lead = mondayIndex(first.getDay());
    const start = new Date(year, monthIndex, 1 - lead);
    const today = new Date();

    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      cells.push({
        date: d,
        day: d.getDate(),
        year: d.getFullYear(),
        month: d.getMonth(),
        inMonth: d.getMonth() === monthIndex,
        isToday: isSameDay(d, today),
      });
    }
    return cells;
  }

  global.Calendar = { buildCells, mondayIndex, isSameDay };
})(window);
