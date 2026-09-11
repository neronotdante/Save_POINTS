"""数据库引擎与会话工厂。

采用**同步** SQLAlchemy 2.0：FastAPI 的 ``def`` 端点自动在线程池中执行，
SQLite 走标准库 ``sqlite3``（零额外驱动）、PostgreSQL 走 ``psycopg``，均可稳定运行。
"""
from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import MetaData, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

# 统一约束 / 索引命名，便于 Alembic 迁移可预期。
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)


# SQLite 需要 check_same_thread=False 以支持多线程（调度器线程）访问。
_connect_args = {"check_same_thread": False} if settings.is_sqlite else {}

engine = create_engine(
    settings.database_url,
    echo=settings.debug,
    pool_pre_ping=True,
    connect_args=_connect_args,
)

if settings.is_sqlite:

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):  # pragma: no cover - 连接期副作用
        """SQLite 并发设置：没有这两条，一轮同步就能把整个后端顶成 500。

        同步是个长时间、高频写入的过程（首次同步几十分钟），而 SQLite 默认的 rollback
        journal 模式下写事务**完全排他**：同步期间前端拉 ``/calendar/timeline``、
        甚至认证时更新 ``auth_tokens.last_used_at``，都会撞上
        ``database is locked`` 直接 500。

        - ``WAL``：读写并发，读不再被写阻塞（同步进行中前端照样能看数据）；
        - ``busy_timeout``：撞锁时等待重试而不是立刻抛错（默认是 0，即立刻失败）。
        """
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=15000")
        cur.execute("PRAGMA synchronous=NORMAL")  # WAL 下的推荐档位，安全且明显更快
        cur.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    """FastAPI 依赖：请求级会话，结束后自动关闭。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
