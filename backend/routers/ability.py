"""能力分析报告：AI 起草（任务制 + 轮询，草稿不落库）→ 人工定稿 → 存档。

存档不可变：只提供创建/列表/详情，刻意不提供更新与删除——历次报告全量留存可回看。
长任务走任务制（ESA 边缘 ~60s 掐长连接，照拆题的成熟模式）。
"""

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ability import build_evidence
from access import owned_student
from ai import (
    AIParseError,
    APITimeoutError,
    AIUnavailable,
    analyze_ability_stream,
    ensure_available,
    validate_ability_data,
)
from ai import _model as ai_model
from auth.dependencies import get_current_user
from auth.models import User
from auth.utils import check_ai_rate
from database import get_db
from llm_events_store import estimate_cost, get_prices, price_tier_at, record_llm_call
from models import AbilityReport, Class, Student

router = APIRouter(prefix="/api/ai", tags=["ai"])
reports_router = APIRouter(prefix="/api/students", tags=["students"])

AI_RATE_HINT = "AI 调用过于频繁，请稍后再试"

# 分析任务表（内存，单实例）：job_id -> {uid, status, elapsed, data/error, created}
_ABILITY_JOBS: dict[str, dict] = {}
_JOB_TTL = 1800


def _gc_jobs() -> None:
    now = time.time()
    for jid in [j for j, v in _ABILITY_JOBS.items() if now - v["created"] > _JOB_TTL]:
        del _ABILITY_JOBS[jid]


class AbilityReportIn(BaseModel):
    student_id: int
    range_start: str = Field("", max_length=10)  # ISO 日期，空 = 全部历史
    range_end: str = Field("", max_length=10)


def _report_out(r: AbilityReport) -> dict:
    scores = json.loads(r.scores) if r.scores else {}
    dims = json.loads(r.dimensions) if r.dimensions else []
    return {
        "id": r.id,
        "student_id": r.student_id,
        "range_start": r.range_start,
        "range_end": r.range_end,
        "assignment_count": r.assignment_count,
        "scores": scores,
        "dimensions": dims,
        "overall": r.overall,
        "suggestions": r.suggestions,
        "prompt_tokens": r.prompt_tokens,
        "completion_tokens": r.completion_tokens,
        "elapsed_seconds": r.elapsed_seconds,
        "cost_yuan": r.cost_yuan,
        "price_tier": r.price_tier or "",
        "created_at": r.created_at.isoformat() if r.created_at else "",
    }


