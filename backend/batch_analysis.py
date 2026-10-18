"""批次统计与 AI 批次分析共用的数据聚合、证据构建和报告持久化。"""

import json
from datetime import datetime, timezone
from statistics import median

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    Assignment,
    BatchAnalysisReport,
    Class,
    ErrorRecord,
    FeedbackSnapshot,
    Question,
    Student,
    Submission,
    utcnow,
)
from serializers import (
    GRADED_STATUSES,
    PROCESSED_STATUSES,
    assignment_brief,
    assignment_student_condition,
    class_brief,
    question_brief,
)

MAX_STUDENT_CHARS = 5_000
MAX_CHARS = 60_000
_TRUNCATED = "\n……（篇幅所限，后续内容已省略）"


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    if limit <= len(_TRUNCATED):
        return text[:limit]
    return text[: limit - len(_TRUNCATED)] + _TRUNCATED


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _created_key(value: datetime | None) -> tuple[int, float]:
    if value is None:
        return 1, 0.0
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return 0, value.timestamp()


def batch_analysis_report_out(report: BatchAnalysisReport) -> dict:
    return {
        "content": report.content,
        "model": report.model,
        "prompt_tokens": report.prompt_tokens,
        "completion_tokens": report.completion_tokens,
        "cache_hit_tokens": report.cache_hit_tokens,
        "cache_miss_tokens": report.cache_miss_tokens,
        "reasoning_tokens": report.reasoning_tokens,
        "cost_yuan": report.cost_yuan,
        "price_tier": report.price_tier or "",
        "total_ms": report.total_ms,
        "created_at": _iso(report.created_at),
        "updated_at": _iso(report.updated_at),
    }


async def upsert_batch_analysis_report(
    db: AsyncSession,
    *,
    assignment_id: int,
    owner_uid: int,
    content: str,
    model: str,
    usage: dict | None,
    metrics: dict | None,
    cost_yuan: float,
    price_tier: str,
) -> BatchAnalysisReport:
    usage = usage or {}
    metrics = metrics or {}
    now = utcnow()
    values = {
        "assignment_id": assignment_id,
        "owner_uid": owner_uid,
        "content": content,
        "model": model,
        "prompt_tokens": usage.get("prompt_tokens", 0) or 0,
        "completion_tokens": usage.get("completion_tokens", 0) or 0,
        "cache_hit_tokens": usage.get("cache_hit_tokens", 0) or 0,
        "cache_miss_tokens": usage.get("cache_miss_tokens", 0) or 0,
        "reasoning_tokens": usage.get("reasoning_tokens", 0) or 0,
        "cost_yuan": cost_yuan or 0.0,
        "price_tier": price_tier or "",
        "total_ms": metrics.get("total_ms", 0) or 0,
        "created_at": now,
        "updated_at": now,
    }
    stmt = sqlite_insert(BatchAnalysisReport).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=["assignment_id"],
        set_={key: value for key, value in values.items() if key != "created_at"},
    )
    await db.execute(stmt)
    await db.commit()
    return (
        await db.execute(
            select(BatchAnalysisReport).where(BatchAnalysisReport.assignment_id == assignment_id)
        )
    ).scalar_one()


