"""能力报告证据构建：把学生的三层数据资产拼成 AI 分析材料。

三层证据：
1. 反馈全文（feedback_snapshots）——最细粒度的能力信号，老师写下的每句点评
2. 错题记录（error_records.note + 题目板块/题号）——错点原文与板块归属
3. 结构化锚点（submissions 统计）——分数/未交/缺项/提交率，给 AI 校准防空泛

体积控制：材料总量超 MAX_CHARS 时，错题明细与近期快照优先保留，
远期快照从最早的开始整篇剔除（保头不保尾）。
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import Assignment, ErrorRecord, FeedbackSnapshot, Question, Student, Submission

MAX_CHARS = 40_000
GRADED = ("已批改", "缺作业")


def _in_range(class_time: str, start: str, end: str) -> bool:
    """class_time 形如「2026-09-12 14:00」；空前缀视为在范围内（不丢数据）。"""
    day = (class_time or "")[:10]
    if not day:
        return True
    if start and day < start:
        return False
    if end and day > end:
        return False
    return True


async def build_evidence(
    db: AsyncSession, student: Student, range_start: str = "", range_end: str = ""
) -> dict:
    """汇总学生在时间范围内的分析材料，返回 {evidence_text, assignment_count, stats}。"""
    # 范围内提交记录（按课次正序）
    rows = (
        await db.execute(
            select(Assignment, Submission)
            .join(Submission, Submission.assignment_id == Assignment.id)
            .where(Submission.student_id == student.id)
            .order_by(Assignment.lesson_no.asc())
        )
    ).all()
    rows = [(a, s) for a, s in rows if _in_range(a.class_time, range_start, range_end)]
    if not rows:
        return {"evidence_text": "", "assignment_count": 0, "stats": {}}

    aids = [a.id for a, _ in rows]
    a_by_id = {a.id: a for a, _ in rows}

    # 反馈快照（该生范围内，每批次取最新一份）
    snaps = (
        await db.execute(
            select(FeedbackSnapshot)
            .where(FeedbackSnapshot.student_id == student.id, FeedbackSnapshot.assignment_id.in_(aids))
            .order_by(FeedbackSnapshot.created_at.desc())
        )
    ).scalars().all()
    latest_snap: dict[int, FeedbackSnapshot] = {}
    for snap in snaps:
        latest_snap.setdefault(snap.assignment_id, snap)

    # 错题明细（带题目板块/题号/题干）
    errs = (
        await db.execute(
            select(ErrorRecord, Question)
            .join(Question, ErrorRecord.question_id == Question.id)
            .where(ErrorRecord.student_id == student.id, Question.assignment_id.in_(aids))
            .order_by(Question.assignment_id.asc(), Question.section.asc(), Question.seq.asc())
        )
    ).all()

    # ── 结构化统计 ──
    graded = [s for _, s in rows if s.status in GRADED and s.score is not None]
    unsubmitted = sum(1 for _, s in rows if s.status == "未交")
    partial = sum(1 for _, s in rows if s.status == "缺作业")
    avg = round(sum(s.score for s in graded) / len(graded), 2) if graded else None
    stats = {
        "total": len(rows),
        "graded": len(graded),
        "unsubmitted": unsubmitted,
        "partial": partial,
        "avg_score": avg,
        "error_total": len(errs),
    }

    def assignment_head(a: Assignment, s: Submission) -> str:
        score = f"{s.score:.2f}" if s.score is not None else "—"
        rating = s.rating_override or s.rating or ""
        return (
            f"── {a.unit_label}（{a.class_time or '日期待定'} · 第{a.lesson_no}次课）"
            f"状态 {s.status} · 分数 {score}{(' ' + rating) if rating else ''}"
        )

    # ── 拼装：统计 + 错题明细（优先保留）+ 反馈全文（可裁）──
    head_lines = [
        f"【提交统计】范围内作业 {stats['total']} 次：已批改 {stats['graded']}、"
        f"缺作业 {partial}、未交 {unsubmitted}；"
        f"平均分 {avg if avg is not None else '—'}；错题共 {stats['error_total']} 题",
    ]

    err_blocks: list[str] = []
    for er, q in errs:
        a = a_by_id[q.assignment_id]
        note = (er.note or "").strip()
        err_blocks.append(
            f"── {a.unit_label} · {q.section} 第{q.seq}题\n"
            f"错点/讲解记录：{note if note else '（无文字记录，仅标记错误）'}"
        )

    snap_blocks: list[tuple[int, str]] = []  # (lesson_no, block) 供从远到近裁剪
    for a, sub in rows:
        snap = latest_snap.get(a.id)
        if not snap or not snap.final_text.strip():
            continue
        snap_blocks.append(
            (a.lesson_no, f"{assignment_head(a, sub)}\n反馈全文：\n{snap.final_text.strip()}")
        )

    err_text = "\n\n".join(err_blocks)
    fixed = "\n".join(head_lines) + "\n\n【错题明细】\n" + (err_text or "（范围内无错题记录）")
    budget = MAX_CHARS - len(fixed) - 200  # 标题与分隔余量

    kept: list[str] = []
    for _lesson_no, block in sorted(snap_blocks, key=lambda x: -x[0]):  # 近期优先
        if budget - len(block) >= 0:
            kept.append(block)
            budget -= len(block)
        elif budget > 1500:  # 放不下整篇就截断保留开头（更早的直接整篇剔除）
            kept.append(block[:budget] + "\n……（篇幅所限，该篇反馈仅保留开头）")
            budget = 0
    kept.reverse()  # 恢复时间正序

    evidence_text = fixed + "\n\n【历次作业与反馈全文】\n" + ("\n\n".join(kept) or "（范围内无反馈快照）")
    return {
        "evidence_text": evidence_text,
        "assignment_count": len(rows),
        "stats": stats,
    }
