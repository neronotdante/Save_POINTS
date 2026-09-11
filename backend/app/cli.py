"""运维命令行入口（不走 HTTP，直连数据库）。

- ``game-calendar-recompute`` —— 阈值改动后一次性重算全库生命状态（本文档 §5 要求
  「阈值是服务端常量，改动要能一次性重算全库」）。重算幂等且无状态，重复跑安全。
- ``game-calendar-bind-apikey`` —— 给用户绑定 Steam Web API Key。本地自用时省掉
  「先登录拿 token 再 POST /auth/apikey」那一圈；Key 从终端隐式读入（不回显、不进
  shell 历史、不落日志），校验通过后 Fernet 加密写 ``users.apikey_enc``。

用法::

    game-calendar-recompute            # 重算全部用户
    game-calendar-recompute 7656119…   # 只重算指定 SteamID

    game-calendar-bind-apikey          # 库里只有一个用户时自动选中
    game-calendar-bind-apikey 7656119… # 指定 SteamID
"""
from __future__ import annotations

import logging
import sys

from sqlalchemy import select

from app.config import settings
from app.core.security import encrypt_apikey, key_source
from app.database import SessionLocal
from app.models.user import User
from app.services.lifecycle import recompute_all_lifecycle, recompute_user_lifecycle


def recompute_lifecycle_cli() -> int:
    """控制台入口：``game-calendar-recompute [steamid ...]``。"""
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    steamids = sys.argv[1:]
    db = SessionLocal()
    try:
        if steamids:
            changed = sum(recompute_user_lifecycle(db, uid) for uid in steamids)
            print(f"重算 {len(steamids)} 个用户，{changed} 条生命状态变化")
        else:
            changed = recompute_all_lifecycle(db)
            print(f"全库重算完成，{changed} 条生命状态变化")
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    return 0


def bind_apikey_cli() -> int:
    """控制台入口：``game-calendar-bind-apikey [steamid]``。

    Key 用 ``getpass`` 读入——**不回显、不作为命令行参数**（否则会进 shell 历史与进程列表）。
    写库前先打一次 ``GetPlayerSummaries`` 验证：Key 无效时直接失败，不留一个能过接口
    校验、却在每日采集里才炸的坏 Key。
    """
    import getpass

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    db = SessionLocal()
    try:
        steamid = sys.argv[1] if len(sys.argv) > 1 else None
        if steamid is None:
            users = db.scalars(select(User)).all()
            if len(users) == 1:
                steamid = users[0].steamid
                print(f"库中唯一用户：{steamid}")
            elif not users:
                print("库中没有用户。请先登录一次（浏览器打开 /auth/steam/openid/login）。")
                return 1
            else:
                print("库中有多个用户，请指定 SteamID：")
                for u in users:
                    print(f"  {u.steamid}  {u.nickname or ''}  已绑Key={bool(u.apikey_enc)}")
                return 1

        user = db.get(User, steamid)
        if user is None:
            print(f"用户 {steamid} 不在库中。请先用该账号登录一次。")
            return 1
        if user.apikey_enc:
            if input("该用户已绑定 Key，覆盖？[y/N] ").strip().lower() != "y":
                print("已取消。")
                return 0

        print("在 https://steamcommunity.com/dev/apikey 申请，粘贴后回车（输入不回显）：")
        apikey = getpass.getpass("API Key: ").strip()
        if not apikey:
            print("未输入，已取消。")
            return 1

        # 写库前先验一次：拿自己的 player summary 是最轻的一次调用
        from app.services.steam import SteamError, get_steam_client

        try:
            summary = get_steam_client().get_player_summaries(apikey, steamid)
        except SteamError as exc:
            print(f"Key 校验失败（未写库）：{exc}")
            return 1
        if not summary:
            print("Key 校验失败：Steam 未返回该 SteamID 的资料（未写库）。")
            return 1

        user.apikey_enc = encrypt_apikey(apikey)
        user.nickname = summary.get("personaname") or user.nickname
        user.avatar = summary.get("avatarfull") or user.avatar
        db.commit()
        print(f"已绑定并加密入库：{user.nickname or steamid}")
        print(f"提示：Key 用「{key_source()}」加密——换了密钥就解不开已存的 Key，备份库时一起备份。")
        return 0
    except (KeyboardInterrupt, EOFError):
        db.rollback()
        print()
        print("已取消。")
        return 130
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(recompute_lifecycle_cli())
