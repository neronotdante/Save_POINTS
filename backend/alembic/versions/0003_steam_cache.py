"""steam public-data cache

Revision ID: 0003_steam_cache
Revises: 0002_lifecycle
Create Date: 2026-09-04

公共上游数据的本地缓存（成就 schema / 全球解锁率 / 商店元数据）。
这些与用户无关的响应占一轮同步 65% 的请求量，首轮还要再加约 300 次 appdetails。
"""
import sqlalchemy as sa
from alembic import op

revision = "0003_steam_cache"
down_revision = "0002_lifecycle"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "steam_cache",
        sa.Column("kind", sa.String(32), primary_key=True),
        sa.Column("cache_key", sa.String(128), primary_key=True),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_steam_cache_fetched", "steam_cache", ["kind", "fetched_at"])


def downgrade() -> None:
    op.drop_index("ix_steam_cache_fetched", table_name="steam_cache")
    op.drop_table("steam_cache")
