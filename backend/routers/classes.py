from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from access import owned_class
from codes import default_cohort, issue_code, validate_cohort
from slug_ids import unique_slug
from auth.dependencies import get_current_user
from auth.models import User
from database import get_db
from feedback import SERIES_DEFAULT_LESSON_TYPE, sync_unit_label, validate_unit_fields
from models import Assignment, Class, ErrorRecord, Question, Student, Submission
from serializers import (
    GRADED_STATUSES,
    PROCESSED_STATUSES,
    assignment_brief,
    assignment_status,
    class_brief,
    student_brief,
)

router = APIRouter(prefix="/api/classes", tags=["classes"])


class StudentCreate(BaseModel):
    name: str
    note: str = ""


class StudentsBatchIn(BaseModel):
    names: list[str]  # 前端负责按行 split，这里收数组


class ClassCreate(BaseModel):
    name: str
    series: str  # WW / NG
    level: int
    term: str  # A / B
    schedule: str = ""
    cohort: str = ""  # 届别（如 202603=2026秋）；空 = 按当前时间自动推导


class ClassPatch(BaseModel):
    name: str | None = None
    series: str | None = None
    level: int | None = None
    term: str | None = None
    schedule: str | None = None
    # 届别可改：只影响今后新发的编码前缀，已发码终身不变（身份证逻辑）
    cohort: str | None = None


