import json
import re
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from auth.models import User
from batch_analysis import aggregate_batch
from models import Assignment, Class, ErrorRecord, LlmCallEvent, Question, Student, Submission, WeeklyReport
from serializers import GRADED_STATUSES, class_brief

TZ = ZoneInfo("Asia/Shanghai")


def normalize_section(name: str) -> str:
    return re.sub(r"^Task\s*\d+\s*[·•\-—.]?\s*", "", name, flags=re.I).strip() or name


def week_start_for(raw: str | None = None) -> date:
    if raw:
        try:
            value = date.fromisoformat(raw)
        except ValueError as error:
            raise HTTPException(status_code=400, detail="周起始日期格式应为 YYYY-MM-DD") from error
    else:
        value = datetime.now(TZ).date()
    return value - timedelta(days=value.weekday())


def utc_boundary(value: date) -> datetime:
    return datetime.combine(value, time.min, tzinfo=TZ).astimezone(timezone.utc)


async def scope_classes(db: AsyncSession, user: User, class_id: int) -> list[Class]:
    query = select(Class).where(Class.owner_uid == user.uid, Class.is_temp.is_(False))
    if class_id:
        query = query.where(Class.id == class_id)
    classes = (await db.execute(query.order_by(Class.id))).scalars().all()
    if class_id and not classes:
        raise HTTPException(status_code=404, detail="班级不存在")
    return classes


async def _week_metrics(db: AsyncSession, class_ids: list[int], uid: int, start: date, end: date) -> dict:
    start_at, end_at = utc_boundary(start), utc_boundary(end)
    submissions = (
        await db.execute(
            select(Submission)
            .join(Assignment, Submission.assignment_id == Assignment.id)
            .where(
                Assignment.class_id.in_(class_ids),
                Submission.graded_at.is_not(None),
                Submission.graded_at >= start_at,
                Submission.graded_at < end_at,
            )
        )
    ).scalars().all() if class_ids else []
    errors = (
        await db.execute(
            select(ErrorRecord, Question)
            .join(Question, ErrorRecord.question_id == Question.id)
            .join(Assignment, Question.assignment_id == Assignment.id)
            .where(
                Assignment.class_id.in_(class_ids),
                ErrorRecord.created_at >= start_at,
                ErrorRecord.created_at < end_at,
            )
        )
    ).all() if class_ids else []
    scores = [float(s.score) for s in submissions if s.status in GRADED_STATUSES and s.score is not None]
    note_keys = {(e.student_id, e.question_id) for e, _ in errors if (e.note or "").strip()}
    sections = {}
    for _, question in errors:
        name = normalize_section(question.section)
        sections[name] = sections.get(name, 0) + 1
    ai = (
        await db.execute(
            select(func.count(LlmCallEvent.id), func.coalesce(func.sum(LlmCallEvent.cost_yuan), 0))
            .where(LlmCallEvent.uid == uid, LlmCallEvent.created_at >= start_at, LlmCallEvent.created_at < end_at)
        )
    ).one()
    return {
        "graded_submissions": len(submissions),
        "error_count": len(errors),
        "finalized_notes": len(note_keys),
        "status_counts": {
            status: sum(s.status == status for s in submissions)
            for status in ("已批改", "缺作业", "未交")
        },
        "avg_score": round(sum(scores) / len(scores), 2) if scores else None,
        "top_sections": [
            {"section": name, "count": count}
            for name, count in sorted(sections.items(), key=lambda item: (-item[1], item[0]))[:5]
        ],
        "ai_calls": int(ai[0] or 0),
        "ai_cost_yuan": round(float(ai[1] or 0), 6),
    }


async def _heatmap(db: AsyncSession, classes: list[Class]) -> dict:
    class_ids = [c.id for c in classes]
    assignments = (
        await db.execute(
            select(Assignment)
            .where(Assignment.class_id.in_(class_ids))
            .order_by(Assignment.lesson_no.desc(), Assignment.id.desc())
            .limit(8)
        )
    ).scalars().all() if class_ids else []
    class_map = {c.id: c for c in classes}
    batches = []
    section_names = []
    for assignment in assignments:
        c = class_map[assignment.class_id]
        data = await aggregate_batch(db, assignment)
        grouped = {}
        for section in data["sections"]:
            name = normalize_section(section["section"])
            if name not in section_names:
                section_names.append(name)
            target = grouped.setdefault(name, {"section": name, "error_count": 0, "question_count": 0, "questions": []})
            for q in section["questions"]:
                wrong_count = len(q["wrong_students"])
                target["error_count"] += wrong_count
                target["question_count"] += 1
                target["questions"].append({
                    "id": q["id"],
                    "seq": q["seq"],
                    "wrong_count": wrong_count,
                    "correct_rate": q["correct_rate"],
                    "wrong_students": q["wrong_students"],
                })
        graded_count = sum(s["status"] in GRADED_STATUSES for s in data["_students"])
        sections = []
        for section in grouped.values():
            possible = graded_count * section["question_count"]
            sections.append({
                **section,
                "graded_count": graded_count,
                "error_rate": round(100 * section["error_count"] / possible, 2) if possible else None,
            })
        batches.append({
            "assignment_id": assignment.id,
            "slug": assignment.slug,
            "unit_label": assignment.unit_label,
            "class_id": c.id,
            "class_name": class_brief(c, assignment)["name"],
            "sections": sections,
        })
    return {"batches": batches, "sections": section_names}