async def _run_ability_job(job_id: str, uid: int, student_id: int, start: str, end: str) -> None:
    """后台跑分析：构建证据 → AI 起草；成本埋点在 finally（自带 session）。"""
    from database import SessionLocal

    job = _ABILITY_JOBS[job_id]
    usage = None
    finish_reason = None
    text_chars = 0
    metrics: dict = {}
    try:
        async with SessionLocal() as db:
            s = await db.get(Student, student_id)
            evidence = await build_evidence(db, s, start, end)
            c = await db.get(Class, s.class_id)
            class_label = f"{c.name}（{'厚少' if c.series == 'WW' else '厚中'}）" if c else ""
        if not evidence["evidence_text"]:
            job["status"] = "error"
            job["error"] = "该学生在所选时间范围内没有作业数据，无法生成报告"
            return
        async for event in analyze_ability_stream(s.name, class_label, evidence["evidence_text"]):
            if event["type"] == "progress":
                job["recv_chars"] = event["recv_chars"]
            elif event["type"] == "done":
                usage = event["usage"]
                finish_reason = event["finish_reason"]
                text_chars = event["text_chars"]
                metrics = event.get("metrics") or {}
                job["status"] = "done"
                job["data"] = {
                    **event["data"],
                    "range_start": start,
                    "range_end": end,
                    "assignment_count": evidence["assignment_count"],
                    "prompt_tokens": (usage or {}).get("prompt_tokens", 0),
                    "completion_tokens": (usage or {}).get("completion_tokens", 0),
                    "elapsed_seconds": int(time.time() - job["created"]),
                }
    except APITimeoutError:
        job["status"] = "error"
        job["error"] = "AI 响应超时，请稍后重试"
    except AIParseError as e:
        finish_reason = "parse_error"
        text_chars = len(e.raw or "")
        job["status"] = "error"
        job["error"] = f"AI 输出解析失败：{e}"
        logging.getLogger("autograde.ai").warning("能力报告解析失败 job=%s raw=%s", job_id, (e.raw or "")[:300])
    except AIUnavailable as e:
        job["status"] = "error"
        job["error"] = str(e)
    except Exception:
        job["status"] = "error"
        job["error"] = "服务内部错误，请重试"
        logging.getLogger("autograde.ai").exception("能力报告任务异常 job=%s", job_id)
    finally:
        settle = await record_llm_call(
            uid=uid,
            feature="ability_report",
            model=ai_model(),
            prompt_tokens=(usage or {}).get("prompt_tokens", 0),
            completion_tokens=(usage or {}).get("completion_tokens", 0),
            finish_reason=finish_reason,
            is_empty=text_chars == 0,
            student_id=student_id,
            cache_hit_tokens=(usage or {}).get("cache_hit_tokens", 0),
            cache_miss_tokens=(usage or {}).get("cache_miss_tokens", 0),
            reasoning_tokens=(usage or {}).get("reasoning_tokens", 0),
            **{k: metrics.get(k, 0) for k in ("ttft_ms", "think_ms", "total_ms")},
        )
        # 结算结果回填进草稿数据（报告页 meta 显示本次生成成本）
        if settle and job.get("status") == "done" and job.get("data") is not None:
            job["data"]["cost_yuan"] = settle["cost_yuan"]
            job["data"]["price_tier"] = settle["price_tier"]


@router.post("/ability-report", status_code=202)
async def create_ability_report(
    body: AbilityReportIn,
    user: User = Depends(get_current_user),
) -> dict:
    """建能力分析任务并立即返回 job_id；结果走 GET /ability-jobs/{job_id} 轮询。"""
    from database import SessionLocal

    async with SessionLocal() as db:
        await owned_student(db, body.student_id, user)
    if not check_ai_rate(user.uid):
        raise HTTPException(status_code=429, detail=AI_RATE_HINT)
    try:
        ensure_available()
    except AIUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    _gc_jobs()
    job_id = uuid.uuid4().hex[:16]
    _ABILITY_JOBS[job_id] = {
        "uid": user.uid,
        "status": "running",
        "created": time.time(),
    }
    asyncio.create_task(
        _run_ability_job(job_id, user.uid, body.student_id, body.range_start.strip(), body.range_end.strip())
    )
    return {"job_id": job_id}


@router.get("/ability-jobs/{job_id}")
async def get_ability_job(job_id: str, user: User = Depends(get_current_user)) -> dict:
    """轮询分析任务：running（带 elapsed 秒）/ done（带草稿 data）/ error。"""
    job = _ABILITY_JOBS.get(job_id)
    if not job or job["uid"] != user.uid:
        raise HTTPException(status_code=404, detail="任务不存在或已过期，请重新发起")
    out = {"status": job["status"], "elapsed": int(time.time() - job["created"])}
    if job["status"] == "running":
        out["recv_chars"] = job.get("recv_chars", 0)
    if job["status"] == "done":
        out["data"] = job["data"]
    elif job["status"] == "error":
        out["error"] = job["error"]
    return out


