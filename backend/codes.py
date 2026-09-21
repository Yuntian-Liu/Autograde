"""全局业务编码：学生码 / 批次码（人读有意义 + 全球唯一 + 校验位）。

格式：``202603-W51-S00042-7``
  - 202603  届别（年+学期，01春/02夏/03秋/04冬），取班级 cohort（建班时人工选定）
  - W51     班级信息快照：系列(W=WW厚少/N=NG厚中) + 级别 + 册(A=1/B=2)
  - S/A     类型：S=学生，A=批次；各自一条序列
  - 00042   序号 5 位，永不清零、删号不复用（身份证逻辑）
  - 7       校验位：前体逐字符加权求和 mod 36

不变式（改这里前先读）：
  - 码一旦发出终身不变——issue_code 只允许在创建路径调用，禁止任何"重算"
  - 前缀只是人读信息位，身份唯一性由序号段保证；班级改 cohort 只影响今后发码
  - 主键不动：code 是展示与寻址层，外键网络仍走自增 id（与 slug 同一铁律）
"""

import re
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import Assignment, Class, Setting, Student

ALPHABET36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
SERIES_LETTER = {"WW": "W", "NG": "N"}  # 未知系列回落 X
TERM_DIGIT = {"A": "1", "B": "2"}

_SEQ_KEY = {"S": "code_seq_student", "A": "code_seq_assignment"}
# 前体结构：cohort6 + 系列1 + 级别1-2位（不定长，级别理论可到 12）+ 册1 + 类型1 + 序号5，末位校验位
_CODE_RE = re.compile(r"^(\d{6})([A-Z])(\d{1,2})(\d)([SA])(\d{5})([0-9A-Z])$")


def default_cohort(now: datetime | None = None) -> str:
    """建班默认值：按当前月份猜学期（3-6春/7-8夏/9-12秋/1-2冬），用户可改。"""
    now = now or datetime.now()
    month = now.month
    if 3 <= month <= 6:
        season = "01"
    elif 7 <= month <= 8:
        season = "02"
    elif 9 <= month <= 12:
        season = "03"
    else:
        season = "04"
    return f"{now.year}{season}"


_COHORT_RE = re.compile(r"^\d{4}0[1-4]$")


def validate_cohort(cohort: str) -> bool:
    return bool(_COHORT_RE.match(cohort))


def compute_check(body: str) -> str:
    """校验位：前体逐字符 (位置 i+1) × 字符值 求和 mod 36。"""
    total = sum((i + 1) * ALPHABET36.index(ch) for i, ch in enumerate(body))
    return ALPHABET36[total % 36]


async def next_seq(db: AsyncSession, kind: str) -> int:
    """取序号并推进计数器（settings 表持久化；调用方事务随业务提交，SQLite 单写者串行）。"""
    key = _SEQ_KEY[kind]
    row = (await db.execute(select(Setting).where(Setting.key == key))).scalar_one_or_none()
    if row is None:
        row = Setting(key=key, value="0")
        db.add(row)
        await db.flush()
    row.value = str(int(row.value or "0") + 1)
    return int(row.value)


async def issue_code(db: AsyncSession, kind: str, cls: Class) -> str:
    """创建路径专用发码：cohort 为空时按当前时间兜底（正常建班已带 cohort）。"""
    cohort = cls.cohort if validate_cohort(cls.cohort or "") else default_cohort()
    series = SERIES_LETTER.get(cls.series, "X")
    term = TERM_DIGIT.get(cls.term, "0")
    seq = await next_seq(db, kind)
    info = f"{series}{cls.level}{term}"
    body = f"{cohort}{info}{kind}{seq:05d}"
    return f"{cohort}-{info}-{kind}{seq:05d}-{compute_check(body)}"


def normalize(code: str) -> str:
    """归一化：去连字符/空白、大写（用户手抄/口述回来的码先过这道）。"""
    return re.sub(r"[^0-9A-Za-z]", "", code or "").upper()


def parse_code(code: str) -> dict | None:
    """校验结构 + 校验位；合法返回 {kind, canonical}（canonical=带连字符规范形），非法 None。"""
    m = _CODE_RE.match(normalize(code))
    if not m:
        return None
    cohort, series, level, term, kind, seq, check = m.groups()
    body = f"{cohort}{series}{level}{term}{kind}{seq}"
    if compute_check(body) != check:
        return None
    return {"kind": kind, "canonical": f"{cohort}-{series}{level}{term}-{kind}{seq}-{check}"}


async def backfill_codes(db: AsyncSession) -> tuple[int, int, int]:
    """存量补发（只碰空值行，已发码一律不动）：
    ① 无 cohort 班级回填当前秋季学期 202603（本系统上线即 2026 秋，可在班级配置改）
    ② ③ 无码学生/批次按 id 顺序补发（前缀取班级快照）。返回三类补发数量。"""
    n_cls = n_student = n_assignment = 0

    classes = (await db.execute(select(Class).order_by(Class.id))).scalars().all()
    for c in classes:
        if not validate_cohort(c.cohort or ""):
            c.cohort = "202603"
            n_cls += 1
    by_id = {c.id: c for c in classes}

    for s in (await db.execute(select(Student).where(Student.code == "").order_by(Student.id))).scalars().all():
        cls = by_id.get(s.class_id)
        if cls is None:
            continue  # 孤儿数据（班级已删）不发码
        s.code = await issue_code(db, "S", cls)
        n_student += 1

    for a in (
        (await db.execute(select(Assignment).where(Assignment.code == "").order_by(Assignment.id)))
        .scalars()
        .all()
    ):
        cls = by_id.get(a.class_id)
        if cls is None:
            continue
        a.code = await issue_code(db, "A", cls)
        n_assignment += 1

    if n_cls or n_student or n_assignment:
        await db.commit()
    return n_cls, n_student, n_assignment
