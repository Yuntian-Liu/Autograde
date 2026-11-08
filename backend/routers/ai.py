"""AI 辅助接口：正式题库/独立预习拆分（任务制 + 轮询）与流式讲解、问答。

拆题是分钟级长任务：SSE 长连接会被边缘代理（ESA ~60s 无响应即 524）掐断，
故改为「POST 建任务立即返回 job_id + GET 轮询状态」——每次轮询都是短请求，代理免疫。
任务表在内存（单实例部署），服务重启任务失效，前端按「任务不存在」提示重试即可。
"""

import asyncio
import json
import logging
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from access import owned_assignment, owned_question
from ai import (
    AIParseError,
    APITimeoutError,
    AIResponseError,
    AIUnavailable,
    chat_stream,
    draft_explanation_stream,
    ensure_available,
    parse_questions_stream,
)
from ai import _model as ai_model
from auth.dependencies import get_current_user
from auth.models import User
from auth.utils import check_ai_rate
from database import get_db
from llm_events_store import record_llm_call
from preview_ai import parse_preview_stream

router = APIRouter(prefix="/api/ai", tags=["ai"])

TIMEOUT_HINT = "AI 响应超时，文档可能过长，请分段粘贴后重试"
AI_RATE_HINT = "AI 调用过于频繁，请稍后再试"

# 拆题任务表（内存，单实例）：job_id -> {uid, status, done_count, data/error, created}
_PARSE_JOBS: dict[str, dict] = {}
_JOB_TTL = 1800  # 30 分钟后清理


def _gc_jobs() -> None:
    now = time.time()
    for jid in [j for j, v in _PARSE_JOBS.items() if now - v["created"] > _JOB_TTL]:
        del _PARSE_JOBS[jid]


class ParseQuestionsIn(BaseModel):
    # 真实文档几千字，100k 字符余量极大；上限防恶意刷量
    raw_text: str = Field(..., max_length=100_000)
    assignment_id: int


async def _run_parse_job(job_id: str, raw_text: str, uid: int, assignment_id: int) -> None:
    job = _PARSE_JOBS[job_id]
    usage = None
    finish_reason = None
    text_chars = 0
    metrics: dict = {}
    provider_request_id = ""
    try:
        async for event in parse_questions_stream(raw_text):
            if event.get("provider_request_id"):
                provider_request_id = event["provider_request_id"]
                job["provider_request_id"] = provider_request_id
            if event["type"] == "stage":
                job["stage"] = event["stage"]
            elif event["type"] == "progress":
                job["stage"] = event.get("stage", "receiving")
                job["done_count"] = event["done"]
                job["recv_chars"] = event["recv_chars"]
                text_chars = event["recv_chars"]
            elif event["type"] == "done":
                usage = event.get("usage")
                finish_reason = event.get("finish_reason")
                text_chars = event.get("text_chars", 0)
                metrics = event.get("metrics") or {}
                job["status"] = "done"
                job["stage"] = "done"
                job["data"] = event["data"]
        logging.getLogger("autograde.ai").info(
            "正式拆题完成 job=%s assignment=%s questions=%s", job_id, assignment_id, job["done_count"]
        )
    except APITimeoutError:
        job["status"] = "error"
        job["error"] = TIMEOUT_HINT
    except AIParseError as error:
        finish_reason = "parse_error"
        text_chars = len(error.raw or "")
        job["status"] = "error"
        job["error"] = f"AI 输出解析失败：{error}"
    except AIUnavailable as error:
        job["status"] = "error"
        job["error"] = str(error)
    except Exception:
        job["status"] = "error"
        job["error"] = "服务内部错误，请重试"
        logging.getLogger("autograde.ai").exception("拆题任务异常 job=%s", job_id)
    finally:
        if job["status"] == "error":
            job["error_stage"] = job.get("stage", "preparing")
        await record_llm_call(
            uid=uid,
            feature="parse_questions",
            model=ai_model(),
            prompt_tokens=(usage or {}).get("prompt_tokens", 0),
            completion_tokens=(usage or {}).get("completion_tokens", 0),
            finish_reason=finish_reason,
            is_empty=text_chars == 0,
            assignment_id=assignment_id,
            cache_hit_tokens=(usage or {}).get("cache_hit_tokens", 0),
            cache_miss_tokens=(usage or {}).get("cache_miss_tokens", 0),
            reasoning_tokens=(usage or {}).get("reasoning_tokens", 0),
            job_id=job_id,
            provider_request_id=provider_request_id,
            **{k: metrics.get(k, 0) for k in ("ttft_ms", "think_ms", "total_ms")},
        )