async def _focus(db: AsyncSession, classes: list[Class], start: date, end: date) -> list[dict]:
    class_ids = [c.id for c in classes]
    start_at, end_at = utc_boundary(start), utc_boundary(end)
    assignments = (
        await db.execute(
            select(Assignment)
            .where(Assignment.class_id.in_(class_ids))
            .order_by(Assignment.lesson_no.desc(), Assignment.id.desc())
        )
    ).scalars().all() if class_ids else []
    class_map = {c.id: c for c in classes}
    people = {}
    for assignment in assignments:
        data = await aggregate_batch(db, assignment)
        for row in data["_students"]:
            if row["status"] == "待批改" or not row.get("graded_at"):
                continue
            graded_at = datetime.fromisoformat(row["graded_at"])
            if graded_at.tzinfo is None:
                graded_at = graded_at.replace(tzinfo=timezone.utc)
            if graded_at < start_at or graded_at >= end_at:
                continue
            person = people.setdefault(row["student_id"], {
                "student_id": row["student_id"],
                "name": row["name"],
                "code": row["code"],
                "class_id": assignment.class_id,
                "class_name": class_brief(class_map[assignment.class_id], assignment)["name"],
                "records": [],
            })
            sections = sorted({normalize_section(e["section"]) for e in data["_errors"].get(row["student_id"], [])})
            person["records"].append({
                "assignment_id": assignment.id,
                "slug": assignment.slug,
                "unit_label": assignment.unit_label,
                "status": row["status"],
                "score": row["score"],
                "sections": sections,
            })
    result = []
    for person in people.values():
        records = person["records"]
        reasons = []
        latest = records[:2]
        if len(latest) == 2 and latest[0]["status"] == latest[1]["status"] and latest[0]["status"] in ("未交", "缺作业"):
            reasons.append({
                "type": latest[0]["status"],
                "detail": f"连续 2 次{latest[0]['status']}：{latest[1]['unit_label']}、{latest[0]['unit_label']}",
            })
        scored = [r for r in records if r["status"] in GRADED_STATUSES and r["score"] is not None]
        if len(scored) >= 4:
            recent = sum(r["score"] for r in scored[:2]) / 2
            previous = sum(r["score"] for r in scored[2:4]) / 2
            if previous - recent >= 10:
                reasons.append({
                    "type": "成绩下滑",
                    "detail": f"最近两次均分 {recent:.2f}，此前两次 {previous:.2f}，下降 {previous - recent:.2f} 分",
                })
        section_counts = {}
        for record in records[:3]:
            for section in record["sections"]:
                section_counts[section] = section_counts.get(section, 0) + 1
        repeated = sorted(name for name, count in section_counts.items() if count >= 2)
        if repeated:
            reasons.append({
                "type": "同板块复现",
                "detail": f"最近 3 次中，{'、'.join(repeated)} 出现至少 2 次错题",
            })
        if reasons:
            result.append({**{k: v for k, v in person.items() if k != "records"}, "reasons": reasons})
    return sorted(result, key=lambda row: (-len(row["reasons"]), row["class_id"], row["student_id"]))


def weekly_report_out(report: WeeklyReport | None) -> dict | None:
    if report is None:
        return None
    return {
        "id": report.id,
        "content": report.content,
        "model": report.model,
        "prompt_tokens": report.prompt_tokens,
        "completion_tokens": report.completion_tokens,
        "cache_hit_tokens": report.cache_hit_tokens,
        "cache_miss_tokens": report.cache_miss_tokens,
        "reasoning_tokens": report.reasoning_tokens,
        "cost_yuan": report.cost_yuan,
        "price_tier": report.price_tier,
        "total_ms": report.total_ms,
        "updated_at": report.updated_at.isoformat() if report.updated_at else None,
    }


async def weekly_payload(db: AsyncSession, user: User, week: str | None, class_id: int = 0) -> dict:
    start = week_start_for(week)
    end = start + timedelta(days=7)
    classes = await scope_classes(db, user, class_id)
    class_ids = [c.id for c in classes]
    current = await _week_metrics(db, class_ids, user.uid, start, end)
    previous = await _week_metrics(db, class_ids, user.uid, start - timedelta(days=7), start)
    heatmap = await _heatmap(db, classes)
    focus = await _focus(db, classes, start, end)
    report = (
        await db.execute(
            select(WeeklyReport).where(
                WeeklyReport.owner_uid == user.uid,
                WeeklyReport.class_id == class_id,
                WeeklyReport.week_start == start.isoformat(),
            )
        )
    ).scalar_one_or_none()
    return {
        "scope": {"class_id": class_id, "classes": [class_brief(c) for c in classes]},
        "week": {
            "start": start.isoformat(),
            "end": (end - timedelta(days=1)).isoformat(),
            "label": f"{start.month}月{start.day}日–{(end - timedelta(days=1)).month}月{(end - timedelta(days=1)).day}日",
        },
        "current": current,
        "previous": previous,
        "heatmap": heatmap,
        "focus": focus,
        "ai_report": weekly_report_out(report),
    }


def build_weekly_evidence(data: dict) -> str:
    current, previous = data["current"], data["previous"]
    lines = [
        f"【周范围】{data['week']['start']} 至 {data['week']['end']}；班级范围：{'、'.join(c['name'] for c in data['scope']['classes']) or '无'}",
        "【本周】"
        + json.dumps(current, ensure_ascii=False),
        "【上周】"
        + json.dumps(previous, ensure_ascii=False),
        "【关注名单】"
        + json.dumps(data["focus"], ensure_ascii=False),
    ]
    cells = []
    for batch in data["heatmap"]["batches"]:
        for section in batch["sections"]:
            if section["error_count"]:
                cells.append({
                    "batch": batch["unit_label"],
                    "section": section["section"],
                    "errors": section["error_count"],
                    "error_rate": section["error_rate"],
                })
    cells.sort(key=lambda row: -(row["error_rate"] or 0))
    lines.append("【最近8批错误集中板块】" + json.dumps(cells[:12], ensure_ascii=False))
    return "\n\n".join(lines)[:20000]
