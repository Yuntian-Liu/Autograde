from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    Assignment,
    ErrorRecord,
    FeedbackSnapshot,
    Question,
    Student,
    Submission,
    TrackingItem,
    TrackingMark,
)
from serializers import PROCESSED_STATUSES

TZ = ZoneInfo("Asia/Shanghai")


def _historical_graded_at(assignment: Assignment) -> datetime:
    raw = (assignment.class_time or "").strip()
    parsed = None
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"):
        try:
            parsed = datetime.strptime(raw, fmt)
            break
        except ValueError:
            continue
    if parsed is not None:
        return parsed.replace(tzinfo=TZ).astimezone(timezone.utc)
    created_at = assignment.created_at
    if created_at.tzinfo is not None:
        return created_at.astimezone(timezone.utc)
    return created_at


async def _absence_candidates(
    db: AsyncSession,
    student: Student,
    excluded_student_ids: set[int] | None = None,
) -> tuple[list[Assignment], int, dict[int, Submission]]:
    excluded = excluded_student_ids or {student.id}
    assignments = (
        await db.execute(
            select(Assignment)
            .where(Assignment.class_id == student.class_id)
            .order_by(Assignment.lesson_no, Assignment.id)
        )
    ).scalars().all()
    classmates = (
        await db.execute(
            select(Student).where(
                Student.class_id == student.class_id,
                Student.assignment_id.is_(None),
            )
        )
    ).scalars().all()
    original_students = [classmate for classmate in classmates if classmate.id not in excluded]
    if not assignments or not original_students:
        return [], 0, {}

    assignment_ids = [assignment.id for assignment in assignments]
    submissions = (
        await db.execute(
            select(Submission).where(Submission.assignment_id.in_(assignment_ids))
        )
    ).scalars().all()
    submission_map = {(sub.student_id, sub.assignment_id): sub for sub in submissions}
    target_submissions = {
        assignment_id: submission_map.get((student.id, assignment_id))
        for assignment_id in assignment_ids
    }

    completed = []
    for assignment in assignments:
        original_ids = [
            classmate.id for classmate in original_students
            if classmate.created_at <= assignment.created_at
        ]
        if original_ids and all(
            (sub := submission_map.get((student_id, assignment.id))) is not None
            and sub.status in PROCESSED_STATUSES
            for student_id in original_ids
        ):
            target = target_submissions[assignment.id]
            if target is None or target.status == "待批改":
                completed.append(assignment)

    if not completed:
        return [], 0, target_submissions
    completed_ids = [assignment.id for assignment in completed]
    error_assignment_ids = set(
        (
            await db.execute(
                select(Question.assignment_id)
                .join(ErrorRecord, ErrorRecord.question_id == Question.id)
                .where(
                    ErrorRecord.student_id == student.id,
                    Question.assignment_id.in_(completed_ids),
                )
            )
        ).scalars().all()
    )
    snapshot_assignment_ids = set(
        (
            await db.execute(
                select(FeedbackSnapshot.assignment_id).where(
                    FeedbackSnapshot.student_id == student.id,
                    FeedbackSnapshot.assignment_id.in_(completed_ids),
                )
            )
        ).scalars().all()
    )
    marked_assignment_ids = set(
        (
            await db.execute(
                select(TrackingItem.assignment_id)
                .join(TrackingMark, TrackingMark.item_id == TrackingItem.id)
                .where(
                    TrackingMark.student_id == student.id,
                    TrackingItem.assignment_id.in_(completed_ids),
                    TrackingItem.is_main.is_(True),
                )
            )
        ).scalars().all()
    )
    conflicts = error_assignment_ids | snapshot_assignment_ids | marked_assignment_ids
    return [a for a in completed if a.id not in conflicts], len(conflicts), target_submissions


async def preview_historical_absence(
    db: AsyncSession,
    student: Student,
    excluded_student_ids: set[int] | None = None,
) -> dict:
    assignments, conflict_count, _ = await _absence_candidates(db, student, excluded_student_ids)
    return {
        "student_id": student.id,
        "assignments": [
            {
                "id": assignment.id,
                "unit_label": assignment.unit_label,
                "lesson_no": assignment.lesson_no,
                "class_time": assignment.class_time,
            }
            for assignment in assignments
        ],
        "conflict_count": conflict_count,
    }


async def backfill_historical_absence(
    db: AsyncSession,
    student: Student,
    excluded_student_ids: set[int] | None = None,
) -> dict:
    assignments, conflict_count, target_submissions = await _absence_candidates(
        db, student, excluded_student_ids
    )
    for assignment in assignments:
        submission = target_submissions[assignment.id]
        if submission is None:
            submission = Submission(student_id=student.id, assignment_id=assignment.id)
            db.add(submission)
        submission.status = "未交"
        submission.score = None
        submission.rating = ""
        submission.rating_override = ""
        submission.preview_wrong = ""
        submission.graded_at = _historical_graded_at(assignment)
    return {
        "student_id": student.id,
        "marked": len(assignments),
        "conflict_count": conflict_count,
        "assignment_ids": [assignment.id for assignment in assignments],
    }
