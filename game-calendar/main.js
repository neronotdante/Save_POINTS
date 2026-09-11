const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

/*
 * 窗口 = 面板 + 透明的投影外扩（UI 规范 v0.3 §1.1）
 *   面板 668 × 768（一切设计取值的基准，圆角 26）
 *   外扩 上 32 / 左右 48 / 下 64 —— 供 §2.3 的三层投影渲染，永远不可见
 *   窗口 668 + 48×2 = 764，768 + 32 + 64 = 864
 * 原来的四周 16px 装不下 `0 18px 44px` 的环境影，投影会被窗口边缘切成直角。
 */
const PANEL_WIDTH = 668;
const PANEL_HEIGHT = 768;
const BLEED = { top: 32, right: 48, bottom: 64, left: 48 };
const WINDOW_WIDTH = PANEL_WIDTH + BLEED.left + BLEED.right;   // 764
const WINDOW_HEIGHT = PANEL_HEIGHT + BLEED.top + BLEED.bottom; // 864

let mainWindow = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    frame: false,
    transparent: true,
    hasShadow: false, // 透明窗开原生阴影会画出一个矩形影，投影全部由 CSS 负责
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 渲染层报错转发到主进程 stdout，便于排障
  mainWindow.webContents.on('console-message', (event, ...args) => {
    const d = args[0];
    const msg = d && typeof d === 'object' && 'message' in d ? d.message : String(args[args.length - 1]);
    const level = d && typeof d === 'object' && 'level' in d ? d.level : args[0];
    if (level === 'error' || level === 3) console.error('[renderer]', msg);
    else console.log('[renderer]', msg);
  });

  // 冒烟截图（可选）：SHOT=<path> npm start 时截图后退出
  if (process.env.SHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(process.env.SHOT, img.toPNG());
          const { width, height } = img.getSize();
          const bmp = img.toBitmap(); // BGRA
          let opaque = 0, white = 0, accent = 0, dark = 0;
          for (let i = 0; i < bmp.length; i += 4) {
            const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2], a = bmp[i + 3];
            if (a > 0) opaque++;
            if (a > 200 && r > 200 && g > 200 && b > 200) white++;
            if (a > 200 && r > 20 && r < 90 && g > 80 && g < 150 && b > 200) accent++; // ~#2F6BFF
            if (a > 200 && r < 60 && g < 60 && b < 80) dark++;
          }
          console.log('screenshot saved:', process.env.SHOT);
          console.log('stats:', JSON.stringify({ width, height, opaque, white, accent, dark }));

          const dom = await mainWindow.webContents.executeJavaScript(`(() => {
            const q = (s) => document.querySelector(s);
            const cs = (s, p) => q(s) ? getComputedStyle(q(s))[p] : null;
            const panel = q('.glass-l2');
            return {
              monthNum: q('#month-num')?.textContent,
              monthYear: q('#month-year')?.textContent,
              cells: document.querySelectorAll('.cell').length,
              todayCells: document.querySelectorAll('.cell.today').length,
              offMonthCells: document.querySelectorAll('.cell.off-month').length,
              dots: document.querySelectorAll('.evdot').length,
              evcount: document.querySelectorAll('.evcount').length,
              evfold: document.querySelectorAll('.evfold').length,
              releaseBars: document.querySelectorAll('.release-bar').length,
              pills: document.querySelectorAll('.pill').length,
              activePill: q('.pill.active')?.textContent,
              weekdays: [...document.querySelectorAll('.wd')].map((x) => x.textContent).join(','),
              todayNumBg: cs('.today-num', 'backgroundColor'),
              activePillBg: cs('.pill.active', 'backgroundColor'),
              syncLabel: q('#sync-label')?.textContent,
              /* 玻璃自检（UI 规范 v0.3 §2） */
              panelSize: panel ? [panel.offsetWidth, panel.offsetHeight].join('x') : null,
              panelFill: cs('.glass-l2', 'backgroundImage').slice(0, 40),
              backdropFilter: cs('.glass-l2', 'backdropFilter'),   // 应为 none —— L2 不得有 blur
              hasRim: !!getComputedStyle(panel, '::before').maskComposite,
              noiseOpacity: getComputedStyle(panel, '::after').opacity,
            };
          })()`);
          console.log('dom:', JSON.stringify(dom));
        } catch (err) {
          console.error('screenshot failed:', err);
        }
        app.quit();
      }, 900);
    });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 无标题栏 / 无关闭按钮：关闭走系统托盘，这里改成隐藏
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/*
 * 透明区鼠标穿透（UI 规范 v0.3 §1.1，阻塞级）
 * 面板外那一圈近 50px 的投影空间虽然看不见，但**默认仍然接收鼠标事件**，
 * 会挡住底下的桌面图标。渲染层做命中判定，指针不在面板内时放行。
 * { forward: true } 是关键：不加的话一旦开始忽略鼠标，渲染层就再也收不到
 * mousemove，状态回不来。
 */
ipcMain.on('glass:pointer-inside', (event, inside) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(!inside, { forward: true });
});

function showWindow() {
  if (!mainWindow) return;
  mainWindow.setIgnoreMouseEvents(false); // 复位，避免隐藏时停在「忽略」状态
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip('游戏日历');
  tray.on('click', toggleWindow);

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: toggleWindow },
    { type: 'separator' },
    {
      label: '立即同步',
      click: () => {
        if (mainWindow) {
          showWindow();
          mainWindow.webContents.send('sync-now');
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      showWindow();
    }
  });
});

// 托盘常驻：不随窗口关闭退出，退出只由托盘「退出」触发
app.on('window-all-closed', () => {
  // 保持运行（托盘仍驻留）
});

app.on('before-quit', () => {
  isQuitting = true;
});
