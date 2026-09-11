# -*- coding: utf-8 -*-
import io, colorsys

T1="#17202E"; T2="rgba(23,32,46,.62)"; T3="rgba(23,32,46,.46)"; TM="rgba(23,32,46,.30)"
ACCENT="#2F6BFF"; EV_REL="#2F6BFF"; EV_BUY="#0E9E68"; EV_FIRST="#C77700"; EV_FB="#6D4AE0"
PANEL_REF="#F2F4F8"
WALL="linear-gradient(145deg,#dfe6f0 0%,#cfd9e8 42%,#e6dfe4 100%)"

def hex2rgb(h):
    h=h.lstrip("#"); return tuple(int(h[i:i+2],16)/255 for i in (0,2,4))
def rgb2hex(r,g,b):
    return "#%02X%02X%02X" % tuple(max(0,min(255,round(c*255))) for c in (r,g,b))
def lum(h):
    def f(c): return c/12.92 if c<=0.03928 else ((c+0.055)/1.055)**2.4
    r,g,b=[f(x) for x in hex2rgb(h)]
    return 0.2126*r+0.7152*g+0.0722*b
def contrast(a,b):
    la,lb=lum(a),lum(b); hi,lo=max(la,lb),min(la,lb)
    return (hi+0.05)/(lo+0.05)

def normalize(h):
    r,g,b=hex2rgb(h)
    hh,l,s=colorsys.rgb_to_hls(r,g,b)
    if s < 0.12:
        return EV_FB, "近灰度 → 回退色"
    s=min(max(s,0.35),0.85)
    l=min(max(l,0.32),0.50)
    out=rgb2hex(*colorsys.hls_to_rgb(hh,l,s))
    guard=""
    while contrast(out,PANEL_REF) < 3.0 and l > 0.24:
        l-=0.04; out=rgb2hex(*colorsys.hls_to_rgb(hh,l,s)); guard="降 L 至达标"
    if contrast(out,PANEL_REF) < 3.0:
        return EV_FB, "仍不达标 → 回退色"
    return out, (guard or "S/L 钳制")

SAMPLES=[("#FFD84D","过亮黄"),("#FF2E6B","荧光粉"),("#0B5D52","过暗青"),
         ("#7BC5FF","浅蓝"),("#2A2E35","近灰度封面")]

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
TAIL = "</x-dc>\n</body>\n</html>\n"

def card(title, body, span=1):
    return ('<div style="grid-column:span %d;border-radius:20px;padding:20px;box-sizing:border-box;'
            'background:rgba(255,255,255,.62);box-shadow:inset 0 0 0 1px rgba(15,23,42,.08), '
            '0 4px 16px rgba(15,23,42,.06)">'
            '<div class="mono" style="font-size:10.5px;letter-spacing:.10em;color:%s;margin-bottom:14px">%s</div>'
            '%s</div>') % (span, T3, title, body)

def swatch(name, value, chip_style, note=""):
    notehtml = ('<span class="mono" style="font-size:10px;color:%s">%s</span>' % (TM, note)) if note else ""
    return ('<div style="display:flex;align-items:center;gap:10px">'
            '<div style="width:28px;height:28px;border-radius:9px;flex:none;%s"></div>'
            '<div style="display:flex;flex-direction:column;gap:1px;min-width:0">'
            '<span class="mono" style="font-size:11px;color:%s">%s</span>'
            '<span class="mono" style="font-size:10px;color:%s">%s</span>%s</div></div>'
            ) % (chip_style, T1, name, T3, value, notehtml)

