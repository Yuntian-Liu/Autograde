"""Autograde 数据模型 —— 9 张表，对应 DEVELOPMENT.md「三、数据模型草案」。

字段以文档为准；created_at 等为工程化补充。
所有枚举值直接用中文字符串入库（一切皆为数据，前端不做翻译层）。
"""

from datetime import datetime, timezone

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Class(Base):
    """班级：厚少=WW（Wonderful World），厚中=NG；A=U1-6 上册，B=U7-12 下册。"""

    __tablename__ = "classes"

    id: Mapped[int] = mapped_column(primary_key=True)
    # 多租户唯一锚点：所有业务数据经此归属到用户；默认 100000 = 首个注册用户（旧库自愈回填值）
    owner_uid: Mapped[int] = mapped_column(Integer, default=100000)
    # 同名校验按 owner 维度在应用层做（多租户下两位老师可各有一个 WW5A）
    name: Mapped[str] = mapped_column(String(32))  # 如 WW5A / NG3B
    series: Mapped[str] = mapped_column(String(8))  # WW / NG
    level: Mapped[int] = mapped_column(Integer)
    term: Mapped[str] = mapped_column(String(1))  # A / B
    schedule: Mapped[str] = mapped_column(String(32))  # 如「周六 14:00」，驱动 deadline
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    students: Mapped[list["Student"]] = relationship(back_populates="class_")
    assignments: Mapped[list["Assignment"]] = relationship(back_populates="class_")


class Student(Base):
    """学生：属于班级，支持插班/转班；note 为老师备注（仅自己可见）。"""

    __tablename__ = "students"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    class_id: Mapped[int] = mapped_column(ForeignKey("classes.id"))
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    class_: Mapped[Class] = relationship(back_populates="students")


class Assignment(Base):
    """作业批次 = 一个工作空间。"""

    __tablename__ = "assignments"

    id: Mapped[int] = mapped_column(primary_key=True)
    class_id: Mapped[int] = mapped_column(ForeignKey("classes.id"))
    unit_label: Mapped[str] = mapped_column(String(32))  # 展示冗余，由结构化字段自动生成，如 U7Day1&U7B Preview
    # 结构化单元进度（feedback.py 据此生成 unit_label 与反馈标题）
    unit_no: Mapped[int] = mapped_column(Integer, default=1)  # 单元号，如 7；范围按班级 term 校验（A=U1-6，B=U7-12）
    lesson_type: Mapped[str] = mapped_column(String(8), default="L")  # L / Day；默认由班级系列推导（WW→L，NG→Day）
    unit_lesson_no: Mapped[int] = mapped_column(Integer, default=1)  # 单元内第几课，如 1
    has_preview: Mapped[bool] = mapped_column(Boolean, default=False)  # 仅 lesson_type=Day 时有意义
    preview_unit_no: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 预习单元号
    preview_half: Mapped[str] = mapped_column(String(1), default="")  # 预习上下册：A / B
    # 预习答案答题卡（JSON 数组 5 个 A/B/C/D，空串 = 未录入）；纯对答案用，不算分不出解析
    preview_answers: Mapped[str] = mapped_column(Text, default="")
    lesson_no: Mapped[int] = mapped_column(Integer)  # 第几次课
    class_time: Mapped[str] = mapped_column(String(32), default="")  # 本次上课时间，如 2026-09-12 14:00
    content: Mapped[str] = mapped_column(String(128), default="")  # 作业内容，如「伴学手册」
    status: Mapped[str] = mapped_column(String(16), default="未开始")  # 未开始/批改中/已完成
    # 板块手动顺序（JSON 板块名数组，空 = 未自定义，回落录入顺序）；_ensure_columns 自动补列
    section_order: Mapped[str] = mapped_column(Text, default="")
    # 对外短码（URL 用，不可枚举 + 防手误；主键仍为自增 int，slug 为空时前端回落 id）；启动自愈回填
    slug: Mapped[str] = mapped_column(String(16), default="", index=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    class_: Mapped[Class] = relationship(back_populates="assignments")
    questions: Mapped[list["Question"]] = relationship(back_populates="assignment")


class Question(Base):
    """题目：解析原文冻结入库，永不经过 AI；score_weight 为 AI 预填 + 人工确认值。"""

    __tablename__ = "questions"

    id: Mapped[int] = mapped_column(primary_key=True)
    assignment_id: Mapped[int] = mapped_column(ForeignKey("assignments.id"))
    seq: Mapped[int] = mapped_column(Integer)  # 板块内题号
    mode: Mapped[str] = mapped_column(String(16), default="verbatim")  # verbatim / ai_expand / manual
    section: Mapped[str] = mapped_column(String(64))  # 板块标签，如「Task 1 · Vocabulary」
    stem: Mapped[str] = mapped_column(Text, default="")  # 题干（v0.0.1 可选）
    options: Mapped[str] = mapped_column(Text, default="")  # 选项，JSON 数组字符串，如 ["A. forest","B. river"]；无选项存空串
    standard_answer: Mapped[str] = mapped_column(Text, default="")
    explanation: Mapped[str] = mapped_column(Text, default="")  # 冻结解析原文
    score_weight: Mapped[float] = mapped_column(Float, default=5.0)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    assignment: Mapped[Assignment] = relationship(back_populates="questions")


class ErrorRecord(Base):
    """错题记录：学生 × 题目，每次批改一行。数据资产核心。"""

    __tablename__ = "error_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"))
    question_id: Mapped[int] = mapped_column(ForeignKey("questions.id"))
    note: Mapped[str] = mapped_column(Text, default="")  # 人工填充 / AI 定稿内容
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Submission(Base):
    """提交状态：score/rating 实时计算；rating_override 存手动覆盖。"""

    __tablename__ = "submissions"

    id: Mapped[int] = mapped_column(primary_key=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"))
    assignment_id: Mapped[int] = mapped_column(ForeignKey("assignments.id"))
    status: Mapped[str] = mapped_column(String(16), default="待批改")  # 待批改/已批改/缺作业/未交
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    rating: Mapped[str] = mapped_column(String(4), default="")
    rating_override: Mapped[str] = mapped_column(String(4), default="")
    # 预习错题题号（JSON 数组，如 [1,3]）；不算分，仅驱动「预习有错题」话术计数
    preview_wrong: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class FeedbackSnapshot(Base):
    """最终反馈全文存档（纯文本），供 AI 薄弱点分析双料喂养。"""

    __tablename__ = "feedback_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"))
    assignment_id: Mapped[int] = mapped_column(ForeignKey("assignments.id"))
    final_text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Phrase(Base):
    """话术库：use_count 驱动智能排序，高频自动排前。"""

    __tablename__ = "phrases"

    id: Mapped[int] = mapped_column(primary_key=True)
    category: Mapped[str] = mapped_column(String(32))  # 问候语·早上/Issue 模板/催交……
    name: Mapped[str] = mapped_column(String(64), default="")  # 条目名（Issue 模板用，如「未交预习」）
    content: Mapped[str] = mapped_column(Text)
    # 渲染格式：空=纯文本 / title_bold=首行加粗 / title_bold+body_italic=首行加粗+其余行倾斜
    format: Mapped[str] = mapped_column(String(32), default="")
    scope: Mapped[str] = mapped_column(String(16), default="内置")  # 内置/自定义
    use_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Setting(Base):
    """全局配置（如等级分数线阈值），JSON 存储可编辑。"""

    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(64), unique=True)
    value: Mapped[str] = mapped_column(Text, default="")


