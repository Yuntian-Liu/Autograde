"""只读接口的序列化辅助。"""

from feedback import feedback_type, unit_progress
from models import Assignment, Class, Question, Student, Submission

GRADED_STATUSES = ("已批改", "缺作业")  # 有分数的状态


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
