import json

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from access import owned_assignment
from auth.dependencies import get_current_user
from auth.models import User
from database import get_db
from feedback import sync_unit_label, validate_unit_fields
from models import (
    Assignment,
    Class,
    ErrorRecord,
    FeedbackSnapshot,
    Phrase,
    Question,
    Student,
    Submission,
)
from rating import rating_for
from serializers import (
    GRADED_STATUSES,
    PROCESSED_STATUSES,
    assignment_brief,
    assignment_status,
    class_brief,
    question_brief,
    student_brief,
    submission_brief,
)

router = APIRouter(prefix="/api/assignments", tags=["assignments"])

SUBMISSION_STATUSES = ("待批改", "已批改", "缺作业", "未交")
QUESTION_MODES = ("verbatim", "ai_expand", "manual")


async def _assignment_progress(db: AsyncSession, a: Assignment) -> dict:
    """批改进度：已处理 = 已批改/缺作业/未交；无提交记录的学生计入待批改。"""
    question_count = (
        await db.execute(select(func.count(Question.id)).where(Question.assignment_id == a.id))
    ).scalar_one()
    total_students = (
        await db.execute(select(func.count(Student.id)).where(Student.class_id == a.class_id))
    ).scalar_one()
    rows = (
        await db.execute(
            select(Submission.status, func.count(Submission.id))
            .where(Submission.assignment_id == a.id)
            .group_by(Submission.status)
        )
    ).all()
    by_status = {status: count for status, count in rows}
    unrecorded = total_students - sum(by_status.values())
    return {
        "question_count": question_count,
        "total_students": total_students,
        "graded_count": sum(by_status.get(s, 0) for s in PROCESSED_STATUSES),
        "pending_count": by_status.get("待批改", 0) + unrecorded,
        "missing_count": by_status.get("缺作业", 0),
        "absent_count": by_status.get("未交", 0),
    }


