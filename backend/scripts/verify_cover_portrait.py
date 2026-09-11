# -*- coding: utf-8 -*-
"""一次性回填：把 CDN 上确实不存在的竖版封面地址清成 NULL。

**为什么需要它。** ``cover_portrait`` 是按 appid 拼出来的模板地址
（``{cdn}/{appid}/library_600x900.jpg``），但并不是每个 app 都上传过 library capsule。
实测本库 348 款里 32 款（9.6%）返回 404，而这 32 款的横版 ``header_image`` **全部可用**
（334/334 全部 200）。

而 CSS ``background-image`` 加载失败是**静默**的：前端只会露出底下那层主题色渐变，
看上去就是「这些游戏没有封面」，实际上有一张好图就在旁边没被用上。清成 NULL 之后，
``lib/cover.js::coverVariants`` 会自动退到横版图，形态（wide）与灯箱比例也跟着对。

``sync_service._resolve_cover_portrait`` 已经改成**存之前先 HEAD**，新同步不会再写死地址；
这个脚本只是把既有数据补齐，免得为此跑一次全量同步。

用法（在 backend/ 下）::

    .venv/Scripts/python.exe scripts/verify_cover_portrait.py          # 只报告，不改库
    .venv/Scripts/python.exe scripts/verify_cover_portrait.py --apply  # 真正写库
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "game_c.db"


def alive(url: str) -> bool:
    """这个地址上真的有东西吗。

    网络异常一律当「存在」——宁可留一个可能挂掉的地址，也不要因为一次超时就把好封面删掉。
    """
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except urllib.error.HTTPError:
        return False
    except Exception:
        return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写库；不带则只报告")
    args = ap.parse_args()

    sys.stdout.reconfigure(encoding="utf-8")
    conn = sqlite3.connect(DB)
    rows = conn.execute(
        "select appid, coalesce(name_zh, name_en, ''), cover_portrait, cover "
        "from games where cover_portrait is not null"
    ).fetchall()
    if not rows:
        print("库里没有带竖版封面的游戏，无事可做")
        return 0

    with cf.ThreadPoolExecutor(24) as ex:
        verdicts = list(ex.map(lambda r: alive(r[2]), rows))
    dead = [r for r, ok in zip(rows, verdicts) if not ok]

    pct = len(dead) / len(rows) * 100
    print(f"检查 {len(rows)} 个竖版封面地址，404 的有 {len(dead)} 个（{pct:.1f}%）")
    print(f"其中横版 header_image 仍可用的：{sum(1 for d in dead if d[3])} / {len(dead)}")
    print()
    for appid, name, _, wide in dead:
        print(f"  {appid:>8}  {name[:38]:<38} 横版={'有' if wide else '无'}")

    if not dead:
        return 0
    if not args.apply:
        print("\n（未写库。确认无误后加 --apply 再跑一次）")
        return 0

    conn.executemany(
        "update games set cover_portrait = null where appid = ?", [(d[0],) for d in dead]
    )
    conn.commit()
    left = conn.execute(
        "select count(*) from games where cover_portrait is not null"
    ).fetchone()[0]
    print(f"\n已清空 {len(dead)} 行；剩余带竖版封面的游戏 {left}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
