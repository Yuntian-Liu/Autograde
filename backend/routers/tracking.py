"""批次提交登记：独立两态矩阵，不改动批改与统计口径。"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from access import owned_assignment
from auth.dependencies import get_current_user
from auth.models import User
from database import get_db
from models import Student, Submission, TrackingItem, TrackingMark
from serializers import GRADED_STATUSES, assignment_student_condition
from tracking import MAIN_TRACKING_NAME

router = APIRouter(prefix="/api/assignments", tags=["tracking"])
logger = logging.getLogger("autograde.tracking")
logger.setLevel(logging.INFO)


def _main_cell(submission: Submission | None, manually_marked: bool) -> dict:
    if submission and submission.status in GRADED_STATUSES:
        return {"submitted": True, "source": "auto"}
    if manually_marked:
        return {"submitted": True, "source": "manual"}
    return {"submitted": False, "source": None}


@router.get("/{assignment_id}/tracking")
async def get_tracking(
    assignment_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    a = await owned_assignment(db, assignment_id, user)
    items = (
        await db.execute(
            select(TrackingItem)
            .where(TrackingItem.assignment_id == a.id)
            .order_by(TrackingItem.is_main.desc(), TrackingItem.position, TrackingItem.id)
        )
    ).scalars().all()
    if not any(item.is_main for item in items):
        raise HTTPException(status_code=500, detail="主作业登记项缺失，请重启服务完成数据修复")

    students = (
        await db.execute(
            select(Student)
            .where(Student.class_id == a.class_id, assignment_student_condition(a))
            .order_by(Student.id)
        )
    ).scalars().all()
    submissions = (
        await db.execute(select(Submission).where(Submission.assignment_id == a.id))
    ).scalars().all()
    submission_by_student = {sub.student_id: sub for sub in submissions}
    marks = (
        await db.execute(
            select(TrackingMark)
            .join(TrackingItem, TrackingMark.item_id == TrackingItem.id)
            .where(TrackingItem.assignment_id == a.id)
        )
    ).scalars().all()
    marked = {(mark.student_id, mark.item_id) for mark in marks}

    rows = []
    counts = {item.id: 0 for item in items}
    for student in students:
        cells = {}
        for item in items:
            manually_marked = (student.id, item.id) in marked
            cell = (
                _main_cell(submission_by_student.get(student.id), manually_marked)
                if item.is_main
                else {"submitted": manually_marked, "source": "manual" if manually_marked else None}
            )
            cells[str(item.id)] = cell
            if cell["submitted"]:
                counts[item.id] += 1
        rows.append({"id": student.id, "name": student.name, "cells": cells})

    return {
        "assignment_id": a.id,
        "items": [
            {
                "id": item.id,
                "name": (a.content.strip() or MAIN_TRACKING_NAME) if item.is_main else item.name,
                "position": item.position,
                "is_main": item.is_main,
                "submitted_count": counts[item.id],
            }
            for item in items
        ],
        "students": rows,
        "total_students": len(rows),
    }


class TrackingMarkIn(BaseModel):
    submitted: bool


@router.put("/{assignment_id}/students/{student_id}/tracking/{item_id}")
async def save_tracking_mark(
    assignment_id: str,
    student_id: int,
    item_id: int,
    body: TrackingMarkIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    a = await owned_assignment(db, assignment_id, user)
    student = await db.get(Student, student_id)
    expected_assignment_id = a.id if a.series is not None else None
    if (
        student is None
        or student.class_id != a.class_id
        or student.assignment_id != expected_assignment_id
    ):
        raise HTTPException(status_code=400, detail="学生不属于该批次")
    item = await db.get(TrackingItem, item_id)
    if item is None or item.assignment_id != a.id:
        raise HTTPException(status_code=400, detail="提交项目不属于本批次")

    submission = (
        await db.execute(
            select(Submission).where(
                Submission.assignment_id == a.id,
                Submission.student_id == student_id,
            )
        )
    ).scalars().first()
    automatic = bool(item.is_main and submission and submission.status in GRADED_STATUSES)
    if automatic and not body.submitted:
        raise HTTPException(status_code=409, detail="已批改的主作业由批改状态自动登记，不能手动取消")

    existing = (
        await db.execute(
            select(TrackingMark).where(
                TrackingMark.item_id == item_id,
                TrackingMark.student_id == student_id,
            )
        )
    ).scalar_one_or_none()
    try:
        if not automatic:
            if body.submitted and existing is None:
                db.add(TrackingMark(item_id=item_id, student_id=student_id))
            elif not body.submitted and existing is not None:
                await db.delete(existing)
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    manually_marked = bool(body.submitted and not automatic)
    cell = (
        _main_cell(submission, manually_marked)
        if item.is_main
        else {"submitted": body.submitted, "source": "manual" if body.submitted else None}
    )
    logger.info(
        "tracking_save uid=%s assignment=%s student=%s item=%s main=%s submitted=%s source=%s",
        user.uid,
        a.id,
        student_id,
        item_id,
        item.is_main,
        cell["submitted"],
        cell["source"] or "pending",
    )
    return {"item_id": item_id, "student_id": student_id, "cell": cell}
