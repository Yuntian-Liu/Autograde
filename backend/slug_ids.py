"""批次对外短码：8 位小写无易混淆字符（去 0/o/1/i/l），URL 用。

- 不可枚举：不泄露业务量，配合 owner_uid 隔离构成纵深防御
- 防手误：敲错一位几乎不可能撞上合法短码（口述/手抄/发链接场景的冗余校验）
- 主键不动：slug 是展示与寻址层，外键网络仍走自增 id（数据兼容铁律）
"""

import secrets

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import Assignment

ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"  # 31 字符，8 位 ≈ 8.5e11 组合
SLUG_LEN = 8


def new_slug() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(SLUG_LEN))


async def unique_slug(db: AsyncSession) -> str:
    """生成查重后的短码（碰撞即重 roll，个人工具量级下几乎一次通过）。"""
    while True:
        s = new_slug()
        exists = await db.execute(select(Assignment.id).where(Assignment.slug == s).limit(1))
        if exists.first() is None:
            return s


async def backfill_slugs(db: AsyncSession) -> int:
    """存量批次补发短码（slug 为空的行）；返回补发数量。启动自愈与手动触发共用。"""
    rows = (
        await db.execute(select(Assignment).where(Assignment.slug == "").order_by(Assignment.id))
    ).scalars().all()
    for a in rows:
        a.slug = await unique_slug(db)
    if rows:
        await db.commit()
    return len(rows)
