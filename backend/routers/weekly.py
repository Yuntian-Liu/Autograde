import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ai import AIParseError, APITimeoutError, AIUnavailable, analyze_weekly_stream, ensure_available
from ai import _model as ai_model
from auth.dependencies import get_current_user
from auth.models import User
from auth.utils import check_ai_rate
from database import SessionLocal, get_db
from llm_events_store import estimate_cost, get_prices, price_tier_at, record_llm_call
from models import WeeklyReport
from weekly import build_weekly_evidence, weekly_payload, weekly_report_out

router = APIRouter(tags=["weekly-report"])
logger = logging.getLogger("autograde.weekly")
logger.setLevel(logging.INFO)
_JOB_TTL = 1800
_WEEKLY_JOBS: dict[str, dict] = {}


class WeeklyIn(BaseModel):
    week: str | None = None
    class_id: int = 0


def _gc_jobs() -> None:
    now = time.time()
    for job_id in [job_id for job_id, job in _WEEKLY_JOBS.items() if now - job["created"] > _JOB_TTL]:
        del _WEEKLY_JOBS[job_id]


async def _evidence(db: AsyncSession, user: User, body: WeeklyIn) -> tuple[dict, str]:
    data = await weekly_payload(db, user, body.week, body.class_id)
    return data, build_weekly_evidence(data)


