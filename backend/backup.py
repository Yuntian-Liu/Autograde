"""全站备份：SQLite 在线快照 → COS backups/ 目录（异地留存）。

- 快照用 sqlite3 .backup API（在线一致性拷贝，不会拷到写一半的损坏页）
- 保留最近 RETENTION_DAYS 天（按 key 日期清理；按天保留才能回答「多少天后删除」）
- 每日自动：固定北京时间 04:00（低峰期）；启动时若没有任何备份或最新备份超 24h 先补一份消灭空白期
- 每份备份记录 自动/手动（内存 _last_backup + 04:00 时段推断，照 Stellaris backup_store）
- 恢复刻意不做在线入口：下载备份文件后手动替换数据库（危险操作留给人）
"""

import asyncio
import logging
import os
import re
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone

from cos_store import cos_enabled, delete_objects, list_objects_meta, presign_download, upload_bytes
from database import DATABASE_PATH

logger = logging.getLogger("autograde.backup")

BACKUP_PREFIX = "backups/"
RETENTION_DAYS = 30
DAILY_INTERVAL = 24 * 3600

_CST = timezone(timedelta(hours=8))  # 文件名与定时对齐用东八区，肉眼可读
_KEY_DATE_RE = re.compile(r"^autograde-(\d{8})-\d{6}\.db$")  # backups/ 后的部分

# 上次备份结果（内存追踪，供管理后台展示；进程重启后丢失，不影响自动备份本身）
_last_backup: dict | None = None


def backup_days_left(key: str, now: datetime | None = None) -> int | None:
    """备份 key → 距清理的天数（<=0 下次 04:00 即清）；key 不合规返回 None（不参与清理判断）。"""
    m = _KEY_DATE_RE.match(key[len(BACKUP_PREFIX):] if key.startswith(BACKUP_PREFIX) else key)
    if not m:
        return None
    file_date = datetime.strptime(m[1], "%Y%m%d").date()
    today = (now or datetime.now(_CST)).date()
    return (file_date - (today - timedelta(days=RETENTION_DAYS))).days


def seconds_until_next_4am(now: datetime | None = None) -> float:
    """距下一个北京时间 04:00 的秒数（纯函数，可测）。"""
    now = now or datetime.now(_CST)
    next_4am = now.replace(hour=4, minute=0, second=0, microsecond=0)
    if now >= next_4am:
        next_4am += timedelta(days=1)
    return (next_4am - now).total_seconds()


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


async def create_backup(manual: bool = False) -> dict:
    """快照 → 传 COS → 清理超龄备份。返回 {key, size, created_at}。manual 记录触发方式。
    失败也落 _last_backup + 日志（上次成功这次失败时，后台不能还显示旧的成功状态）。"""
    global _last_backup
    try:
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
        # 保留最近 RETENTION_DAYS 天：days_left < 0 才清（=0 属保留期最后一天，界面上显示「今日清理」）
        items = await list_objects_meta(BACKUP_PREFIX)
        expired = []
        for o in items:
            d = backup_days_left(o["key"])
            if d is not None and d < 0:
                expired.append(o["key"])
        if expired:
            await delete_objects(expired)
        logger.warning("备份完成 %s（%.1f KB，%s）", key, size / 1024, "手动" if manual else "自动")  # WARNING 级才进诊断环形缓冲
        _last_backup = {
            "key": key,
            "ok": True,
            "manual": manual,
            "time": datetime.now(_CST).strftime("%m-%d %H:%M"),
        }
        return {"key": key, "size": size, "created_at": datetime.now(timezone.utc).isoformat()}
    except Exception as e:
        _last_backup = {
            "key": "",
            "ok": False,
            "manual": manual,
            "time": datetime.now(_CST).strftime("%m-%d %H:%M"),
            "error": str(e)[:200],
        }
        logger.exception("备份失败（%s）", "手动" if manual else "自动")
        raise


def _bj_hour(modified: str) -> int | None:
    """COS LastModified(UTC) → 北京时间小时数；解析失败 None。"""
    try:
        dt = datetime.fromisoformat(modified.replace("Z", "+00:00"))
        return (dt + timedelta(hours=8)).hour
    except (ValueError, AttributeError):
        return None


async def list_backups() -> list[dict]:
    """备份列表（新的在前）。mode：内存记录精确匹配；否则按上传时刻是否落在 03-05 点推断自动/手动。"""
    items = await list_objects_meta(BACKUP_PREFIX)
    out = []
    for o in items:
        if _last_backup and _last_backup["key"] == o["key"]:
            mode = "手动" if _last_backup["manual"] else "自动"
        else:
            h = _bj_hour(o.get("modified", ""))
            mode = "自动" if h is not None and 3 <= h <= 5 else "手动"
        out.append({**o, "mode": mode, "days_left": backup_days_left(o["key"])})
    return sorted(out, key=lambda o: o["key"], reverse=True)


def get_last_backup() -> dict | None:
    return _last_backup


async def backup_download_url(key: str) -> str:
    """签发备份下载 URL；key 必须严格落在 backups/ 前缀下（防任意对象读取）。"""
    if not key.startswith(BACKUP_PREFIX) or "/" in key[len(BACKUP_PREFIX) :]:
        raise ValueError("非法备份 key")
    return await presign_download(key)


async def maybe_daily_backup() -> None:
    """后台常驻：启动时若没有任何备份或最新备份超 24h 先补一份（消灭空白期），
    随后对齐到每天北京时间 04:00 执行（低峰期，不再随部署时刻漂移）。异常只记日志不炸主程序。"""
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
        logger.exception("启动补备份失败")
    # 对齐 04:00 后每日自转
    await asyncio.sleep(seconds_until_next_4am())
    while True:
        try:
            await create_backup()
        except Exception:
            logger.exception("每日自动备份失败")
        await asyncio.sleep(DAILY_INTERVAL)