@router.post("/ability-report/estimate")
async def estimate_ability_report(
    body: AbilityReportIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """生成前预估：证据字符数 → 估算输入/输出 token 与费用（按当前峰谷价）、数据量。

    经验系数：中文约 1.5 字符/token；系统提示词 ~900 token；输出 ~2500 token（六维细析+证据）。
    只做本地聚合不调 AI，毫秒级返回。"""
    s = await owned_student(db, body.student_id, user)
    evidence = await build_evidence(db, s, body.range_start.strip(), body.range_end.strip())
    chars = len(evidence["evidence_text"])
    est_prompt = 900 + int(chars / 1.5)
    # 推理模型的思考 token 计入输出计费：实测报告输出 ~9000 token（可见正文仅 ~2500）
    est_output = 9000
    prices = await get_prices(db)
    tier = price_tier_at(datetime.now(timezone.utc), prices)
    return {
        "assignment_count": evidence["assignment_count"],
        "evidence_chars": chars,
        "est_prompt_tokens": est_prompt,
        "est_output_tokens": est_output,
        "est_cost_yuan": estimate_cost(est_prompt, est_output, prices, tier),
        "price_tier": tier,
        "has_data": bool(evidence["evidence_text"]),
    }


class AbilityReportSave(BaseModel):
    range_start: str = Field("", max_length=10)
    range_end: str = Field("", max_length=10)
    assignment_count: int = Field(0, ge=0)
    overall: str
    suggestions: str
    dimensions: list[dict]
    prompt_tokens: int = Field(0, ge=0)
    completion_tokens: int = Field(0, ge=0)
    elapsed_seconds: int = Field(0, ge=0)
    cost_yuan: float = Field(0.0, ge=0)
    price_tier: str = Field("", max_length=8)


@reports_router.post("/{student_id}/ability-reports", status_code=201)
async def save_ability_report(
    student_id: int,
    body: AbilityReportSave,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """存定稿：人工编辑后的完整报告，服务端按 AI 输出同一套 schema 再校验。"""
    await owned_student(db, student_id, user)
    try:
        data = validate_ability_data(
            {"overall": body.overall, "suggestions": body.suggestions, "dimensions": body.dimensions}
        )
    except AIParseError as e:
        raise HTTPException(status_code=422, detail=f"报告结构不完整：{e}") from e
    r = AbilityReport(
        student_id=student_id,
        range_start=body.range_start.strip(),
        range_end=body.range_end.strip(),
        assignment_count=body.assignment_count,
        scores=json.dumps(data["scores"], ensure_ascii=False),
        dimensions=json.dumps(data["dimensions"], ensure_ascii=False),
        overall=data["overall"],
        suggestions=data["suggestions"],
        prompt_tokens=body.prompt_tokens,
        completion_tokens=body.completion_tokens,
        elapsed_seconds=body.elapsed_seconds,
        cost_yuan=body.cost_yuan,
        price_tier=body.price_tier.strip(),
    )
    db.add(r)
    await db.commit()
    await db.refresh(r)
    return _report_out(r)


@reports_router.get("/{student_id}/ability-reports")
async def list_ability_reports(
    student_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """历次报告列表（时间倒序）：摘要字段 + 六维分数，供列表行与对比选择。"""
    await owned_student(db, student_id, user)
    rows = (
        await db.execute(
            select(AbilityReport)
            .where(AbilityReport.student_id == student_id)
            .order_by(AbilityReport.created_at.desc(), AbilityReport.id.desc())
        )
    ).scalars().all()
    return [
        {
            "id": r.id,
            "range_start": r.range_start,
            "range_end": r.range_end,
            "assignment_count": r.assignment_count,
            "scores": json.loads(r.scores) if r.scores else {},
            "created_at": r.created_at.isoformat() if r.created_at else "",
        }
        for r in rows
    ]


@reports_router.get("/{student_id}/ability-reports/{report_id}")
async def get_ability_report(
    student_id: int,
    report_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    await owned_student(db, student_id, user)
    r = await db.get(AbilityReport, report_id)
    if r is None or r.student_id != student_id:
        raise HTTPException(status_code=404, detail="报告不存在")
    return _report_out(r)
