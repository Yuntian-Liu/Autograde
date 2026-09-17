"""客户端事件接收端：clientLog flush 批量落库（登录即可，非管理员专属）。"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from auth.dependencies import get_current_user
from auth.models import User
from database import get_db
from models import ClientEvent

router = APIRouter(tags=["client-log"])

MAX_BATCH = 100


class ClientEventIn(BaseModel):
    ts: str = Field(default="", max_length=32)
    type: str = Field(default="", max_length=16)
    detail: str = Field(default="")


class ClientLogIn(BaseModel):
    events: list[ClientEventIn] = Field(default_factory=list, max_length=MAX_BATCH)


@router.post("/api/client-log", status_code=201)
async def ingest_client_log(
    body: ClientLogIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    for e in body.events:
        db.add(
            ClientEvent(
                uid=user.uid,
                client_ts=e.ts[:32],
                type=e.type[:16],
                detail=str(e.detail)[:800],
            )
        )
    await db.commit()
    return {"accepted": len(body.events)}
