const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gameCalendar', {
  onSyncNow: (callback) => {
    ipcRenderer.on('sync-now', () => callback());
  },
  // 透明区鼠标穿透：渲染层做命中判定，主进程执行 setIgnoreMouseEvents
  setPointerInside: (inside) => {
    ipcRenderer.send('glass:pointer-inside', !!inside);
  },
  platform: process.platform,
});
