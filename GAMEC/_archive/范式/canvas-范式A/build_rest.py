# -*- coding: utf-8 -*-
import io

T1="#17202E"; T2="rgba(23,32,46,.62)"; T3="rgba(23,32,46,.46)"; TM="rgba(23,32,46,.30)"
ACCENT="#2F6BFF"; EV_REL="#2F6BFF"; EV_BUY="#0E9E68"; EV_FIRST="#C77700"; EV_FB="#6D4AE0"
WALL="linear-gradient(145deg,#dfe6f0 0%,#cfd9e8 42%,#e6dfe4 100%)"

HEAD = """<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;700&display=swap">
  <style>
    body { margin: 0; font-family: 'Noto Sans SC', 'Microsoft YaHei UI', 'Segoe UI', system-ui, sans-serif; }
    a { color: #2F6BFF; } a:hover { color: #1E4FD8; }
    .mono { font-family: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', monospace; }
    .grot { font-family: 'Space Grotesk', 'Noto Sans SC', sans-serif; }
  </style>
</helmet>
"""
TAIL = """</x-dc>
</body>
</html>
"""

TASKBAR = ('<div style="position:absolute;left:0;right:0;bottom:0;height:44px;'
           'background:rgba(255,255,255,.55);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);'
           'display:flex;align-items:center;justify-content:center;gap:14px">'
           + '<div style="width:18px;height:18px;border-radius:5px;background:rgba(23,32,46,.22)"></div>'*4
           + '<div style="width:18px;height:18px;border-radius:5px;background:%s;'
             'box-shadow:0 0 0 2px rgba(47,107,255,.22)"></div>' % ACCENT
           + '</div>')

PANEL_STYLE = ('position:absolute;left:96px;top:56px;width:668px;height:768px;border-radius:26px;'
   'box-sizing:border-box;padding:18px 14px 14px;'
   'background:linear-gradient(158deg, rgba(255,255,255,.72), rgba(255,255,255,.52));'
   '-webkit-backdrop-filter:blur(28px) saturate(160%);backdrop-filter:blur(28px) saturate(160%);'
   'box-shadow:0 0 0 1px rgba(15,23,42,.10), 0 16px 48px rgba(15,23,42,.18), '
   'inset 0 1px 0 rgba(255,255,255,.92), inset 0 -1px 0 rgba(15,23,42,.06);'
   'display:flex;flex-direction:column;align-items:center')

def plate(panel_inner):
    return ('<div style="position:relative;width:860px;height:900px;overflow:hidden;background:' + WALL + '">'
            '<div style="' + PANEL_STYLE + '">' + panel_inner + '</div>' + TASKBAR + '</div>')

def svg(path, size=14, color=None, sw="2"):
    return ('<svg width="%d" height="%d" viewBox="0 0 24 24" fill="none" stroke="%s" stroke-width="%s" '
            'stroke-linecap="round" stroke-linejoin="round">%s</svg>') % (size, size, color or T2, sw, path)

def icon_btn(path):
    return ('<div style="width:30px;height:30px;border-radius:999px;background:rgba(255,255,255,.62);flex:none;'
            'box-shadow:inset 0 0 0 1px rgba(15,23,42,.10), inset 0 1px 0 rgba(255,255,255,.90);'
            'display:flex;align-items:center;justify-content:center">%s</div>') % svg(path)

def sec_btn(label):
    return ('<div style="height:30px;padding:0 14px;border-radius:999px;background:rgba(255,255,255,.62);flex:none;'
            'box-shadow:inset 0 0 0 1px rgba(15,23,42,.10), inset 0 1px 0 rgba(255,255,255,.90);'
            'display:flex;align-items:center;font-size:11px;color:%s">%s</div>') % (T1, label)

def pri_btn(label, w=None):
    width = ("width:%dpx;justify-content:center;" % w) if w else "padding:0 24px;"
    return ('<div style="height:44px;%sborder-radius:999px;background:%s;display:flex;align-items:center;'
            'box-shadow:0 6px 20px rgba(47,107,255,.30), inset 0 1px 0 rgba(255,255,255,.40);'
            'font-size:13.5px;font-weight:500;color:#fff">%s</div>') % (width, ACCENT, label)

def switch(on=True):
    track = EV_BUY if on else "rgba(15,23,42,.16)"
    knob_x = "align-items:center;justify-content:flex-end" if on else "align-items:center;justify-content:flex-start"
    return ('<div style="width:44px;height:26px;border-radius:999px;background:%s;flex:none;display:flex;%s;'
            'padding:3px;box-sizing:border-box"><div style="width:20px;height:20px;border-radius:999px;'
            'background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.25)"></div></div>') % (track, knob_x)

def group_label(text):
    return ('<div class="mono" style="font-size:10.5px;letter-spacing:.10em;color:%s;padding-left:4px;'
            'margin-bottom:8px">%s</div>') % (T3, text)

