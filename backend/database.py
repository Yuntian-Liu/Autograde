"""数据库连接与启动自愈（_ensure_columns：启动时建表/补列，零手动迁移）。"""

import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = os.getenv("DATABASE_PATH", str(BASE_DIR / "autograde.db"))

engine = create_async_engine(f"sqlite+aiosqlite:///{DATABASE_PATH}", echo=False)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    async with SessionLocal() as session:
        yield session


async def init_db() -> None:
    """启动自愈：先 create_all 建缺失的表，再逐表补齐缺失的列。"""
    from models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_ensure_columns)


def _ensure_columns(conn) -> None:
    """对比模型与库内实际列，缺列则 ALTER TABLE ADD COLUMN。

    仅支持「新增可空列 / 带默认值列」级别的演进，不做删列与类型变更。
    """
    from models import Base

    inspector = inspect(conn)
    existing_tables = set(inspector.get_table_names())
    for table in Base.metadata.sorted_tables:
        if table.name not in existing_tables:
            continue
        existing_cols = {c["name"] for c in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in existing_cols:
                continue
            col_type = column.type.compile(conn.dialect)
            conn.execute(
                text(f'ALTER TABLE {table.name} ADD COLUMN "{column.name}" {col_type}')
            )