async def aggregate_batch(db: AsyncSession, assignment: Assignment) -> dict:
    students = (
        await db.execute(
            select(Student)
            .where(
                Student.class_id == assignment.class_id,
                assignment_student_condition(assignment),
            )
            .order_by(Student.id)
        )
    ).scalars().all()
    student_ids = [student.id for student in students]
    names = {student.id: student.name for student in students}

    submissions = (
        (
            await db.execute(
                select(Submission)
                .where(
                    Submission.assignment_id == assignment.id,
                    Submission.student_id.in_(student_ids),
                )
                .order_by(Submission.id)
            )
        ).scalars().all()
        if student_ids
        else []
    )
    submission_by_student: dict[int, Submission] = {}
    for submission in submissions:
        submission_by_student.setdefault(submission.student_id, submission)

    student_rows: list[dict] = []
    ranking_rows: list[dict] = []
    for student in students:
        submission = submission_by_student.get(student.id)
        status = submission.status if submission else "待批改"
        score = (
            float(submission.score)
            if submission and status in GRADED_STATUSES and submission.score is not None
            else None
        )
        rank_score = score if status in GRADED_STATUSES else 0.0 if status == "未交" else None
        if status in GRADED_STATUSES and rank_score is None:
            rank_score = 0.0
        created_at = submission.created_at if submission else None
        row = {
            "student_id": student.id,
            "name": student.name,
            "code": student.code,
            "status": status,
            "score": score,
            "rank_score": rank_score,
            "graded_at": _iso(created_at),
        }
        student_rows.append(row)
        if status in PROCESSED_STATUSES:
            ranking_rows.append({**row, "_created_at": created_at})

    ranking_rows.sort(
        key=lambda row: (
            -row["rank_score"],
            _created_key(row["_created_at"]),
            row["name"],
            row["student_id"],
        )
    )
    ranking = []
    for index, row in enumerate(ranking_rows, start=1):
        ranking.append({"rank": index, **{key: value for key, value in row.items() if key != "_created_at"}})

    graded_count = sum(row["status"] in PROCESSED_STATUSES for row in student_rows)
    absent_count = sum(row["status"] == "未交" for row in student_rows)
    valid_scores = sorted(
        float(row["score"])
        for row in student_rows
        if row["status"] in GRADED_STATUSES and row["score"] is not None and row["score"] > 0
    )
    summary = {
        "total_students": len(student_rows),
        "graded_count": graded_count,
        "absent_count": absent_count,
        "pending_count": len(student_rows) - graded_count,
        "valid_count": len(valid_scores),
        "avg_score": round(sum(valid_scores) / len(valid_scores), 2) if valid_scores else None,
        "median_score": round(float(median(valid_scores)), 2) if valid_scores else None,
        "max_score": max(valid_scores) if valid_scores else None,
        "min_score": min(valid_scores) if valid_scores else None,
    }

    questions = (
        await db.execute(
            select(Question)
            .where(Question.assignment_id == assignment.id)
            .order_by(Question.section, Question.seq, Question.id)
        )
    ).scalars().all()
    graded_sids = {
        row["student_id"] for row in student_rows if row["status"] in GRADED_STATUSES
    }
    error_rows = (
        (
            await db.execute(
                select(ErrorRecord, Question)
                .join(Question, ErrorRecord.question_id == Question.id)
                .where(
                    Question.assignment_id == assignment.id,
                    ErrorRecord.student_id.in_(student_ids),
                )
                .order_by(ErrorRecord.id)
            )
        ).all()
        if student_ids
        else []
    )
    wrong_by_question: dict[int, list[dict]] = {}
    errors_by_student: dict[int, list[dict]] = {}
    seen_wrong: set[tuple[int, int]] = set()
    for error, question in error_rows:
        if error.student_id not in graded_sids:
            continue
        errors_by_student.setdefault(error.student_id, []).append(
            {
                "question_id": question.id,
                "section": question.section,
                "seq": question.seq,
                "awarded_score": float(error.awarded_score),
                "score_weight": float(question.score_weight),
                "note": error.note or "",
            }
        )
        key = (question.id, error.student_id)
        if key not in seen_wrong:
            seen_wrong.add(key)
            wrong_by_question.setdefault(question.id, []).append(
                {"id": error.student_id, "name": names[error.student_id]}
            )

    groups: dict[str, list[Question]] = {}
    for question in questions:
        groups.setdefault(question.section, []).append(question)
    try:
        custom_order = json.loads(assignment.section_order) if assignment.section_order else []
    except ValueError:
        custom_order = []
    if custom_order:
        ordered = [name for name in custom_order if name in groups]
        ordered += sorted(
            (name for name in groups if name not in custom_order),
            key=lambda name: min(question.id for question in groups[name]),
        )
    else:
        ordered = sorted(groups, key=lambda name: min(question.id for question in groups[name]))

    sections = []
    for name in ordered:
        section = {"section": name, "questions": []}
        for question in groups[name]:
            item = question_brief(question)
            wrong = wrong_by_question.get(question.id, [])
            base = len(graded_sids)
            item["correct_rate"] = (
                round(100 * (base - len(wrong)) / base, 2) if base > 0 else None
            )
            item["wrong_students"] = wrong
            section["questions"].append(item)
        section["question_count"] = len(section["questions"])
        section["total_weight"] = round(
            sum(question["score_weight"] for question in section["questions"]), 2
        )
        sections.append(section)

    snapshots = (
        (
            await db.execute(
                select(FeedbackSnapshot)
                .where(
                    FeedbackSnapshot.assignment_id == assignment.id,
                    FeedbackSnapshot.student_id.in_(student_ids),
                )
                .order_by(FeedbackSnapshot.id.desc())
            )
        ).scalars().all()
        if student_ids
        else []
    )
    latest_snapshots: dict[int, str] = {}
    for snapshot in snapshots:
        if snapshot.student_id in graded_sids:
            latest_snapshots.setdefault(snapshot.student_id, snapshot.final_text or "")

    return {
        "summary": summary,
        "ranking": ranking,
        "valid_scores": valid_scores,
        "sections": sections,
        "_students": student_rows,
        "_errors": errors_by_student,
        "_snapshots": latest_snapshots,
    }


