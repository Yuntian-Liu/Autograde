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

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import SessionLocal
from models import Assignment, Class, LlmCallEvent, Setting

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


def estimate_cost(prompt_tokens: int, completion_tokens: int, prices: dict, tier: str = "peak") -> float:
    """成本 = (输入×输入价 + 输出×输出价) / 1e6，按峰/谷取价，保留 6 位。"""
    if tier == "offpeak":
        p_in = float(prices.get("offpeak_input", 0) or 0)
        p_out = float(prices.get("offpeak_output", 0) or 0)
    else:
        p_in = float(prices.get("price_input", 0) or 0)
        p_out = float(prices.get("price_output", 0) or 0)
    return round(((prompt_tokens or 0) * p_in + (completion_tokens or 0) * p_out) / 1e6, 6)


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
) -> None:
    """埋点一条 AI 调用；按调用时刻判峰谷并结算成本；独立 session，失败静默（只日志）。"""
    try:
        async with SessionLocal() as db:
            prices = await get_prices(db)
            tier = price_tier_at(datetime.now(timezone.utc), prices)
            db.add(
                LlmCallEvent(
                    uid=uid,
                    feature=feature,
                    assignment_id=assignment_id,
                    model=model,
                    prompt_tokens=prompt_tokens or 0,
                    completion_tokens=completion_tokens or 0,
                    cost_yuan=estimate_cost(
                        prompt_tokens or 0, completion_tokens or 0, prices, tier
                    ),
                    price_tier=tier,
                    finish_reason=finish_reason,
                    is_empty=is_empty,
                )
            )
            await db.commit()
    except Exception as e:  # noqa: BLE001 埋点绝不阻断主流程
        logger.warning("llm 埋点失败: %s", str(e)[:200])


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
