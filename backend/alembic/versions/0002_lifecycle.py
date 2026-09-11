"""game lifecycle fields (PRD §3 P-13/P-14)

Revision ID: 0002_lifecycle
Revises: 0001_initial
Create Date: 2026-09-02

新增游戏生命状态派生字段与成就回填游标：

- ``games.playtime_forever`` / ``rtime_last_played`` —— 封盘判定的两个上游输入（GetOwnedGames）；
- ``games.last_active_at`` / ``launched_ever`` / ``lifecycle`` / ``shelved_at`` / ``lifecycle_at``
  —— 每次采集收尾重算（幂等，见 ``app/services/lifecycle.py``）；
- ``games.ach_total`` —— 成就总数（GetSchemaForGame），判定 ``ach_unlocked / ach_total >= T_ach`` 用；
- ``games.achievements_at`` —— 该游戏最近一次成就回填时间，成就增量 + 分批的判据；
- ``sync_state.lifecycle_at`` —— 最近一次重算时间。

历史行的默认值：``lifecycle`` 一律先写 ``never_launched``，下一轮同步收尾会按真实
``last_active_at`` 重算——判定无状态、不读旧值，所以初值不影响最终结果。
"""
import sqlalchemy as sa
from alembic import op

revision = "0002_lifecycle"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("games") as batch:
        batch.add_column(
            sa.Column("playtime_forever", sa.Integer(), nullable=False, server_default="0")
        )
        batch.add_column(sa.Column("rtime_last_played", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("last_active_at", sa.DateTime(), nullable=True))
        batch.add_column(
            sa.Column("launched_ever", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch.add_column(
            sa.Column(
                "lifecycle", sa.String(16), nullable=False, server_default="never_launched"
            )
        )
        batch.add_column(sa.Column("shelved_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("lifecycle_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("ach_total", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("achievements_at", sa.DateTime(), nullable=True))

    # 「隐藏从未启动」开关与封盘帽都按 lifecycle 过滤，建索引避免全表扫。
    op.create_index("ix_games_user_lifecycle", "games", ["user_id", "lifecycle"])

    with op.batch_alter_table("sync_state") as batch:
        batch.add_column(sa.Column("lifecycle_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("sync_state") as batch:
        batch.drop_column("lifecycle_at")

    op.drop_index("ix_games_user_lifecycle", table_name="games")

    with op.batch_alter_table("games") as batch:
        for col in (
            "achievements_at",
            "ach_total",
            "lifecycle_at",
            "shelved_at",
            "lifecycle",
            "launched_ever",
            "last_active_at",
            "rtime_last_played",
            "playtime_forever",
        ):
            batch.drop_column(col)
