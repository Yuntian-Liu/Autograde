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
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

import config
from auth.models import InviteCode, User
from auth.utils import get_login_blocked_count
from rating import DEFAULT_THRESHOLDS, get_thresholds
from database import DATABASE_PATH
from llm_events_store import get_prices
from models import (
    AbilityReport,
    Assignment,
    Class,
    ClientEvent,
    ErrorRecord,
    FeedbackSnapshot,
    LlmCallEvent,
    Note,
    NoteImage,
    Phrase,
    Question,
    Setting,
    Student,
    Submission,
)

APP_VERSION = "0.16.0"
# 与 frontend/src/legal/changelog.js 的 AGREEMENT_VERSION 保持同步（核对用户看到的协议是否最新）
AGREEMENT_VERSION = "2026-09-24.2"
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
    """组装诊断包（仅请求者本人数据）。
    client_events 为落库的客户端事件（前端周期 flush）；导出时前端另注入 client_events_local（未 flush 尾段）。"""

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
            "student_id": e.student_id,
            "model": e.model,
            "prompt_tokens": e.prompt_tokens,
            "completion_tokens": e.completion_tokens,
            # 缓存拆分与延迟（V0.15.0）：模型慢/超时/成本异常排查的直接证据
            "cache_hit_tokens": e.cache_hit_tokens,
            "cache_miss_tokens": e.cache_miss_tokens,
            "reasoning_tokens": e.reasoning_tokens,
            "ttft_ms": e.ttft_ms,
            "think_ms": e.think_ms,
            "total_ms": e.total_ms,
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

    # LLM 24h 健康聚合（V0.15.0）：「模型是不是出问题了」类报障的直接证据——
    # 正常率/空回答/异常/平均延迟/缓存命中率，只看诊断包不用登管理后台
    llm24_start = datetime.now(timezone.utc) - timedelta(hours=24)
    t24, h24, e24, f24, ttft24, total24, hit24, miss24 = (
        await db.execute(
            select(
                func.count(LlmCallEvent.id),
                func.sum(
                    case(
                        (and_(LlmCallEvent.finish_reason == "stop", LlmCallEvent.is_empty.is_(False)), 1),
                        else_=0,
                    )
                ),
                func.sum(case((LlmCallEvent.is_empty.is_(True), 1), else_=0)),
                func.sum(case((LlmCallEvent.finish_reason.is_(None), 1), else_=0)),
                func.avg(case((LlmCallEvent.ttft_ms > 0, LlmCallEvent.ttft_ms), else_=None)),
                func.avg(case((LlmCallEvent.total_ms > 0, LlmCallEvent.total_ms), else_=None)),
                func.coalesce(func.sum(LlmCallEvent.cache_hit_tokens), 0),
                func.coalesce(func.sum(LlmCallEvent.cache_miss_tokens), 0),
            ).where(LlmCallEvent.uid == user.uid, LlmCallEvent.created_at >= llm24_start)
        )
    ).one()
    hit24, miss24 = int(hit24 or 0), int(miss24 or 0)
    llm_health_24h = {
        "total": t24 or 0,
        "healthy_rate": round(int(h24 or 0) / t24 * 100, 1) if t24 else None,
        "empty": int(e24 or 0),
        "failed": int(f24 or 0),
        "avg_ttft_ms": int(ttft24) if ttft24 else None,
        "avg_total_ms": int(total24) if total24 else None,
        "cache_hit_rate": round(hit24 / (hit24 + miss24) * 100, 1) if (hit24 + miss24) else None,
    }

    # 编码序号计数器是全站总量（平台规模信息，隐私收敛）：仅 admin 的导出包带当前值；
    # seq > 有码数 = 删号退役（正常），seq < 有码数 = 计数器被重置（bug）
    code_seq_counters = None
    if user.is_admin:
        seq_rows = (
            await db.execute(
                select(Setting).where(
                    Setting.key.in_(("code_seq_student", "code_seq_assignment"))
                )
            )
        ).scalars().all()
        code_seq_counters = {r.key: int(r.value or 0) for r in seq_rows}

    # 备份健康（admin 专属；平台级信息）：份数 + 最新备份年龄——「备份是不是没跑」的直接证据，
    # 不用翻日志尾段找。拉取失败也如实上报（失败本身就是信号）
    backup_health = None
    if user.is_admin:
        from cos_store import cos_enabled as _cos_ok, list_objects_meta as _list_bk

        if not _cos_ok():
            backup_health = {"cos_set": False}
        else:
            try:
                bk = await _list_bk("backups/")
                newest = max((o["modified"] for o in bk), default=None)
                age_h = None
                if newest:
                    age_h = round(
                        (
                            datetime.now(timezone.utc)
                            - datetime.fromisoformat(newest.replace("Z", "+00:00"))
                        ).total_seconds()
                        / 3600,
                        1,
                    )
                backup_health = {"count": len(bk), "newest_age_hours": age_h}
            except Exception:
                backup_health = {"error": "备份列表拉取失败"}

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
            "cos_set": bool(
                config.COS_SECRET_ID and config.COS_SECRET_KEY and config.COS_BUCKET
            ),
            "aliyun_captcha_set": bool(config.ALIYUN_CAPTCHA_PREFIX),
            "ai_base_url": mask_urls(os.getenv("OPENAI_BASE_URL", "").strip()),
            "ai_model": os.getenv("AI_MODEL", "").strip(),
            "ai_prices": prices,
            "database_file": os.path.basename(DATABASE_PATH),
            "agreement_version": AGREEMENT_VERSION,
            # 分数线是否被自定义过（排查等级异常时先排除配置因素）
            "rating_thresholds_custom": (
                await get_thresholds(db) != DEFAULT_THRESHOLDS
            ),
        },
        "data": {
            "db_size_mb": round(db_size / 1024 / 1024, 3),
            "classes": await count_classes(),
            "students": await count_owned(Student, Student.class_id),
            "assignments": await count_owned(Assignment, Assignment.class_id),
            # 业务编码健康（V0.13.0）：缺码数应恒为 0——非 0 即发码/回填断链；
            # 无届别班级数同理（cohort 空 = 编码前缀来源缺失）
            "codes_students": (
                await db.execute(
                    select(func.count(Student.id))
                    .join(Class, Student.class_id == Class.id)
                    .where(Class.owner_uid == user.uid, Student.code != "")
                )
            ).scalar_one(),
            "codes_assignments": (
                await db.execute(
                    select(func.count(Assignment.id))
                    .join(Class, Assignment.class_id == Class.id)
                    .where(Class.owner_uid == user.uid, Assignment.code != "")
                )
            ).scalar_one(),
            "codes_missing_students": (
                await db.execute(
                    select(func.count(Student.id))
                    .join(Class, Student.class_id == Class.id)
                    .where(Class.owner_uid == user.uid, Student.code == "")
                )
            ).scalar_one(),
            "codes_missing_assignments": (
                await db.execute(
                    select(func.count(Assignment.id))
                    .join(Class, Assignment.class_id == Class.id)
                    .where(Class.owner_uid == user.uid, Assignment.code == "")
                )
            ).scalar_one(),
            "classes_without_cohort": (
                await db.execute(
                    select(func.count(Class.id)).where(
                        Class.owner_uid == user.uid, Class.cohort == ""
                    )
                )
            ).scalar_one(),
            "code_seq_counters": code_seq_counters,  # None = 非 admin 导出（全站计数器不发给普通用户）
            "backup_health": backup_health,  # None = 非 admin；{cos_set:False} 或 {count, newest_age_hours} 或 {error}
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
            # 能力报告（V0.15.0）：存档数 + 生成失败排查配合 llm feature=ability_report 看
            "ability_reports": (
                await db.execute(
                    select(func.count(AbilityReport.id))
                    .join(Student, AbilityReport.student_id == Student.id)
                    .join(Class, Student.class_id == Class.id)
                    .where(Class.owner_uid == user.uid)
                )
            ).scalar_one(),
            "submissions_by_status": submissions_by_status,
            # 预习功能（V0.11.0）：答题卡已录的批次数 / 有预习错题登记的提交数（排查预习联动问题）
            "preview_answered_assignments": (
                await db.execute(
                    select(func.count(Assignment.id))
                    .join(Class, Assignment.class_id == Class.id)
                    .where(Class.owner_uid == user.uid, Assignment.preview_answers != "")
                )
            ).scalar_one(),
            "preview_wrong_records": (
                await db.execute(
                    select(func.count(Submission.id))
                    .join(Assignment, Submission.assignment_id == Assignment.id)
                    .join(Class, Assignment.class_id == Class.id)
                    .where(Class.owner_uid == user.uid, Submission.preview_wrong != "")
                )
            ).scalar_one(),
            "phrases": await count(Phrase),  # 全局话术配置，非用户数据
            "llm_call_events": (
                await db.execute(
                    select(func.count(LlmCallEvent.id)).where(LlmCallEvent.uid == user.uid)
                )
            ).scalar_one(),
            "llm_call_events_by_feature": llm_by_feature,
            "llm_health_24h": llm_health_24h,
            "notes": (
                await db.execute(select(func.count(Note.id)).where(Note.owner_uid == user.uid))
            ).scalar_one(),
            "notes_archived": (
                await db.execute(
                    select(func.count(Note.id)).where(
                        Note.owner_uid == user.uid, Note.archived.is_(True)
                    )
                )
            ).scalar_one(),
            "note_images": (
                await db.execute(
                    select(func.count(NoteImage.id)).where(NoteImage.owner_uid == user.uid)
                )
            ).scalar_one(),
            "client_events": (
                await db.execute(select(func.count(ClientEvent.id)).where(ClientEvent.uid == user.uid))
            ).scalar_one(),
        },
        "recent_llm_calls": recent_llm,
        # 客户端事件（落库，该用户最近 200 条；detail 过 URL 打码）
        "client_events": [
            {
                "id": e.id,
                "client_ts": e.client_ts,
                "type": e.type,
                "detail": mask_urls(e.detail),
                "created_at": e.created_at.isoformat() if e.created_at else None,
            }
            for e in (
                await db.execute(
                    select(ClientEvent)
                    .where(ClientEvent.uid == user.uid)
                    .order_by(ClientEvent.id.desc())
                    .limit(200)
                )
            ).scalars().all()
        ],
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
