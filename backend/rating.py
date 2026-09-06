"""十档等级：默认分数线见 DEVELOPMENT.md 2.7，可在 settings 表中覆盖校准。"""

import json

DEFAULT_THRESHOLDS: list[tuple[str, float]] = [
    ("A+", 97), ("A", 93), ("A-", 90),
    ("B+", 85), ("B", 80), ("B-", 75),
    ("C+", 70), ("C", 65), ("C-", 60),
    ("D", 0),
]

RATINGS = [r for r, _ in DEFAULT_THRESHOLDS]

SETTINGS_KEY = "rating_thresholds"


def parse_thresholds(raw: str | None) -> list[tuple[str, float]]:
    """从 settings.value（JSON）解析分数线；非法或缺失时回落默认值。"""
    if not raw:
        return DEFAULT_THRESHOLDS
    try:
        data = json.loads(raw)
        pairs = [(str(item["rating"]), float(item["min"])) for item in data]
        return sorted(pairs, key=lambda p: -p[1]) or DEFAULT_THRESHOLDS
    except (ValueError, KeyError, TypeError):
        return DEFAULT_THRESHOLDS


def rating_for(score: float, thresholds: list[tuple[str, float]] | None = None) -> str:
    for rating, minimum in thresholds or DEFAULT_THRESHOLDS:
        if score >= minimum:
            return rating
    return "D"