# --- 1 window schematic (scale 0.28) ---
sw, sh = int(700*0.30), int(800*0.30)   # 210 x 240
pw, ph = int(668*0.30), int(768*0.30)   # 200 x 230
schematic = ('<div style="display:flex;align-items:flex-start;gap:20px">'
  '<div style="position:relative;width:%dpx;height:%dpx;border-radius:12px;background:%s;'
  'display:flex;align-items:center;justify-content:center">'
    '<div style="width:%dpx;height:%dpx;border-radius:10px;box-sizing:border-box;'
    'border:1px dashed rgba(15,23,42,.35);display:flex;align-items:center;justify-content:center">'
      '<div style="width:%dpx;height:%dpx;border-radius:8px;'
      'background:linear-gradient(158deg, rgba(255,255,255,.80), rgba(255,255,255,.58));'
      'box-shadow:0 0 0 1px rgba(15,23,42,.10), 0 8px 20px rgba(15,23,42,.16), '
      'inset 0 1px 0 rgba(255,255,255,.92)"></div></div></div>'
  '<div style="display:flex;flex-direction:column;gap:10px;flex-grow:1">'
    '<div style="display:flex;flex-direction:column;gap:2px">'
      '<span style="font-size:13.5px;font-weight:500;color:%s">L1 · Windows 桌面</span>'
      '<span style="font-size:11px;color:%s">产品不绘制底色，窗口 background: transparent</span></div>'
    '<div style="display:flex;flex-direction:column;gap:2px">'
      '<span style="font-size:13.5px;font-weight:500;color:%s">窗口 700 × 800（虚线）</span>'
      '<span style="font-size:11px;color:%s">无边框、无标题栏、无最小化 / 最大化 / 关闭；四周 16px 透明边距只供投影</span></div>'
    '<div style="display:flex;flex-direction:column;gap:2px">'
      '<span style="font-size:13.5px;font-weight:500;color:%s">L2 · 主面板 668 × 768</span>'
      '<span style="font-size:11px;color:%s">圆角 26；内边距 上 18 / 左右 14 / 下 14；内容宽 640</span></div>'
    '<div style="display:flex;flex-direction:column;gap:2px">'
      '<span style="font-size:13.5px;font-weight:500;color:%s">退出与显隐 · 系统托盘</span>'
      '<span style="font-size:11px;color:%s">单击显隐；右键：显示或隐藏 · 立即同步 · 设置 · 退出</span></div>'
  '</div></div>'
  ) % (sw+30, sh+30, WALL, sw, sh, pw, ph, T1,T2, T1,T2, T1,T2, T1,T2)

# --- 2 color tokens ---
tok = [
  ("--accent", ACCENT, "background:%s"%ACCENT, "4.09:1"),
  ("--text-1", "#17202E", "background:#17202E", ""),
  ("--text-2", "rgba(23,32,46,.62)", "background:rgba(23,32,46,.62)", ""),
  ("--text-3", "rgba(23,32,46,.46)", "background:rgba(23,32,46,.46)", ""),
  ("--text-muted", "rgba(23,32,46,.30)", "background:rgba(23,32,46,.30)", "仅非本月日期"),
  ("--glass-border", "rgba(15,23,42,.10)", "background:rgba(15,23,42,.10)", ""),
  ("--divider", "rgba(15,23,42,.08)", "background:rgba(15,23,42,.08)", ""),
  ("--hover", "rgba(15,23,42,.05)", "background:rgba(15,23,42,.05)", ""),
  ("--panel-ref", PANEL_REF, "background:%s;box-shadow:inset 0 0 0 1px rgba(15,23,42,.10)"%PANEL_REF, "对比度基准"),
  ("--bg-fallback", "#EEF1F6", "background:#EEF1F6;box-shadow:inset 0 0 0 1px rgba(15,23,42,.10)", "无透明时兜底"),
]
tokens_grid = ('<div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:14px">%s</div>'
  % "".join(swatch(n,v,s,note) for n,v,s,note in tok))

# --- 3 event colors ---
ev = [("发售 release","--ev-release",EV_REL),("购买 purchase","--ev-purchase",EV_BUY),
      ("首玩 first_play","--ev-first",EV_FIRST),("成就回退 fallback","--ev-achieve-fallback",EV_FB)]
ev_html = "".join(
  '<div style="display:flex;align-items:center;gap:10px">'
  '<span style="width:6px;height:6px;border-radius:999px;background:%s;flex:none;'
  'box-shadow:inset 0 0 0 .5px rgba(15,23,42,.14)"></span>'
  '<span style="font-size:13.5px;font-weight:500;color:%s;flex-grow:1">%s</span>'
  '<span class="mono" style="font-size:11px;color:%s">%s</span>'
  '<span class="mono" style="font-size:10px;color:%s;width:52px;text-align:right">%.2f:1</span></div>'
  % (c, T1, label, T3, c, TM, contrast(c, PANEL_REF)) for label, tokname, c in ev)
ev_html += ('<div style="height:1px;background:rgba(15,23,42,.08);margin:4px 0"></div>'
  '<div style="display:flex;align-items:center;gap:10px">'
  '<span style="width:6px;height:6px;border-radius:999px;background:#238A79;flex:none;'
  'box-shadow:inset 0 0 0 .5px rgba(15,23,42,.14)"></span>'
  '<span style="font-size:13.5px;font-weight:500;color:%s;flex-grow:1">成就 achievement</span>'
  '<span class="mono" style="font-size:11px;color:%s">游戏主题色</span></div>'
  '<span style="font-size:11px;color:%s;text-wrap:pretty">浅底不用外发光；色点一律 6 × 6，'
  '加 inset 0 0 0 .5px rgba(15,23,42,.14) 压边。</span>' % (T1, T3, T2))