def listrow(main, sub, right):
    subhtml = ('<span class="mono" style="font-size:11px;color:%s">%s</span>' % (T3, sub)) if sub else ''
    return ('<div style="display:flex;align-items:center;gap:12px;height:58px;padding:0 14px;box-sizing:border-box;'
            'border-radius:18px;background:rgba(255,255,255,.55);box-shadow:inset 0 0 0 1px rgba(15,23,42,.06)">'
            '<div style="display:flex;flex-direction:column;gap:2px;flex-grow:1;min-width:0">'
            '<span style="font-size:13.5px;font-weight:500;color:%s">%s</span>%s</div>%s</div>'
            ) % (T1, main, subhtml, right)

BACK = '<polyline points="15 18 9 12 15 6"></polyline>'

def view_header(title):
    return ('<div style="display:flex;align-items:center;gap:12px;width:640px;height:62px;flex:none;'
            'margin-bottom:8px">%s<span style="font-size:16px;font-weight:500;color:%s">%s</span></div>'
            ) % (icon_btn(BACK), T1, title)

# ---------------- Settings ----------------
avatar = ('<div style="width:38px;height:38px;border-radius:12px;flex:none;'
          'background:linear-gradient(150deg,#2E6BB8,#16406F)"></div>')
acct_row = ('<div style="display:flex;align-items:center;gap:12px;height:58px;padding:0 14px;box-sizing:border-box;'
            'border-radius:18px;background:rgba(255,255,255,.55);box-shadow:inset 0 0 0 1px rgba(15,23,42,.06)">'
            '%s<div style="display:flex;flex-direction:column;gap:2px;flex-grow:1">'
            '<span style="font-size:13.5px;font-weight:500;color:%s">已登录 · SugarLips</span>'
            '<span class="mono" style="font-size:11px;color:%s">76561198000000000</span></div>%s</div>'
            ) % (avatar, T1, T3, sec_btn("退出登录"))

settings_inner = (view_header("设置")
  + '<div style="width:640px;display:flex;flex-direction:column;gap:20px;flex-grow:1">'
  + '<div>' + group_label("ACCOUNT") + '<div style="display:flex;flex-direction:column;gap:8px">' + acct_row + '</div></div>'
  + '<div>' + group_label("SYNC") + '<div style="display:flex;flex-direction:column;gap:8px">'
      + listrow("自动同步", "每 6 小时", switch(True))
      + listrow("上次同步", "08-25 15:20", sec_btn("立即同步"))
    + '</div></div>'
  + '<div>' + group_label("DATA") + '<div style="display:flex;flex-direction:column;gap:8px">'
      + listrow("导出 JSON 备份", "", sec_btn("导出"))
      + listrow("封面与主题色缓存", "512 款 · api 431 / local 74 / fallback 7", sec_btn("重算"))
    + '</div></div>'
  + '</div>'
  + '<div style="width:640px;height:34px;display:flex;align-items:center;flex:none">'
    '<span style="font-size:11px;color:%s">退出程序请用任务栏托盘图标的右键菜单。</span></div>' % T3)

io.open("Settings.dc.html","w",encoding="utf-8").write(HEAD + plate(settings_inner) + "\n" + TAIL)

# ---------------- FirstRun ----------------
logo = ('<div style="width:64px;height:64px;border-radius:20px;background:%s;display:flex;align-items:center;'
        'justify-content:center;box-shadow:0 10px 28px rgba(47,107,255,.28)">%s</div>'
        ) % (ACCENT, svg('<rect x="3" y="4" width="18" height="18" rx="3"></rect>'
                         '<line x1="3" y1="9" x2="21" y2="9"></line>'
                         '<line x1="8" y1="2" x2="8" y2="6"></line>'
                         '<line x1="16" y1="2" x2="16" y2="6"></line>', 30, "#fff", "1.8"))
firstrun_inner = ('<div style="width:640px;flex-grow:1;display:flex;flex-direction:column;align-items:center;'
  'justify-content:center;gap:20px">%s'
  '<span class="grot" style="font-size:26px;font-weight:600;color:%s;text-align:center">'
  '把你的游戏，放回一条时间线上</span>'
  '<span style="font-size:13.5px;color:%s;text-align:center;max-width:360px;text-wrap:pretty">'
  '登录后自动取回愿望单、入库时间、首次游玩与成就解锁时间。数据只存在这台电脑上。</span>'
  '<div style="margin-top:8px">%s</div></div>'
  '<div style="width:640px;height:34px;display:flex;align-items:center;justify-content:center;flex:none">'
  '<span class="mono" style="font-size:11px;color:%s">v0.1</span></div>'
  ) % (logo, T1, T2, pri_btn("用 Steam 账号登录", 240), TM)
