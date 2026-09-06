"""反馈标题规则（DEVELOPMENT.md 2.1 / 旧版 Gradify build_header 的升级）。

- 厚少（WW）：课型 L   → {学生} U{n}L{m} 练习反馈
- 厚中（NG）：课型 Day → {学生} U{n}Day{m} 伴学手册反馈
- 预习（仅厚中）：追加 &U{n}{A|B} Preview
"""

from models import Assignment, Class

LESSON_TYPES = ("L", "Day")
PREVIEW_HALVES = ("A", "B")

# 册 → 单元号范围（A=U1-6 上册，B=U7-12 下册）
TERM_UNIT_RANGE = {"A": (1, 6), "B": (7, 12)}

# 班级系列 → 默认课型 / 反馈类型
SERIES_DEFAULT_LESSON_TYPE = {"WW": "L", "NG": "Day"}
SERIES_FEEDBACK_TYPE = {"WW": "练习反馈", "NG": "伴学手册反馈"}


def unit_progress(a: Assignment) -> str:
    """单元进度串，如 U7Day1；带预习时 U7Day1&U7B Preview。"""
    text = f"U{a.unit_no}{a.lesson_type}{a.unit_lesson_no}"
    if a.has_preview and a.preview_unit_no:
        text += f"&U{a.preview_unit_no}{a.preview_half} Preview"
    return text


def feedback_type(class_series: str) -> str:
    return SERIES_FEEDBACK_TYPE.get(class_series, "反馈")


def feedback_title(student_name: str, assignment: Assignment, class_: Class) -> str:
    """完整反馈标题，如「Alice U7Day1&U7B Preview 伴学手册反馈」。"""
    return f"{student_name} {unit_progress(assignment)} {feedback_type(class_.series)}"


def sync_unit_label(a: Assignment) -> None:
    """unit_label 为展示冗余字段，由结构化字段生成，禁止手填。"""
    a.unit_label = unit_progress(a)


def validate_unit_fields(
    class_: Class,
    unit_no: int,
    lesson_type: str,
    has_preview: bool,
    preview_unit_no: int | None,
    preview_half: str,
) -> str | None:
    """校验结构化单元进度字段，返回中文错误信息；None 表示通过。"""
    if lesson_type not in LESSON_TYPES:
        return "课型仅支持 L / Day"
    lo, hi = TERM_UNIT_RANGE.get(class_.term, (1, 12))
    if not (lo <= unit_no <= hi):
        return f"单元号超出本册范围（{class_.term} 册为 U{lo}-U{hi}）"
    if has_preview:
        if preview_unit_no is None or preview_half not in PREVIEW_HALVES:
            return "开启预习时必须填写预习单元号与上下册（A/B）"
        if not (lo <= preview_unit_no <= hi):
            return f"预习单元号超出本册范围（{class_.term} 册为 U{lo}-U{hi}）"
    return None
