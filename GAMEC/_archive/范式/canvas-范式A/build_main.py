# -*- coding: utf-8 -*-
import io

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
<script data-dc-script data-props='{"wallpaper":{"editor":"enum","options":["\\u6d45\\u8272\\u58c1\\u7eb8","\\u7eaf\\u767d\\u58c1\\u7eb8","\\u6df1\\u8272\\u58c1\\u7eb8"],"default":"\\u6d45\\u8272\\u58c1\\u7eb8","section":"\\u53ef\\u8bfb\\u6027\\u9a8c\\u8bc1"}}'>
class Component extends DCLogic {
  renderVals() {
    const w = this.props.wallpaper ?? '\\u6d45\\u8272\\u58c1\\u7eb8';
    const map = {
      '\\u6d45\\u8272\\u58c1\\u7eb8': 'linear-gradient(145deg,#dfe6f0 0%,#cfd9e8 42%,#e6dfe4 100%)',
      '\\u7eaf\\u767d\\u58c1\\u7eb8': '#ffffff',
      '\\u6df1\\u8272\\u58c1\\u7eb8': 'linear-gradient(145deg,#2b3444 0%,#1d2532 55%,#332c3a 100%)'
    };
    const bar = { '\\u6df1\\u8272\\u58c1\\u7eb8': 'rgba(20,26,36,.72)' };
    return { wallBg: map[w] || map['\\u6d45\\u8272\\u58c1\\u7eb8'], barBg: bar[w] || 'rgba(255,255,255,.55)' };
  }
}
</script>
</body>
</html>
"""

# ---- palette ----
T1 = "#17202E"
T2 = "rgba(23,32,46,.62)"
T3 = "rgba(23,32,46,.46)"
TM = "rgba(23,32,46,.30)"
ACCENT = "#2F6BFF"
EV_REL = "#2F6BFF"
EV_BUY = "#0E9E68"
EV_FIRST = "#C77700"
# normalized game theme colors (achievement only)
G = {
    "silksong": "#238A79",
    "elden":    "#B0761A",
    "outer":    "#2E6BB8",
    "signalis": "#A8452F",
    "hades":    "#6233C2",
}

def dot(color):
    return ('<span style="width:6px;height:6px;border-radius:999px;background:%s;'
            'box-shadow:inset 0 0 0 .5px rgba(15,23,42,.14)"></span>') % color

def xn(color, n):
    return ('<span class="mono" style="font-size:9px;line-height:1;color:%s">&times;%d</span>') % (color, n)

def plus(n):
    return ('<span class="mono" style="font-size:9px;line-height:1;color:%s">+%d</span>') % (T3, n)

# day -> (list of inline marks html, has_release_bar)
EV = {
    4:  ([dot(EV_REL)], True),
    6:  ([dot(G["silksong"]), xn(G["silksong"], 7)], False),
    8:  ([dot(EV_BUY), dot(G["elden"]), xn(G["elden"], 4)], False),
    12: ([dot(EV_FIRST), dot(G["outer"]), xn(G["outer"], 24)], False),
    14: ([dot(EV_REL)], True),
    18: ([dot(G["hades"]), xn(G["hades"], 3)], False),
    20: ([dot(EV_BUY), dot(G["signalis"]), xn(G["signalis"], 5)], False),
    22: ([dot(G["silksong"]), xn(G["silksong"], 12), dot(EV_FIRST), dot(EV_BUY), plus(1)], False),
    25: ([dot(G["silksong"]), xn(G["silksong"], 9)], False),
    27: ([dot(EV_REL)], True),
}

# 6 rows x 7 cols, Monday first. Aug 2026: 1st = Saturday.
rows = [
    [(27,0),(28,0),(29,0),(30,0),(31,0),(1,1),(2,1)],
    [(3,1),(4,1),(5,1),(6,1),(7,1),(8,1),(9,1)],
    [(10,1),(11,1),(12,1),(13,1),(14,1),(15,1),(16,1)],
    [(17,1),(18,1),(19,1),(20,1),(21,1),(22,1),(23,1)],
    [(24,1),(25,1),(26,1),(27,1),(28,1),(29,1),(30,1)],
    [(31,1),(1,0),(2,0),(3,0),(4,0),(5,0),(6,0)],
]
TODAY = 25

cells = []
for r in rows:
    for (n, cur) in r:
        marks, relbar = ("", False)
        inner = ""
        if cur and n in EV:
            marks_list, relbar = EV[n]
            inner = ('<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">%s</div>'
                     % "".join(marks_list))
        elif not cur and n == 2:
            inner = ('<div style="display:flex;align-items:center;gap:4px;opacity:.45">%s</div>' % dot(EV_REL))
            relbar = False
        is_today = cur and n == TODAY
        if is_today:
            box = ('background:rgba(255,255,255,.85);box-shadow:0 6px 16px rgba(15,23,42,.14),'
                   'inset 0 0 0 1px rgba(15,23,42,.12);')
            num = ('<span style="display:inline-flex;align-items:center;justify-content:center;'
                   'width:22px;height:22px;border-radius:999px;background:%s;color:#fff;'
                   'font-size:14px;line-height:1" class="grot">%d</span>') % (ACCENT, n)
        else:
            box = "background:transparent;"
            color = T1 if cur else TM
            num = ('<span class="grot" style="font-size:14px;line-height:22px;color:%s">%d</span>') % (color, n)
        bar = ""
        if relbar:
            bar = ('<div style="position:absolute;left:0;right:0;bottom:0;height:2px;'
                   'background:%s;border-radius:0 0 12px 12px"></div>') % EV_REL
        cells.append(
            '<div style="position:relative;width:88px;height:88px;border-radius:12px;%s'
            'padding:8px;box-sizing:border-box;display:flex;flex-direction:column;'
            'justify-content:space-between;overflow:hidden">%s%s%s</div>'
            % (box, num, inner or '<div></div>', bar))

grid = ('<div style="display:grid;grid-template-columns:repeat(7, minmax(0, 1fr));'
        'gap:4px;width:640px;height:548px;flex:none">%s</div>' % "".join(cells))

weekdays = "".join(
    '<div class="mono" style="width:88px;text-align:center;font-size:10.5px;letter-spacing:.10em;'
    'color:%s">%s</div>' % (T3, d) for d in ["MON","TUE","WED","THU","FRI","SAT","SUN"])
weekrow = ('<div style="display:grid;grid-template-columns:repeat(7, minmax(0, 1fr));gap:4px;'
           'width:640px;height:20px;align-items:center;flex:none;margin-bottom:8px">%s</div>' % weekdays)

months = []
for m, label in [(4,"4月"),(5,"5月"),(6,"6月"),(7,"7月"),(8,"8月"),(9,"9月"),(10,"10月"),(11,"11月"),(12,"12月")]:
    if m == 8:
        months.append('<div class="mono" style="flex:none;height:26px;padding:0 12px;border-radius:999px;'
                      'display:flex;align-items:center;font-size:11px;background:%s;color:#fff">%s</div>' % (ACCENT, label))
    else:
        months.append('<div class="mono" style="flex:none;height:26px;padding:0 12px;border-radius:999px;'
                      'display:flex;align-items:center;font-size:11px;background:rgba(255,255,255,.55);'
                      'box-shadow:inset 0 0 0 1px rgba(15,23,42,.06);color:%s">%s</div>' % (T2, label))
monthstrip = ('<div style="display:flex;align-items:center;gap:4px;width:640px;height:32px;'
              'overflow:hidden;flex:none;margin-bottom:12px">%s</div>' % "".join(months))

def icon_btn(path, extra=""):
    return ('<div style="width:30px;height:30px;border-radius:999px;background:rgba(255,255,255,.62);'
            'box-shadow:inset 0 0 0 1px rgba(15,23,42,.10), inset 0 1px 0 rgba(255,255,255,.90);'
            'display:flex;align-items:center;justify-content:center;%s">'
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="%s" stroke-width="2" '
            'stroke-linecap="round" stroke-linejoin="round">%s</svg></div>') % (extra, T2, path)

prev_i = icon_btn('<polyline points="15 18 9 12 15 6"></polyline>')
next_i = icon_btn('<polyline points="9 18 15 12 9 6"></polyline>')
gear = icon_btn('<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.5.6.86 1.12.9H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>')

header = ('<div style="display:flex;align-items:flex-end;justify-content:space-between;width:640px;'
          'height:62px;flex:none;margin-bottom:8px">'
          '<div style="display:flex;align-items:baseline;gap:8px">'
          '<span class="grot" style="font-size:54px;line-height:.92;font-weight:600;letter-spacing:-.02em;color:%s">8</span>'
          '<span style="font-size:16px;font-weight:500;color:%s">月</span>'
          '<span class="mono" style="font-size:11px;color:%s">2026</span>'
          '</div>'
          '<div style="display:flex;align-items:center;gap:8px">%s%s</div>'
          '</div>') % (T1, T1, T3, prev_i, next_i)

bottombar = ('<div style="display:flex;align-items:center;justify-content:space-between;width:640px;'
             'height:34px;flex:none;margin-top:12px">'
             '<div style="display:flex;align-items:center;gap:8px">'
             '<span style="width:6px;height:6px;border-radius:999px;background:%s"></span>'
             '<span class="mono" style="font-size:11px;color:%s">上次同步 08-25 15:20</span>'
             '</div>%s</div>') % (EV_BUY, T3, gear)

panel = ('<div style="position:absolute;left:96px;top:56px;width:668px;height:768px;border-radius:26px;'
         'box-sizing:border-box;padding:18px 14px 14px;'
         'background:linear-gradient(158deg, rgba(255,255,255,.72), rgba(255,255,255,.52));'
         '-webkit-backdrop-filter:blur(28px) saturate(160%%);backdrop-filter:blur(28px) saturate(160%%);'
         'box-shadow:0 0 0 1px rgba(15,23,42,.10), 0 16px 48px rgba(15,23,42,.18), '
         'inset 0 1px 0 rgba(255,255,255,.92), inset 0 -1px 0 rgba(15,23,42,.06);'
         'display:flex;flex-direction:column;align-items:center">'
         '%s%s%s%s%s</div>') % (header, monthstrip, weekrow_placeholder if False else weekrow, grid, bottombar)

taskbar = ('<div style="position:absolute;left:0;right:0;bottom:0;height:44px;background:{{barBg}};'
           '-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);display:flex;align-items:center;'
           'justify-content:center;gap:14px">'
           + "".join('<div style="width:18px;height:18px;border-radius:5px;background:rgba(23,32,46,.22)"></div>' for _ in range(4))
           + '<div style="width:18px;height:18px;border-radius:5px;background:%s;box-shadow:0 0 0 2px rgba(47,107,255,.22)"></div>' % ACCENT
           + '</div>')

root = ('<div style="position:relative;width:860px;height:900px;overflow:hidden;background:{{wallBg}}">'
        '%s%s</div>') % (panel, taskbar)

io.open("/home/claude/gamec-canvas/Main.dc.html", "w", encoding="utf-8").write(HEAD + root + "\n" + TAIL)
print("written")
