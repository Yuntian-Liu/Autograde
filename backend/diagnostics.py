"""服务端日志环形缓冲 + 诊断日志导出（生产 Debug 用）。

脱敏纪律（照 Stellaris 体系）：
- 密钥类一律只报布尔（是否配置 / 是否改掉默认值）
- URL 统一打码（mask_urls → [链接已脱敏]），日志尾段逐条过
- 邀请码只报统计（总数/已用/剩余），明文与使用者一律不进包
- 只含请求者本人数据（LLM 调用、数据量按 owner_uid 过滤）
- 操作路径、最近错误日志保留（这是诊断的意义）
"""

import logging
import os
import platform
import re
import sys
from collections import deque
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import config
from auth.models import InviteCode, User
from auth.utils import get_login_blocked_count
from database import DATABASE_PATH
from llm_events_store import get_prices
from models import (
    Assignment,
    Class,
    ErrorRecord,
    FeedbackSnapshot,
    LlmCallEvent,
    Phrase,
    Question,
    Student,
    Submission,
)

APP_VERSION = "0.5.1"
# 与 frontend/src/legal/changelog.js 的 AGREEMENT_VERSION 保持同步（核对用户看到的协议是否最新）
AGREEMENT_VERSION = "2026-09-13"
_STARTED_AT = datetime.now(timezone.utc)

MAX_LOG_ENTRIES = 500
_log_buffer: deque = deque(maxlen=MAX_LOG_ENTRIES)

_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)


def mask_urls(s: str) -> str:
    """URL 脱敏：诊断包不携带完整链接（大小写不敏感）。"""
    return _URL_RE.sub("[链接已脱敏]", s or "")


class RingBufferHandler(logging.Handler):
    """把日志记录（含堆栈）写进环形缓冲，供诊断导出。"""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            entry = {
                "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
                "level": record.levelname,
                "logger": record.name,
                "msg": record.getMessage()[:800],
            }
            if record.exc_info:
                entry["exc"] = self.format(record)[:1500]  # 含异常栈
            _log_buffer.append(entry)
        except Exception:  # noqa: BLE001 日志采集自身绝不影响业务
            pass


def attach_log_buffer() -> None:
    """main.py lifespan 启动时挂载（幂等）。"""
    root = logging.getLogger()
    if not any(isinstance(h, RingBufferHandler) for h in root.handlers):
        root.addHandler(RingBufferHandler())


