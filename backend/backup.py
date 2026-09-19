"""全站备份：SQLite 在线快照 → COS backups/ 目录（异地留存）。

- 快照用 sqlite3 .backup API（在线一致性拷贝，不会拷到写一半的损坏页）
- 保留最近 RETENTION 份，超出自动清理
- 每日自动：主进程后台任务，最新备份超过 24h 就补一份
- 恢复刻意不做在线入口：下载备份文件后手动替换数据库（危险操作留给人）
"""

import asyncio
import logging
import os
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone

from cos_store import cos_enabled, delete_objects, list_objects_meta, presign_download, upload_bytes
from database import DATABASE_PATH

logger = logging.getLogger("autograde.backup")

BACKUP_PREFIX = "backups/"
RETENTION = 30
DAILY_INTERVAL = 24 * 3600

_CST = timezone(timedelta(hours=8))  # 文件名用东八区，肉眼可读


def _snapshot() -> tuple[str, int]:
    """在线快照到临时文件，返回 (路径, 字节数)。"""
    fd, dst_path = tempfile.mkstemp(suffix=".db", prefix="autograde-cos-backup-")
    os.close(fd)
    try:
        src = sqlite3.connect(DATABASE_PATH)
        dst = sqlite3.connect(dst_path)
        with dst:
            src.backup(dst)
        dst.close()
        src.close()
    except Exception:
        if os.path.exists(dst_path):
            os.remove(dst_path)
        raise
    return dst_path, os.path.getsize(dst_path)


async def create_backup() -> dict:
    """快照 → 传 COS → 清理超龄备份。返回 {key, size, created_at}。"""
    if not cos_enabled():
        raise RuntimeError("对象存储未配置")
    if not os.path.exists(DATABASE_PATH):
        raise RuntimeError("数据库文件不存在")
    stamp = datetime.now(_CST).strftime("%Y%m%d-%H%M%S")
    key = f"{BACKUP_PREFIX}autograde-{stamp}.db"
    path, size = await asyncio.to_thread(_snapshot)
    try:
        with open(path, "rb") as f:
            await upload_bytes(key, f.read(), "application/octet-stream")
    finally:
        if os.path.exists(path):
            os.remove(path)
    # 保留最近 N 份（key 含时间戳，字典序即时间序）
    items = sorted(await list_objects_meta(BACKUP_PREFIX), key=lambda o: o["key"])
    excess = len(items) - RETENTION
    if excess > 0:
        await delete_objects([o["key"] for o in items[:excess]])
    logger.warning("备份完成 %s（%.1f KB）", key, size / 1024)  # WARNING 级才进诊断环形缓冲
    return {"key": key, "size": size, "created_at": datetime.now(timezone.utc).isoformat()}


async def list_backups() -> list[dict]:
    """备份列表（新的在前）。"""
    items = await list_objects_meta(BACKUP_PREFIX)
    return sorted(items, key=lambda o: o["key"], reverse=True)


async def backup_download_url(key: str) -> str:
    """签发备份下载 URL；key 必须严格落在 backups/ 前缀下（防任意对象读取）。"""
    if not key.startswith(BACKUP_PREFIX) or "/" in key[len(BACKUP_PREFIX) :]:
        raise ValueError("非法备份 key")
    return await presign_download(key)


async def maybe_daily_backup() -> None:
    """后台常驻：最新备份超过 24h 就补一份，随后每 24h 自转。异常只记日志不炸主程序。"""
    while True:
        try:
            if cos_enabled() and os.path.exists(DATABASE_PATH):
                items = await list_objects_meta(BACKUP_PREFIX)
                newest = max((o["modified"] for o in items), default="")
                stale = True
                if newest:
                    try:
                        newest_dt = datetime.fromisoformat(newest.replace("Z", "+00:00"))
                        stale = datetime.now(timezone.utc) - newest_dt > timedelta(hours=24)
                    except ValueError:
                        stale = True
                if stale:
                    await create_backup()
        except Exception:
            logger.exception("每日自动备份失败")
        await asyncio.sleep(DAILY_INTERVAL)