@router.post("/parse-questions", status_code=202)
async def parse_questions_api(
    body: ParseQuestionsIn,
    user: User = Depends(get_current_user),
) -> dict:
    from database import SessionLocal

    async with SessionLocal() as db:
        await owned_assignment(db, body.assignment_id, user)
    if not check_ai_rate(user.uid):
        raise HTTPException(status_code=429, detail=AI_RATE_HINT)
    if not body.raw_text.strip():
        raise HTTPException(status_code=400, detail="粘贴内容不能为空")
    try:
        ensure_available()
    except AIUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    _gc_jobs()
    job_id = uuid.uuid4().hex[:16]
    _PARSE_JOBS[job_id] = {
        "uid": user.uid,
        "status": "running",
        "stage": "preparing",
        "model": ai_model(),
        "done_count": 0,
        "recv_chars": 0,
        "created": time.time(),
    }
    logging.getLogger("autograde.ai").info(
        "正式拆题任务创建 job=%s assignment=%s uid=%s", job_id, body.assignment_id, user.uid
    )
    asyncio.create_task(_run_parse_job(job_id, body.raw_text, user.uid, body.assignment_id))
    return {"job_id": job_id, "model": ai_model()}


@router.get("/parse-jobs/{job_id}")
async def get_parse_job(job_id: str, user: User = Depends(get_current_user)) -> dict:
    job = _PARSE_JOBS.get(job_id)
    if not job or job["uid"] != user.uid:
        raise HTTPException(status_code=404, detail="任务不存在或已过期，请重新发起")
    out = {
        "status": job["status"],
        "stage": job.get("stage", "preparing"),
        "model": job.get("model") or ai_model(),
        "job_id": job_id,
        "elapsed_seconds": int(time.time() - job["created"]),
        "done_count": job.get("done_count", 0),
        "recv_chars": job.get("recv_chars", 0),
        "provider_request_id": job.get("provider_request_id", ""),
    }
    if job["status"] == "done":
        out["data"] = job["data"]
    elif job["status"] == "error":
        out["error"] = job["error"]
        out["error_stage"] = job.get("error_stage", "")
    return out


class ChatIn(BaseModel):
    messages: list[dict] = Field(..., max_length=20)
    assignment_id: int | None = None  # 仅成本归属上下文，不进 prompt（盲答原则）
    web_search: bool = False


