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
    name: Mapped[str] = mapped_column(String(32), unique=True)  # 如 WW5A / NG3B
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
    lesson_no: Mapped[int] = mapped_column(Integer)  # 第几次课
    class_time: Mapped[str] = mapped_column(String(32), default="")  # 本次上课时间，如 2026-09-12 14:00
    content: Mapped[str] = mapped_column(String(128), default="")  # 作业内容，如「伴学手册」
    status: Mapped[str] = mapped_column(String(16), default="未开始")  # 未开始/批改中/已完成
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
    category: Mapped[str] = mapped_column(String(32))  # 问候语/评级话术/Issue 模板……
    content: Mapped[str] = mapped_column(Text)
    scope: Mapped[str] = mapped_column(String(16), default="内置")  # 内置/自定义
    use_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Setting(Base):
    """全局配置（如等级分数线阈值），JSON 存储可编辑。"""

    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(64), unique=True)
    value: Mapped[str] = mapped_column(Text, default="")
