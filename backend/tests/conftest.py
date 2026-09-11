"""pytest 基座：隔离的 SQLite 测试库 + TestClient + 假 Steam 客户端。"""
from __future__ import annotations

import os

# 必须在导入 app 之前设置，保证 config 读取到测试态配置。
os.environ.setdefault("GC_AUTO_CREATE_TABLES", "false")
os.environ.setdefault("GC_SCHEDULER_ENABLED", "false")
os.environ.setdefault("GC_DATABASE_URL", "sqlite://")
os.environ.setdefault("GC_SECRET_KEY", "test-secret-key")
# 测试只测 API；托管前端会把 "/" 接成 index.html，让根路径重定向的用例失去意义。
os.environ.setdefault("GC_SERVE_FRONTEND", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app


class FakeSteamMixin:
    """所有 Steam 替身的公共部分。

    真实 ``SteamClient`` 持有 httpx 连接池、需要 ``close()``（也支持 with），
    替身必须跟上这个契约——否则生产代码里的 ``steam.close()`` 会在测试里炸。
    """

    closed = False
    # 竖版封面按 appid 拼模板地址，存之前要 HEAD 验一次。替身默认「都在」，
    # 需要验 404 分支的用例自己覆盖它。
    portrait_exists = True

    def asset_exists(self, url: str) -> bool:
        return self.portrait_exists

    def close(self) -> None:
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        self.close()


class FakeSteam(FakeSteamMixin):
    """假 Steam 客户端：固定 SteamID，无真实网络。"""

    def __init__(self, steamid: str = "76561198000000000") -> None:
        self.steamid = steamid

    def get_token_details(self, access_token: str) -> str:
        return self.steamid

    def get_player_summaries(self, apikey: str, steamid: str) -> dict:
        return {"personaname": "tester", "avatarfull": "https://x/a.jpg"}

    def get_app_details(self, appid: int, language: str = "schinese"):
        return None

    def download_bytes(self, url: str):
        return None

    def get_recently_played(self, apikey: str, steamid: str):
        return []

    def get_player_achievements(self, apikey: str, steamid: str, appid: int):
        return []


@pytest.fixture()
def db_engine():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    yield engine
    Base.metadata.drop_all(bind=engine)
    engine.dispose()


@pytest.fixture()
def db_session(db_engine):
    Session = sessionmaker(bind=db_engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture()
def client(db_engine, monkeypatch):
    fake = FakeSteam()
    monkeypatch.setattr("app.api.auth.get_steam_client", lambda: fake)
    monkeypatch.setattr("app.api.wishlist.get_steam_client", lambda: fake)

    Session = sessionmaker(bind=db_engine)

    def override_get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
