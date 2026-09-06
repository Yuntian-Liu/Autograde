from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Assignment, Class, ErrorRecord, Question, Student, Submission
from serializers import (
    GRADED_STATUSES,
    assignment_brief,
    class_brief,
    question_brief,
    student_brief,
    submission_brief,
)

router = APIRouter(prefix="/api/assignments", tags=["assignments"])


async def _assignment_progress(db: AsyncSession, assignment_id: int) -> dict:
    question_count = (
        await db.execute(
            select(func.count(Question.id)).where(Question.assignment_id == assignment_id)
        )
    ).scalar_one()
    rows = (
        await db.execute(
            select(Submission.status, func.count(Submission.id))
            .where(Submission.assignment_id == assignment_id)
            .group_by(Submission.status)
        )
    ).all()
    by_status = {status: count for status, count in rows}
    return {
        "question_count": question_count,
        "total_students": sum(by_status.values()),
        "graded_count": sum(by_status.get(s, 0) for s in GRADED_STATUSES),
        "pending_count": by_status.get("待批改", 0),
        "missing_count": by_status.get("缺作业", 0),
        "absent_count": by_status.get("未交", 0),
    }


@router.get("")
async def list_assignments(
    limit: int = Query(default=8, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """最近批次：工作台「最近批次」板块数据源。"""
    assignments = (
        await db.execute(select(Assignment).order_by(Assignment.created_at.desc()).limit(limit))
    ).scalars().all()
    result = []
    for a in assignments:
        c = await db.get(Class, a.class_id)
        result.append(
            {
                **assignment_brief(a),
                **await _assignment_progress(db, a.id),
                "class": class_brief(c) if c else None,
            }
        )
    return result


@router.get("/{assignment_id}")
async def get_assignment(assignment_id: int, db: AsyncSession = Depends(get_db)) -> dict:
    a = await db.get(Assignment, assignment_id)
    if a is None:
        raise HTTPException(status_code=404, detail="批次不存在")
    c = await db.get(Class, a.class_id)

    questions = (
        await db.execute(
            select(Question)
            .where(Question.assignment_id == assignment_id)
            .order_by(Question.section, Question.seq)
        )
    ).scalars().all()

    # 按板块分组，保持出现顺序
    sections: list[dict] = []
    index: dict[str, dict] = {}
    for q in questions:
        if q.section not in index:
            index[q.section] = {"section": q.section, "questions": []}
            sections.append(index[q.section])
        index[q.section]["questions"].append(question_brief(q))
    for section in sections:
        qs = section["questions"]
        section["question_count"] = len(qs)
        section["total_weight"] = round(sum(q["score_weight"] for q in qs), 2)

    return {
        **assignment_brief(a),
        **await _assignment_progress(db, a.id),
        "class": class_brief(c) if c else None,
        "sections": sections,
        "total_weight": round(sum(q.score_weight for q in questions), 2),
    }


@router.get("/{assignment_id}/students")
async def get_assignment_students(
    assignment_id: int, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    """批改界面左栏数据源：每个学生带提交状态/分数/等级、已勾选错题、历史数据。"""
    a = await db.get(Assignment, assignment_id)
    if a is None:
        raise HTTPException(status_code=404, detail="批次不存在")

    students = (
        await db.execute(
            select(Student).where(Student.class_id == a.class_id).order_by(Student.id)
        )
    ).scalars().all()

    result = []
    for s in students:
        sub = (
            await db.execute(
                select(Submission).where(
                    Submission.student_id == s.id, Submission.assignment_id == assignment_id
                )
            )
        ).scalars().first()

        # 本批次已记录的错题（用于批改界面预勾选）
        error_question_ids = (
            await db.execute(
                select(ErrorRecord.question_id)
                .join(Question, ErrorRecord.question_id == Question.id)
                .where(ErrorRecord.student_id == s.id, Question.assignment_id == assignment_id)
            )
        ).scalars().all()

        # 历史分数：本班其他批次中已批改/缺作业的分数，按课次倒序
        history_scores = (
            await db.execute(
                select(Submission.score)
                .join(Assignment, Submission.assignment_id == Assignment.id)
                .where(
                    Submission.student_id == s.id,
                    Submission.assignment_id != assignment_id,
                    Submission.status.in_(GRADED_STATUSES),
                    Submission.score.is_not(None),
                )
                .order_by(Assignment.lesson_no.desc())
            )
        ).scalars().all()
        recent = [float(x) for x in history_scores[:5]]
        recent_avg_5 = round(sum(recent) / len(recent), 2) if recent else None
        last_score = round(float(history_scores[0]), 2) if history_scores else None

        # 历史薄弱板块：按错题数取前 3
        weak_rows = (
            await db.execute(
                select(Question.section, func.count(ErrorRecord.id))
                .join(ErrorRecord, ErrorRecord.question_id == Question.id)
                .where(ErrorRecord.student_id == s.id)
                .group_by(Question.section)
                .order_by(func.count(ErrorRecord.id).desc())
                .limit(3)
            )
        ).all()
        weak_sections = [section for section, _ in weak_rows]

        result.append(
            {
                **student_brief(s),
                "submission": submission_brief(sub) if sub else None,
                "error_question_ids": list(error_question_ids),
                "recent_avg_5": recent_avg_5,
                "last_score": last_score,
                "weak_sections": weak_sections,
            }
        )
    return result