async def build_diagnostics(db: AsyncSession, user: User) -> dict:
    """组装诊断包（仅请求者本人数据；前端会再注入浏览器端事件后整包下载）。"""

    async def count(model) -> int:
        return (await db.execute(select(func.count(model.id)))).scalar_one()

    async def count_owned(model, join_col) -> int:
        """按 class.owner_uid 归属过滤的数据量。"""
        return (
            await db.execute(
                select(func.count(model.id))
                .join(Class, join_col == Class.id)
                .where(Class.owner_uid == user.uid)
            )
        ).scalar_one()

    async def count_classes() -> int:
        return (
            await db.execute(
                select(func.count(Class.id)).where(Class.owner_uid == user.uid)
            )
        ).scalar_one()

    prices = await get_prices(db)
    # 只含请求者本人的 LLM 调用流水
    recent_llm = [
        {
            "id": e.id,
            "feature": e.feature,
            "assignment_id": e.assignment_id,
            "model": e.model,
            "prompt_tokens": e.prompt_tokens,
            "completion_tokens": e.completion_tokens,
            "cost_yuan": e.cost_yuan,
            "price_tier": e.price_tier,
            "finish_reason": e.finish_reason,
            "is_empty": e.is_empty,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in (
            await db.execute(
                select(LlmCallEvent)
                .where(LlmCallEvent.uid == user.uid)
                .order_by(LlmCallEvent.id.desc())
                .limit(20)
            )
        ).scalars().all()
    ]

    # 邀请码只报统计，明文与使用者不进包
    invite_rows = (
        await db.execute(
            select(InviteCode.use_count, InviteCode.max_uses, InviteCode.revoked)
        )
    ).all()
    invite_stats = {
        "total": len(invite_rows),
        "used": sum(r.use_count for r in invite_rows),
        "remaining": sum(max(0, r.max_uses - r.use_count) for r in invite_rows if not r.revoked),
    }

    db_size = os.path.getsize(DATABASE_PATH) if os.path.exists(DATABASE_PATH) else 0

    # submissions 按状态拆分（排查「批改状态不对劲」类问题的第一手数据）
    sub_status_rows = (
        await db.execute(
            select(Submission.status, func.count(Submission.id))
            .join(Assignment, Submission.assignment_id == Assignment.id)
            .join(Class, Assignment.class_id == Class.id)
            .where(Class.owner_uid == user.uid)
            .group_by(Submission.status)
        )
    ).all()
    submissions_by_status = {status: n for status, n in sub_status_rows}

    # LLM 调用按功能拆分（排查 AI 类问题：拆题 vs 起草各自量与失败）
    llm_feature_rows = (
        await db.execute(
            select(LlmCallEvent.feature, func.count(LlmCallEvent.id))
            .where(LlmCallEvent.uid == user.uid)
            .group_by(LlmCallEvent.feature)
        )
    ).all()
    llm_by_feature = {feature: n for feature, n in llm_feature_rows}

    return {
        "app": {
            "version": APP_VERSION,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "started_at": _STARTED_AT.isoformat(),
            "uptime_hours": round((datetime.now(timezone.utc) - _STARTED_AT).total_seconds() / 3600, 2),
            "is_prod": config.IS_PROD,
        },
        "runtime": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
        },
        "config": {
            # 密钥类一律只报布尔
            "jwt_secret_set": config.JWT_SECRET != "dev-secret-change-me",
            "resend_set": bool(config.RESEND_API_KEY and config.RESEND_FROM),
            "openai_key_set": bool(os.getenv("OPENAI_API_KEY", "").strip()),
            "ai_base_url": mask_urls(os.getenv("OPENAI_BASE_URL", "").strip()),
            "ai_model": os.getenv("AI_MODEL", "").strip(),
            "ai_prices": prices,
            "database_file": os.path.basename(DATABASE_PATH),
            "agreement_version": AGREEMENT_VERSION,
        },
        "data": {
            "db_size_mb": round(db_size / 1024 / 1024, 3),
            "classes": await count_classes(),
            "students": await count_owned(Student, Student.class_id),
            "assignments": await count_owned(Assignment, Assignment.class_id),
            "submissions": (
                await db.execute(
                    select(func.count(Submission.id))
                    .join(Assignment, Submission.assignment_id == Assignment.id)
                    .join(Class, Assignment.class_id == Class.id)
                    .where(Class.owner_uid == user.uid)
                )
            ).scalar_one(),
            # 题库/错题/快照同样按归属过滤（经 assignment 或 student 链路）
            "questions": (
                await db.execute(
                    select(func.count(Question.id))
                    .join(Assignment, Question.assignment_id == Assignment.id)
                    .join(Class, Assignment.class_id == Class.id)
                    .where(Class.owner_uid == user.uid)
                )
            ).scalar_one(),
            "error_records": (
                await db.execute(
                    select(func.count(ErrorRecord.id))
                    .join(Student, ErrorRecord.student_id == Student.id)
                    .join(Class, Student.class_id == Class.id)
                    .where(Class.owner_uid == user.uid)
                )
            ).scalar_one(),
            "feedback_snapshots": (
                await db.execute(
                    select(func.count(FeedbackSnapshot.id))
                    .join(Student, FeedbackSnapshot.student_id == Student.id)
                    .join(Class, Student.class_id == Class.id)
                    .where(Class.owner_uid == user.uid)
                )
            ).scalar_one(),
            "submissions_by_status": submissions_by_status,
            "phrases": await count(Phrase),  # 全局话术配置，非用户数据
            "llm_call_events": (
                await db.execute(
                    select(func.count(LlmCallEvent.id)).where(LlmCallEvent.uid == user.uid)
                )
            ).scalar_one(),
            "llm_call_events_by_feature": llm_by_feature,
        },
        "recent_llm_calls": recent_llm,
        "security": {
            # 拦截事件含第三方 IP，不进包；管理员可在后台安全面板查看
            "login_blocked_count": get_login_blocked_count(),
        },
        "invite_codes": invite_stats,
        # 服务端日志尾段保留（诊断意义所在），URL 逐条打码
        "server_log_tail": [
            {
                **entry,
                "msg": mask_urls(entry["msg"]),
                **({"exc": mask_urls(entry["exc"])} if "exc" in entry else {}),
            }
            for entry in list(_log_buffer)[-200:]
        ],
    }
