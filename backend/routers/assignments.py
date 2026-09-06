from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from feedback import sync_unit_label, validate_unit_fields
from models import (
    Assignment,
    Class,
    ErrorRecord,
    FeedbackSnapshot,
    Question,
    Student,
    Submission,
)
from rating import rating_for
from serializers import (
    GRADED_STATUSES,
    assignment_brief,
    class_brief,
    question_brief,
    student_brief,
    submission_brief,
)

router = APIRouter(prefix="/api/assignments", tags=["assignments"])

SUBMISSION_STATUSES = ("待批改", "已批改", "缺作业", "未交")
QUESTION_MODES = ("verbatim", "ai_expand", "manual")


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

        # 本批次已记录的错题（用于批改界面预勾选）与已定稿的 note
        error_rows = (
            await db.execute(
                select(ErrorRecord)
                .join(Question, ErrorRecord.question_id == Question.id)
                .where(ErrorRecord.student_id == s.id, Question.assignment_id == assignment_id)
            )
        ).scalars().all()
        error_question_ids = [er.question_id for er in error_rows]
        error_notes = {str(er.question_id): er.note for er in error_rows if er.note}

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
                "error_question_ids": error_question_ids,
                "error_notes": error_notes,
                "recent_avg_5": recent_avg_5,
                "last_score": last_score,
                "weak_sections": weak_sections,
            }
        )
    return result


class AssignmentPatch(BaseModel):
    unit_no: int | None = None
    lesson_type: str | None = None
    unit_lesson_no: int | None = None
    has_preview: bool | None = None
    preview_unit_no: int | None = None
    preview_half: str | None = None
    lesson_no: int | None = None
    class_time: str | None = None
    content: str | None = None
    status: str | None = None


@router.patch("/{assignment_id}")
async def update_assignment(
    assignment_id: int, body: AssignmentPatch, db: AsyncSession = Depends(get_db)
) -> dict:
    a = await db.get(Assignment, assignment_id)
    if a is None:
        raise HTTPException(status_code=404, detail="批次不存在")
    c = await db.get(Class, a.class_id)

    for field in ("unit_no", "lesson_type", "unit_lesson_no", "has_preview",
                  "preview_unit_no", "preview_half", "lesson_no", "class_time",
                  "content", "status"):
        value = getattr(body, field)
        if value is not None:
            setattr(a, field, value)

    error = validate_unit_fields(
        c, a.unit_no, a.lesson_type, a.has_preview, a.preview_unit_no, a.preview_half
    )
    if error:
        raise HTTPException(status_code=400, detail=error)
    if not a.has_preview:
        a.preview_half = ""
    sync_unit_label(a)
    await db.commit()
    return assignment_brief(a)


@router.delete("/{assignment_id}", status_code=204)
async def delete_assignment(assignment_id: int, db: AsyncSession = Depends(get_db)) -> None:
    a = await db.get(Assignment, assignment_id)
    if a is None:
        raise HTTPException(status_code=404, detail="批次不存在")
    question_ids = select(Question.id).where(Question.assignment_id == assignment_id)
    await db.execute(delete(ErrorRecord).where(ErrorRecord.question_id.in_(question_ids)))
    await db.execute(delete(Submission).where(Submission.assignment_id == assignment_id))
    await db.execute(
        delete(FeedbackSnapshot).where(FeedbackSnapshot.assignment_id == assignment_id)
    )
    await db.execute(delete(Question).where(Question.assignment_id == assignment_id))
    await db.delete(a)
    await db.commit()


class QuestionIn(BaseModel):
    section: str
    seq: int | None = None  # 缺省时按板块内现有最大题号顺延
    mode: str = "verbatim"
    stem: str = ""
    standard_answer: str = ""
    explanation: str = ""
    score_weight: float = 5.0


class QuestionsBatchIn(BaseModel):
    questions: list[QuestionIn]


