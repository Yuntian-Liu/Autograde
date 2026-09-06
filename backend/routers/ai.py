"""AI 辅助接口：题库结构化拆分（草稿不落库）与讲解起草。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ai import AIParseError, AIUnavailable, draft_explanation, parse_questions
from database import get_db
from models import Assignment, Question

router = APIRouter(prefix="/api/ai", tags=["ai"])


class ParseQuestionsIn(BaseModel):
    raw_text: str
    assignment_id: int


@router.post("/parse-questions")
async def parse_questions_api(
    body: ParseQuestionsIn, db: AsyncSession = Depends(get_db)
) -> dict:
    a = await db.get(Assignment, body.assignment_id)
    if a is None:
        raise HTTPException(status_code=404, detail="批次不存在")
    if not body.raw_text.strip():
        raise HTTPException(status_code=400, detail="粘贴内容不能为空")
    try:
        return await parse_questions(body.raw_text)
    except AIUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except AIParseError as e:
        raise HTTPException(
            status_code=422, detail=f"AI 输出解析失败：{e}｜原始输出片段：{e.raw}"
        ) from e


class DraftExplanationIn(BaseModel):
    question_id: int
    error_description: str


@router.post("/draft-explanation")
async def draft_explanation_api(
    body: DraftExplanationIn, db: AsyncSession = Depends(get_db)
) -> dict:
    q = await db.get(Question, body.question_id)
    if q is None:
        raise HTTPException(status_code=404, detail="题目不存在")
    if not body.error_description.strip():
        raise HTTPException(status_code=400, detail="请先描述学生错点")
    try:
        text = await draft_explanation(q, body.error_description)
    except AIUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return {"draft": text}
