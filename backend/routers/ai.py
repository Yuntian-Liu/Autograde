"""AI 辅助接口：题库结构化拆分（SSE 流式，草稿不落库）与讲解起草。"""

import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from access import owned_assignment, owned_question
from ai import (
    AIParseError,
    APITimeoutError,
    AIUnavailable,
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


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


class ParseQuestionsIn(BaseModel):
    # 真实文档几千字，100k 字符余量极大；上限防恶意刷量
    raw_text: str = Field(..., max_length=100_000)
    assignment_id: int


@router.post("/parse-questions")
async def parse_questions_api(
    body: ParseQuestionsIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StreamingResponse:
    """SSE 事件流：progress（已整理题目数）→ done（完整草稿）/ error（中文原因）。"""
    await owned_assignment(db, body.assignment_id, user)
    if not check_ai_rate(user.uid):
        raise HTTPException(status_code=429, detail=AI_RATE_HINT)
    if not body.raw_text.strip():
        raise HTTPException(status_code=400, detail="粘贴内容不能为空")
    try:
        ensure_available()  # key 缺失在起流前按 503 快速失败
    except AIUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    async def event_stream():
        usage = None
        finish_reason = None
        text_chars = 0
        try:
            async for event in parse_questions_stream(body.raw_text):
                if event["type"] == "done":
                    usage = event.get("usage")
                    finish_reason = event.get("finish_reason")
                    text_chars = event.get("text_chars", 0)
                yield _sse(event)
        except APITimeoutError:
            yield _sse({"type": "error", "detail": TIMEOUT_HINT})
        except AIParseError as e:
            finish_reason = "parse_error"
            text_chars = len(e.raw or "")
            yield _sse(
                {"type": "error", "detail": f"AI 输出解析失败：{e}｜原始输出片段：{e.raw}"}
            )
        except AIUnavailable as e:
            yield _sse({"type": "error", "detail": str(e)})
        finally:
            # 成本埋点：成功/失败/空回答都记一行，绝不阻断主流程
            await record_llm_call(
                uid=user.uid,
                feature="parse_questions",
                model=ai_model(),
                prompt_tokens=(usage or {}).get("prompt_tokens", 0),
                completion_tokens=(usage or {}).get("completion_tokens", 0),
                finish_reason=finish_reason,
                is_empty=text_chars == 0,
                assignment_id=body.assignment_id,
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
    try:
        result = await draft_explanation(q, body.error_description)
        text, usage, finish_reason = result["text"], result["usage"], result["finish_reason"]
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
        )
    return {"draft": text}
