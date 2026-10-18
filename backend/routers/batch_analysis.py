"""批次分析与 AI 批次分析任务接口。"""

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from access import owned_assignment
from ai import (
    AIParseError,
    APITimeoutError,
    AIUnavailable,
    analyze_batch_analysis_stream,
    ensure_available,
)
from ai import _model as ai_model
from auth.dependencies import get_current_user
from auth.models import User
from auth.utils import check_ai_rate
from batch_analysis import (
    aggregate_batch,
    batch_analysis_report_out,
    build_assignment_analysis,
    build_batch_evidence,
    upsert_batch_analysis_report,
)
from database import get_db
from llm_events_store import estimate_cost, get_prices, price_tier_at, record_llm_call
from models import Assignment, Class
from serializers import class_brief

router = APIRouter(prefix="/api/assignments", tags=["assignments"])
ai_router = APIRouter(prefix="/api/ai", tags=["ai"])

AI_RATE_HINT = "AI 调用过于频繁，请稍后再试"
NO_DATA_HINT = "该批次没有有效学生成绩数据，无法生成 AI 分析"
logger = logging.getLogger("autograde.ai")
logger.setLevel(logging.INFO)  # 根日志默认 WARNING，批次任务生命周期必须能进诊断环形缓冲
_JOB_TTL = 1800
_BATCH_ANALYSIS_JOBS: dict[str, dict] = {}


class BatchAnalysisIn(BaseModel):
    assignment_id: int


def _gc_jobs() -> None:
    now = time.time()
    for job_id in [
        job_id
        for job_id, job in _BATCH_ANALYSIS_JOBS.items()
        if now - job["created"] > _JOB_TTL
    ]:
        del _BATCH_ANALYSIS_JOBS[job_id]


async def _background_evidence(db: AsyncSession, assignment_id: int, uid: int):
    assignment = await db.get(Assignment, assignment_id)
    class_ = await db.get(Class, assignment.class_id) if assignment else None
    if assignment is None or class_ is None or class_.owner_uid != uid:
        return None
    data = await aggregate_batch(db, assignment)
    evidence = build_batch_evidence(assignment, class_, data)
    return assignment, class_, evidence