@router.get("")
async def list_assignments(
    limit: int = Query(default=8, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """最近批次：工作台「最近批次」板块数据源（仅本人班级）。"""
    assignments = (
        await db.execute(
            select(Assignment)
            .join(Class, Assignment.class_id == Class.id)
            .where(Class.owner_uid == user.uid)
            .order_by(Assignment.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    result = []
    for a in assignments:
        c = await db.get(Class, a.class_id)
        result.append(
            {
                **assignment_brief(a),
                "status": await assignment_status(db, a),  # 动态推导，覆盖静态字段
                **await _assignment_progress(db, a),
                "class": class_brief(c) if c else None,
            }
        )
    return result


@router.get("/{assignment_id}")
async def get_assignment(
    assignment_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    a = await owned_assignment(db, assignment_id, user)
    assignment_id = a.id  # slug 入口归一化为主键，正文查询不受影响
    c = await db.get(Class, a.class_id)

    questions = (
        await db.execute(
            select(Question)
            .where(Question.assignment_id == assignment_id)
            .order_by(Question.section, Question.seq)
        )
    ).scalars().all()

    # 逐题正确率：分母 = 已批改（已批改/缺作业）学生数；答错名单随题输出（量小）
    graded_sids = set(
        (
            await db.execute(
                select(Submission.student_id).where(
                    Submission.assignment_id == assignment_id,
                    Submission.status.in_(GRADED_STATUSES),
                )
            )
        ).scalars().all()
    )
    wrong_rows = (
        await db.execute(
            select(ErrorRecord.question_id, ErrorRecord.student_id, Student.name)
            .join(Student, ErrorRecord.student_id == Student.id)
            .join(Question, ErrorRecord.question_id == Question.id)
            .where(Question.assignment_id == assignment_id)
        )
    ).all()
    wrong_by_q: dict[int, list[tuple[int, str]]] = {}
    for qid, sid, name in wrong_rows:
        if sid in graded_sids:  # 未批改/未交学生不进统计
            wrong_by_q.setdefault(qid, []).append((sid, name))
    base = len(graded_sids)

    # 按板块分组（组内保持 seq 序），组间顺序：手动 section_order 优先，缺省按录入顺序（组首题 id）
    groups: dict[str, list] = {}
    for q in questions:
        groups.setdefault(q.section, []).append(q)
    try:
        custom_order = json.loads(a.section_order) if a.section_order else []
    except ValueError:
        custom_order = []
    if custom_order:
        ordered = [n for n in custom_order if n in groups]  # 列表内有效板块按序
        ordered += sorted(
            (n for n in groups if n not in custom_order),
            key=lambda n: min(q.id for q in groups[n]),
        )  # 后录的新板块 append 兜底
    else:
        ordered = sorted(groups, key=lambda n: min(q.id for q in groups[n]))

    sections: list[dict] = []
    for name in ordered:
        sec = {"section": name, "questions": []}
        for q in groups[name]:
            item = question_brief(q)
            wrong = wrong_by_q.get(q.id, [])
            item["correct_rate"] = round(100 * (base - len(wrong)) / base, 2) if base > 0 else None
            item["wrong_students"] = [{"id": sid, "name": name_} for sid, name_ in wrong]
            sec["questions"].append(item)
        sec["question_count"] = len(sec["questions"])
        sec["total_weight"] = round(sum(q["score_weight"] for q in sec["questions"]), 2)
        sections.append(sec)

    return {
        **assignment_brief(a),
        "status": await assignment_status(db, a),  # 动态推导，覆盖静态字段
        **await _assignment_progress(db, a),
        "class": class_brief(c) if c else None,
        "sections": sections,
        "total_weight": round(sum(q.score_weight for q in questions), 2),
    }


@router.get("/{assignment_id}/students")
async def get_assignment_students(
    assignment_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """批改界面左栏数据源：每个学生带提交状态/分数/等级、已勾选错题、历史数据。"""
    a = await owned_assignment(db, assignment_id, user)
    assignment_id = a.id  # slug 入口归一化为主键，正文查询不受影响

    students = (
        await db.execute(
            select(Student).where(Student.class_id == a.class_id).order_by(Student.id)
        )
    ).scalars().all()

    # 最新反馈快照（每生一条，整批一次查询避免 N+1；供批改页快照回显）
    snap_rows = (
        await db.execute(
            select(FeedbackSnapshot.student_id, FeedbackSnapshot.final_text)
            .where(FeedbackSnapshot.assignment_id == assignment_id)
            .order_by(FeedbackSnapshot.id.desc())
        )
    ).all()
    latest_snapshots: dict[int, str] = {}
    for sid, text in snap_rows:
        latest_snapshots.setdefault(sid, text)

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
                "feedback_text": latest_snapshots.get(s.id),
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
    assignment_id: str,
    body: AssignmentPatch,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    a = await owned_assignment(db, assignment_id, user)
    assignment_id = a.id  # slug 入口归一化为主键，正文查询不受影响
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
async def delete_assignment(
    assignment_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    a = await owned_assignment(db, assignment_id, user)
    assignment_id = a.id  # slug 入口归一化为主键，正文查询不受影响
    question_ids = select(Question.id).where(Question.assignment_id == assignment_id)
    await db.execute(delete(ErrorRecord).where(ErrorRecord.question_id.in_(question_ids)))
    await db.execute(delete(Submission).where(Submission.assignment_id == assignment_id))
    await db.execute(
        delete(FeedbackSnapshot).where(FeedbackSnapshot.assignment_id == assignment_id)
    )
    await db.execute(delete(Question).where(Question.assignment_id == assignment_id))
    await db.delete(a)
    await db.commit()


class SectionRenameIn(BaseModel):
    from_: str = Field(alias="from")
    to: str


@router.patch("/{assignment_id}/sections")
async def rename_section(
    assignment_id: str,
    body: SectionRenameIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """板块整组改名：板块名会进反馈输出标题，必须事务落库生效；section_order 联动换名。"""
    a = await owned_assignment(db, assignment_id, user)
    assignment_id = a.id  # slug 入口归一化为主键，正文查询不受影响
    src, dst = body.from_.strip(), body.to.strip()
    if not src or not dst:
        raise HTTPException(status_code=400, detail="板块名不能为空")
    if src == dst:
        raise HTTPException(status_code=400, detail="板块名未变化")
    result = await db.execute(
        update(Question)
        .where(Question.assignment_id == assignment_id, Question.section == src)
        .values(section=dst)
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"板块不存在：{src}")
    # 手动顺序里的旧名同步替换，保持板块排序不因改名错位
    try:
        order = json.loads(a.section_order) if a.section_order else []
    except ValueError:
        order = []
    if src in order:
        order = [dst if n == src else n for n in order]
        a.section_order = json.dumps(order, ensure_ascii=False)
    await db.commit()
    return {"from": src, "to": dst, "updated": result.rowcount}


class SectionOrderIn(BaseModel):
    order: list[str]


@router.put("/{assignment_id}/sections-order")
async def update_section_order(
    assignment_id: str,
    body: SectionOrderIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """板块手动排序：order 必须与库内板块集合完全一致（多/缺均 400）。"""
    a = await owned_assignment(db, assignment_id, user)
    assignment_id = a.id  # slug 入口归一化为主键，正文查询不受影响
    current = set(
        (
            await db.execute(
                select(Question.section).where(Question.assignment_id == assignment_id).distinct()
            )
        ).scalars().all()
    )
    incoming = [n.strip() for n in body.order if n.strip()]
    if len(incoming) != len(set(incoming)):
        raise HTTPException(status_code=400, detail="板块顺序存在重复")
    if set(incoming) != current:
        raise HTTPException(
            status_code=400,
            detail=f"板块列表与题库不一致（题库共 {len(current)} 个板块）",
        )
    a.section_order = json.dumps(incoming, ensure_ascii=False)
    await db.commit()
    return {"order": incoming}


class QuestionIn(BaseModel):
    section: str
    seq: int | None = None  # 缺省时按板块内现有最大题号顺延
    mode: str = "verbatim"
    stem: str = ""
    options: list[str] = []  # 选项数组，入库时转 JSON 字符串
    standard_answer: str = ""
    explanation: str = ""
    score_weight: float = 5.0


class QuestionsBatchIn(BaseModel):
    questions: list[QuestionIn]


@router.post("/{assignment_id}/questions", status_code=201)
async def create_questions(
    assignment_id: str,
    body: QuestionsBatchIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """批量录题：人工验收后冻结入库（AI 解析结果也走这里落定）。"""
    a = await owned_assignment(db, assignment_id, user)
    assignment_id = a.id  # slug 入口归一化为主键，正文查询不受影响
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
            options=json.dumps(item.options, ensure_ascii=False),
            standard_answer=item.standard_answer,
            explanation=item.explanation,
            score_weight=item.score_weight,
        )
        db.add(q)
        created.append(q)
    await db.commit()
    return [question_brief(q) for q in created]


class QuestionPutIn(BaseModel):
    id: int | None = None  # 有 id = 更新（保批改引用）；无 id = 新增
    section: str
    seq: int | None = None  # 缺省时按请求内同板块最大题号顺延
    mode: str = "verbatim"
    stem: str = ""
    options: list[str] = []
    standard_answer: str = ""
    explanation: str = ""
    score_weight: float = 5.0


class QuestionsPutIn(BaseModel):
    questions: list[QuestionPutIn]
    section_order: list[str] | None = None  # 整批编辑的板块顺序（编辑器内上下移的结果）


@router.put("/{assignment_id}/questions")
async def replace_questions(
    assignment_id: str,
    body: QuestionsPutIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """整批编辑（diff 替换）：带 id 的行 UPDATE（id 不变，错题/提交/快照引用全保），
    无 id 的行 INSERT，库内有而请求没有的行 DELETE（级联删该题错题记录）。
    事务内一次落定；section_order 一并写入（板块卡上下移的编辑结果）。"""
    a = await owned_assignment(db, assignment_id, user)
    assignment_id = a.id  # slug 入口归一化为主键，正文查询不受影响
    if not body.questions:
        raise HTTPException(status_code=400, detail="题目列表不能为空")
    for item in body.questions:
        if item.mode not in QUESTION_MODES:
            raise HTTPException(status_code=400, detail=f"未知题目模式：{item.mode}")
        if not item.section.strip():
            raise HTTPException(status_code=400, detail="板块名不能为空")
        if not item.standard_answer.strip():
            raise HTTPException(status_code=400, detail=f"题目缺少标准答案（seq={item.seq or '新'}）")

    existing = (
        await db.execute(select(Question).where(Question.assignment_id == assignment_id))
    ).scalars().all()
    by_id = {q.id: q for q in existing}
    keep_ids = {item.id for item in body.questions if item.id is not None}
    # 请求里的 id 必须属于本批次（防跨批次串改）
    foreign = [i for i in keep_ids if i not in by_id]
    if foreign:
        raise HTTPException(status_code=400, detail=f"题目不属于本批次：{foreign[:5]}")

    try:
        updated = inserted = 0
        # seq 缺省顺延：请求内同板块已出现的最大题号 +1
        next_seq: dict[str, int] = {}
        for item in body.questions:
            section = item.section.strip()
            base = next_seq.get(section, 0)
            if item.seq is not None:
                next_seq[section] = max(base, item.seq)
        for item in body.questions:
            section = item.section.strip()
            seq = item.seq if item.seq is not None else next_seq.get(section, 0) + 1
            next_seq[section] = max(next_seq.get(section, 0), seq)
            payload = dict(
                section=section,
                seq=seq,
                mode=item.mode,
                stem=item.stem,
                options=json.dumps(item.options, ensure_ascii=False),
                standard_answer=item.standard_answer,
                explanation=item.explanation,
                score_weight=item.score_weight,
            )
            if item.id is not None:
                q = by_id[item.id]
                for field, value in payload.items():
                    setattr(q, field, value)
                updated += 1
            else:
                db.add(Question(assignment_id=assignment_id, **payload))
                inserted += 1
        # 消失的题：级联删错题记录后删除
        removed_ids = [q.id for q in existing if q.id not in keep_ids]
        if removed_ids:
            await db.execute(delete(ErrorRecord).where(ErrorRecord.question_id.in_(removed_ids)))
            await db.execute(delete(Question).where(Question.id.in_(removed_ids)))
        # 板块顺序（编辑器上下移结果）
        if body.section_order is not None:
            a.section_order = json.dumps(
                [n.strip() for n in body.section_order if n.strip()], ensure_ascii=False
            )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return {
        "updated": updated,
        "inserted": inserted,
        "removed": len(removed_ids),
        "total": len(body.questions),
    }


@router.delete("/{assignment_id}/questions", status_code=204)
async def clear_questions(
    assignment_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    """一键清空题库：题目 + 错题记录 + 提交记录 + 反馈快照全清，批次保留（回到刚建状态）。"""
    a = await owned_assignment(db, assignment_id, user)
    assignment_id = a.id  # slug 入口归一化为主键，正文查询不受影响
    question_ids = select(Question.id).where(Question.assignment_id == assignment_id)
    await db.execute(delete(ErrorRecord).where(ErrorRecord.question_id.in_(question_ids)))
    await db.execute(delete(Submission).where(Submission.assignment_id == assignment_id))
    await db.execute(delete(FeedbackSnapshot).where(FeedbackSnapshot.assignment_id == assignment_id))
    await db.execute(delete(Question).where(Question.assignment_id == assignment_id))
    a.section_order = ""  # 板块顺序随之失效
    await db.commit()


class GradingIn(BaseModel):
    status: str
    checked_question_ids: list[int] = []
    rating_override: str = ""
    notes: dict[int, str] = {}  # question_id → 该题定稿内容（manual 人工填充 / ai_expand 定稿）
    final_text: str = ""
    used_phrase_ids: list[int] = []  # 本次用到的话术（问候/评级/Issue），驱动 use_count 越用越聪明


@router.put("/{assignment_id}/students/{student_id}/grading")
async def save_grading(
    assignment_id: str,
    student_id: int,
    body: GradingIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """批改落库：score/rating 由后端按 score_weight 复算（不信前端），
    error_records 先删后插，feedback_snapshots 存档 final_text。"""
    a = await owned_assignment(db, assignment_id, user)
    assignment_id = a.id  # slug 入口归一化为主键，正文查询不受影响
    s = await db.get(Student, student_id)
    if s is None:
        raise HTTPException(status_code=404, detail="学生不存在")
    if s.class_id != a.class_id:
        raise HTTPException(status_code=400, detail="学生不属于该批次的班级")
    if body.status not in SUBMISSION_STATUSES:
        raise HTTPException(status_code=400, detail="未知提交状态")

    # 复位分支：改回「待批改」= 清除该生该批次全部批改记录（登记错学生时用）
    # 错题记录 + 分数/等级 + 反馈快照一并删除，事务包裹；正常保存分支不受影响
    if body.status == "待批改":
        try:
            await db.execute(
                delete(ErrorRecord).where(
                    ErrorRecord.student_id == student_id,
                    ErrorRecord.question_id.in_(
                        select(Question.id).where(Question.assignment_id == assignment_id)
                    ),
                )
            )
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
            sub.status = "待批改"
            sub.score = None
            sub.rating = ""
            sub.rating_override = ""
            await db.execute(
                delete(FeedbackSnapshot).where(
                    FeedbackSnapshot.student_id == student_id,
                    FeedbackSnapshot.assignment_id == assignment_id,
                )
            )
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        return {"submission": submission_brief(sub), "error_question_ids": []}

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

        # 话术使用计数：同一学生同一批次重复保存不重复计（先按本次全量回滚旧计数再累加新计数）
        if body.used_phrase_ids:
            await db.execute(
                update(Phrase)
                .where(Phrase.id.in_(body.used_phrase_ids))
                .values(use_count=Phrase.use_count + 1)
            )

        await db.commit()
    except Exception:
        await db.rollback()
        raise

    return {
        "submission": submission_brief(sub),
        "error_question_ids": checked_ids,
    }
