"""每日采集定时任务：per user 轮询 GetRecentlyPlayedGames + 成就回填。

约定（后端接口文档 §5）：
- 用各用户 API Key 轮询；单用户失败不影响他人（逐用户 try/except 隔离）。
- 失败重试 + 指数退避（``retry_with_backoff``）。
"""
from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler
from cryptography.fernet import InvalidToken
from sqlalchemy import delete, select

from app.config import settings
from app.core.security import decrypt_apikey
from app.core.timeutil import utcnow
from app.database import SessionLocal
from app.models.user import AuthToken, User
from app.services.sync_service import iter_user_sync, retry_with_backoff

logger = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def _sync_one_user(steamid: str) -> None:
    """同步单个用户；任何失败都隔离在本函数内，不影响其他用户。"""
    try:
        db = SessionLocal()
        try:
            user = db.get(User, steamid)
            if user is None or not user.apikey_enc:
                return
            apikey = decrypt_apikey(user.apikey_enc)
        finally:
            db.close()

        def run() -> None:
            for event in iter_user_sync(steamid, apikey):
                if event.get("step") == "done":
                    logger.info("用户 %s 同步完成: %s", steamid, event)

        retry_with_backoff(run)
    except InvalidToken:
        logger.error("用户 %s 的 API Key 解密失败（密钥不一致），跳过", steamid)
    except Exception:  # noqa: BLE001
        logger.exception("用户 %s 同步失败（已隔离，不影响其他用户）", steamid)


def _daily_collect() -> None:
    """每日采集入口：遍历所有已绑定 Key 的用户。"""
    db = SessionLocal()
    try:
        steamids = db.scalars(select(User.steamid).where(User.apikey_enc.is_not(None))).all()
    finally:
        db.close()

    logger.info("每日采集开始，共 %d 个用户", len(steamids))
    for steamid in steamids:
        _sync_one_user(steamid)
    logger.info("每日采集结束")


def _cleanup_expired_tokens() -> None:
    """定期清理已过期 token（P0-5）。"""
    db = SessionLocal()
    try:
        deleted = db.execute(
            delete(AuthToken).where(
                AuthToken.expires_at.is_not(None),
                AuthToken.expires_at < utcnow(),
            )
        ).rowcount
        if deleted:
            db.commit()
            logger.info("清理过期 token %d 条", deleted)
    finally:
        db.close()


def start_scheduler() -> BackgroundScheduler | None:
    """启动后台调度器；``scheduler_enabled`` 为 False 时返回 None。"""
    global _scheduler
    if not settings.scheduler_enabled:
        logger.info("定时任务已禁用（GC_SCHEDULER_ENABLED=false）")
        return None

    scheduler = BackgroundScheduler(timezone=settings.daily_sync_timezone)
    scheduler.add_job(
        _daily_collect,
        "cron",
        hour=settings.daily_sync_hour,
        minute=settings.daily_sync_minute,
        id="daily_collect",
        replace_existing=True,
        misfire_grace_time=3600,
        coalesce=True,
    )
    # P0-5：过期 token 定期清理（每 6 小时一次）。
    scheduler.add_job(
        _cleanup_expired_tokens,
        "interval",
        hours=6,
        id="cleanup_expired_tokens",
        replace_existing=True,
        coalesce=True,
    )
    scheduler.start()
    _scheduler = scheduler
    logger.info(
        "每日采集定时任务已启动（%02d:%02d %s）",
        settings.daily_sync_hour,
        settings.daily_sync_minute,
        settings.daily_sync_timezone,
    )
    return scheduler


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None


__all__ = ["start_scheduler", "shutdown_scheduler"]
