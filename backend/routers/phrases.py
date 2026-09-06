"""话术库接口：读（登录即可，内置全局共享）+ 写（管理员，可视化管理）。"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth.dependencies import get_admin_user, get_current_user
from auth.models import User
from database import get_db
from models import Phrase
from serializers import phrase_brief

router = APIRouter(prefix="/api/phrases", tags=["phrases"])


@router.get("")
async def list_phrases(
    category: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    stmt = select(Phrase).order_by(Phrase.use_count.desc(), Phrase.id)
    if category:
        stmt = stmt.where(Phrase.category == category)
    phrases = (await db.execute(stmt)).scalars().all()
    return [phrase_brief(p) for p in phrases]


class PhraseIn(BaseModel):
    category: str = Field(..., min_length=1, max_length=32)
    name: str = Field(default="", max_length=64)
    content: str = Field(..., min_length=1)
    scope: str = "自定义"  # 新增一律自定义；内置由系统补种


@router.post("", status_code=201)
async def create_phrase(
    body: PhraseIn,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
) -> dict:
    p = Phrase(
        category=body.category.strip(),
        name=body.name.strip(),
        content=body.content.strip(),
        scope="自定义",
    )
    db.add(p)
    await db.commit()
    return phrase_brief(p)


@router.put("/{phrase_id}")
async def update_phrase(
    phrase_id: int,
    body: PhraseIn,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
) -> dict:
    """编辑（内置话术也可编辑内容；补种走标记制不会拉回原文）。"""
    p = await db.get(Phrase, phrase_id)
    if p is None:
        raise HTTPException(status_code=404, detail="话术不存在")
    p.category = body.category.strip()
    p.name = body.name.strip()
    p.content = body.content.strip()
    await db.commit()
    return phrase_brief(p)


@router.delete("/{phrase_id}", status_code=204)
async def delete_phrase(
    phrase_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
) -> None:
    """删除：仅自定义话术可删，内置话术受保护（可编辑替代删除）。"""
    p = await db.get(Phrase, phrase_id)
    if p is None:
        raise HTTPException(status_code=404, detail="话术不存在")
    if p.scope == "内置":
        raise HTTPException(status_code=400, detail="内置话术不可删除（可编辑内容）")
    await db.delete(p)
    await db.commit()
