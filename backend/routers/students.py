"""学生写接口：改名 / 备注（note 仅自己可见）/ 删除；个人统计只读接口。"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from access import owned_student
from auth.dependencies import get_current_user
from auth.models import User
from database import get_db
from enrollment import backfill_historical_absence, preview_historical_absence
from models import (
    AbilityReport,
    Assignment,
    Class,
    ErrorRecord,
    FeedbackSnapshot,
    Question,
    Student,
    Submission,
    TrackingCompletion,
    TrackingMark,
)
from rating import gpa_for_submission
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
    # 连同该学生的批改与登记数据一起清理，避免孤儿行（含能力报告存档，隐私政策承诺连带删除）
    await db.execute(delete(TrackingCompletion).where(TrackingCompletion.student_id == student_id))
    await db.execute(delete(TrackingMark).where(TrackingMark.student_id == student_id))
    await db.execute(delete(ErrorRecord).where(ErrorRecord.student_id == student_id))
    await db.execute(delete(Submission).where(Submission.student_id == student_id))
    await db.execute(delete(FeedbackSnapshot).where(FeedbackSnapshot.student_id == student_id))
    await db.execute(delete(AbilityReport).where(AbilityReport.student_id == student_id))
    await db.delete(s)
    await db.commit()


async def _owned_formal_student(db: AsyncSession, student_id: int, user: User) -> Student:
    student = await owned_student(db, student_id, user)
    class_ = await db.get(Class, student.class_id)
    if class_.is_temp or student.assignment_id is not None:
        raise HTTPException(status_code=400, detail="临时学生无需处理历史批次")
    return student


@router.get("/{student_id}/pre-enrollment-absence")
async def preview_student_historical_absence(
    student_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    student = await _owned_formal_student(db, student_id, user)
    return await preview_historical_absence(db, student)


@router.post("/{student_id}/pre-enrollment-absence")
async def apply_student_historical_absence(
    student_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    student = await _owned_formal_student(db, student_id, user)
    try:
        result = await backfill_historical_absence(db, student)
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    logging.getLogger("autograde.business").info(
        "student_historical_absence uid=%s class=%s student=%s marked=%s conflicts=%s assignments=%s",
        user.uid,
        student.class_id,
        student.id,
        result["marked"],
        result["conflict_count"],
        result["assignment_ids"],
    )
    return result


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
            "assignment_slug": a.slug,
            "unit_label": a.unit_label,
            "lesson_no": a.lesson_no,
            "class_time": a.class_time,
            "status": sub.status,
            "score": sub.score,
            "rating": sub.rating_override or sub.rating,
            "gpa": gpa_for_submission(sub),
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
