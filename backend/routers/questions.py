"""题库写接口：单题修改 / 删除（批量冻结入库见 assignments 路由）。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import ErrorRecord, Question
from serializers import question_brief
from sqlalchemy import delete

router = APIRouter(prefix="/api/questions", tags=["questions"])

QUESTION_MODES = ("verbatim", "ai_expand", "manual")


class QuestionPatch(BaseModel):
    seq: int | None = None
    section: str | None = None
    mode: str | None = None
    stem: str | None = None
    standard_answer: str | None = None
    explanation: str | None = None
    score_weight: float | None = None


@router.patch("/{question_id}")
async def update_question(
    question_id: int, body: QuestionPatch, db: AsyncSession = Depends(get_db)
) -> dict:
    q = await db.get(Question, question_id)
    if q is None:
        raise HTTPException(status_code=404, detail="题目不存在")
    if body.mode is not None and body.mode not in QUESTION_MODES:
        raise HTTPException(status_code=400, detail=f"未知题目模式：{body.mode}")
    for field in ("seq", "section", "mode", "stem", "standard_answer", "explanation", "score_weight"):
        value = getattr(body, field)
        if value is not None:
            setattr(q, field, value)
    await db.commit()
    return question_brief(q)


@router.delete("/{question_id}", status_code=204)
async def delete_question(question_id: int, db: AsyncSession = Depends(get_db)) -> None:
    q = await db.get(Question, question_id)
    if q is None:
        raise HTTPException(status_code=404, detail="题目不存在")
    await db.execute(delete(ErrorRecord).where(ErrorRecord.question_id == question_id))
    await db.delete(q)
    await db.commit()