async def build_assignment_analysis(
    db: AsyncSession, assignment: Assignment, class_: Class
) -> dict:
    data = await aggregate_batch(db, assignment)
    report = (
        await db.execute(
            select(BatchAnalysisReport).where(
                BatchAnalysisReport.assignment_id == assignment.id,
                BatchAnalysisReport.owner_uid == class_.owner_uid,
            )
        )
    ).scalar_one_or_none()
    return {
        "assignment": {**assignment_brief(assignment), "class": class_brief(class_, assignment)},
        "summary": data["summary"],
        "ranking": data["ranking"],
        "valid_scores": data["valid_scores"],
        "sections": data["sections"],
        "ai_report": batch_analysis_report_out(report) if report else None,
    }


def build_batch_evidence(assignment: Assignment, class_: Class, data: dict) -> str:
    if not data["valid_scores"]:
        return ""

    summary = data["summary"]
    class_name = class_brief(class_, assignment)["name"]
    header = (
        f"【批次】{class_name} / {assignment.unit_label}；上课时间 {assignment.class_time or '日期待定'}\n"
        f"【人数】名单 {summary['total_students']}；已处理 {summary['graded_count']}；"
        f"未交 {summary['absent_count']}；待批改 {summary['pending_count']}；有效分 {summary['valid_count']}\n"
        f"【有效分统计】平均 {summary['avg_score']}；中位 {summary['median_score']}；"
        f"最高 {summary['max_score']}；最低 {summary['min_score']}"
    )

    cores: list[str] = []
    snapshots: list[str] = []
    for row in data["_students"]:
        score = f"{row['score']:g}" if row["score"] is not None else "—"
        rank_score = f"{row['rank_score']:g}" if row["rank_score"] is not None else "不参与"
        lines = [
            f"{row['name']}｜状态 {row['status']}｜真实分 {score}｜排名分 {rank_score}"
        ]
        for error in data["_errors"].get(row["student_id"], []):
            note = error["note"].strip() or "（无文字记录，仅标记错误）"
            lines.append(
                f"  错题 {error['section']} 第{error['seq']}题："
                f"得分 {error['awarded_score']:g}/{error['score_weight']:g}；人工错点 {note}"
            )
        cores.append(_clip("\n".join(lines), MAX_STUDENT_CHARS))
        snapshots.append((data["_snapshots"].get(row["student_id"]) or "").strip())

    question_lines = []
    for section in data["sections"]:
        for question in section["questions"]:
            wrong_names = "、".join(item["name"] for item in question["wrong_students"]) or "无"
            rate = question["correct_rate"]
            question_lines.append(
                f"{section['section']} 第{question['seq']}题｜"
                f"正确率 {f'{rate:g}%' if rate is not None else '—'}｜"
                f"错误人数 {len(question['wrong_students'])}｜错误学生 {wrong_names}"
            )

    def render(chosen_snapshots: list[str]) -> str:
        student_blocks = []
        for core, snapshot in zip(cores, chosen_snapshots, strict=True):
            if snapshot:
                core += f"\n  反馈快照（仅作补充，不覆盖以上当前事实）：{snapshot}"
            student_blocks.append(core)
        return (
            header
            + "\n\n【学生逐人证据】\n"
            + ("\n\n".join(student_blocks) or "（无学生）")
            + "\n\n【逐题统计】\n"
            + ("\n".join(question_lines) or "（无题目）")
        )

    empty_snapshots = [""] * len(cores)
    base_length = len(render(empty_snapshots))
    if base_length >= MAX_CHARS:
        return _clip(render(empty_snapshots), MAX_CHARS)

    chosen: list[str] = []
    used = 0
    prefix = "\n  反馈快照（仅作补充，不覆盖以上当前事实）："
    for core, snapshot in zip(cores, snapshots, strict=True):
        allowance = min(
            MAX_STUDENT_CHARS - len(core) - len(prefix),
            MAX_CHARS - base_length - used - len(prefix),
        )
        selected = _clip(snapshot, allowance) if snapshot and allowance > 0 else ""
        chosen.append(selected)
        if selected:
            used += len(prefix) + len(selected)
    return _clip(render(chosen), MAX_CHARS)
