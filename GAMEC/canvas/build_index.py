#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_index.py —— 由 canvas.json + *.dc.html 生成本地画布全景页 index.html。

用法：在 GAMEC/canvas/ 目录下执行
    python build_index.py

产物 index.html 是自包含的单文件（画板内容以 srcdoc 内嵌），
双击即可在浏览器打开，不联网、不发布。
每次改完画板重跑一次即可。
"""

import html
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent


def esc_attr(s: str) -> str:
    return html.escape(s, quote=True)


def build(root: pathlib.Path) -> str:
    cfg = json.loads((root / "canvas.json").read_text(encoding="utf-8"))
    boards = cfg.get("artboards", [])
    notes = cfg.get("annotations", [])

    # 画布外接矩形（含批注），留出上下左右边距
    xs, ys, xe, ye = [], [], [], []
    for b in boards:
        xs.append(b["x"]); ys.append(b["y"])
        xe.append(b["x"] + b["w"]); ye.append(b["y"] + b["h"])
    for n in notes:
        xs.append(n["x"]); ys.append(n["y"])
        xe.append(n["x"] + n.get("w", 300)); ye.append(n["y"] + 160)
    min_x, min_y = min(xs) - 80, min(ys) - 80
    max_x, max_y = max(xe) + 80, max(ye) + 80
    world_w, world_h = max_x - min_x, max_y - min_y

    parts = []
    for i, b in enumerate(boards):
        src = root / b["file"]
        if not src.exists():
            print(f"  ! 缺少画板文件：{b['file']}", file=sys.stderr)
            continue
        doc = src.read_text(encoding="utf-8")
        parts.append(
            f'''<div class="board" style="left:{b["x"] - min_x}px;top:{b["y"] - min_y}px;'''
            f'''width:{b["w"]}px;height:{b["h"]}px">
  <div class="board-label">{html.escape(b.get("title", b["file"]))}'''
            f'''<span class="board-file">{html.escape(b["file"])}</span></div>
  <iframe loading="lazy" sandbox="allow-same-origin" srcdoc="{esc_attr(doc)}"></iframe>
</div>'''
        )

    for n in notes:
        body = "".join(
            f"<p>{html.escape(line)}</p>" for line in n["text"].split("\n") if line.strip()
        )
        parts.append(
            f'''<div class="note" style="left:{n["x"] - min_x}px;top:{n["y"] - min_y}px;'''
            f'''width:{n.get("w", 300)}px">{body}</div>'''
        )

    boards_nav = "".join(
        f'<button data-i="{i}">{html.escape(b.get("title", b["file"]))}</button>'
        for i, b in enumerate(boards)
    )
    boards_meta = json.dumps(
        [
            {"x": b["x"] - min_x, "y": b["y"] - min_y, "w": b["w"], "h": b["h"]}
            for b in boards
        ],
        ensure_ascii=False,
    )

    return TEMPLATE.format(
        world_w=world_w,
        world_h=world_h,
        content="\n".join(parts),
        nav=boards_nav,
        meta=boards_meta,
    )


TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>游戏日历 · 设计画布（本地）</title>
<style>
  * {{ box-sizing: border-box; }}
  html, body {{ height: 100%; margin: 0; }}
  body {{
    background: #eceef1;
    font: 13px/1.5 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
    color: #2b2f36;
    overflow: hidden;
  }}
  #stage {{ position: absolute; inset: 0; cursor: grab; overflow: hidden; }}
  #stage.dragging {{ cursor: grabbing; }}
  #world {{
    position: absolute; top: 0; left: 0;
    width: {world_w}px; height: {world_h}px;
    transform-origin: 0 0;
  }}
  .board {{ position: absolute; }}
  .board-label {{
    position: absolute; top: -30px; left: 2px;
    font-size: 15px; font-weight: 600; color: #3c424b;
    white-space: nowrap;
  }}
  .board-file {{
    margin-left: 10px; font-size: 12px; font-weight: 400; color: #99a0aa;
  }}
  .board iframe {{
    width: 100%; height: 100%;
    border: 0; border-radius: 12px;
    background: #fff;
    box-shadow: 0 2px 6px rgba(20,26,38,.06), 0 14px 40px rgba(20,26,38,.10);
  }}
  .note {{
    position: absolute;
    background: #fffbe6;
    border: 1px solid #f0e3ad;
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 13px; line-height: 1.7; color: #6a5c2a;
    box-shadow: 0 4px 14px rgba(120,100,30,.10);
  }}
  .note p {{ margin: 0 0 4px; }}
  .note p:last-child {{ margin-bottom: 0; }}
  #bar {{
    position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
    display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
    justify-content: center; max-width: calc(100vw - 40px);
    background: rgba(255,255,255,.86);
    backdrop-filter: blur(14px) saturate(1.4);
    border: 1px solid rgba(255,255,255,.7);
    border-radius: 14px; padding: 8px 10px;
    box-shadow: 0 8px 30px rgba(20,26,38,.16);
    z-index: 10;
  }}
  #bar button {{
    border: 1px solid #dfe3e9; background: #fff; color: #3c424b;
    border-radius: 8px; padding: 5px 10px; font: inherit; cursor: pointer;
  }}
  #bar button:hover {{ background: #f4f6f9; }}
  #bar .sep {{ width: 1px; height: 20px; background: #dfe3e9; margin: 0 4px; }}
  #zoom {{ min-width: 48px; text-align: center; color: #7a828d; font-variant-numeric: tabular-nums; }}
  #tip {{
    position: fixed; left: 16px; top: 14px; color: #8b929c; font-size: 12px; z-index: 10;
  }}
</style>
</head>
<body>
<div id="tip">拖拽平移 · 滚轮缩放 · 双击适应窗口</div>
<div id="stage"><div id="world">
{content}
</div></div>
<div id="bar">
  <button id="fit">适应窗口</button><button id="reset">100%</button>
  <span id="zoom">100%</span><span class="sep"></span>{nav}
</div>
<script>
const boards = {meta};
const stage = document.getElementById('stage');
const world = document.getElementById('world');
const zoomLabel = document.getElementById('zoom');
const W = {world_w}, H = {world_h};
let scale = 1, tx = 0, ty = 0;

function apply() {{
  world.style.transform = `translate(${{tx}}px, ${{ty}}px) scale(${{scale}})`;
  zoomLabel.textContent = Math.round(scale * 100) + '%';
}}
function fit() {{
  const padX = 60, padTop = 50, padBottom = 130;   // 底部给工具条留位
  scale = Math.min((innerWidth - padX * 2) / W, (innerHeight - padTop - padBottom) / H);
  tx = (innerWidth - W * scale) / 2;
  ty = padTop + (innerHeight - padTop - padBottom - H * scale) / 2;
  apply();
}}
function focusBoard(i) {{
  const b = boards[i]; if (!b) return;
  const pad = 90;
  scale = Math.min((innerWidth - pad * 2) / b.w, (innerHeight - pad * 2) / b.h, 1.4);
  tx = innerWidth / 2 - (b.x + b.w / 2) * scale;
  ty = innerHeight / 2 - (b.y + b.h / 2) * scale;
  apply();
}}
stage.addEventListener('wheel', e => {{
  e.preventDefault();
  const k = Math.exp(-e.deltaY * 0.0016);
  const next = Math.min(3, Math.max(0.06, scale * k));
  tx = e.clientX - (e.clientX - tx) * (next / scale);
  ty = e.clientY - (e.clientY - ty) * (next / scale);
  scale = next; apply();
}}, {{ passive: false }});
let drag = null;
stage.addEventListener('pointerdown', e => {{
  drag = {{ x: e.clientX - tx, y: e.clientY - ty }};
  stage.classList.add('dragging'); stage.setPointerCapture(e.pointerId);
}});
stage.addEventListener('pointermove', e => {{
  if (!drag) return;
  tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply();
}});
stage.addEventListener('pointerup', () => {{ drag = null; stage.classList.remove('dragging'); }});
stage.addEventListener('dblclick', fit);
document.getElementById('fit').onclick = fit;
document.getElementById('reset').onclick = () => {{ scale = 1; tx = 40; ty = 40; apply(); }};
document.querySelectorAll('#bar button[data-i]').forEach(b => {{
  b.onclick = () => focusBoard(+b.dataset.i);
}});
addEventListener('resize', fit);
fit();
</script>
</body>
</html>
"""


if __name__ == "__main__":
    root = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else HERE
    out = root / "index.html"
    out.write_text(build(root), encoding="utf-8")
    print(f"已生成 {out}（{out.stat().st_size / 1024:.0f} KB）")
