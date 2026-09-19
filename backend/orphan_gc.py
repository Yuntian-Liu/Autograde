"""孤儿图片 GC：清理 COS 里没有任何笔记引用的图片对象。

两类孤儿：贴图后未保存的 tmp 件；笔记里删掉图片后残留的对象。
安全三保险：引用集合以笔记正文为唯一事实来源；只清 7 天前上传的（编辑途中的碰不到）；
清理时重新扫描（不拿过期清单删）。仅管理员可触发，全部动作进日志。
"""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from cos_store import delete_objects, extract_image_keys, list_objects_meta
from models import Note, NoteImage

logger = logging.getLogger("autograde.gc")

ORPHAN_MIN_AGE_DAYS = 7  # 只清上传超过 7 天的（防误删编辑途中的）


async def _referenced_keys(db: AsyncSession) -> set[str]:
    """全站笔记正文引用的图片 key 集合（正文是唯一事实来源）。"""
    contents = (await db.execute(select(Note.content))).scalars().all()
    keys: set[str] = set()
    for c in contents:
        keys.update(extract_image_keys(c or ""))
    return keys


async def scan_orphans(db: AsyncSession) -> dict:
    """扫描未引用图片（只读不删）：返回 {count, bytes}。"""
    referenced = await _referenced_keys(db)
    cutoff = datetime.now(timezone.utc) - timedelta(days=ORPHAN_MIN_AGE_DAYS)
    orphans = []
    for o in await list_objects_meta("notes/"):
        if o["key"] in referenced:
            continue
        try:
            modified = datetime.fromisoformat(o["modified"].replace("Z", "+00:00"))
        except ValueError:
            continue  # 时间解析不了宁可不删
        if modified < cutoff:
            orphans.append(o)
    return {
        "count": len(orphans),
        "bytes": sum(o["size"] for o in orphans),
        "_keys": [o["key"] for o in orphans],
    }


async def cleanup_orphans(db: AsyncSession) -> dict:
    """真删：重新扫描（不拿过期清单）→ 删 COS 对象 + 清 NoteImage 对应行。"""
    scan = await scan_orphans(db)
    keys = scan["_keys"]
    if not keys:
        return {"deleted": 0, "freed_bytes": 0}
    await delete_objects(keys)
    await db.execute(delete(NoteImage).where(NoteImage.key.in_(keys)))
    await db.commit()
    logger.warning("孤儿图片清理：删除 %d 个对象，释放 %.1f KB", len(keys), scan["bytes"] / 1024)
    return {"deleted": len(keys), "freed_bytes": scan["bytes"]}
