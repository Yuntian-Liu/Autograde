"""AI 调用流水：峰谷定价、成本结算、埋点与聚合查询（供管理后台 AI 用量页）。

- 峰谷定价自 Stellaris 移植：DeepSeek 官方错峰规则预填（峰 09:00-12:00 / 14:00-18:00
  北京时间，周末全谷）；时段判定含头不含尾、支持跨午夜窗口；全部参数管理后台可改
- 单价存 settings 表（key=ai_prices，元/百万 token）；JSON 缺键逐项回落默认，旧结构兼容
- 成本「发票原则」：调用发生时按当时时段单价算好写入 cost_yuan + price_tier，改价不改历史
- record_llm_call 埋点失败只记日志，绝不阻断业务主流程
"""

import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import SessionLocal
from models import Assignment, Class, LlmCallEvent, Setting, Student

logger = logging.getLogger(__name__)

PRICES_KEY = "ai_prices"

# DeepSeek 官方峰谷价（元/百万 token，预填值，管理后台可改）
DEFAULT_PRICES = {
    "price_input": 4.0,  # 峰：输入（缓存未命中）
    "price_output": 12.0,  # 峰：输出
    "price_cache_hit": 0.5,  # 峰：输入（缓存命中）
    "offpeak_input": 1.0,  # 谷：输入
    "offpeak_output": 4.0,  # 谷：输出
    "offpeak_cache_hit": 0.25,  # 谷：缓存命中
    "peak_windows": [["09:00", "12:00"], ["14:00", "18:00"]],  # 北京时间
    "weekend_rule": "all_offpeak",  # all_offpeak=周末全谷 / same=周末同工作日
}

_TZ_CN = timezone(timedelta(hours=8))
_PRICE_KEYS = (
    "price_input",
    "price_output",
    "price_cache_hit",
    "offpeak_input",
    "offpeak_output",
    "offpeak_cache_hit",
)


def _normalize_windows(raw) -> list[tuple[int, int]]:
    """[["09:00","12:00"],...] → [(540,720),...] 分钟对；非法项丢弃。"""
    windows = []
    if not isinstance(raw, list):
        return windows
    for pair in raw:
        if not (isinstance(pair, (list, tuple)) and len(pair) == 2):
            continue
        try:
            sh, sm = map(int, str(pair[0]).split(":"))
            eh, em = map(int, str(pair[1]).split(":"))
        except ValueError:
            continue
        s, e = sh * 60 + sm, eh * 60 + em
        if 0 <= s < 1440 and 0 < e <= 1440 and s != e:
            windows.append((s, e))
    return windows


