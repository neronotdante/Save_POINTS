// 轻量发布订阅 store（02§8 状态形状），不引入状态管理库（timeline/docs/前端开发规范.md §8）。

/**
 * @template T
 * @param {T} initial
 */
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    /** @param {Partial<T>} partial */
    set(partial) {
      state = { ...state, ...partial };
      subs.forEach((fn) => fn(state));
    },
    /** @param {(state: T) => void} fn @returns {() => void} unsubscribe */
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
