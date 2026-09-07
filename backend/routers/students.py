"""学生写接口：改名 / 备注（note 仅自己可见）/ 删除；个人统计只读接口。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from access import owned_student
from auth.dependencies import get_current_user
from auth.models import User
from database import get_db
from models import Assignment, ErrorRecord, FeedbackSnapshot, Question, Student, Submission
from serializers import student_brief
router = APIRouter(prefix="/api/students", tags=["students"])


class StudentPatch(BaseModel):
    name: str | None = None
    note: str | None = None


@router.patch("/{student_id}")
async def update_student(
    student_id: int,
    body: StudentPatch,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    s = await owned_student(db, student_id, user)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="学生姓名不能为空")
        s.name = name
    if body.note is not None:
        s.note = body.note
    await db.commit()
    return student_brief(s)


@router.delete("/{student_id}", status_code=204)
async def delete_student(
    student_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> None:
    s = await owned_student(db, student_id, user)
    # 连同该学生的批改数据一起清理，避免孤儿行
    await db.execute(delete(ErrorRecord).where(ErrorRecord.student_id == student_id))
    await db.execute(delete(Submission).where(Submission.student_id == student_id))
    await db.execute(delete(FeedbackSnapshot).where(FeedbackSnapshot.student_id == student_id))
    await db.delete(s)
    await db.commit()


@router.get("/{student_id}/stats")
async def student_stats(
    student_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    """学生详情页数据源：历次提交（时间正序）+ 错题板块聚合。口径：分数只认已批改/缺作业。"""
    s = await owned_student(db, student_id, user)

    # 历次提交（含无提交记录的批次？只列有提交记录的；时间正序按 class_time/lesson_no）
    rows = (
        await db.execute(
            select(Assignment, Submission)
            .join(Submission, Submission.assignment_id == Assignment.id)
            .where(Submission.student_id == student_id)
            .order_by(Assignment.lesson_no.asc())
        )
    ).all()

    # 该生各批次错题数（一次聚合查询，经 question 归属批次）
    err_counts = dict(
        (
            await db.execute(
                select(Question.assignment_id, func.count(ErrorRecord.id))
                .join(ErrorRecord, ErrorRecord.question_id == Question.id)
                .where(ErrorRecord.student_id == student_id)
                .group_by(Question.assignment_id)
            )
        ).all()
    )

    history = [
        {
            "assignment_id": a.id,
            "unit_label": a.unit_label,
            "lesson_no": a.lesson_no,
            "class_time": a.class_time,
            "status": sub.status,
            "score": sub.score,
            "rating": sub.rating_override or sub.rating,
            "error_count": err_counts.get(a.id, 0),
        }
        for a, sub in rows
    ]

    # 薄弱板块：错题按板块聚合降序
    weak = (
        await db.execute(
            select(Question.section, func.count(ErrorRecord.id))
            .join(ErrorRecord, ErrorRecord.question_id == Question.id)
            .where(ErrorRecord.student_id == student_id)
            .group_by(Question.section)
            .order_by(func.count(ErrorRecord.id).desc())
        )
    ).all()

    return {
        "student": student_brief(s),
        "history": history,
        "weak_sections": [{"section": sec, "count": n} for sec, n in weak],
    }
