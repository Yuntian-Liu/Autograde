"""题库写接口：单题修改 / 删除（批量冻结入库见 assignments 路由）。"""

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from access import owned_question
from auth.dependencies import get_current_user
from auth.models import User
from database import get_db
from models import ErrorRecord, Question
from serializers import question_brief

router = APIRouter(prefix="/api/questions", tags=["questions"])

QUESTION_MODES = ("verbatim", "ai_expand", "manual")


class QuestionPatch(BaseModel):
    seq: int | None = None
    section: str | None = None
    mode: str | None = None
    stem: str | None = None
    options: list[str] | None = None  # 选项数组，入库时转 JSON 字符串
    standard_answer: str | None = None
    explanation: str | None = None
    score_weight: float | None = None


@router.patch("/{question_id}")
async def update_question(
    question_id: int,
    body: QuestionPatch,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    q = await owned_question(db, question_id, user)
    if body.mode is not None and body.mode not in QUESTION_MODES:
        raise HTTPException(status_code=400, detail=f"未知题目模式：{body.mode}")
    for field in ("seq", "section", "mode", "stem", "standard_answer", "explanation", "score_weight"):
        value = getattr(body, field)
        if value is not None:
            setattr(q, field, value)
    if body.options is not None:
        q.options = json.dumps(body.options, ensure_ascii=False)
    await db.commit()
    return question_brief(q)


@router.delete("/{question_id}", status_code=204)
async def delete_question(
    question_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> None:
    q = await owned_question(db, question_id, user)
    await db.execute(delete(ErrorRecord).where(ErrorRecord.question_id == question_id))
    await db.delete(q)
    await db.commit()