def _validate_class_fields(series: str, term: str) -> str | None:
    if series not in ("WW", "NG"):
        return "班级系列仅支持 WW（厚少）/ NG（厚中）"
    if term not in ("A", "B"):
        return "册别仅支持 A（上册）/ B（下册）"
    return None


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
async def list_classes(
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> list[dict]:
    classes = (
        await db.execute(select(Class).where(Class.owner_uid == user.uid).order_by(Class.id))
    ).scalars().all()
    result = []
    for c in classes:
        result.append({**class_brief(c), **await _class_stats(db, c.id)})
    return result


@router.get("/{class_id}")
async def get_class(
    class_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    c = await owned_class(db, class_id, user)

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
        # 已处理 = 已批改/缺作业/未交；无提交记录的学生计入待批改
        rows = (
            await db.execute(
                select(Submission.status, func.count(Submission.id))
                .where(Submission.assignment_id == a.id)
                .group_by(Submission.status)
            )
        ).all()
        by_status = {status: count for status, count in rows}
        unrecorded = len(students) - sum(by_status.values())
        assignment_items.append(
            {
                **assignment_brief(a),
                "status": await assignment_status(db, a),  # 动态推导，覆盖静态字段
                "question_count": question_count,
                "total_students": len(students),
                "graded_count": sum(by_status.get(s, 0) for s in PROCESSED_STATUSES),
                "pending_count": by_status.get("待批改", 0) + unrecorded,
            }
        )

    return {
        **class_brief(c),
        **await _class_stats(db, class_id),
        "students": [student_brief(s) for s in students],
        "assignments": assignment_items,
    }


@router.post("", status_code=201)
async def create_class(
    body: ClassCreate, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="班级名不能为空")
    error = _validate_class_fields(body.series, body.term)
    if error:
        raise HTTPException(status_code=400, detail=error)
    # 同名校验按 owner 维度（多租户下两位老师可各有一个 WW5A）
    exists = (
        await db.execute(
            select(func.count(Class.id)).where(Class.name == name, Class.owner_uid == user.uid)
        )
    ).scalar_one()
    if exists:
        raise HTTPException(status_code=400, detail=f"班级名已存在：{name}")
    cohort = body.cohort.strip() or default_cohort()
    if not validate_cohort(cohort):
        raise HTTPException(status_code=400, detail="届别格式应为「年+学期」，如 202603（01春/02夏/03秋/04冬）")
    c = Class(
        name=name,
        series=body.series,
        level=body.level,
        term=body.term,
        schedule=body.schedule.strip(),
        cohort=cohort,
        owner_uid=user.uid,
    )
    db.add(c)
    await db.commit()
    return class_brief(c)


@router.patch("/{class_id}")
async def update_class(
    class_id: int,
    body: ClassPatch,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    c = await owned_class(db, class_id, user)
    series = body.series if body.series is not None else c.series
    term = body.term if body.term is not None else c.term
    error = _validate_class_fields(series, term)
    if error:
        raise HTTPException(status_code=400, detail=error)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="班级名不能为空")
        dup = (
            await db.execute(
                select(func.count(Class.id)).where(
                    Class.name == name,
                    Class.owner_uid == user.uid,
                    Class.id != class_id,
                )
            )
        ).scalar_one()
        if dup:
            raise HTTPException(status_code=400, detail=f"班级名已存在：{name}")
        c.name = name
    c.series = series
    c.term = term
    if body.level is not None:
        c.level = body.level
    if body.schedule is not None:
        c.schedule = body.schedule.strip()
    if body.cohort is not None:
        cohort = body.cohort.strip()
        if not validate_cohort(cohort):
            raise HTTPException(status_code=400, detail="届别格式应为「年+学期」，如 202603（01春/02夏/03秋/04冬）")
        c.cohort = cohort  # 只影响今后发码前缀；已发码终身不变
    await db.commit()
    return class_brief(c)


@router.delete("/{class_id}", status_code=204)
async def delete_class(
    class_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> None:
    """拒绝非空班级：名下还有学生或批次时不删，返回中文提示。"""
    c = await owned_class(db, class_id, user)
    student_count = (
        await db.execute(select(func.count(Student.id)).where(Student.class_id == class_id))
    ).scalar_one()
    assignment_count = (
        await db.execute(select(func.count(Assignment.id)).where(Assignment.class_id == class_id))
    ).scalar_one()
    if student_count or assignment_count:
        raise HTTPException(
            status_code=400,
            detail=f"班级下还有 {student_count} 名学生、{assignment_count} 个批次，请先清理后再删除",
        )
    await db.delete(c)
    await db.commit()


@router.post("/{class_id}/students/batch", status_code=201)
async def import_students(
    class_id: int,
    body: StudentsBatchIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """名单一键导入：逐行 trim、去空、输入内去重、与现有学生重名跳过。
    编码在同一事务内连续取号——整批导入的学生码连号。"""
    c = await owned_class(db, class_id, user)
    existing = set(
        (
            await db.execute(select(Student.name).where(Student.class_id == class_id))
        ).scalars().all()
    )
    added = []
    skipped = []
    seen = set()
    for raw in body.names:
        name = raw.strip()
        if not name:
            continue
        if name in seen or name in existing:
            skipped.append(name)
            continue
        seen.add(name)
        s = Student(name=name, class_id=class_id, code=await issue_code(db, "S", c))
        db.add(s)
        added.append(s)
    await db.commit()
    return {"added": len(added), "skipped": skipped, "students": [student_brief(s) for s in added]}


@router.post("/{class_id}/students", status_code=201)
async def create_student(
    class_id: int,
    body: StudentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    c = await owned_class(db, class_id, user)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="学生姓名不能为空")
    s = Student(name=name, class_id=class_id, note=body.note, code=await issue_code(db, "S", c))
    db.add(s)
    await db.commit()
    return student_brief(s)


@router.post("/{class_id}/assignments", status_code=201)
async def create_assignment(
    class_id: int,
    body: AssignmentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    c = await owned_class(db, class_id, user)
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
        slug=await unique_slug(db),
        code=await issue_code(db, "A", c),
    )
    sync_unit_label(a)
    db.add(a)
    await db.commit()
    return assignment_brief(a)


@router.get("/{class_id}/leaderboard")
async def class_leaderboard(
    class_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    """排行榜成绩矩阵：全班学生 × 全部批次的提交状态与分数。
    排名口径（实时/历次、含提交率/纯分数）全在前端算，后端只供数据。"""
    c = await owned_class(db, class_id, user)

    students = (
        await db.execute(select(Student).where(Student.class_id == class_id).order_by(Student.id))
    ).scalars().all()
    assignments = (
        await db.execute(
            select(Assignment).where(Assignment.class_id == class_id).order_by(Assignment.lesson_no.asc())
        )
    ).scalars().all()

    sub_rows = (
        await db.execute(
            select(
                Submission.student_id,
                Submission.assignment_id,
                Submission.status,
                Submission.score,
                Submission.created_at,
            )
            .join(Assignment, Submission.assignment_id == Assignment.id)
            .where(Assignment.class_id == class_id)
        )
    ).all()
    # cells[student_id][assignment_id] = {status, score, graded_at}（graded_at 供同分时「先批完者优先」）
    cells: dict[int, dict[int, dict]] = {}
    graded_per_assignment: dict[int, int] = {}
    for sid, aid, status, score, created in sub_rows:
        cells.setdefault(sid, {})[aid] = {
            "status": status,
            "score": score,
            "graded_at": created.isoformat() if created else None,
        }
        if status in PROCESSED_STATUSES:
            graded_per_assignment[aid] = graded_per_assignment.get(aid, 0) + 1

    total_students = len(students)
    return {
        "batches": [
            {
                "assignment_id": a.id,
                "unit_label": a.unit_label,
                "lesson_no": a.lesson_no,
                "pending": total_students - graded_per_assignment.get(a.id, 0),
                "total_students": total_students,
            }
            for a in assignments
        ],
        "students": [
            {"student_id": s.id, "name": s.name, "cells": cells.get(s.id, {})} for s in students
        ],
    }


@router.get("/{class_id}/stats")
async def class_stats(
    class_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    """班级统计页数据源。口径：平均分只算有分数的提交（已批改/缺作业）；未交/待批改不进平均。"""
    c = await owned_class(db, class_id, user)

    total_students = (
        await db.execute(select(func.count(Student.id)).where(Student.class_id == class_id))
    ).scalar_one()

    assignments = (
        await db.execute(
            select(Assignment)
            .where(Assignment.class_id == class_id)
            .order_by(Assignment.lesson_no.asc())
        )
    ).scalars().all()

    # 各批次各状态计数 + 有分数提交的平均分（各一次聚合查询）
    status_rows = (
        await db.execute(
            select(Submission.assignment_id, Submission.status, func.count(Submission.id))
            .join(Assignment, Submission.assignment_id == Assignment.id)
            .where(Assignment.class_id == class_id)
            .group_by(Submission.assignment_id, Submission.status)
        )
    ).all()
    status_by_assignment: dict[int, dict[str, int]] = {}
    for aid, status, n in status_rows:
        status_by_assignment.setdefault(aid, {})[status] = n

    avg_rows = (
        await db.execute(
            select(Submission.assignment_id, func.avg(Submission.score))
            .join(Assignment, Submission.assignment_id == Assignment.id)
            .where(
                Assignment.class_id == class_id,
                Submission.status.in_(GRADED_STATUSES),
                Submission.score.is_not(None),
            )
            .group_by(Submission.assignment_id)
        )
    ).all()
    avg_by_assignment = {aid: round(float(v), 2) for aid, v in avg_rows}

    items = []
    for a in assignments:
        by_status = status_by_assignment.get(a.id, {})
        submitted = sum(by_status.get(s, 0) for s in GRADED_STATUSES)  # 已交（含缺作业）
        items.append(
            {
                "assignment_id": a.id,
                "unit_label": a.unit_label,
                "lesson_no": a.lesson_no,
                "class_time": a.class_time,
                "avg_score": avg_by_assignment.get(a.id),
                "submitted": submitted,
                "absent": by_status.get("未交", 0),
                "pending": by_status.get("待批改", 0) + (total_students - sum(by_status.values())),
                "total_students": total_students,
            }
        )

    # 每题错误排行（全班，按次数降序；带板块与题号）
    top_rows = (
        await db.execute(
            select(Question.id, Question.section, Question.seq, func.count(ErrorRecord.id))
            .join(ErrorRecord, ErrorRecord.question_id == Question.id)
            .join(Assignment, Question.assignment_id == Assignment.id)
            .where(Assignment.class_id == class_id)
            .group_by(Question.id)
            .order_by(func.count(ErrorRecord.id).desc())
            .limit(20)
        )
    ).all()

    return {
        "class": class_brief(c),
        "assignments": items,
        "top_errors": [
            {"question_id": qid, "section": sec, "seq": seq, "count": n}
            for qid, sec, seq, n in top_rows
        ],
    }
