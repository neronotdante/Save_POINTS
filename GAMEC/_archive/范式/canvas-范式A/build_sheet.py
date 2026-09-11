# -*- coding: utf-8 -*-
import io
src = io.open("/home/claude/gamec-canvas/Main.dc.html", encoding="utf-8").read()
MARK = '<div style="position:absolute;left:0;right:0;bottom:0;height:44px'
assert MARK in src

T1="#17202E"; T2="rgba(23,32,46,.62)"; T3="rgba(23,32,46,.46)"
EV_BUY="#0E9E68"; EV_FIRST="#C77700"
SILK="#238A79"; ELDEN="#B0761A"

def dot(c):
    return ('<span style="width:6px;height:6px;border-radius:999px;background:%s;flex:none;'
            'box-shadow:inset 0 0 0 .5px rgba(15,23,42,.14)"></span>') % c

def cover(c1, c2, txt):
    return ('<div style="width:46px;height:62px;border-radius:10px;flex:none;'
            'background:linear-gradient(150deg,%s,%s);display:flex;align-items:flex-end;'
            'justify-content:center;padding-bottom:6px;box-sizing:border-box">'
            '<span class="grot" style="font-size:12px;font-weight:600;color:rgba(255,255,255,.92)">%s</span></div>'
            ) % (c1, c2, txt)

def row(cov, name, mark, stamp):
    return ('<div style="display:flex;align-items:center;gap:12px;height:62px;padding:0 12px;'
            'box-sizing:border-box;border-radius:18px;background:rgba(255,255,255,.55);'
            'box-shadow:inset 0 0 0 1px rgba(15,23,42,.06)">'
            '%s<div style="display:flex;align-items:center;gap:8px;flex-grow:1;min-width:0">%s'
            '<span style="font-size:13.5px;font-weight:500;color:%s;white-space:nowrap;overflow:hidden;'
            'text-overflow:ellipsis">%s</span></div>'
            '<span class="mono" style="font-size:11px;color:%s;flex:none">%s</span></div>'
            ) % (cov, mark, T1, name, T3, stamp)

def metric(num, label):
    return ('<div style="width:56px;display:flex;flex-direction:column;align-items:flex-end;gap:2px">'
            '<span class="mono" style="font-size:20px;line-height:1;font-weight:500;color:%s">%s</span>'
            '<span style="font-size:11px;line-height:1.5;color:%s;white-space:nowrap">%s</span></div>'
            ) % (T1, num, T2, label)

rows_html = "".join([
    row(cover("#238A79","#0E4F45","SS"), "空洞骑士：丝之歌",
        '<span style="display:flex;align-items:center;gap:4px;flex:none">%s<span class="mono" '
        'style="font-size:9px;color:%s">&times;12</span></span>' % (dot(SILK), SILK), "22:41"),
    row(cover("#B0761A","#6B4406","ER"), "艾尔登法环",
        '<span style="display:flex;align-items:center;gap:4px;flex:none">%s<span class="mono" '
        'style="font-size:9px;color:%s">&times;6</span></span>' % (dot(ELDEN), ELDEN), "20:03"),
    row(cover("#2E6BB8","#16406F","OW"), "星际拓荒", dot(EV_FIRST), "19:12"),
    row(cover("#A8452F","#5F2418","SG"), "SIGNALIS", dot(EV_BUY), "14:20"),
])

sheet = (
 '<div style="position:absolute;left:96px;top:56px;width:668px;height:768px;border-radius:26px;'
 'background:rgba(15,23,42,.18)"></div>'
 '<div style="position:absolute;left:96px;top:404px;width:668px;height:420px;'
 'border-radius:30px 30px 26px 26px;box-sizing:border-box;padding:20px 20px 16px;'
 'background:linear-gradient(160deg, rgba(255,255,255,.88), rgba(255,255,255,.70));'
 '-webkit-backdrop-filter:blur(44px) saturate(180%%);backdrop-filter:blur(44px) saturate(180%%);'
 'box-shadow:0 0 0 1px rgba(15,23,42,.12), 0 -10px 50px rgba(15,23,42,.22), '
 'inset 0 1px 0 rgba(255,255,255,.92), inset 0 -1px 0 rgba(15,23,42,.06);'
 'display:flex;flex-direction:column">'
   '<div style="display:flex;align-items:flex-start;justify-content:space-between;height:96px;flex:none">'
     '<div style="display:flex;flex-direction:column;gap:4px">'
       '<span class="grot" style="font-size:40px;line-height:1;font-weight:600;color:%s">22</span>'
       '<span style="font-size:11px;color:%s">星期六 · 2026 年 8 月</span>'
     '</div>'
     '<div style="display:flex;align-items:flex-start;gap:20px">%s%s</div>'
   '</div>'
   '<div style="display:flex;flex-direction:column;gap:8px">%s</div>'
 '</div>'
) % (T1, T2, metric("18","成就解锁"), metric("1","首次启动"), rows_html)

out = src.replace(MARK, sheet + MARK, 1)
io.open("/home/claude/gamec-canvas/DaySheet.dc.html","w",encoding="utf-8").write(out)
print("ok")
