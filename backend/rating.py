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

SETTINGS_KEY = "rating_thresholds"


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