@router.post("/chat")
async def chat_api(body: ChatIn, user: User = Depends(get_current_user)):
    """AI 助教浮窗问答（SSE 流式）：通用问答无角色设定，ESA 对持续字节流不掐。"""
    msgs = []
    for m in body.messages:
        role = m.get("role")
        content = str(m.get("content", ""))
        if role not in ("user", "assistant"):
            raise HTTPException(status_code=400, detail="消息角色非法")
        if not content.strip() or len(content) > 4000:
            raise HTTPException(status_code=400, detail="消息为空或超长")
        msgs.append({"role": role, "content": content})
    if not msgs or msgs[-1]["role"] != "user":
        raise HTTPException(status_code=400, detail="最后一条必须是提问")
    if not check_ai_rate(user.uid):
        raise HTTPException(status_code=429, detail=AI_RATE_HINT)
    if body.assignment_id is not None:
        from database import SessionLocal

        async with SessionLocal() as db:
            await owned_assignment(db, body.assignment_id, user)
    try:
        ensure_available()
    except AIUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    async def gen():
        usage = None
        finish_reason = None
        text_chars = 0
        web_search_count = 0
        metrics: dict = {}
        provider_request_id = ""
        stage = "preparing"
        try:
            async for event in chat_stream(msgs, web_search=body.web_search):
                provider_request_id = event.get("provider_request_id") or provider_request_id
                if event["type"] == "stage":
                    stage = event["stage"]
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                elif event["type"] == "delta":
                    stage = "receiving"
                    text_chars = event.get("recv_chars", text_chars)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                elif event["type"] == "done":
                    usage = event["usage"]
                    finish_reason = event["finish_reason"]
                    text_chars = event["text_chars"]
                    web_search_count = event.get("web_search_count", 0)
                    metrics = event.get("metrics") or {}
                    settle = await record_llm_call(
                        uid=user.uid,
                        feature="chat",
                        model=ai_model(),
                        prompt_tokens=(usage or {}).get("prompt_tokens", 0),
                        completion_tokens=(usage or {}).get("completion_tokens", 0),
                        finish_reason=finish_reason,
                        is_empty=text_chars == 0,
                        assignment_id=body.assignment_id,
                        cache_hit_tokens=(usage or {}).get("cache_hit_tokens", 0),
                        cache_miss_tokens=(usage or {}).get("cache_miss_tokens", 0),
                        reasoning_tokens=(usage or {}).get("reasoning_tokens", 0),
                        web_search_count=web_search_count,
                        provider_request_id=provider_request_id,
                        **{k: metrics.get(k, 0) for k in ("ttft_ms", "think_ms", "total_ms")},
                    )
                    payload = {
                        "type": "done",
                        "usage": usage or {},
                        "metrics": metrics,
                        "cost_yuan": (settle or {}).get("cost_yuan", 0),
                        "price_tier": (settle or {}).get("price_tier", ""),
                        "web_search_count": web_search_count,
                        "provider_request_id": provider_request_id,
                    }
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        except Exception as e:
            logging.getLogger("autograde.ai").warning("chat 流异常 stage=%s: %s", stage, str(e)[:200])
            await record_llm_call(
                uid=user.uid,
                feature="chat",
                model=ai_model(),
                prompt_tokens=(usage or {}).get("prompt_tokens", 0),
                completion_tokens=(usage or {}).get("completion_tokens", 0),
                finish_reason=finish_reason,
                is_empty=text_chars == 0,
                assignment_id=body.assignment_id,
                web_search_count=web_search_count,
                provider_request_id=provider_request_id,
                **{k: metrics.get(k, 0) for k in ("ttft_ms", "think_ms", "total_ms")},
            )
            if isinstance(e, AIResponseError):
                hint = str(e)
            elif isinstance(e, APITimeoutError):
                hint = "AI 响应超时，请重试"
            else:
                hint = "AI 服务异常，请重试"
            yield f"data: {json.dumps({'type': 'error', 'message': hint, 'stage': stage}, ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


class DraftExplanationIn(BaseModel):
    question_id: int
    error_description: str = Field(..., max_length=2_000)


