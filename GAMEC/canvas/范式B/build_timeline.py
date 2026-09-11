#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_timeline.py —— 生成范式 B（横向时间轴）的 4 块画板与 canvas.json。

用法：在 GAMEC/canvas/ 目录下执行
    python build_timeline.py            # 生成 范式B/*.dc.html + 范式B/canvas.json
    python build_index.py 范式B          # 再由画板生成本地全景页 范式B/index.html

取值来源：05_UI设计规范 v1.0（色彩 / 字体 / 组件 / 事件标记）+ 07_视图范式 v2.0 §4（时间轴结构）。
v1.1 变更：引线高度改算法分配（D-3）、底栏状态点改 --text-1（D-10）、成就头部封面 46x69（D-12）、
封盘帽与封盘标注（D-16）、新增 设置 / 首启 / 同步 三块画板（D-17）、悬浮 panel 顶部收敛与成就行数上限实算。
本文件只产出设计稿，不是实现；实现在 timeline/ 仓库，见 开发文档/01 §2A。
"""
import pathlib
HERE = pathlib.Path(__file__).resolve().parent
import json, io

W,H = 1440,900
AXIS = 480
TH = {"ER":"#9A6B1F","HAD":"#A33055","HK":"#2E5E8A","SV":"#3E7A34","CEL":"#7A3E8F","FAC":"#B05A1E"}
PUR = "#0E9E68"   # --ev-purchase
REL = "#2F6BFF"   # --ev-release

def lighten(hexc, amt=0.30):
    c = hexc.lstrip('#')
    r,g,b = int(c[0:2],16),int(c[2:4],16),int(c[4:6],16)
    r = int(r+(255-r)*amt); g = int(g+(255-g)*amt); b = int(b+(255-b)*amt)
    return '#%02X%02X%02X' % (r,g,b)

ICON = {
 "play":'<path d="M8 5.4 19 12 8 18.6Z"/>',
 "cart":'<circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17.5" cy="19.5" r="1.3"/><path d="M2.8 4h2.4l2.4 11.1a1.6 1.6 0 0 0 1.6 1.3h7.7a1.6 1.6 0 0 0 1.6-1.3L20.6 8.2H6"/>',
 "key":'<circle cx="7.8" cy="12" r="3.7"/><path d="M11.5 12H21"/><path d="M17.6 12v3.1"/><path d="M20.4 12v2.1"/>',
 "cal":'<rect x="3.5" y="5.2" width="17" height="15.3" rx="2.6"/><path d="M3.5 10.2h17M8 3.4v3.4M16 3.4v3.4"/>',
 "chevL":'<path d="M14.6 6.4 9 12l5.6 5.6"/>',
 "chevR":'<path d="M9.4 6.4 15 12l-5.6 5.6"/>',
 "gear":'<circle cx="12" cy="12" r="3.2"/><path d="M12 3.6v2.2M12 18.2v2.2M20.4 12h-2.2M5.8 12H3.6M17.9 6.1l-1.6 1.6M7.7 16.3 6.1 17.9M17.9 17.9l-1.6-1.6M7.7 7.7 6.1 6.1"/>',
}
def svg(name, size=14, sw=1.8):
    return ('<svg width="%d" height="%d" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            'stroke-width="%s" stroke-linecap="round" stroke-linejoin="round">%s</svg>') % (size,size,sw,ICON[name])

def unit(icon, color, xn=None, shelved=False):
    """一个 unit = [封盘帽] + 图标行 + 色点。封盘帽压在 unit 正上方 4px（05 §6 第 10 条 / 07 §4.9）。"""
    x = ''
    if xn: x = '<span class="mono" style="font-size:9px;color:%s;">&#215;%d</span>' % (color, xn)
    cap = ('<div style="width:12px;height:1.5px;border-radius:1px;background:var(--text-3);'
           'margin-bottom:4px;"></div>') if shelved else ''
    return ('<div style="display:flex;flex-direction:column;align-items:center;">%s'
            '<div style="display:flex;align-items:center;gap:3px;color:%s;margin-bottom:5px;">%s%s</div>'
            '<div class="dot" style="background:%s;"></div></div>') % (cap, color, svg(icon), x, color)

# ---------- D-3：引线（stem）高度的分配算法 ----------
# 规则：引线默认恒为 STEM_BASE；只有当相邻组的「命中区」（组宽 + 16，07 §4.8）在水平上
# 重叠时，右侧那组才逐级抬高一档，直到与所有冲突组不同层。层级用尽（同一重叠簇 > STEM_LVLS 组）
# 时不再加高，交给 05 §6 第 2 条的 +N 折叠处理。
STEM_BASE, STEM_STEP, STEM_LVLS = 64, 40, 4   # 步进 40 = 标记块高 32 + 呼吸 8
UNIT_W, UNIT_W_XN, UNIT_GAP, PLUS_W, HIT_PAD = 14, 30, 12, 16, 16

def group_w(ev):
    """标记组宽（不含命中区留白）。"""
    us = ev["units"]
    w = sum(UNIT_W_XN if (len(u) > 2 and u[2]) else UNIT_W for u in us) + UNIT_GAP * (len(us) - 1)
    if ev.get("plus"): w += UNIT_GAP + PLUS_W
    return w

def assign_stems(evs):
    evs = sorted(evs, key=lambda e: e["x"])
    for i, e in enumerate(evs):
        used = set()
        for j in range(i):
            p = evs[j]
            if e["x"] - p["x"] < (group_w(e) + group_w(p)) / 2 + HIT_PAD + 8:
                used.add(p["_lvl"])
        lvl = next((l for l in range(STEM_LVLS) if l not in used), STEM_LVLS - 1)
        e["_lvl"] = lvl
        e["stem"] = STEM_BASE + lvl * STEM_STEP
    return evs

COL_MAX = 5          # 07 §4.2：每列最多 5 张
def shots(x, cols):
    if not cols: return ''
    chunks = [cols[i:i+COL_MAX] for i in range(0, len(cols), COL_MAX)]
    body = ''.join(
        '<div style="display:flex;flex-direction:column;gap:6px;">%s</div>'
        % ''.join('<div class="shot" style="background:linear-gradient(135deg,%s,%s);"></div>'
                  % (lighten(c,.38), c) for c in ch)
        for ch in chunks)
    return ('<div style="position:absolute;left:%dpx;top:%dpx;transform:translateX(-50%%);'
            'display:flex;align-items:flex-start;gap:6px;">%s</div>') % (x, AXIS+32, body)

def group(ev):
    us = ''.join(unit(*u) for u in ev["units"])
    if ev.get("plus"):
        us += ('<span class="mono" style="font-size:9px;color:var(--text-3);align-self:flex-end;'
               'padding-bottom:2px;">+%d</span>' % ev["plus"])
    return ('<div style="position:absolute;left:%dpx;bottom:%dpx;transform:translateX(-50%%);'
            'display:flex;flex-direction:column;align-items:center;">'
            '<div style="display:flex;align-items:flex-end;gap:12px;padding-bottom:7px;">%s</div>'
            '<div style="width:1px;height:%dpx;background:var(--stem);"></div></div>'
            ) % (ev["x"], H-AXIS, us, ev["stem"]) + shots(ev["x"], ev.get("shots"))

def tick(x, label, accent=False):
    col = 'var(--accent)' if accent else 'rgba(15,23,42,.14)'
    lc  = 'color:var(--accent);' if accent else ''
    return ('<div style="position:absolute;left:%dpx;top:%dpx;width:1px;height:%dpx;background:%s;"></div>'
            '<div class="label" style="position:absolute;left:%dpx;top:%dpx;transform:translateX(-50%%);'
            'white-space:nowrap;%s">%s</div>') % (x, AXIS, 7 if accent else 5, col, x, AXIS+11, lc, label)

def band(x0,x1,label):
    return ('<div style="position:absolute;left:%dpx;top:%dpx;width:%dpx;height:13px;border-radius:7px;'
            'background:repeating-linear-gradient(45deg,rgba(15,23,42,.07) 0 2px,transparent 2px 6px);'
            '-webkit-mask-image:linear-gradient(90deg,#000 0 76%%,transparent 100%%);'
            'mask-image:linear-gradient(90deg,#000 0 76%%,transparent 100%%);"></div>'
            '<div class="label" style="position:absolute;left:%dpx;top:%dpx;transform:translateX(-50%%);'
            'white-space:nowrap;">%s</div>') % (x0, AXIS-6, x1-x0, (x0+x1)//2, AXIS-28, label)

SEG = ["日","周","月"]
def header(num, active):
    segs = ''.join('<div class="%s">%s</div>' % ('on' if s==active else '', s) for s in SEG)
    return ('<div style="position:absolute;left:40px;top:0;height:96px;display:flex;align-items:center;">'
            '<div class="num" style="font-size:54px;line-height:.92;font-weight:600;letter-spacing:-.02em;">%s</div></div>'
            '<div style="position:absolute;right:40px;top:0;height:96px;display:flex;align-items:center;gap:10px;">'
            '<div class="iconbtn">%s</div><div class="iconbtn">%s</div>'
            '<div class="seg" style="margin-left:6px;">%s</div></div>'
            ) % (num, svg("chevL",14), svg("chevR",14), segs)

FOOT = ('<div style="position:absolute;left:40px;bottom:0;height:34px;display:flex;align-items:center;gap:8px;">'
        '<div class="dot" style="background:%s;"></div>'
        '<div class="mono" style="font-size:11px;color:var(--text-3);">LAST SYNC 2026-08-27 09:12</div></div>'
        '<div style="position:absolute;right:40px;bottom:2px;"><div class="iconbtn">%s</div></div>') % ("var(--text-1)", svg("gear",14))

HEAD = '''<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600&family=JetBrains+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500&display=swap">
  <style>
    :root{
      --bg-fallback:#EEF1F6; --panel-ref:#F2F4F8; --accent:#2F6BFF; --accent-ink:#FFFFFF;
      --divider:rgba(15,23,42,.08); --hover:rgba(15,23,42,.05);
      --text-1:#17202E; --text-2:rgba(23,32,46,.62); --text-3:rgba(23,32,46,.50); --text-muted:rgba(23,32,46,.30);
      --ev-release:#2F6BFF; --ev-purchase:#0E9E68; --ev-achieve-fallback:#6D4AE0;
      --axis:rgba(15,23,42,.16); --stem:rgba(15,23,42,.14);
    }
    *{box-sizing:border-box;}
    body{margin:0;width:1440px;height:900px;background:var(--bg-fallback);color:var(--text-1);
      font-family:"Noto Sans SC","Microsoft YaHei UI","Segoe UI",system-ui,sans-serif;
      -webkit-font-smoothing:antialiased;}
    a{color:#2F6BFF;} a:hover{color:#1B4FD8;}
    .num{font-family:"Space Grotesk",system-ui,sans-serif;}
    .mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace;}
    .label{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10.5px;letter-spacing:.10em;
      text-transform:uppercase;color:var(--text-3);}
    .dot{width:6px;height:6px;border-radius:50%;box-shadow:inset 0 0 0 .5px rgba(15,23,42,.14);}
    .iconbtn{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.30);
      border:1px solid rgba(15,23,42,.10);box-shadow:inset 0 1px 0 rgba(255,255,255,.90);
      display:flex;align-items:center;justify-content:center;color:var(--text-2);}
    .seg{height:30px;border-radius:999px;background:rgba(255,255,255,.30);border:1px solid rgba(15,23,42,.10);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.90);display:flex;align-items:center;padding:2px;gap:2px;}
    .seg>div{height:24px;padding:0 15px;border-radius:999px;display:flex;align-items:center;
      font-size:13.5px;font-weight:500;color:var(--text-2);}
    .seg>div.on{background:var(--accent);color:var(--accent-ink);box-shadow:0 2px 8px rgba(47,107,255,.30);}
    .shot{width:96px;height:54px;border-radius:8px;box-shadow:inset 0 0 0 .5px rgba(15,23,42,.14);}
    .axis{position:absolute;left:0;right:0;top:480px;height:1px;background:var(--axis);}
    .mid{position:absolute;left:720px;top:96px;bottom:34px;width:1px;background:rgba(15,23,42,.05);}
  </style>
</helmet>
'''
TAIL = '''</x-dc>
</body>
</html>
'''

def build(num, active, ticks, bands, events, edge=False, extra=''):
    events = assign_stems(events)
    p = [HEAD, '<div style="position:relative;width:1440px;height:900px;overflow:hidden;">',
         header(num, active), '<div class="mid"></div>', '<div class="axis"></div>']
    for b in bands: p.append(band(*b))
    for t in ticks: p.append(tick(*t))
    for e in events: p.append(group(e))
    if edge:
        p.append('<div style="position:absolute;right:0;top:96px;bottom:34px;width:64px;'
                 'background:linear-gradient(270deg,rgba(15,23,42,.07),rgba(15,23,42,0));'
                 'display:flex;align-items:center;justify-content:center;color:var(--text-3);">%s</div>'
                 % svg("chevR",20,2))
    p.append(FOOT); p.append(extra); p.append('</div>'); p.append(TAIL)
    return ''.join(p)

# ---------- 月档 ----------
main_ticks = [(96,"MAR"),(240,"APR"),(390,"MAY"),(530,"JUN"),
              (660,"JUL 06"),(760,"JUL 13"),(860,"JUL 20"),(960,"JUL 27"),
              (1060,"AUG 03"),(1160,"AUG 10"),(1310,"AUG 24"),(1380,"AUG 27",True)]
main_ev = [
 {"x":140,"units":[("cal",REL)]},
 {"x":300,"units":[("key",TH["ER"],3)],"shots":[TH["ER"]]*2},
 {"x":470,"units":[("cart",PUR),("play",TH["HK"])]},
 {"x":700,"units":[("cart",PUR),("play",TH["SV"]),("key",TH["SV"],6)],"plus":1,"shots":[TH["SV"]]*4},
 {"x":880,"units":[("key",TH["HAD"],12,True)]},   # D-16 封盘帽
 {"x":1060,"units":[("cart",PUR),("key",TH["FAC"],4),("play",TH["FAC"])],"plus":2,
  "shots":[TH["FAC"]]*7},
 {"x":1260,"units":[("key",TH["CEL"],5)],"shots":[TH["CEL"]]*3},
 {"x":1380,"units":[("play",TH["HK"]),("key",TH["ER"],8),("cart",PUR)],"plus":1,
  "shots":[TH["ER"]]*5},
]
# ---------- 周档 ----------
week_ticks = [(120,"JUL 20"),(300,"JUL 27"),(480,"AUG 03"),
              (840,"AUG 17"),(930,"AUG 19"),(1020,"AUG 21"),(1110,"AUG 23"),(1200,"AUG 25"),(1330,"AUG 27",True)]
week_ev = [
 {"x":160,"units":[("play",TH["HK"])],"shots":[TH["HK"]]*2},
 {"x":330,"units":[("key",TH["SV"],6),("cart",PUR)],"shots":[TH["SV"]]*4},
 {"x":620,"units":[("cal",REL)]},
 {"x":860,"units":[("key",TH["CEL"],5)],"shots":[TH["CEL"]]*3},
 {"x":1020,"units":[("play",TH["FAC"]),("key",TH["FAC"],4)],"shots":[TH["FAC"]]*6},
 {"x":1180,"units":[("key",TH["HAD"],9)],"shots":[TH["HAD"]]*3},
 {"x":1330,"units":[("play",TH["HK"]),("key",TH["ER"],8),("cart",PUR)],"plus":1,"shots":[TH["ER"]]*5},
]
# ---------- 日档 ----------
day_ticks = [(200,"AUG 21"),(700,"AUG 25"),(920,"AUG 26"),(1140,"AUG 27",True)]
day_ev = [
 {"x":200,"units":[("cart",PUR)]},
 {"x":460,"units":[("cal",REL)]},
 {"x":720,"units":[("play",TH["CEL"])],"shots":[TH["CEL"]]*4},
 {"x":860,"units":[("key",TH["CEL"],5)]},
 {"x":960,"units":[("key",TH["SV"],3)],"shots":[TH["SV"]]*3},
 {"x":1090,"units":[("play",TH["FAC"])],"shots":[TH["FAC"]]*2},
 {"x":1240,"units":[("key",TH["ER"],8)],"shots":[TH["ER"]]*8},
 {"x":1380,"units":[("cart",PUR)]},
]

# 截图带重叠自检
def check(name, evs):
    spans=[]
    for e in evs:
        n=len(e.get("shots") or [])
        if not n: continue
        nc=(n+COL_MAX-1)//COL_MAX
        w=nc*96+(nc-1)*6
        spans.append((e["x"]-w/2, e["x"]+w/2))
    spans.sort()
    for i in range(1,len(spans)):
        if spans[i][0] < spans[i-1][1]-0.5:
            print("WARN %s 截图重叠: %s vs %s" % (name, spans[i-1], spans[i]))
    if spans and (spans[0][0] < 8 or spans[-1][1] > W-8):
        print("WARN %s 截图出界: %s" % (name, spans[0] if spans[0][0]<8 else spans[-1]))
for n,e in (("Main",main_ev),("Week",week_ev),("Day",day_ev)): check(n,e)

io.open(str(HERE / "Main.dc.html"),"w",encoding="utf-8").write(
    build("2026.07","月",main_ticks,[(150,600,"APR &#8212; JUN")],main_ev,edge=True))
io.open(str(HERE / "Week.dc.html"),"w",encoding="utf-8").write(
    build("2026.08","周",week_ticks,[(540,780,"AUG 05 &#8212; AUG 15")],week_ev))
io.open(str(HERE / "Day.dc.html"),"w",encoding="utf-8").write(
    build("08.25","日",day_ticks,[(300,620,"AUG 22 &#8212; AUG 24")],day_ev))

# ---------- 时点悬浮 panel（07 §4.8）----------
HEADER_H   = 96
PANEL_TOP_MIN = HEADER_H + 8          # 贴近头部下沿时向下收敛，最小边距 8（与「贴视口左右缘收敛」对称）
MARK_H     = 25                       # 标记块高 = 图标 14 + gap 5 + 色点 6
ANCHOR_GAP = 10                       # panel 底边距标记
PANEL_W, COVER_W = 320, 96

def mark_top(stem):
    return AXIS - stem - 7 - MARK_H

def prow(icon, color, xn, ts):
    x = '<span class="mono" style="font-size:9px;color:%s;">&#215;%d</span>' % (color, xn) if xn else ''
    return ('<div style="display:flex;align-items:center;gap:4px;">'
            '<div style="display:flex;align-items:center;gap:3px;color:%s;">%s%s</div>'
            '<div style="flex:1 1 auto;"></div>'
            '<div class="mono" style="font-size:11px;color:var(--text-3);">%s</div></div>'
            ) % (color, svg(icon), x, ts)

def dots(n, cur=0):
    if n < 2: return ''
    cells = ''.join('<div style="width:6px;height:6px;border-radius:50%%;background:%s;"></div>'
                    % ('var(--accent)' if i==cur else 'rgba(15,23,42,.18)') for i in range(n))
    return '<div style="display:flex;gap:6px;justify-content:center;margin-top:8px;">%s</div>' % cells

def hit(x, w, top):
    return ('<div style="position:absolute;left:%dpx;top:%dpx;transform:translateX(-50%%);width:%dpx;'
            'height:44px;border-radius:14px;background:var(--hover);"></div>') % (x, top, w)

def panel_box(x, top, inner, w=PANEL_W):
    return ('<div style="position:absolute;left:%dpx;top:%dpx;width:%dpx;background:#FFFFFF;'
            'border:1px solid rgba(15,23,42,.06);border-radius:18px;box-shadow:0 12px 32px rgba(15,23,42,.16);'
            'padding:14px;display:flex;gap:12px;">%s</div>') % (x - w//2, top, w, inner)

def place(x, stem, gw, inner, h):
    """命中区 + panel；panel 顶部不越过头部下沿 8px（超出则向下收敛）。"""
    mt = mark_top(stem)
    top = max(PANEL_TOP_MIN, mt - 8 - ANCHOR_GAP - h)
    return hit(x, gw + HIT_PAD, mt - 8) + panel_box(x, top, inner)

def cover(c, abbr, w, h, fs=13):
    return ('<div style="width:%dpx;height:%dpx;flex:0 0 auto;border-radius:%dpx;'
            'background:linear-gradient(150deg,%s,%s);display:flex;align-items:flex-end;'
            'justify-content:center;padding-bottom:%dpx;">'
            '<span class="num" style="font-size:%dpx;font-weight:600;color:rgba(255,255,255,.92);">%s</span>'
            '</div>') % (w, h, 10 if w > 60 else 8, lighten(c,.34), c, 6 if w > 60 else 4, fs, abbr)

def game_panel(color, abbr, name, date, rows, pages=1, shelf=None):
    """游戏形态 panel。shelf = (运行天数, 已解锁, 总数) 时加封盘标注（07 §4.9）。"""
    tag = ('<span style="font-size:11px;line-height:1.5;color:var(--text-3);">封盘</span>') if shelf else ''
    # 07 §4.9 原写「日期行右侧补依据」，320 宽下与日期同排放不下（实测 207px > 右栏 184px），
    # 改为日期下方独立一行，其余取值不变。
    basis = ('<div class="mono" style="font-size:11px;color:var(--text-3);">运行 %d 天 &#183; 成就 %d/%d</div>'
             % shelf) if shelf else ''
    return (
      '<div style="display:flex;flex-direction:column;">%s%s</div>'
      '<div style="flex:1 1 auto;display:flex;flex-direction:column;gap:10px;padding-top:2px;">'
        '<div style="display:flex;flex-direction:column;gap:3px;">'
          '<div style="display:flex;align-items:baseline;gap:6px;">'
            '<div style="font-size:13.5px;font-weight:500;line-height:1.5;">%s</div>%s</div>'
          '<div class="mono" style="font-size:11px;color:var(--text-3);">%s</div>%s'
        '</div>'
        '<div style="height:1px;background:var(--divider);"></div>'
        '<div style="display:flex;flex-direction:column;gap:8px;">%s</div>'
      '</div>'
    ) % (cover(color, abbr, COVER_W, 144), dots(pages, 0), name, tag, date, basis,
         ''.join(prow(*r) for r in rows))

GAME_H = 186          # 14 + 封面 144 + 8 + 圆点 6 + 14

# ---- 形态一：游戏（月档，Stardew Valley，3 款分页）----
_c = TH["SV"]
hover_ev = assign_stems([dict(e) for e in main_ev])
_sv = next(e for e in hover_ev if e["x"] == 700)
panel = place(700, _sv["stem"], group_w(_sv),
              game_panel(_c, "SV", "Stardew Valley", "2026-07-06",
                         [("play", _c, None, "09:12"), ("key", _c, 6, "13:40")], pages=3),
              GAME_H)
io.open(str(HERE / "HoverPanel.dc.html"),"w",encoding="utf-8").write(
    build("2026.07","月",main_ticks,[(150,600,"APR &#8212; JUN")],main_ev,edge=True,extra=panel))

# ---- 形态一·封盘（D-16）：月档 x=880 的 Hades 成就簇 ----
_h = TH["HAD"]
_hd = next(e for e in hover_ev if e["x"] == 880)
shelved_panel = place(880, _hd["stem"], group_w(_hd),
                      game_panel(_h, "HAD", "Hades", "2026-07-28",
                                 [("key", _h, 12, "22:06")], pages=1, shelf=(63, 38, 50)),
                      GAME_H)
io.open(str(HERE / "ShelvedPanel.dc.html"),"w",encoding="utf-8").write(
    build("2026.07","月",main_ticks,[(150,600,"APR &#8212; JUN")],main_ev,edge=True,extra=shelved_panel))

# ---- 形态二：成就簇（日档）----
# 行数上限实算：markTop(64) = 384，头部下沿 96 → 可用 288；panel 需 H + 18。
# 4 行（46x69 头部）= 296 → 314 > 288 放不下；3 行 + "+N" = 269 → 287 恰好容下。
ACH_X = 860
ACHS = [("初次登顶","42.8%"), ("无死亡通关","11.3%"), ("集齐草莓","3.9%")]
ACH_ROWS_MAX = 3
ACH_H = 14 + 69 + 10 + 1 + 10 + (ACH_ROWS_MAX*40 + (ACH_ROWS_MAX-1)*6) + 6 + 13 + 14   # = 269
_a = TH["CEL"]

def arow(name, pct):
    return ('<div style="height:40px;display:flex;align-items:center;gap:10px;">'
            '<div style="width:32px;height:32px;flex:0 0 32px;border-radius:6px;'
            'background:linear-gradient(150deg,%s,%s);box-shadow:inset 0 0 0 .5px rgba(15,23,42,.14);"></div>'
            '<div style="flex:1 1 auto;font-size:13.5px;font-weight:500;line-height:1.5;white-space:nowrap;'
            'overflow:hidden;text-overflow:ellipsis;">%s</div>'
            '<div class="mono" style="font-size:11px;color:var(--text-3);">%s</div></div>'
            ) % (lighten(_a,.30), _a, name, pct)

ach_inner = (
  '<div style="flex:1 1 auto;display:flex;flex-direction:column;gap:10px;">'
    '<div style="display:flex;align-items:center;gap:10px;height:69px;">%s'
      '<div style="display:flex;flex-direction:column;gap:3px;">'
        '<div style="font-size:13.5px;font-weight:500;line-height:1.5;">Celeste</div>'
        '<div class="mono" style="font-size:11px;color:var(--text-3);">2026-08-26</div>'
      '</div>'
      '<div style="flex:1 1 auto;"></div>'
      '<div style="display:flex;align-items:center;gap:3px;color:%s;">%s'
        '<span class="mono" style="font-size:9px;color:%s;">&#215;5</span></div>'
    '</div>'
    '<div style="height:1px;background:var(--divider);"></div>'
    '<div style="display:flex;flex-direction:column;gap:6px;">%s'
      '<div class="mono" style="font-size:9px;color:var(--text-3);align-self:flex-end;">+2</div>'
    '</div>'
  '</div>'
) % (cover(_a,"CEL",46,69,11), _a, svg("key"), _a, ''.join(arow(*a) for a in ACHS))

day_stems = assign_stems([dict(e) for e in day_ev])
_ce = next(e for e in day_stems if e["x"] == ACH_X)
ach_panel = place(ACH_X, _ce["stem"], group_w(_ce), ach_inner, ACH_H)
io.open(str(HERE / "AchievePanel.dc.html"),"w",encoding="utf-8").write(
    build("08.25","日",day_ticks,[(300,620,"AUG 22 &#8212; AUG 24")],day_ev,extra=ach_panel))

# ---------- D-17：全屏替换页（设置 / 首启 / 同步）----------
COL_W = 640
def page(inner):
    return HEAD + ('<div style="position:relative;width:1440px;height:900px;overflow:hidden;">%s</div>'
                   % inner) + TAIL

def col(top, blocks):
    return ('<div style="position:absolute;left:%dpx;top:%dpx;width:%dpx;display:flex;'
            'flex-direction:column;gap:26px;">%s</div>') % ((W-COL_W)//2, top, COL_W, ''.join(blocks))

def grp(label, rows):
    return ('<div style="display:flex;flex-direction:column;gap:8px;">'
            '<div class="label" style="padding-left:4px;">%s</div>'
            '<div style="display:flex;flex-direction:column;gap:8px;">%s</div></div>') % (label, ''.join(rows))

def row(main, sub, right):
    subhtml = '<div class="mono" style="font-size:11px;color:var(--text-3);">%s</div>' % sub if sub else ''
    return ('<div style="min-height:58px;border-radius:18px;background:rgba(255,255,255,.24);'
            'border:1px solid rgba(15,23,42,.06);padding:0 16px;display:flex;align-items:center;gap:14px;">'
            '<div style="flex:1 1 auto;display:flex;flex-direction:column;gap:3px;">'
            '<div style="font-size:13.5px;font-weight:500;line-height:1.5;">%s</div>%s</div>%s</div>'
            ) % (main, subhtml, right)

def btn2(text):
    return ('<div class="iconbtn" style="width:auto;height:30px;border-radius:999px;padding:0 14px;'
            'font-size:13.5px;font-weight:500;color:var(--text-1);">%s</div>') % text

def btn1(text, icon=None):
    ic = ('<span style="display:flex;color:var(--accent-ink);">%s</span>' % svg(icon,16)) if icon else ''
    return ('<div style="height:44px;border-radius:999px;padding:0 22px;background:var(--accent);'
            'color:var(--accent-ink);font-size:13.5px;font-weight:500;display:flex;align-items:center;'
            'gap:8px;box-shadow:0 6px 20px rgba(47,107,255,.30),inset 0 1px 0 rgba(255,255,255,.40);">'
            '%s%s</div>') % (ic, text)

def toggle(on=True):
    return ('<div style="width:44px;height:26px;flex:0 0 44px;border-radius:999px;position:relative;'
            'background:%s;"><div style="position:absolute;top:3px;left:%dpx;width:20px;height:20px;'
            'border-radius:50%%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.25);"></div></div>'
            ) % ('#0E9E68' if on else 'rgba(15,23,42,.16)', 21 if on else 3)

CHEV = '<div style="color:var(--text-3);display:flex;">%s</div>' % svg("chevR",16)
MONO = lambda t: '<div class="mono" style="font-size:11px;color:var(--text-3);">%s</div>' % t

def topbar(title, back=True):
    b = ('<div class="iconbtn">%s</div>' % svg("chevL",14)) if back else ''
    return ('<div style="position:absolute;left:40px;top:0;height:96px;display:flex;align-items:center;'
            'gap:14px;">%s<div style="font-size:16px;font-weight:500;line-height:1.4;">%s</div></div>'
            ) % (b, title)

AVATAR = ('<div style="width:44px;height:44px;flex:0 0 44px;border-radius:14px;'
          'background:rgba(15,23,42,.06);box-shadow:inset 0 0 0 .5px rgba(15,23,42,.10);"></div>')

settings = topbar("设置") + col(136, [
  grp("ACCOUNT", [
    ('<div style="min-height:76px;border-radius:18px;background:rgba(255,255,255,.24);'
     'border:1px solid rgba(15,23,42,.06);padding:0 16px;display:flex;align-items:center;gap:14px;">'
     '%s<div style="flex:1 1 auto;display:flex;flex-direction:column;gap:3px;">'
     '<div style="font-size:13.5px;font-weight:500;line-height:1.5;">已连接 Steam</div>'
     '<div class="mono" style="font-size:11px;color:var(--text-3);">76561198&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;42 &#183; 537 GAMES</div>'
     '</div>%s</div>') % (AVATAR, btn2("退出登录")),
  ]),
  grp("SYNC", [
    row("立即同步", "LAST SYNC 2026-08-27 09:12", btn1("同步")),
    row("启动时自动同步", None, toggle(True)),
  ]),
  grp("DATA", [
    row("隐藏从未启动的游戏", None,
        '<div style="display:flex;align-items:center;gap:12px;">%s%s</div>' % (MONO("128"), toggle(True))),
    row("导出 JSON 备份", "SQLITE &#183; 18.4 MB", CHEV),
    row("打开数据目录", None, CHEV),
  ]),
])
io.open(str(HERE / "Settings.dc.html"),"w",encoding="utf-8").write(page(settings))

def hero(body):
    return ('<div style="position:absolute;left:%dpx;top:300px;width:%dpx;display:flex;'
            'flex-direction:column;gap:22px;">'
            '<div class="num" style="font-size:54px;line-height:.92;font-weight:600;letter-spacing:-.02em;">'
            'GAME_C</div>%s</div>') % ((W-COL_W)//2, COL_W, body)

firstrun = hero(
  '<div style="font-size:13.5px;font-weight:500;line-height:1.8;color:var(--text-2);max-width:520px;">'
  '登录 Steam 后，购买、首次启动、成就解锁与当时的截图会落在同一条时间轴上。数据留在本机。</div>'
  '<div style="display:flex;align-items:center;gap:12px;">%s%s</div>' % (btn1("登录 Steam"), btn2("导入本地备份")))
io.open(str(HERE / "FirstRun.dc.html"),"w",encoding="utf-8").write(page(firstrun))

STAGES = [("OWNED", 0), ("WISHLIST", 0), ("PLAY_DAYS", 0), ("SCREENSHOTS", 1), ("ACHIEVEMENTS", 2)]
stage_html = ''.join(
  '<div class="label" style="color:%s;">%s</div>'
  % ('var(--text-1)' if st == 1 else ('var(--text-3)' if st == 0 else 'rgba(23,32,46,.30)'), n)
  for n, st in STAGES)

syncing = hero(
  '<div style="display:flex;flex-direction:column;gap:12px;">'
    '<div style="display:flex;align-items:center;gap:10px;">'
      '<div style="flex:1 1 auto;font-size:13.5px;font-weight:500;line-height:1.5;">正在拉取游戏截图</div>'
      '<div class="mono" style="font-size:11px;color:var(--text-3);">312 / 537</div></div>'
    '<div style="height:5px;border-radius:999px;background:rgba(15,23,42,.10);overflow:hidden;">'
      '<div style="width:58%%;height:5px;border-radius:999px;background:var(--accent);"></div></div>'
    '<div style="display:flex;gap:16px;">%s</div>'
  '</div>' % stage_html)
io.open(str(HERE / "Syncing.dc.html"),"w",encoding="utf-8").write(page(syncing))

# ---------- canvas.json ----------
def ab(f,x,y,t): return {"file":f,"x":x,"y":y,"w":W,"h":H,"title":t}
canvas = {
 "artboards":[
   ab("Main.dc.html",0,0,"主视图 · 月档（默认）"),
   ab("Week.dc.html",1560,0,"主视图 · 周档"),
   ab("Day.dc.html",0,1080,"主视图 · 日档"),
   ab("HoverPanel.dc.html",1560,1080,"悬浮 panel · 游戏形态（月档）"),
   ab("AchievePanel.dc.html",0,2160,"悬浮 panel · 成就形态（日档）"),
   ab("ShelvedPanel.dc.html",1560,2160,"悬浮 panel · 封盘标注（月档）"),
   ab("Settings.dc.html",0,3240,"设置"),
   ab("FirstRun.dc.html",1560,3240,"首启 · 登录引导"),
   ab("Syncing.dc.html",0,4320,"首启 · 同步进度态"),
 ],
 "annotations":[
   {"id":"note-scale","x":0,"y":-150,"w":700,
    "text":"变化坐标（07 §4.3）：左段按月/周压缩，画成轴上的斜纹带；右段展开到周/日。\n分界处这稿取「渐变」（斜纹向密集侧渐隐）—— PRD §8 未决 #3 的两个选项之一，另一个是跳变。"},
   {"id":"note-stem","x":1560,"y":-150,"w":700,
    "text":"引线高度（D-3 已定，写进 build_timeline.py::assign_stems）：\n默认恒为 64；只有相邻组的命中区（组宽 + 16）水平重叠时，右侧组才逐级抬高一档，步进 40（标记块高 32 + 呼吸 8），上限 4 档 = 64/104/144/184。\n本三档数据下无一组冲突，故全部落在 64 —— 原稿 64~212 的手工差值是装饰，不是规则。"},
   {"id":"note-panel","x":0,"y":2030,"w":700,
    "text":"悬浮 panel 两种形态（07 §4.8）：\n· 游戏形态 —— 封面 96×144，多款游戏时封面下出圆点分页；panel 里不放截图。封盘时游戏名右侧加「封盘」文字标，判定依据「运行 N 天 · 成就 x/y」320 宽下与日期同排放不下，改为日期下方独立一行。\n· 成就形态 —— 头部封面 46×69（D-12）。行数上限实算为 3 行：标记顶 384 − 头部下沿 96 = 288 可用，4 行 panel 需 314 放不下，3 行 + 「+N」= 269 恰好容下。panel 顶部另设 104 收敛下限。"},
   {"id":"note-pages","x":1560,"y":3110,"w":700,
    "text":"全屏替换页（05 §8）。设置只有三组：账号 / 同步 / 数据；数据组第一行就是「隐藏从未启动的游戏」开关，右侧只给受影响款数。封盘三阈值 V0.1 不出现在设置里（写死）。\n首启分登录引导与同步进度两态；中文没有对应字号 token，标题用产品名走 display/month（Space Grotesk 54），不新增字号。"},
 ],
 "launch":{"view":"canvas"}
}
io.open(str(HERE / "canvas.json"),"w",encoding="utf-8").write(json.dumps(canvas,ensure_ascii=False,indent=2))
print("done")