# --- 4 theme color pipeline ---
def pair(raw, label):
    out, why = normalize(raw)
    return ('<div style="display:flex;align-items:center;gap:10px">'
      '<div style="width:34px;height:44px;border-radius:8px;flex:none;background:%s"></div>'
      '<span class="mono" style="font-size:10px;color:%s;width:62px">%s</span>'
      '%s'
      '<div style="width:34px;height:44px;border-radius:8px;flex:none;background:%s;'
      'box-shadow:0 0 0 1px rgba(15,23,42,.08)"></div>'
      '<div style="display:flex;flex-direction:column;gap:1px;flex-grow:1">'
      '<span class="mono" style="font-size:11px;color:%s">%s</span>'
      '<span style="font-size:10px;color:%s">%s · %s · %.2f:1</span></div></div>'
      ) % (raw, T3, raw,
           '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="%s" stroke-width="2" '
           'stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line>'
           '<polyline points="12 5 19 12 12 19"></polyline></svg>' % TM,
           out, T1, out, TM, label, why, contrast(out, PANEL_REF))

steps_txt = ('<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">'
  '<span style="font-size:11px;color:%s;text-wrap:pretty">① 色值 API → ② 缓存封面本地取色（64×64，丢弃 L&lt;12%% / L&gt;92%% 像素，k-means k=3）→ ③ 回退色。</span>'
  '<span style="font-size:11px;color:%s;text-wrap:pretty">规范化：色相不动；S 钳制 35~85%%；L 钳制 32~50%%；对 --panel-ref 不足 3:1 则每步 −4%% L，下限 24%%；近灰度（S&lt;12%%）直接回退。</span>'
  '<span style="font-size:11px;color:%s;text-wrap:pretty">同步时算一次入库（theme_color / source / at），渲染期只读。</span></div>'
  ) % (T2, T2, T2)
pipeline = steps_txt + ('<div style="display:flex;flex-direction:column;gap:10px">%s</div>'
  % "".join(pair(h, lab) for h, lab in SAMPLES))

# --- 5 grid numbers ---
rows_g = [("窗口","700 × 800（固定，不可缩放）"),("主面板","668 × 768 · 圆角 26"),
          ("面板内边距","上 18 / 左右 14 / 下 14"),("内容宽","640"),
          ("日历格","88 × 88 · gap 4 · 7 × 6"),("网格","640 × 548"),
          ("月份头 / 月份条","62 / 32"),("星期行 / 底栏","20 / 34"),
          ("段间 gap","8 · 12 · 8 · 12（合计 768 闭合）"),
          ("浮层","668 × 420 · 圆角 30 30 26 26"),
          ("浮层顶部区 / 事件行","96 / 62 · gap 8")]
grid_html = "".join(
  '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;'
  'padding:7px 0;box-shadow:inset 0 -1px 0 rgba(15,23,42,.06)">'
  '<span style="font-size:11px;color:%s;flex:none">%s</span>'
  '<span class="mono" style="font-size:11px;color:%s;text-align:right">%s</span></div>' % (T2, k, T1, v)
  for k, v in rows_g)

# --- 6 removed ---
removed = ["最小化 / 最大化 / 关闭按钮与标题栏","深色底 #0B0E14 与整套深色 token",
           "底栏左下角「已发售 + 数量」入口","已发售清单页与其筛选段控",
           "意愿等级 chip（必买 / 打折买 / 观望）","浮层内的解释性文案与发售日说明",
           "浮层「手动补录」入口（V0.5 再启用）"]
removed_html = "".join(
  '<div style="display:flex;align-items:center;gap:10px;padding:6px 0">'
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="%s" stroke-width="2" '
  'stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>'
  '<span style="font-size:11px;color:%s">%s</span></div>' % (TM, T2, r) for r in removed)

body = ('<div style="width:980px;min-height:1180px;box-sizing:border-box;padding:36px;background:#E9EDF3;'
  'display:flex;flex-direction:column;gap:22px">'
  '<div style="display:flex;align-items:baseline;justify-content:space-between">'
    '<span class="grot" style="font-size:30px;font-weight:600;color:%s">游戏日历 · UI 规范 v0.2</span>'
    '<span class="mono" style="font-size:11px;color:%s">浅色液态玻璃 · 桌面悬浮 · 700 × 800</span></div>'
  '<div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:22px">'
  '%s%s%s%s%s%s</div></div>'
  ) % (T1, T3,
       card("窗口形态 / WINDOW", schematic, 2),
       card("色彩 / COLOR TOKENS", tokens_grid),
       card("事件色 / EVENT COLORS", ev_html),
       card("游戏主题色 / THEME COLOR", pipeline, 2),
       card("栅格 / GRID", grid_html),
       card("v0.1 起删除的项 / REMOVED", removed_html))

io.open("Tokens.dc.html","w",encoding="utf-8").write(HEAD + body + "\n" + TAIL)
print("ok tokens")
for h,l in SAMPLES:
    o,w=normalize(h); print(h,l,"->",o,w,round(contrast(o,PANEL_REF),2))