@router.post("/draft-explanation")
async def draft_explanation_api(
    body: DraftExplanationIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = await owned_question(db, body.question_id, user)
    if not check_ai_rate(user.uid):
        raise HTTPException(status_code=429, detail=AI_RATE_HINT)
    if not body.error_description.strip():
        raise HTTPException(status_code=400, detail="请先描述学生错点")
    try:
        ensure_available()
    except AIUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    async def gen():
        usage = None
        finish_reason = None
        text_chars = 0
        metrics: dict = {}
        provider_request_id = ""
        stage = "preparing"
        try:
            async for event in draft_explanation_stream(q, body.error_description):
                provider_request_id = event.get("provider_request_id") or provider_request_id
                if event["type"] in ("stage", "delta"):
                    if event["type"] == "stage":
                        stage = event["stage"]
                    else:
                        stage = "receiving"
                        text_chars = event.get("recv_chars", text_chars)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                elif event["type"] == "done":
                    usage = event.get("usage")
                    finish_reason = event.get("finish_reason")
                    text_chars = event.get("text_chars", 0)
                    metrics = event.get("metrics") or {}
                    settle = await record_llm_call(
                        uid=user.uid,
                        feature="draft_explanation",
                        model=ai_model(),
                        prompt_tokens=(usage or {}).get("prompt_tokens", 0),
                        completion_tokens=(usage or {}).get("completion_tokens", 0),
                        finish_reason=finish_reason,
                        is_empty=text_chars == 0,
                        assignment_id=q.assignment_id,
                        cache_hit_tokens=(usage or {}).get("cache_hit_tokens", 0),
                        cache_miss_tokens=(usage or {}).get("cache_miss_tokens", 0),
                        reasoning_tokens=(usage or {}).get("reasoning_tokens", 0),
                        provider_request_id=provider_request_id,
                        **{k: metrics.get(k, 0) for k in ("ttft_ms", "think_ms", "total_ms")},
                    )
                    payload = {
                        "type": "done",
                        "draft": event["text"],
                        "cost_yuan": (settle or {}).get("cost_yuan", 0),
                        "price_tier": (settle or {}).get("price_tier", ""),
                        "provider_request_id": provider_request_id,
                    }
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        except Exception as error:
            logging.getLogger("autograde.ai").warning(
                "讲解起草失败 stage=%s question=%s error=%s", stage, q.id, str(error)[:200]
            )
            await record_llm_call(
                uid=user.uid,
                feature="draft_explanation",
                model=ai_model(),
                prompt_tokens=(usage or {}).get("prompt_tokens", 0),
                completion_tokens=(usage or {}).get("completion_tokens", 0),
                finish_reason=finish_reason,
                is_empty=text_chars == 0,
                assignment_id=q.assignment_id,
                provider_request_id=provider_request_id,
                **{k: metrics.get(k, 0) for k in ("ttft_ms", "think_ms", "total_ms")},
            )
            hint = "AI 响应超时，请重试" if isinstance(error, APITimeoutError) else str(error) if isinstance(error, AIParseError) else "AI 服务异常，请重试"
            yield f"data: {json.dumps({'type': 'error', 'message': hint, 'stage': stage}, ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


_PREVIEW_JOBS: dict[str, dict] = {}


def _gc_preview_jobs() -> None:
    now = time.time()
    for job_id in [jid for jid, value in _PREVIEW_JOBS.items() if now - value["created"] > _JOB_TTL]:
        del _PREVIEW_JOBS[job_id]


def _preview_job_out(job_id: str, job: dict) -> dict:
    out = {
        "status": job["status"],
        "stage": job.get("stage", "preparing"),
        "model": job.get("model") or ai_model(),
        "job_id": job_id,
        "elapsed_seconds": int(time.time() - job["created"]),
        "done_count": job.get("done_count", 0),
        "recv_chars": job.get("recv_chars", 0),
        "provider_request_id": job.get("provider_request_id", ""),
    }
    if job["status"] == "done":
        out["data"] = job["data"]
    elif job["status"] == "error":
        out["error"] = job["error"]
        out["error_stage"] = job.get("error_stage", "")
    return out


async def _run_preview_job(job_id: str, raw_text: str, uid: int, assignment_id: int) -> None:
    job = _PREVIEW_JOBS[job_id]
    usage = None
    finish_reason = None
    text_chars = 0
    metrics: dict = {}
    provider_request_id = ""
    try:
        async for event in parse_preview_stream(raw_text):
            if event.get("model"):
                job["model"] = event["model"]
            if event.get("provider_request_id"):
                provider_request_id = event["provider_request_id"]
                job["provider_request_id"] = provider_request_id
            if event["type"] == "stage":
                job["stage"] = event["stage"]
            elif event["type"] == "progress":
                job["stage"] = event.get("stage", "receiving")
                job["done_count"] = event["done"]
                job["recv_chars"] = event["recv_chars"]
                text_chars = event["recv_chars"]
            elif event["type"] == "done":
                usage = event.get("usage")
                finish_reason = event.get("finish_reason")
                text_chars = event.get("text_chars", 0)
                metrics = event.get("metrics") or {}
                job["status"] = "done"
                job["stage"] = "done"
                job["data"] = event["data"]
        logging.getLogger("autograde.ai").info(
            "预习拆分完成 job=%s assignment=%s questions=5", job_id, assignment_id
        )
    except APITimeoutError:
        job["status"] = "error"
        job["error"] = "AI 响应超时，请稍后重试"
    except AIParseError as error:
        finish_reason = "parse_error"
        text_chars = len(error.raw or "")
        job["status"] = "error"
        job["error"] = f"AI 输出解析失败：{error}"
    except AIUnavailable as error:
        job["status"] = "error"
        job["error"] = str(error)
    except Exception:
        job["status"] = "error"
        job["error"] = "AI 服务异常，请稍后重试"
        logging.getLogger("autograde.ai").exception("预习拆分异常 job=%s", job_id)
    finally:
        if job["status"] == "error":
            job["error_stage"] = job.get("stage", "preparing")
            logging.getLogger("autograde.ai").warning(
                "预习拆分失败 job=%s stage=%s", job_id, job["error_stage"]
            )
        await record_llm_call(
            uid=uid,
            feature="parse_preview",
            model=ai_model(),
            prompt_tokens=(usage or {}).get("prompt_tokens", 0),
            completion_tokens=(usage or {}).get("completion_tokens", 0),
            finish_reason=finish_reason,
            is_empty=text_chars == 0,
            assignment_id=assignment_id,
            cache_hit_tokens=(usage or {}).get("cache_hit_tokens", 0),
            cache_miss_tokens=(usage or {}).get("cache_miss_tokens", 0),
            reasoning_tokens=(usage or {}).get("reasoning_tokens", 0),
            job_id=job_id,
            provider_request_id=provider_request_id,
            **{key: metrics.get(key, 0) for key in ("ttft_ms", "think_ms", "total_ms")},
        )


@router.post("/parse-preview", status_code=202)
async def parse_preview_api(body: ParseQuestionsIn, user: User = Depends(get_current_user)) -> dict:
    from database import SessionLocal

    async with SessionLocal() as db:
        assignment = await owned_assignment(db, body.assignment_id, user)
        if not assignment.has_preview:
            raise HTTPException(status_code=400, detail="该批次未开启预习")
    if not body.raw_text.strip():
        raise HTTPException(status_code=400, detail="粘贴内容不能为空")
    if not check_ai_rate(user.uid):
        raise HTTPException(status_code=429, detail=AI_RATE_HINT)
    try:
        ensure_available()
    except AIUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    _gc_preview_jobs()
    job_id = uuid.uuid4().hex[:16]
    _PREVIEW_JOBS[job_id] = {
        "uid": user.uid,
        "status": "running",
        "stage": "preparing",
        "model": ai_model(),
        "done_count": 0,
        "recv_chars": 0,
        "created": time.time(),
    }
    logging.getLogger("autograde.ai").info(
        "预习拆分任务创建 job=%s assignment=%s uid=%s", job_id, body.assignment_id, user.uid
    )
    asyncio.create_task(_run_preview_job(job_id, body.raw_text, user.uid, body.assignment_id))
    return {"job_id": job_id, "model": ai_model()}


@router.get("/preview-jobs/{job_id}")
async def get_preview_job(job_id: str, user: User = Depends(get_current_user)) -> dict:
    _gc_preview_jobs()
    job = _PREVIEW_JOBS.get(job_id)
    if not job or job["uid"] != user.uid:
        raise HTTPException(status_code=404, detail="任务不存在或已过期，请重新发起")
    return _preview_job_out(job_id, job)