io.open("FirstRun.dc.html","w",encoding="utf-8").write(HEAD + plate(firstrun_inner) + "\n" + TAIL)

# ---------------- Syncing ----------------
def step(name, state, note):
    if state == "done":
        mark = svg('<polyline points="20 6 9 17 4 12"></polyline>', 14, EV_BUY, "2.4")
    elif state == "run":
        mark = ('<div style="width:10px;height:10px;border-radius:999px;background:%s;'
                'box-shadow:0 0 0 4px rgba(47,107,255,.18)"></div>') % ACCENT
    else:
        mark = ('<div style="width:10px;height:10px;border-radius:999px;'
                'box-shadow:inset 0 0 0 1.5px rgba(23,32,46,.22)"></div>')
    color = T1 if state != "wait" else TM
    return ('<div style="display:flex;align-items:center;gap:12px;height:44px;padding:0 14px;box-sizing:border-box">'
            '<div style="width:14px;display:flex;justify-content:center;flex:none">%s</div>'
            '<span style="font-size:13.5px;font-weight:500;color:%s;flex-grow:1">%s</span>'
            '<span class="mono" style="font-size:11px;color:%s">%s</span></div>') % (mark, color, name, T3, note)

progress = ('<div style="width:100%;height:6px;border-radius:999px;background:rgba(15,23,42,.08);overflow:hidden">'
            '<div style="width:61%;height:6px;border-radius:999px;background:' + ACCENT + '"></div></div>')
sync_inner = ('<div style="width:640px;flex-grow:1;display:flex;flex-direction:column;justify-content:center;gap:24px">'
  '<div style="display:flex;flex-direction:column;gap:8px">'
    '<div style="display:flex;align-items:baseline;justify-content:space-between">'
      '<span style="font-size:16px;font-weight:500;color:%s">正在取回你的记录</span>'
      '<span class="mono" style="font-size:11px;color:%s">312 / 512</span></div>%s</div>'
  '<div style="display:flex;flex-direction:column;border-radius:18px;background:rgba(255,255,255,.55);'
  'box-shadow:inset 0 0 0 1px rgba(15,23,42,.06);padding:6px 0">%s%s%s%s%s</div></div>'
  '<div style="width:640px;height:34px;display:flex;align-items:center;flex:none">'
  '<span style="font-size:11px;color:%s">可以关掉面板，同步会在后台继续。</span></div>'
  ) % (T1, T3, progress,
       step("愿望单", "done", "128"),
       step("库存与元数据", "done", "512"),
       step("入库时间", "done", "512"),
       step("成就解锁时间", "run", "312 / 512"),
       step("封面与主题色", "wait", "—"),
       T3)
io.open("Syncing.dc.html","w",encoding="utf-8").write(HEAD + plate(sync_inner) + "\n" + TAIL)

# ---------------- Tray ----------------
def menu_item(label, div=False):
    sep = ('<div style="height:1px;background:rgba(15,23,42,.08);margin:6px 10px"></div>') if div else ''
    return sep + ('<div style="height:34px;display:flex;align-items:center;padding:0 14px;font-size:13.5px;'
                  'color:%s">%s</div>') % (T1, label)

tray_menu = ('<div style="position:absolute;right:26px;bottom:62px;width:180px;border-radius:18px;'
  'padding:6px 0;box-sizing:border-box;'
  'background:linear-gradient(160deg, rgba(255,255,255,.92), rgba(255,255,255,.78));'
  '-webkit-backdrop-filter:blur(44px) saturate(180%%);backdrop-filter:blur(44px) saturate(180%%);'
  'box-shadow:0 0 0 1px rgba(15,23,42,.12), 0 12px 40px rgba(15,23,42,.22), '
  'inset 0 1px 0 rgba(255,255,255,.92)">%s%s%s%s</div>'
  ) % (menu_item("显示或隐藏"), menu_item("立即同步"), menu_item("设置"), menu_item("退出", True))

tray_bar = ('<div style="position:absolute;left:0;right:0;bottom:0;height:44px;'
  'background:rgba(255,255,255,.55);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);'
  'display:flex;align-items:center;justify-content:flex-end;gap:12px;padding-right:20px">'
  + '<div style="width:14px;height:14px;border-radius:4px;background:rgba(23,32,46,.22)"></div>'*3
  + '<div style="width:18px;height:18px;border-radius:5px;background:%s;'
    'box-shadow:0 0 0 3px rgba(47,107,255,.20)"></div>' % ACCENT
  + '<span class="mono" style="font-size:11px;color:%s">15:20</span></div>' % T2)

tray_root = ('<div style="position:relative;width:520px;height:420px;overflow:hidden;background:' + WALL + '">'
  + tray_menu + tray_bar + '</div>')
io.open("Tray.dc.html","w",encoding="utf-8").write(HEAD + tray_root + "\n" + TAIL)
print("ok settings/firstrun/syncing/tray")
