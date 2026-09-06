from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from feedback import SERIES_DEFAULT_LESSON_TYPE, sync_unit_label, validate_unit_fields
from models import Assignment, Class, Question, Student, Submission
from serializers import GRADED_STATUSES, assignment_brief, class_brief, student_brief

router = APIRouter(prefix="/api/classes", tags=["classes"])


class StudentCreate(BaseModel):
    name: str
    note: str = ""


class AssignmentCreate(BaseModel):
    unit_no: int
    lesson_type: str | None = None  # 缺省按班级系列预填：WW→L，NG→Day
    unit_lesson_no: int = 1
    has_preview: bool = False
    preview_unit_no: int | None = None
    preview_half: str = ""
    lesson_no: int
    class_time: str = ""
    content: str = ""
    status: str = "未开始"


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


@router.post("/{class_id}/students", status_code=201)
async def create_student(
    class_id: int, body: StudentCreate, db: AsyncSession = Depends(get_db)
) -> dict:
    c = await db.get(Class, class_id)
    if c is None:
        raise HTTPException(status_code=404, detail="班级不存在")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="学生姓名不能为空")
    s = Student(name=name, class_id=class_id, note=body.note)
    db.add(s)
    await db.commit()
    return student_brief(s)


@router.post("/{class_id}/assignments", status_code=201)
async def create_assignment(
    class_id: int, body: AssignmentCreate, db: AsyncSession = Depends(get_db)
) -> dict:
    c = await db.get(Class, class_id)
    if c is None:
        raise HTTPException(status_code=404, detail="班级不存在")
    lesson_type = body.lesson_type or SERIES_DEFAULT_LESSON_TYPE.get(c.series, "L")
    error = validate_unit_fields(
        c, body.unit_no, lesson_type, body.has_preview, body.preview_unit_no, body.preview_half
    )
    if error:
        raise HTTPException(status_code=400, detail=error)
    a = Assignment(
        class_id=class_id,
        unit_no=body.unit_no,
        lesson_type=lesson_type,
        unit_lesson_no=body.unit_lesson_no,
        has_preview=body.has_preview,
        preview_unit_no=body.preview_unit_no,
        preview_half=body.preview_half if body.has_preview else "",
        lesson_no=body.lesson_no,
        class_time=body.class_time,
        content=body.content,
        status=body.status,
    )
    sync_unit_label(a)
    db.add(a)
    await db.commit()
    return assignment_brief(a)