class LlmCallEvent(Base):
    """AI 调用流水：每次录题拆分/讲解起草一行（含失败），成本按当时单价算好写入（发票原则）。

    assignment_id 支撑「按批次看成本」；埋点失败绝不阻断主流程。
    """

    __tablename__ = "llm_call_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    uid: Mapped[int] = mapped_column(Integer, default=0)  # 调用者业务 uid
    feature: Mapped[str] = mapped_column(String(32))  # parse_questions / draft_explanation
    assignment_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 批次维度
    model: Mapped[str] = mapped_column(String(64), default="")
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_yuan: Mapped[float] = mapped_column(Float, default=0.0)  # 按当时单价结算，改价不改历史
    price_tier: Mapped[str] = mapped_column(String(8), default="")  # peak / offpeak；空 = 峰谷引入前的旧行
    finish_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)  # None=调用异常
    is_empty: Mapped[bool] = mapped_column(Boolean, default=False)  # 正文 0 字符
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Note(Base):
    """笔记：多租户锚点直挂 owner_uid（游离笔记无班级）；关联字段均可空。

    content 为文本行 + 图片占位符 [[img:key]]；title = 内容首行冗余（微信笔记规则）。
    """

    __tablename__ = "notes"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_uid: Mapped[int] = mapped_column(Integer, index=True)
    class_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    student_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    assignment_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    title: Mapped[str] = mapped_column(String(128), default="")
    content: Mapped[str] = mapped_column(Text, default="")
    # 用户手动编辑过（笔记编辑页 PATCH 即置位）后，批改联动永久脱钩不再覆盖
    user_edited: Mapped[bool] = mapped_column(Boolean, default=False)
    # 归档：旧班历史笔记单独收进归档区，不污染活跃列表；legacy_name = 归档时填的学生名/备注
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    legacy_name: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class NoteImage(Base):
    """笔记图片追踪：上传签发时入库（note_id 可空=未贴进正文的临时件），
    笔记保存时对账归属；删除笔记连带清理。"""

    __tablename__ = "note_images"

    id: Mapped[int] = mapped_column(primary_key=True)
    note_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # NULL = 临时（未贴进正文）
    owner_uid: Mapped[int] = mapped_column(Integer, index=True)
    key: Mapped[str] = mapped_column(String(256), unique=True)  # COS 对象 key
    size: Mapped[int] = mapped_column(Integer, default=0)  # 字节
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class ClientEvent(Base):
    """客户端事件落库：前端 clientLog 定期 flush 上来（诊断导出随包返回）。"""

    __tablename__ = "client_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    uid: Mapped[int] = mapped_column(Integer, index=True)  # 上报者业务 uid
    client_ts: Mapped[str] = mapped_column(String(32), default="")  # 前端时间戳（MM-DD HH:mm:ss）
    type: Mapped[str] = mapped_column(String(16), default="")
    detail: Mapped[str] = mapped_column(String(800), default="")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)  # 服务端时间
