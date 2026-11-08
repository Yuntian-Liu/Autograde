"""十二档等级：分数线为真实教学校准值（左闭右开，A+ 双闭），可在 settings 表中覆盖校准。

A+ [95,100] · A [90,95) · A- [85,90) · B+ [82,85) · B [78,82) · B- [75,78)
C+ [72,75) · C [68,72) · C- [65,68) · D [61,65) · E [60,61) · F [0,60)
"""

import json

DEFAULT_THRESHOLDS: list[tuple[str, float]] = [
    ("A+", 95), ("A", 90), ("A-", 85),
    ("B+", 82), ("B", 78), ("B-", 75),
    ("C+", 72), ("C", 68), ("C-", 65),
    ("D", 61), ("E", 60),
    ("F", 0),
]

RATINGS = [r for r, _ in DEFAULT_THRESHOLDS]

GPA_BY_RATING = {
    "A+": 4.33, "A": 4.00, "A-": 3.67,
    "B+": 3.33, "B": 3.00, "B-": 2.67,
    "C+": 2.33, "C": 2.00, "C-": 1.67,
    "D": 1.33, "E": 1.00, "F": 0.00,
}

SETTINGS_KEY = "rating_thresholds"


def gpa_for_rating(rating: str) -> float | None:
    return GPA_BY_RATING.get(rating)


def gpa_for_submission(submission) -> float | None:
    if submission.score is None:
        return None
    return gpa_for_rating(submission.rating_override or submission.rating)


def average_gpa(submissions) -> float | None:
    values = [gpa for submission in submissions if (gpa := gpa_for_submission(submission)) is not None]
    return round(sum(values) / len(values), 2) if values else None


def parse_thresholds(raw: str | None) -> list[tuple[str, float]]:
    """从 settings.value（JSON）解析分数线；非法、缺失或旧十档残留一律回退默认十二档。"""
    if not raw:
        return DEFAULT_THRESHOLDS
    try:
        data = json.loads(raw)
        pairs = [(str(item["rating"]), float(item["min"])) for item in data]
    except (ValueError, KeyError, TypeError):
        return DEFAULT_THRESHOLDS
    # 兼容旧十档配置：档位集合与十二档不一致视为过期，回退默认
    if {r for r, _ in pairs} != set(RATINGS):
        return DEFAULT_THRESHOLDS
    return sorted(pairs, key=lambda p: -p[1]) or DEFAULT_THRESHOLDS


def rating_for(score: float, thresholds: list[tuple[str, float]] | None = None) -> str:
    for rating, minimum in thresholds or DEFAULT_THRESHOLDS:
        if score >= minimum:
            return rating
    return "F"


async def get_thresholds(db) -> list[tuple[str, float]]:
    """当前生效分数线：settings 表覆盖值（非法/旧档自动回退默认十二档）。"""
    from sqlalchemy import select

    from models import Setting

    row = (
        await db.execute(select(Setting).where(Setting.key == SETTINGS_KEY))
    ).scalar_one_or_none()
    return parse_thresholds(row.value if row else None)