async def _run_batch_analysis_job(job_id: str, uid: int, assignment_id: int) -> None:
    from database import SessionLocal

    job = _BATCH_ANALYSIS_JOBS.get(job_id)
    if job is None:
        return
    usage = None
    finish_reason = None
    text_chars = 0
    metrics: dict = {}
    content = None
    llm_started = False
    recorded = False

    async def settle_call():
        return await record_llm_call(
            uid=uid,
            feature="batch_analysis",
            assignment_id=assignment_id,
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
            loaded = await _background_evidence(db, assignment_id, uid)
            if loaded is None:
                job["status"] = "error"
                job["error"] = "批次不存在"
                logger.warning("批次分析失败：批次不存在 job=%s assignment=%s", job_id, assignment_id)
                return
            assignment, class_, evidence = loaded
        if not evidence:
            job["status"] = "error"
            job["error"] = NO_DATA_HINT
            logger.warning("批次分析失败：无有效成绩 job=%s assignment=%s", job_id, assignment_id)
            return

        llm_started = True
        async for event in analyze_batch_analysis_stream(
            class_brief(class_, assignment)["name"], assignment.unit_label, evidence
        ):
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
            assignment = await db.get(Assignment, assignment_id)
            class_ = await db.get(Class, assignment.class_id) if assignment else None
            if assignment is None or class_ is None or class_.owner_uid != uid:
                job["status"] = "error"
                job["error"] = "批次不存在"
                return
            report = await upsert_batch_analysis_report(
                db,
                assignment_id=assignment_id,
                owner_uid=uid,
                content=content,
                model=ai_model(),
                usage=usage,
                metrics=metrics,
                cost_yuan=(settle or {}).get("cost_yuan", 0.0),
                price_tier=(settle or {}).get("price_tier", ""),
            )
        job["status"] = "done"
        job["result"] = batch_analysis_report_out(report)
        logger.info(
            "批次分析完成 job=%s assignment=%s tokens=%s/%s",
            job_id, assignment_id,
            (usage or {}).get("prompt_tokens", 0),
            (usage or {}).get("completion_tokens", 0),
        )
    except APITimeoutError:
        job["status"] = "error"
        job["error"] = "AI 响应超时，请稍后重试"
        logger.warning("批次分析超时 job=%s assignment=%s", job_id, assignment_id)
    except AIParseError as error:
        finish_reason = "parse_error"
        text_chars = len(error.raw or "")
        job["status"] = "error"
        job["error"] = f"AI 输出解析失败：{error}"
        logging.getLogger("autograde.ai").warning(
            "批次分析解析失败 job=%s raw=%s", job_id, (error.raw or "")[:300]
        )
    except AIUnavailable as error:
        job["status"] = "error"
        job["error"] = str(error)
        logger.warning("批次分析不可用 job=%s assignment=%s error=%s", job_id, assignment_id, error)
    except Exception:
        job["status"] = "error"
        job["error"] = "服务内部错误，请重试"
        logging.getLogger("autograde.ai").exception("批次分析任务异常 job=%s", job_id)
    finally:
        if llm_started and not recorded:
            await settle_call()


@router.get("/{assignment_id}/analysis")
async def get_batch_analysis(
    assignment_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    assignment = await owned_assignment(db, assignment_id, user)
    class_ = await db.get(Class, assignment.class_id)
    return await build_assignment_analysis(db, assignment, class_)


@ai_router.post("/batch-analysis/estimate")
async def estimate_batch_analysis(
    body: BatchAnalysisIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    assignment = await owned_assignment(db, body.assignment_id, user)
    class_ = await db.get(Class, assignment.class_id)
    data = await aggregate_batch(db, assignment)
    chars = len(build_batch_evidence(assignment, class_, data))
    est_prompt = 700 + int(chars / 1.5)
    est_output = 7000
    prices = await get_prices(db)
    tier = price_tier_at(datetime.now(timezone.utc), prices)
    return {
        "chars": chars,
        "est_prompt_tokens": est_prompt,
        "est_output_tokens": est_output,
        "est_total_tokens": est_prompt + est_output,
        "est_cost_yuan": estimate_cost(est_prompt, est_output, prices, tier),
        "price_tier": tier,
        "est_seconds": max(60, round((est_prompt + est_output) / 50)),
    }


@ai_router.post("/batch-analysis", status_code=202)
async def create_batch_analysis(
    body: BatchAnalysisIn,
    user: User = Depends(get_current_user),
) -> dict:
    from database import SessionLocal

    async with SessionLocal() as db:
        loaded = await _background_evidence(db, body.assignment_id, user.uid)
        if loaded is None:
            raise HTTPException(status_code=404, detail="批次不存在")
        _, _, evidence = loaded
    if not evidence:
        raise HTTPException(status_code=400, detail=NO_DATA_HINT)
    if not check_ai_rate(user.uid):
        raise HTTPException(status_code=429, detail=AI_RATE_HINT)
    try:
        ensure_available()
    except AIUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    _gc_jobs()
    job_id = uuid.uuid4().hex[:16]
    _BATCH_ANALYSIS_JOBS[job_id] = {
        "uid": user.uid,
        "assignment_id": body.assignment_id,
        "status": "running",
        "recv_chars": 0,
        "created": time.time(),
    }
    logger.info("批次分析任务创建 job=%s assignment=%s uid=%s", job_id, body.assignment_id, user.uid)
    asyncio.create_task(_run_batch_analysis_job(job_id, user.uid, body.assignment_id))
    return {"job_id": job_id}


@ai_router.get("/batch-analysis-jobs/{job_id}")
async def get_batch_analysis_job(
    job_id: str, user: User = Depends(get_current_user)
) -> dict:
    _gc_jobs()
    job = _BATCH_ANALYSIS_JOBS.get(job_id)
    if not job or job["uid"] != user.uid:
        raise HTTPException(status_code=404, detail="任务不存在或已过期，请重新发起")
    result = {"status": job["status"], "recv_chars": job.get("recv_chars", 0)}
    if job["status"] == "done":
        result["result"] = job["result"]
    elif job["status"] == "error":
        result["error"] = job["error"]
    return result