def price_tier_at(dt: datetime, prices: dict) -> str:
    """判定某时刻（转北京时间）属峰还是谷。空窗口恒峰；周末规则次之；窗口含头不含尾。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone(_TZ_CN)
    windows = _normalize_windows(prices.get("peak_windows"))
    if not windows:
        return "peak"
    if (prices.get("weekend_rule") or "all_offpeak") == "all_offpeak" and local.weekday() >= 5:
        return "offpeak"
    hm = local.hour * 60 + local.minute
    for s, e in windows:
        if s <= e:
            if s <= hm < e:
                return "peak"
        else:  # 跨午夜（如 22:00-06:00）
            if hm >= s or hm < e:
                return "peak"
    return "offpeak"


def estimate_cost(
    prompt_tokens: int,
    completion_tokens: int,
    prices: dict,
    tier: str = "peak",
    cache_hit: int = 0,
    cache_miss: int = 0,
) -> float:
    """成本 = (未命中×输入价 + 命中×缓存命中价 + 输出×输出价) / 1e6，按峰/谷取价，保留 6 位。
    无缓存拆分时兜底：全部输入按未命中计（不多算不少算）。"""
    if tier == "offpeak":
        p_in = float(prices.get("offpeak_input", 0) or 0)
        p_out = float(prices.get("offpeak_output", 0) or 0)
        p_hit = float(prices.get("offpeak_cache_hit", 0) or 0)
    else:
        p_in = float(prices.get("price_input", 0) or 0)
        p_out = float(prices.get("price_output", 0) or 0)
        p_hit = float(prices.get("price_cache_hit", 0) or 0)
    if not cache_hit and not cache_miss:
        cache_miss = prompt_tokens or 0
    return round(
        ((cache_miss or 0) * p_in + (cache_hit or 0) * p_hit + (completion_tokens or 0) * p_out) / 1e6,
        6,
    )


def unit_prices(prices: dict, tier: str) -> tuple[float, float, float]:
    """取峰/谷三单价（输入/输出/缓存命中），供结算快照写入。"""
    if tier == "offpeak":
        return (
            float(prices.get("offpeak_input", 0) or 0),
            float(prices.get("offpeak_output", 0) or 0),
            float(prices.get("offpeak_cache_hit", 0) or 0),
        )
    return (
        float(prices.get("price_input", 0) or 0),
        float(prices.get("price_output", 0) or 0),
        float(prices.get("price_cache_hit", 0) or 0),
    )


async def _get_setting(db: AsyncSession, key: str) -> Setting | None:
    """settings 主键是自增 id，key 是 unique 列——必须 select 查（session.get 只按主键）。"""
    return (await db.execute(select(Setting).where(Setting.key == key))).scalar_one_or_none()


async def get_prices(db: AsyncSession) -> dict:
    """读取单价：settings JSON 缺键逐项回落默认（旧结构向后兼容）。"""
    row = await _get_setting(db, PRICES_KEY)
    if row is None or not row.value:
        return dict(DEFAULT_PRICES)
    try:
        data = json.loads(row.value)
    except ValueError:
        return dict(DEFAULT_PRICES)
    prices = dict(DEFAULT_PRICES)
    if isinstance(data, dict):
        for k in _PRICE_KEYS:
            if data.get(k) is not None:
                prices[k] = float(data[k])
        if isinstance(data.get("peak_windows"), list):
            prices["peak_windows"] = data["peak_windows"]
        if data.get("weekend_rule") in ("all_offpeak", "same"):
            prices["weekend_rule"] = data["weekend_rule"]
    return prices


async def set_prices(db: AsyncSession, prices: dict) -> dict:
    row = await _get_setting(db, PRICES_KEY)
    if row is None:
        row = Setting(key=PRICES_KEY, value="")
        db.add(row)
    row.value = json.dumps(prices, ensure_ascii=False)
    await db.commit()
    return prices


async def record_llm_call(
    uid: int,
    feature: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    finish_reason: str | None,
    is_empty: bool,
    assignment_id: int | None = None,
    student_id: int | None = None,
    cache_hit_tokens: int = 0,
    cache_miss_tokens: int = 0,
    reasoning_tokens: int = 0,
    ttft_ms: int = 0,
    think_ms: int = 0,
    total_ms: int = 0,
) -> dict | None:
    """埋点一条 AI 调用；按调用时刻判峰谷并结算成本（含缓存命中拆分）；
    单价快照同行写入（发票原则）；独立 session，失败静默（只日志）。
    返回结算结果（cost/tier）供业务层展示，失败返回 None。"""
    try:
        async with SessionLocal() as db:
            prices = await get_prices(db)
            tier = price_tier_at(datetime.now(timezone.utc), prices)
            u_in, u_out, u_hit = unit_prices(prices, tier)
            cost = estimate_cost(
                prompt_tokens or 0,
                completion_tokens or 0,
                prices,
                tier,
                cache_hit=cache_hit_tokens or 0,
                cache_miss=cache_miss_tokens or 0,
            )
            db.add(
                LlmCallEvent(
                    uid=uid,
                    feature=feature,
                    assignment_id=assignment_id,
                    student_id=student_id,
                    model=model,
                    prompt_tokens=prompt_tokens or 0,
                    completion_tokens=completion_tokens or 0,
                    cache_hit_tokens=cache_hit_tokens or 0,
                    cache_miss_tokens=cache_miss_tokens or 0,
                    reasoning_tokens=reasoning_tokens or 0,
                    ttft_ms=ttft_ms or 0,
                    think_ms=think_ms or 0,
                    total_ms=total_ms or 0,
                    cost_yuan=cost,
                    price_tier=tier,
                    unit_input=u_in,
                    unit_output=u_out,
                    unit_cache_hit=u_hit,
                    finish_reason=finish_reason,
                    is_empty=is_empty,
                )
            )
            await db.commit()
            return {"cost_yuan": cost, "price_tier": tier}
    except Exception as e:  # noqa: BLE001 埋点绝不阻断主流程
        logger.warning("llm 埋点失败: %s", str(e)[:200])
        return None


def _window_start(window: str) -> datetime | None:
    now = datetime.now(timezone.utc)
    if window == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    if window == "7d":
        return now - timedelta(days=7)
    if window == "30d":
        return now - timedelta(days=30)
    return None  # all


def _since(window: str) -> list:
    start = _window_start(window)
    return [LlmCallEvent.created_at >= start] if start is not None else []


async def ai_usage_stats(db: AsyncSession, window: str = "7d") -> dict:
    """AI 用量聚合：总览（含峰谷成本结构）+ 按功能 + 按批次 + 按天峰谷趋势 + 最近明细。"""
    cond = _since(window)

    row = (
        await db.execute(
            select(
                func.count(LlmCallEvent.id),
                func.coalesce(func.sum(LlmCallEvent.prompt_tokens), 0),
                func.coalesce(func.sum(LlmCallEvent.completion_tokens), 0),
                func.coalesce(func.sum(LlmCallEvent.cost_yuan), 0.0),
                func.sum(case((LlmCallEvent.is_empty.is_(True), 1), else_=0)),
                func.sum(case((LlmCallEvent.finish_reason.is_(None), 1), else_=0)),
                func.coalesce(
                    func.sum(case((LlmCallEvent.price_tier == "peak", LlmCallEvent.cost_yuan), else_=0.0)),
                    0.0,
                ),
                func.coalesce(
                    func.sum(
                        case((LlmCallEvent.price_tier == "offpeak", LlmCallEvent.cost_yuan), else_=0.0)
                    ),
                    0.0,
                ),
            ).where(*cond)
        )
    ).one()
    calls, ptok, ctok, cost, empty, failed, peak_cost, offpeak_cost = row

    by_feature = [
        {"feature": f, "calls": c, "tokens": t, "cost": round(k, 6)}
        for f, c, t, k in (
            await db.execute(
                select(
                    LlmCallEvent.feature,
                    func.count(LlmCallEvent.id),
                    func.sum(LlmCallEvent.prompt_tokens + LlmCallEvent.completion_tokens),
                    func.sum(LlmCallEvent.cost_yuan),
                )
                .where(*cond)
                .group_by(LlmCallEvent.feature)
            )
        ).all()
    ]

    by_assignment = [
        {
            "assignment_id": aid,
            "label": label,
            "class_name": cname,
            "calls": c,
            "tokens": t,
            "cost": round(k, 6),
        }
        for aid, label, cname, c, t, k in (
            await db.execute(
                select(
                    LlmCallEvent.assignment_id,
                    Assignment.unit_label,
                    Class.name,
                    func.count(LlmCallEvent.id),
                    func.sum(LlmCallEvent.prompt_tokens + LlmCallEvent.completion_tokens),
                    func.sum(LlmCallEvent.cost_yuan),
                )
                .join(Assignment, LlmCallEvent.assignment_id == Assignment.id)
                .join(Class, Assignment.class_id == Class.id)
                .where(*cond)
                .group_by(LlmCallEvent.assignment_id, Assignment.unit_label, Class.name)
                .order_by(func.sum(LlmCallEvent.cost_yuan).desc())
            )
        ).all()
    ]

    # 按天峰谷趋势（前端堆叠柱状图；price_tier 为空的旧行归入 untagged）
    rows = (
        await db.execute(
            select(
                func.date(LlmCallEvent.created_at),
                LlmCallEvent.price_tier,
                func.count(LlmCallEvent.id),
                func.sum(LlmCallEvent.prompt_tokens + LlmCallEvent.completion_tokens),
                func.sum(LlmCallEvent.cost_yuan),
            )
            .where(*cond)
            .group_by(func.date(LlmCallEvent.created_at), LlmCallEvent.price_tier)
            .order_by(func.date(LlmCallEvent.created_at))
        )
    ).all()
    by_day_map: dict[str, dict] = {}
    for day, tier, c, t, k in rows:
        item = by_day_map.setdefault(
            str(day),
            {"day": str(day), "calls": 0, "tokens": 0, "peak_cost": 0.0, "offpeak_cost": 0.0, "untagged_cost": 0.0},
        )
        item["calls"] += c or 0
        item["tokens"] += int(t or 0)
        if tier == "peak":
            item["peak_cost"] = round(item["peak_cost"] + float(k or 0), 6)
        elif tier == "offpeak":
            item["offpeak_cost"] = round(item["offpeak_cost"] + float(k or 0), 6)
        else:
            item["untagged_cost"] = round(item["untagged_cost"] + float(k or 0), 6)
    by_day = list(by_day_map.values())

    recent = [
        {
            "id": e.id,
            "uid": e.uid,
            "feature": e.feature,
            "assignment_id": e.assignment_id,
            "model": e.model,
            "prompt_tokens": e.prompt_tokens,
            "completion_tokens": e.completion_tokens,
            "cost_yuan": e.cost_yuan,
            "price_tier": e.price_tier or "",
            "finish_reason": e.finish_reason,
            "is_empty": e.is_empty,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in (
            await db.execute(
                select(LlmCallEvent)
                .where(*cond)
                .order_by(LlmCallEvent.id.desc())
                .limit(50)
            )
        ).scalars().all()
    ]

    return {
        "window": window,
        "summary": {
            "calls": calls,
            "prompt_tokens": ptok,
            "completion_tokens": ctok,
            "cost_yuan": round(float(cost), 6),
            "peak_cost": round(float(peak_cost), 6),
            "offpeak_cost": round(float(offpeak_cost), 6),
            "empty": int(empty or 0),
            "failed": int(failed or 0),
        },
        "by_feature": by_feature,
        "by_assignment": by_assignment,
        "by_day": by_day,
        "recent": recent,
    }


_HEALTH_WINDOWS = {"24h": timedelta(hours=24), "7d": timedelta(days=7)}


async def llm_health(db: AsyncSession, window: str = "24h") -> dict:
    """模型健康：正常率（stop 且非空，互斥口径）/ 空回答 / 异常 / 平均延迟 / 缓存命中率。
    SQLite 对 Boolean 求和会被 SQLAlchemy 按 Boolean 解码——必须 case 转 Integer。"""
    delta = _HEALTH_WINDOWS.get(window, timedelta(hours=24))
    start = datetime.now(timezone.utc) - delta
    cond = [LlmCallEvent.created_at >= start]

    row = (
        await db.execute(
            select(
                func.count(LlmCallEvent.id),
                func.sum(
                    case(
                        (and_(LlmCallEvent.finish_reason == "stop", LlmCallEvent.is_empty.is_(False)), 1),
                        else_=0,
                    )
                ),
                func.sum(case((LlmCallEvent.is_empty.is_(True), 1), else_=0)),
                func.sum(case((LlmCallEvent.finish_reason.is_(None), 1), else_=0)),
                func.avg(case((LlmCallEvent.ttft_ms > 0, LlmCallEvent.ttft_ms), else_=None)),
                func.avg(case((LlmCallEvent.total_ms > 0, LlmCallEvent.total_ms), else_=None)),
                func.coalesce(func.sum(LlmCallEvent.cache_hit_tokens), 0),
                func.coalesce(func.sum(LlmCallEvent.cache_miss_tokens), 0),
            ).where(*cond)
        )
    ).one()
    total, healthy, empty, failed, avg_ttft, avg_total, hit, miss = row
    total = total or 0
    healthy = int(healthy or 0)

    by_feature = [
        {"feature": f, "total": t, "healthy": int(h or 0), "empty": int(e or 0), "failed": int(x or 0)}
        for f, t, h, e, x in (
            await db.execute(
                select(
                    LlmCallEvent.feature,
                    func.count(LlmCallEvent.id),
                    func.sum(
                        case(
                            (and_(LlmCallEvent.finish_reason == "stop", LlmCallEvent.is_empty.is_(False)), 1),
                            else_=0,
                        )
                    ),
                    func.sum(case((LlmCallEvent.is_empty.is_(True), 1), else_=0)),
                    func.sum(case((LlmCallEvent.finish_reason.is_(None), 1), else_=0)),
                )
                .where(*cond)
                .group_by(LlmCallEvent.feature)
            )
        ).all()
    ]

    hit, miss = int(hit or 0), int(miss or 0)
    return {
        "window": window,
        "total": total,
        "healthy": healthy,
        "healthy_rate": round(healthy / total * 100, 1) if total else None,
        "empty": int(empty or 0),
        "failed": int(failed or 0),
        "avg_ttft_ms": int(avg_ttft) if avg_ttft else None,
        "avg_total_ms": int(avg_total) if avg_total else None,
        "cache_hit_rate": round(hit / (hit + miss) * 100, 1) if (hit + miss) else None,
        "by_feature": by_feature,
    }


def _event_out(e: LlmCallEvent, ctx: dict | None = None) -> dict:
    return {
        "id": e.id,
        "created_at": e.created_at.isoformat() if e.created_at else None,
        "feature": e.feature,
        "model": e.model,
        "context": ctx or None,
        "prompt_tokens": e.prompt_tokens,
        "completion_tokens": e.completion_tokens,
        "cache_hit_tokens": e.cache_hit_tokens,
        "cache_miss_tokens": e.cache_miss_tokens,
        "reasoning_tokens": e.reasoning_tokens,
        "ttft_ms": e.ttft_ms,
        "think_ms": e.think_ms,
        "total_ms": e.total_ms,
        "cost_yuan": e.cost_yuan,
        "price_tier": e.price_tier or "",
        "finish_reason": e.finish_reason,
        "is_empty": e.is_empty,
    }


async def _resolve_contexts(db: AsyncSession, events: list[LlmCallEvent]) -> dict[int, dict]:
    """批量解析业务上下文：assignment_id → 班级+unit_label+批次码；student_id → 学生名+学生码。"""
    ctx: dict[int, dict] = {}
    aids = {e.assignment_id for e in events if e.assignment_id}
    sids = {e.student_id for e in events if e.student_id}
    amap: dict[int, dict] = {}
    if aids:
        rows = (
            await db.execute(
                select(Assignment, Class)
                .join(Class, Assignment.class_id == Class.id)
                .where(Assignment.id.in_(aids))
            )
        ).all()
        for a, c in rows:
            amap[a.id] = {"kind": "assignment", "label": f"{c.name} {a.unit_label}", "code": a.code or ""}
    smap: dict[int, dict] = {}
    if sids:
        for s in (await db.execute(select(Student).where(Student.id.in_(sids)))).scalars().all():
            smap[s.id] = {"kind": "student", "label": s.name, "code": s.code or ""}
    out: dict[int, dict] = {}
    for e in events:
        if e.assignment_id and e.assignment_id in amap:
            out[e.id] = amap[e.assignment_id]
        elif e.student_id and e.student_id in smap:
            out[e.id] = smap[e.student_id]
    return out


async def llm_calls_list(
    db: AsyncSession, window: str = "7d", feature: str = "", limit: int = 100
) -> list[dict]:
    """调用明细列表（时间倒序），带业务上下文（名字+编号）。"""
    start = _window_start(window)
    cond = []
    if start is not None:
        cond.append(LlmCallEvent.created_at >= start)
    if feature:
        cond.append(LlmCallEvent.feature == feature)
    events = (
        await db.execute(
            select(LlmCallEvent)
            .where(*cond)
            .order_by(LlmCallEvent.id.desc())
            .limit(min(limit, 500))
        )
    ).scalars().all()
    ctxs = await _resolve_contexts(db, events)
    return [_event_out(e, ctxs.get(e.id)) for e in events]


async def llm_call_detail(db: AsyncSession, call_id: int) -> dict | None:
    """单次调用详情（消费单）：含结算单价快照，改价后仍能精确还原发票行。"""
    e = await db.get(LlmCallEvent, call_id)
    if e is None:
        return None
    ctxs = await _resolve_contexts(db, [e])
    out = _event_out(e, ctxs.get(e.id))
    out["unit_input"] = e.unit_input
    out["unit_output"] = e.unit_output
    out["unit_cache_hit"] = e.unit_cache_hit
    out["uid"] = e.uid
    out["assignment_id"] = e.assignment_id
    out["student_id"] = e.student_id
    return out
