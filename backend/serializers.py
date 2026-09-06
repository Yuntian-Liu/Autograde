"""只读接口的序列化辅助。"""

import json

from sqlalchemy import func, select

from feedback import feedback_type, unit_progress
from models import Assignment, Class, Phrase, Question, Student, Submission

GRADED_STATUSES = ("已批改", "缺作业")  # 有分数的状态
PROCESSED_STATUSES = ("已批改", "缺作业", "未交")  # 已处理：唯一未处理状态是「待批改」


async def assignment_status(db, a: Assignment) -> str:
    """批次状态动态推导（不读 assignments.status 静态字段）：
    全部学生待批改 = 未开始；存在待批改 = 批改中；零待批改 = 已完成。
    没有提交记录的学生视为待批改。"""
    total = (
        await db.execute(select(func.count(Student.id)).where(Student.class_id == a.class_id))
    ).scalar_one()
    if total == 0:
        return "未开始"
    rows = (
        await db.execute(
            select(Submission.status, func.count(Submission.id))
            .where(Submission.assignment_id == a.id)
            .group_by(Submission.status)
        )
    ).all()
    by_status = {status: count for status, count in rows}
    pending = by_status.get("待批改", 0) + (total - sum(by_status.values()))
    if pending == 0:
        return "已完成"
    if pending >= total:
        return "未开始"
    return "批改中"


def parse_options(raw: str) -> list[str]:
    """questions.options 存 JSON 数组字符串，输出时解析成数组；非法或空一律 []。"""
    if not raw:
        return []
    try:
        data = json.loads(raw)
        return [str(x) for x in data] if isinstance(data, list) else []
    except (ValueError, TypeError):
        return []


def class_brief(c: Class) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "series": c.series,
        "level": c.level,
        "term": c.term,
        "schedule": c.schedule,
        "feedback_type": feedback_type(c.series),
    }


def assignment_brief(a: Assignment) -> dict:
    return {
        "id": a.id,
        "class_id": a.class_id,
        "unit_label": a.unit_label,
        "unit_no": a.unit_no,
        "lesson_type": a.lesson_type,
        "unit_lesson_no": a.unit_lesson_no,
        "has_preview": a.has_preview,
        "preview_unit_no": a.preview_unit_no,
        "preview_half": a.preview_half,
        "unit_progress": unit_progress(a),
        "lesson_no": a.lesson_no,
        "class_time": a.class_time,
        "content": a.content,
        "status": a.status,
    }


def question_brief(q: Question) -> dict:
    return {
        "id": q.id,
        "seq": q.seq,
        "mode": q.mode,
        "section": q.section,
        "stem": q.stem,
        "options": parse_options(q.options),
        "standard_answer": q.standard_answer,
        "explanation": q.explanation,
        "score_weight": q.score_weight,
    }


def student_brief(s: Student) -> dict:
    return {"id": s.id, "name": s.name, "class_id": s.class_id, "note": s.note}


def submission_brief(sub: Submission) -> dict:
    return {
        "id": sub.id,
        "status": sub.status,
        "score": sub.score,
        "rating": sub.rating,
        "rating_override": sub.rating_override,
    }


def phrase_brief(p: Phrase) -> dict:
    return {
        "id": p.id,
        "category": p.category,
        "name": p.name,
        "content": p.content,
        "scope": p.scope,
        "use_count": p.use_count,
    }
