"""initial schema (explicit)

Revision ID: 0001_initial
Revises:
Create Date: 2026-08-28

显式建表（替换早期的 ``Base.metadata.create_all`` 版）：autogenerate 可据此比对后续差异。
约束 / 索引命名对齐 ``app/database.NAMING_CONVENTION``，避免将来 autogenerate 产生伪差异。
"""
import sqlalchemy as sa
from alembic import op

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("steamid", sa.String(17), primary_key=True),
        sa.Column("nickname", sa.String(255), nullable=True),
        sa.Column("avatar", sa.Text(), nullable=True),
        sa.Column("apikey_enc", sa.Text(), nullable=True),
        sa.Column("session_cookie_enc", sa.Text(), nullable=True),
        sa.Column("refresh_token_enc", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )

    op.create_table(
        "auth_tokens",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("user_id", sa.String(17), sa.ForeignKey("users.steamid", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_auth_tokens_token_hash", "auth_tokens", ["token_hash"], unique=True)
    op.create_index("ix_auth_tokens_user_id", "auth_tokens", ["user_id"])

    op.create_table(
        "games",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(17), sa.ForeignKey("users.steamid", ondelete="CASCADE"), nullable=False),
        sa.Column("appid", sa.Integer(), nullable=False),
        sa.Column("name_zh", sa.String(255), nullable=True),
        sa.Column("name_en", sa.String(255), nullable=True),
        sa.Column("cover", sa.Text(), nullable=True),
        sa.Column("cover_portrait", sa.Text(), nullable=True),
        sa.Column("developer", sa.String(255), nullable=True),
        sa.Column("release_date", sa.Date(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("wishlist_priority", sa.Integer(), nullable=True),
        sa.Column("theme_color", sa.String(7), nullable=True),
        sa.Column("theme_color_source", sa.String(16), nullable=True),
        sa.Column("theme_color_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "appid", name="uq_games_user_appid"),
    )
    op.create_index("ix_games_user_id", "games", ["user_id"])

    op.create_table(
        "play_days",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(17), sa.ForeignKey("users.steamid", ondelete="CASCADE"), nullable=False),
        sa.Column("game_id", sa.Integer(), sa.ForeignKey("games.id", ondelete="CASCADE"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "game_id", "date", name="uq_play_days_user_game_date"),
    )
    op.create_index("ix_play_days_user_id", "play_days", ["user_id"])
    op.create_index("ix_play_days_game_id", "play_days", ["game_id"])
    op.create_index("ix_play_days_user_date", "play_days", ["user_id", "date"])

    op.create_table(
        "achievements",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(17), sa.ForeignKey("users.steamid", ondelete="CASCADE"), nullable=False),
        sa.Column("game_id", sa.Integer(), sa.ForeignKey("games.id", ondelete="CASCADE"), nullable=False),
        sa.Column("achievement_id", sa.String(128), nullable=False),
        sa.Column("unlocktime", sa.DateTime(), nullable=False),
        sa.Column("display_name", sa.String(255), nullable=True),
        sa.Column("icon_url", sa.Text(), nullable=True),
        sa.Column("global_percent", sa.Float(), nullable=True),
        sa.Column("percent_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "game_id", "achievement_id", name="uq_achievements_user_game_ach"),
    )
    op.create_index("ix_achievements_user_id", "achievements", ["user_id"])
    op.create_index("ix_achievements_game_id", "achievements", ["game_id"])
    op.create_index("ix_achievements_user_unlocktime", "achievements", ["user_id", "unlocktime"])

    op.create_table(
        "purchases",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(17), sa.ForeignKey("users.steamid", ondelete="CASCADE"), nullable=False),
        sa.Column("game_id", sa.Integer(), sa.ForeignKey("games.id", ondelete="CASCADE"), nullable=False),
        sa.Column("time_created", sa.DateTime(), nullable=False),
        sa.Column("payment_method", sa.String(64), nullable=True),
        sa.Column("channel", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "game_id", "time_created", name="uq_purchases_user_game_time"),
    )
    op.create_index("ix_purchases_user_id", "purchases", ["user_id"])
    op.create_index("ix_purchases_game_id", "purchases", ["game_id"])

    op.create_table(
        "reviews",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(17), sa.ForeignKey("users.steamid", ondelete="CASCADE"), nullable=False),
        sa.Column("appid", sa.Integer(), nullable=False),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "appid", name="uq_reviews_user_appid"),
    )
    op.create_index("ix_reviews_user_id", "reviews", ["user_id"])

    op.create_table(
        "screenshots",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(17), sa.ForeignKey("users.steamid", ondelete="CASCADE"), nullable=False),
        sa.Column("game_id", sa.Integer(), sa.ForeignKey("games.id", ondelete="CASCADE"), nullable=False),
        sa.Column("shot_id", sa.String(64), nullable=False),
        sa.Column("taken_at", sa.DateTime(), nullable=False),
        sa.Column("thumbnail_url", sa.Text(), nullable=True),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("privacy", sa.Integer(), nullable=False),
        sa.Column("caption", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "game_id", "shot_id", name="uq_screenshots_user_game_shot"),
    )
    op.create_index("ix_screenshots_user_id", "screenshots", ["user_id"])
    op.create_index("ix_screenshots_game_id", "screenshots", ["game_id"])
    op.create_index("ix_screenshots_user_taken", "screenshots", ["user_id", "taken_at"])

    op.create_table(
        "sync_state",
        sa.Column("user_id", sa.String(17), sa.ForeignKey("users.steamid", ondelete="CASCADE"), primary_key=True),
        sa.Column("last_sync_at", sa.DateTime(), nullable=True),
        sa.Column("recently_played_at", sa.DateTime(), nullable=True),
        sa.Column("owned_games_at", sa.DateTime(), nullable=True),
        sa.Column("achievements_at", sa.DateTime(), nullable=True),
        sa.Column("screenshots_at", sa.DateTime(), nullable=True),
        sa.Column("wishlist_at", sa.DateTime(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("sync_state")
    op.drop_table("screenshots")
    op.drop_table("reviews")
    op.drop_table("purchases")
    op.drop_table("achievements")
    op.drop_table("play_days")
    op.drop_table("games")
    op.drop_table("auth_tokens")
    op.drop_table("users")
