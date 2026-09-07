"""管理接口 — 邀请码 / AI 用量与成本 / 安全面板 / 总览 / 备份下载（is_admin 守卫）。"""

import os
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

import config
from auth.dependencies import get_admin_user
from auth.models import InviteCode, User
from auth.utils import generate_invite_code, get_login_blocked_count, get_login_blocked_events
from database import DATABASE_PATH, get_db
from llm_events_store import DEFAULT_PRICES, ai_usage_stats, get_prices, set_prices
from models import Assignment, Class, LlmCallEvent, Student, Submission

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ---- 总览 ----


@router.get("/overview")
async def overview(
    admin: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """看板汇总：用户/班级/批次/批改数 + DB 大小 + 今日 AI 成本。"""
    users = (await db.execute(select(func.count(User.id)))).scalar_one()
    classes = (await db.execute(select(func.count(Class.id)))).scalar_one()
    assignments = (await db.execute(select(func.count(Assignment.id)))).scalar_one()
    graded = (
        await db.execute(
            select(func.count(Submission.id)).where(Submission.status.in_(("已批改", "缺作业")))
        )
    ).scalar_one()
    students = (await db.execute(select(func.count(Student.id)))).scalar_one()

    start_today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    from models import LlmCallEvent

    today_cost = (
        await db.execute(
            select(func.coalesce(func.sum(LlmCallEvent.cost_yuan), 0.0)).where(
                LlmCallEvent.created_at >= start_today
            )
        )
    ).scalar_one()

    db_size = os.path.getsize(DATABASE_PATH) if os.path.exists(DATABASE_PATH) else 0
    return {
        "users": users,
        "classes": classes,
        "assignments": assignments,
        "students": students,
        "graded": graded,
        "db_size_mb": round(db_size / 1024 / 1024, 2),
        "ai_cost_today_yuan": round(float(today_cost), 6),
        "version": "0.4.0",
    }


# ---- AI 用量与单价 ----


@router.get("/ai-usage")
async def ai_usage(
    window: str = "7d",
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if window not in ("today", "7d", "30d", "all"):
        raise HTTPException(status_code=400, detail="window 仅支持 today/7d/30d/all")
    return await ai_usage_stats(db, window)


@router.get("/ai-prices")
async def read_prices(admin: User = Depends(get_admin_user), db=Depends(get_db)) -> dict:
    prices = await get_prices(db)
    return {"prices": prices, "defaults": DEFAULT_PRICES}


class PricesIn(BaseModel):
    # 峰价三元组（缓存命中价暂不参与结算，仅留存配置）
    price_input: float = Field(..., ge=0)
    price_cache_hit: float = Field(..., ge=0)
    price_output: float = Field(..., ge=0)
    # 谷价三元组
    offpeak_input: float = Field(..., ge=0)
    offpeak_cache_hit: float = Field(..., ge=0)
    offpeak_output: float = Field(..., ge=0)
    # 峰时段（北京时间，[["09:00","12:00"],...]，支持跨午夜）与周末规则
    peak_windows: list[list[str]] = Field(default=[["09:00", "12:00"], ["14:00", "18:00"]])
    weekend_rule: str = Field(default="all_offpeak")

    @field_validator("peak_windows")
    @classmethod
    def _check_windows(cls, v):
        from llm_events_store import _normalize_windows

        if len(_normalize_windows(v)) != len(v):
            raise ValueError("峰时段格式应为 HH:MM 起止对（如 09:00/12:00）")
        return v

    @field_validator("weekend_rule")
    @classmethod
    def _check_rule(cls, v):
        if v not in ("all_offpeak", "same"):
            raise ValueError("weekend_rule 仅支持 all_offpeak / same")
        return v


@router.put("/ai-prices")
async def update_prices(
    body: PricesIn, admin: User = Depends(get_admin_user), db=Depends(get_db)
) -> dict:
    """改单价/时段只影响之后的调用（历史 cost_yuan 是结算时的发票，不回溯）。"""
    prices = await set_prices(db, body.model_dump())
    return {"prices": prices}


# ---- 安全面板 ----


@router.get("/security-status")
async def security_status(admin: User = Depends(get_admin_user)) -> dict:
    return {
        "login_blocked_count": get_login_blocked_count(),
        "login_blocked_events": get_login_blocked_events(),
        "keys": {
            "jwt_secret_set": config.JWT_SECRET != "dev-secret-change-me",
            "resend_set": bool(config.RESEND_API_KEY and config.RESEND_FROM),
            "openai_key_set": bool(os.getenv("OPENAI_API_KEY", "").strip()),
            "is_prod": config.IS_PROD,
        },
    }


# ---- 数据管理：在线备份下载 ----


@router.post("/backup")
async def backup_download(admin: User = Depends(get_admin_user)) -> FileResponse:
    """sqlite 在线快照（.backup，不会拷到写一半的损坏页）→ 浏览器下载。"""
    if not os.path.exists(DATABASE_PATH):
        raise HTTPException(status_code=404, detail="数据库文件不存在")
    fd, dst_path = tempfile.mkstemp(suffix=".db", prefix="autograde-backup-")
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
    filename = f"autograde-{datetime.now().strftime('%Y%m%d-%H%M')}.db"
    return FileResponse(
        dst_path,
        filename=filename,
        media_type="application/octet-stream",
        background=BackgroundTask(lambda: os.path.exists(dst_path) and os.remove(dst_path)),
    )


# ---- 邀请码 ----


class InviteCreateIn(BaseModel):
    count: int = Field(default=1, ge=1, le=20)  # 批量生成数量
    valid_days: int | None = Field(default=None, ge=1, le=365)  # 空 = 永不过期
    max_uses: int = Field(default=1, ge=1, le=100)  # 每码可用次数
    note: str = Field(default="", max_length=100)  # 备注（给谁发的等）


def _invite_brief(c) -> dict:
    now = datetime.now(timezone.utc)
    expired = False
    if c.expires_at is not None:
        exp = c.expires_at if c.expires_at.tzinfo else c.expires_at.replace(tzinfo=timezone.utc)
        expired = now > exp
    used_up = c.use_count >= c.max_uses
    status = "已作废" if c.revoked else ("已过期" if expired else ("已用完" if used_up else "可用"))
    return {
        "id": c.id,
        "code": c.code,
        "created_by": c.created_by,
        "used_by": c.used_by,
        "used_at": c.used_at.isoformat() if c.used_at else None,
        "expires_at": c.expires_at.isoformat() if c.expires_at else None,
        "max_uses": c.max_uses,
        "use_count": c.use_count,
        "revoked": c.revoked,
        "note": c.note or "",
        "status": status,
    }


@router.get("/invite-codes")
async def list_invite_codes(
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    codes = (
        await db.execute(
            select(InviteCode).order_by(InviteCode.id.desc())
        )
    ).scalars().all()
    return [_invite_brief(c) for c in codes]


@router.post("/invite-codes", status_code=201)
async def create_invite_codes(
    body: InviteCreateIn,
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """批量生成邀请码（AG-XXXXXXXX 大写 hex）。"""
    expires_at = (
        datetime.now(timezone.utc) + timedelta(days=body.valid_days)
        if body.valid_days
        else None
    )
    codes = [
        InviteCode(
            code=generate_invite_code(),
            created_by=admin.uid,
            expires_at=expires_at,
            max_uses=body.max_uses,
            note=body.note.strip(),
        )
        for _ in range(body.count)
    ]
    db.add_all(codes)
    await db.commit()
    return [_invite_brief(c) for c in codes]


@router.delete("/invite-codes/{code_id}", status_code=204)
async def revoke_invite_code(
    code_id: int,
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """作废邀请码（软删，保留历史可追溯）。"""
    c = await db.get(InviteCode, code_id)
    if c is None:
        raise HTTPException(status_code=404, detail="邀请码不存在")
    c.revoked = True
    await db.commit()
