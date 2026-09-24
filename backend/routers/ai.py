"""AI 辅助接口：题库结构化拆分（任务制 + 轮询，草稿不落库）与讲解起草。

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
    AIUnavailable,
    chat_stream,
    draft_explanation,
    ensure_available,
    parse_questions_stream,
)
from ai import _model as ai_model
from auth.dependencies import get_current_user
from auth.models import User
from auth.utils import check_ai_rate
from database import get_db
from llm_events_store import record_llm_call

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
    """后台跑拆题流：progress 更新计数，done/error 落任务表；成本埋点在 finally（自带 session）。"""
    job = _PARSE_JOBS[job_id]
    usage = None
    finish_reason = None
    text_chars = 0
    metrics: dict = {}
    try:
        async for event in parse_questions_stream(raw_text):
            if event["type"] == "progress":
                job["done_count"] = event["done"]
            elif event["type"] == "done":
                usage = event.get("usage")
                finish_reason = event.get("finish_reason")
                text_chars = event.get("text_chars", 0)
                metrics = event.get("metrics") or {}
                job["status"] = "done"
                job["data"] = event["data"]
    except APITimeoutError:
        job["status"] = "error"
        job["error"] = TIMEOUT_HINT
    except AIParseError as e:
        finish_reason = "parse_error"
        text_chars = len(e.raw or "")
        job["status"] = "error"
        job["error"] = f"AI 输出解析失败：{e}｜原始输出片段：{e.raw}"
    except AIUnavailable as e:
        job["status"] = "error"
        job["error"] = str(e)
    except Exception:
        job["status"] = "error"
        job["error"] = "服务内部错误，请重试"
        logging.getLogger("autograde.ai").exception("拆题任务异常 job=%s", job_id)
    finally:
        # 成本埋点：成功/失败/空回答都记一行，绝不阻断主流程
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
            **{k: metrics.get(k, 0) for k in ("ttft_ms", "think_ms", "total_ms")},
        )


@router.post("/parse-questions", status_code=202)
async def parse_questions_api(
    body: ParseQuestionsIn,
    user: User = Depends(get_current_user),
) -> dict:
    """建拆题任务并立即返回 job_id；结果走 GET /parse-jobs/{job_id} 轮询。"""
    # 注意：owned_assignment 需要 db，这里不开请求级 session 进后台任务（任务内不碰请求 session）
    from database import SessionLocal

    async with SessionLocal() as db:
        await owned_assignment(db, body.assignment_id, user)
    if not check_ai_rate(user.uid):
        raise HTTPException(status_code=429, detail=AI_RATE_HINT)
    if not body.raw_text.strip():
        raise HTTPException(status_code=400, detail="粘贴内容不能为空")
    try:
        ensure_available()  # key 缺失在建任务前按 503 快速失败
    except AIUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    _gc_jobs()
    job_id = uuid.uuid4().hex[:16]
    _PARSE_JOBS[job_id] = {
        "uid": user.uid,
        "status": "running",
        "done_count": 0,
        "created": time.time(),
    }
    asyncio.create_task(_run_parse_job(job_id, body.raw_text, user.uid, body.assignment_id))
    return {"job_id": job_id}


@router.get("/parse-jobs/{job_id}")
async def get_parse_job(job_id: str, user: User = Depends(get_current_user)) -> dict:
    """轮询拆题任务：running（带 done_count）/ done（带 data）/ error（带 error）。"""
    job = _PARSE_JOBS.get(job_id)
    if not job or job["uid"] != user.uid:
        raise HTTPException(status_code=404, detail="任务不存在或已过期，请重新发起")
    out = {"status": job["status"], "done_count": job["done_count"]}
    if job["status"] == "done":
        out["data"] = job["data"]
    elif job["status"] == "error":
        out["error"] = job["error"]
    return out


class ChatIn(BaseModel):
    messages: list[dict] = Field(..., max_length=20)
    assignment_id: int | None = None  # 仅成本归属上下文，不进 prompt（盲答原则）


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
        metrics: dict = {}
        try:
            async for event in chat_stream(msgs):
                if event["type"] == "delta":
                    yield f"data: {json.dumps({'type': 'delta', 'text': event['text']}, ensure_ascii=False)}\n\n"
                elif event["type"] == "done":
                    usage = event["usage"]
                    finish_reason = event["finish_reason"]
                    text_chars = event["text_chars"]
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
                        **{k: metrics.get(k, 0) for k in ("ttft_ms", "think_ms", "total_ms")},
                    )
                    payload = {
                        "type": "done",
                        "usage": usage or {},
                        "metrics": metrics,
                        "cost_yuan": (settle or {}).get("cost_yuan", 0),
                        "price_tier": (settle or {}).get("price_tier", ""),
                    }
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        except Exception as e:  # 流中断：落一条失败埋点 + 给前端可读错误帧
            logging.getLogger("autograde.ai").warning("chat 流异常: %s", str(e)[:200])
            await record_llm_call(
                uid=user.uid,
                feature="chat",
                model=ai_model(),
                prompt_tokens=(usage or {}).get("prompt_tokens", 0),
                completion_tokens=(usage or {}).get("completion_tokens", 0),
                finish_reason=finish_reason,
                is_empty=text_chars == 0,
                assignment_id=body.assignment_id,
            )
            hint = "AI 响应超时，请重试" if isinstance(e, APITimeoutError) else "AI 服务异常，请重试"
            yield f"data: {json.dumps({'type': 'error', 'message': hint}, ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


class DraftExplanationIn(BaseModel):
    question_id: int
    error_description: str = Field(..., max_length=2_000)


@router.post("/draft-explanation")
async def draft_explanation_api(
    body: DraftExplanationIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    q = await owned_question(db, body.question_id, user)
    if not check_ai_rate(user.uid):
        raise HTTPException(status_code=429, detail=AI_RATE_HINT)
    if not body.error_description.strip():
        raise HTTPException(status_code=400, detail="请先描述学生错点")
    text = ""
    usage = None
    finish_reason = None
    metrics: dict = {}
    try:
        result = await draft_explanation(q, body.error_description)
        text, usage, finish_reason = result["text"], result["usage"], result["finish_reason"]
        metrics = result.get("metrics") or {}
    except AIUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except APITimeoutError as e:
        raise HTTPException(status_code=504, detail="AI 响应超时，请稍后重试") from e
    finally:
        await record_llm_call(
            uid=user.uid,
            feature="draft_explanation",
            model=ai_model(),
            prompt_tokens=(usage or {}).get("prompt_tokens", 0),
            completion_tokens=(usage or {}).get("completion_tokens", 0),
            finish_reason=finish_reason,
            is_empty=not text.strip(),
            assignment_id=q.assignment_id,
            cache_hit_tokens=(usage or {}).get("cache_hit_tokens", 0),
            cache_miss_tokens=(usage or {}).get("cache_miss_tokens", 0),
            reasoning_tokens=(usage or {}).get("reasoning_tokens", 0),
            **{k: metrics.get(k, 0) for k in ("ttft_ms", "think_ms", "total_ms")},
        )
    return {"draft": text}
