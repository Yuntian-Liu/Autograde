from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Assignment, Class, Question, Student, Submission
from serializers import GRADED_STATUSES, assignment_brief, class_brief, student_brief

router = APIRouter(prefix="/api/classes", tags=["classes"])


async def _class_stats(db: AsyncSession, class_id: int) -> dict:
    """学生数 / 待批改数 / 上批平均分。"""
    student_count = (
        await db.execute(select(func.count(Student.id)).where(Student.class_id == class_id))
    ).scalar_one()

    pending_count = (
        await db.execute(
            select(func.count(Submission.id))
            .join(Assignment, Submission.assignment_id == Assignment.id)
            .where(Assignment.class_id == class_id, Submission.status == "待批改")
        )
    ).scalar_one()

    # 上批平均分：最近一个有分数记录的批次的均分
    last_avg = None
    assignment_ids = (
        await db.execute(
            select(Assignment.id)
            .where(Assignment.class_id == class_id)
            .order_by(Assignment.lesson_no.desc())
        )
    ).scalars().all()
    for aid in assignment_ids:
        avg = (
            await db.execute(
                select(func.avg(Submission.score)).where(
                    Submission.assignment_id == aid,
                    Submission.status.in_(GRADED_STATUSES),
                    Submission.score.is_not(None),
                )
            )
        ).scalar_one()
        if avg is not None:
            last_avg = round(float(avg), 2)
            break

    return {
        "student_count": student_count,
        "pending_count": pending_count,
        "last_avg_score": last_avg,
    }


@router.get("")
async def list_classes(db: AsyncSession = Depends(get_db)) -> list[dict]:
    classes = (await db.execute(select(Class).order_by(Class.id))).scalars().all()
    result = []
    for c in classes:
        result.append({**class_brief(c), **await _class_stats(db, c.id)})
    return result


@router.get("/{class_id}")
async def get_class(class_id: int, db: AsyncSession = Depends(get_db)) -> dict:
    c = await db.get(Class, class_id)
    if c is None:
        raise HTTPException(status_code=404, detail="班级不存在")

    students = (
        await db.execute(select(Student).where(Student.class_id == class_id).order_by(Student.id))
    ).scalars().all()

    assignments = (
        await db.execute(
            select(Assignment)
            .where(Assignment.class_id == class_id)
            .order_by(Assignment.lesson_no.desc())
        )
    ).scalars().all()

    assignment_items = []
    for a in assignments:
        question_count = (
            await db.execute(
                select(func.count(Question.id)).where(Question.assignment_id == a.id)
            )
        ).scalar_one()
        graded_count = (
            await db.execute(
                select(func.count(Submission.id)).where(
                    Submission.assignment_id == a.id,
                    Submission.status.in_(GRADED_STATUSES),
                )
            )
        ).scalar_one()
        pending_count = (
            await db.execute(
                select(func.count(Submission.id)).where(
                    Submission.assignment_id == a.id, Submission.status == "待批改"
                )
            )
        ).scalar_one()
        assignment_items.append(
            {
                **assignment_brief(a),
                "question_count": question_count,
                "total_students": len(students),
                "graded_count": graded_count,
                "pending_count": pending_count,
            }
        )

    return {
        **class_brief(c),
        **await _class_stats(db, class_id),
        "students": [student_brief(s) for s in students],
        "assignments": assignment_items,
    }