@router.get("/api/weekly-report")
async def get_weekly_report(
    week: str | None = None,
    class_id: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    return await weekly_payload(db, user, week, class_id)


@router.post("/api/ai/weekly-report/estimate")
async def estimate_weekly_report(
    body: WeeklyIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    data, evidence = await _evidence(db, user, body)
    if not data["current"]["graded_submissions"]:
        raise HTTPException(status_code=400, detail="本周没有批改数据，无法生成 AI 周报")
    chars = len(evidence)
    est_prompt = 700 + int(chars / 1.5)
    est_output = 4000
    prices = await get_prices(db)
    tier = price_tier_at(datetime.now(timezone.utc), prices)
    return {
        "chars": chars,
        "est_prompt_tokens": est_prompt,
        "est_output_tokens": est_output,
        "est_total_tokens": est_prompt + est_output,
        "est_cost_yuan": estimate_cost(est_prompt, est_output, prices, tier),
        "price_tier": tier,
        "est_seconds": max(45, round((est_prompt + est_output) / 60)),
    }


@router.post("/api/ai/weekly-report", status_code=202)
async def create_weekly_report(body: WeeklyIn, user: User = Depends(get_current_user)) -> dict:
    async with SessionLocal() as db:
        data, _ = await _evidence(db, user, body)
    if not data["current"]["graded_submissions"]:
        raise HTTPException(status_code=400, detail="本周没有批改数据，无法生成 AI 周报")
    if not check_ai_rate(user.uid):
        raise HTTPException(status_code=429, detail="AI 调用过于频繁，请稍后再试")
    try:
        ensure_available()
    except AIUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    _gc_jobs()
    job_id = uuid.uuid4().hex[:16]
    _WEEKLY_JOBS[job_id] = {
        "uid": user.uid,
        "week": data["week"]["start"],
        "class_id": body.class_id,
        "status": "running",
        "recv_chars": 0,
        "created": time.time(),
    }
    logger.info("weekly_report_start job=%s uid=%s week=%s class=%s", job_id, user.uid, data["week"]["start"], body.class_id)
    asyncio.create_task(_run_weekly_job(job_id, user.uid, body)
    )
    return {"job_id": job_id}


async def _run_weekly_job(job_id: str, uid: int, body: WeeklyIn) -> None:
    job = _WEEKLY_JOBS.get(job_id)
    if job is None:
        return
    usage = None
    finish_reason = None
    text_chars = 0
    metrics = {}
    content = None
    llm_started = False
    recorded = False

    async def settle_call():
        return await record_llm_call(
            uid=uid,
            feature="weekly_report",
            model=ai_model(),
            prompt_tokens=(usage or {}).get("prompt_tokens", 0),
            completion_tokens=(usage or {}).get("completion_tokens", 0),
            finish_reason=finish_reason,
            is_empty=text_chars == 0,
            cache_hit_tokens=(usage or {}).get("cache_hit_tokens", 0),
            cache_miss_tokens=(usage or {}).get("cache_miss_tokens", 0),
            reasoning_tokens=(usage or {}).get("reasoning_tokens", 0),
            **{key: metrics.get(key, 0) for key in ("ttft_ms", "think_ms", "total_ms")},
        )

    try:
        async with SessionLocal() as db:
            user = (await db.execute(select(User).where(User.uid == uid))).scalar_one()
            _, evidence = await _evidence(db, user, body)
        llm_started = True
        async for event in analyze_weekly_stream(evidence):
            if event["type"] == "progress":
                job["recv_chars"] = event["recv_chars"]
            elif event["type"] == "done":
                usage = event.get("usage")
                finish_reason = event.get("finish_reason")
                text_chars = event.get("text_chars", 0)
                metrics = event.get("metrics") or {}
                content = event["data"]["content"]
        if not content:
            raise AIParseError("输出为空")
        settle = await settle_call()
        recorded = True
        async with SessionLocal() as db:
            report = (
                await db.execute(
                    select(WeeklyReport).where(
                        WeeklyReport.owner_uid == uid,
                        WeeklyReport.class_id == body.class_id,
                        WeeklyReport.week_start == job["week"],
                    )
                )
            ).scalar_one_or_none()
            if report is None:
                report = WeeklyReport(owner_uid=uid, class_id=body.class_id, week_start=job["week"])
                db.add(report)
            report.content = content
            report.model = ai_model()
            report.prompt_tokens = (usage or {}).get("prompt_tokens", 0)
            report.completion_tokens = (usage or {}).get("completion_tokens", 0)
            report.cache_hit_tokens = (usage or {}).get("cache_hit_tokens", 0)
            report.cache_miss_tokens = (usage or {}).get("cache_miss_tokens", 0)
            report.reasoning_tokens = (usage or {}).get("reasoning_tokens", 0)
            report.cost_yuan = (settle or {}).get("cost_yuan", 0.0)
            report.price_tier = (settle or {}).get("price_tier", "")
            report.total_ms = metrics.get("total_ms", 0)
            await db.commit()
        job["status"] = "done"
        job["result"] = weekly_report_out(report)
        logger.info("weekly_report_done job=%s uid=%s tokens=%s/%s", job_id, uid, (usage or {}).get("prompt_tokens", 0), (usage or {}).get("completion_tokens", 0))
    except APITimeoutError:
        job["status"] = "error"
        job["error"] = "AI 响应超时，请稍后重试"
        logger.warning("weekly_report_timeout job=%s", job_id)
    except AIParseError as error:
        finish_reason = "parse_error"
        text_chars = len(error.raw or "")
        job["status"] = "error"
        job["error"] = f"AI 输出解析失败：{error}"
        logger.warning("weekly_report_parse_error job=%s raw=%s", job_id, (error.raw or "")[:300])
    except AIUnavailable as error:
        job["status"] = "error"
        job["error"] = str(error)
        logger.warning("weekly_report_unavailable job=%s error=%s", job_id, error)
    except Exception:
        job["status"] = "error"
        job["error"] = "服务内部错误，请重试"
        logger.exception("weekly_report_error job=%s", job_id)
    finally:
        if llm_started and not recorded:
            await settle_call()


@router.get("/api/ai/weekly-report-jobs/{job_id}")
async def get_weekly_report_job(job_id: str, user: User = Depends(get_current_user)) -> dict:
    _gc_jobs()
    job = _WEEKLY_JOBS.get(job_id)
    if not job or job["uid"] != user.uid:
        raise HTTPException(status_code=404, detail="任务不存在或已过期，请重新发起")
    result = {"status": job["status"], "recv_chars": job.get("recv_chars", 0)}
    if job["status"] == "done":
        result["result"] = job["result"]
    elif job["status"] == "error":
        result["error"] = job["error"]
    return result