@router.post("/{assignment_id}/questions", status_code=201)
async def create_questions(
    assignment_id: int, body: QuestionsBatchIn, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    """批量录题：人工验收后冻结入库（AI 解析结果也走这里落定）。"""
    a = await db.get(Assignment, assignment_id)
    if a is None:
        raise HTTPException(status_code=404, detail="批次不存在")
    if not body.questions:
        raise HTTPException(status_code=400, detail="题目列表不能为空")
    for item in body.questions:
        if item.mode not in QUESTION_MODES:
            raise HTTPException(status_code=400, detail=f"未知题目模式：{item.mode}")
        if not item.section.strip():
            raise HTTPException(status_code=400, detail="板块名不能为空")

    # 板块内现有最大题号，用于 seq 缺省顺延
    rows = (
        await db.execute(
            select(Question.section, func.max(Question.seq))
            .where(Question.assignment_id == assignment_id)
            .group_by(Question.section)
        )
    ).all()
    next_seq = {section: (max_seq or 0) + 1 for section, max_seq in rows}

    created = []
    for item in body.questions:
        section = item.section.strip()
        seq = item.seq if item.seq is not None else next_seq.get(section, 1)
        next_seq[section] = seq + 1
        q = Question(
            assignment_id=assignment_id,
            seq=seq,
            mode=item.mode,
            section=section,
            stem=item.stem,
            standard_answer=item.standard_answer,
            explanation=item.explanation,
            score_weight=item.score_weight,
        )
        db.add(q)
        created.append(q)
    await db.commit()
    return [question_brief(q) for q in created]


class GradingIn(BaseModel):
    status: str
    checked_question_ids: list[int] = []
    rating_override: str = ""
    notes: dict[int, str] = {}  # question_id → 该题定稿内容（manual 人工填充 / ai_expand 定稿）
    final_text: str = ""


@router.put("/{assignment_id}/students/{student_id}/grading")
async def save_grading(
    assignment_id: int, student_id: int, body: GradingIn, db: AsyncSession = Depends(get_db)
) -> dict:
    """批改落库：score/rating 由后端按 score_weight 复算（不信前端），
    error_records 先删后插，feedback_snapshots 存档 final_text。"""
    a = await db.get(Assignment, assignment_id)
    if a is None:
        raise HTTPException(status_code=404, detail="批次不存在")
    s = await db.get(Student, student_id)
    if s is None:
        raise HTTPException(status_code=404, detail="学生不存在")
    if s.class_id != a.class_id:
        raise HTTPException(status_code=400, detail="学生不属于该批次的班级")
    if body.status not in SUBMISSION_STATUSES:
        raise HTTPException(status_code=400, detail="未知提交状态")

    questions = (
        await db.execute(select(Question).where(Question.assignment_id == assignment_id))
    ).scalars().all()
    qmap = {q.id: q for q in questions}
    checked_ids = list(dict.fromkeys(body.checked_question_ids))  # 去重保序
    unknown = [qid for qid in checked_ids if qid not in qmap]
    if unknown:
        raise HTTPException(status_code=400, detail=f"题目不属于本批次：{unknown}")

    # 后端复算：总分 100 按权重归一化，扣勾选错题权重
    if body.status in GRADED_STATUSES:
        total_weight = sum(q.score_weight for q in questions)
        checked_weight = sum(qmap[qid].score_weight for qid in checked_ids)
        score = round(100 * (total_weight - checked_weight) / total_weight, 2) if total_weight > 0 else 100.0
        rating = body.rating_override or rating_for(score)
        rating_override = body.rating_override
    else:
        score = None
        rating = ""
        rating_override = ""

    try:
        sub = (
            await db.execute(
                select(Submission).where(
                    Submission.student_id == student_id,
                    Submission.assignment_id == assignment_id,
                )
            )
        ).scalars().first()
        if sub is None:
            sub = Submission(student_id=student_id, assignment_id=assignment_id)
            db.add(sub)
        sub.status = body.status
        sub.score = score
        sub.rating = rating
        sub.rating_override = rating_override

        # 错题记录：先删该学生该批次旧记录，再插新
        await db.execute(
            delete(ErrorRecord).where(
                ErrorRecord.student_id == student_id,
                ErrorRecord.question_id.in_(
                    select(Question.id).where(Question.assignment_id == assignment_id)
                ),
            )
        )
        for qid in checked_ids:
            db.add(
                ErrorRecord(
                    student_id=student_id,
                    question_id=qid,
                    note=body.notes.get(qid, ""),
                )
            )

        if body.final_text:
            snap = (
                await db.execute(
                    select(FeedbackSnapshot).where(
                        FeedbackSnapshot.student_id == student_id,
                        FeedbackSnapshot.assignment_id == assignment_id,
                    )
                )
            ).scalars().first()
            if snap is None:
                snap = FeedbackSnapshot(student_id=student_id, assignment_id=assignment_id)
                db.add(snap)
            snap.final_text = body.final_text

        await db.commit()
    except Exception:
        await db.rollback()
        raise

    return {
        "submission": submission_brief(sub),
        "error_question_ids": checked_ids,
    }
