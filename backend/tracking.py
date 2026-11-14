"""批次提交登记的共享校验、配置与生命周期辅助。"""

from pydantic import BaseModel
from sqlalchemy import and_, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from models import Assignment, TrackingItem, TrackingMark

MAIN_TRACKING_NAME = "本次作业"
MAX_TRACKING_ITEMS = 30


class TrackingItemIn(BaseModel):
    id: int | None = None
    name: str


def clean_tracking_names(names: list[str]) -> list[str]:
    if len(names) > MAX_TRACKING_ITEMS:
        raise ValueError(f"每批最多登记 {MAX_TRACKING_ITEMS} 个自定义项目")
    cleaned = []
    seen = set()
    for raw in names:
        name = raw.strip()
        if not name:
            raise ValueError("提交项目名称不能为空")
        if len(name) > 64:
            raise ValueError("提交项目名称不能超过 64 个字符")
        if name == MAIN_TRACKING_NAME:
            raise ValueError("本次作业为固定项目，请勿重复添加")
        key = name.casefold()
        if key in seen:
            raise ValueError(f"提交项目重复：{name}")
        seen.add(key)
        cleaned.append(name)
    return cleaned


def create_tracking_items(db: AsyncSession, assignment_id: int, names: list[str]) -> None:
    cleaned = clean_tracking_names(names)
    db.add(
        TrackingItem(
            assignment_id=assignment_id,
            name=MAIN_TRACKING_NAME,
            position=0,
            is_main=True,
        )
    )
    for index, name in enumerate(cleaned, start=1):
        db.add(
            TrackingItem(
                assignment_id=assignment_id,
                name=name,
                position=index,
                is_main=False,
            )
        )


async def custom_tracking_items(db: AsyncSession, assignment_id: int) -> list[TrackingItem]:
    return (
        await db.execute(
            select(TrackingItem)
            .where(TrackingItem.assignment_id == assignment_id, TrackingItem.is_main.is_(False))
            .order_by(TrackingItem.position, TrackingItem.id)
        )
    ).scalars().all()


async def replace_tracking_items(
    db: AsyncSession, assignment_id: int, incoming: list[TrackingItemIn]
) -> dict:
    names = clean_tracking_names([item.name for item in incoming])
    existing = await custom_tracking_items(db, assignment_id)
    by_id = {item.id: item for item in existing}
    incoming_ids = [item.id for item in incoming if item.id is not None]
    if len(incoming_ids) != len(set(incoming_ids)):
        raise ValueError("提交项目 ID 重复")
    foreign = [item_id for item_id in incoming_ids if item_id not in by_id]
    if foreign:
        raise ValueError("提交项目不属于本批次")

    keep_ids = set(incoming_ids)
    removed_ids = [item.id for item in existing if item.id not in keep_ids]
    if removed_ids:
        await db.execute(delete(TrackingMark).where(TrackingMark.item_id.in_(removed_ids)))
        await db.execute(delete(TrackingItem).where(TrackingItem.id.in_(removed_ids)))

    inserted = 0
    for position, (item_in, name) in enumerate(zip(incoming, names), start=1):
        if item_in.id is not None:
            item = by_id[item_in.id]
            item.name = name
            item.position = position
        else:
            db.add(
                TrackingItem(
                    assignment_id=assignment_id,
                    name=name,
                    position=position,
                    is_main=False,
                )
            )
            inserted += 1
    return {
        "updated": len(incoming_ids),
        "inserted": inserted,
        "removed": len(removed_ids),
    }


async def backfill_tracking_items(db: AsyncSession) -> int:
    assignment_ids = (
        await db.execute(
            select(Assignment.id)
            .outerjoin(
                TrackingItem,
                and_(
                    TrackingItem.assignment_id == Assignment.id,
                    TrackingItem.is_main.is_(True),
                ),
            )
            .where(TrackingItem.id.is_(None))
        )
    ).scalars().all()
    for assignment_id in assignment_ids:
        db.add(
            TrackingItem(
                assignment_id=assignment_id,
                name=MAIN_TRACKING_NAME,
                position=0,
                is_main=True,
            )
        )
    if assignment_ids:
        await db.commit()
    return len(assignment_ids)


async def clear_main_manual_mark(db: AsyncSession, assignment_id: int, student_id: int) -> None:
    main_item = select(TrackingItem.id).where(
        TrackingItem.assignment_id == assignment_id,
        TrackingItem.is_main.is_(True),
    )
    await db.execute(
        delete(TrackingMark).where(
            TrackingMark.student_id == student_id,
            TrackingMark.item_id.in_(main_item),
        )
    )


def tracking_item_brief(item: TrackingItem) -> dict:
    return {
        "id": item.id,
        "name": item.name,
        "position": item.position,
        "is_main": item.is_main,
    }
