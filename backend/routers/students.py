"""学生写接口：改名 / 备注（note 仅自己可见）/ 删除。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from access import owned_student
from auth.dependencies import get_current_user
from auth.models import User
from database import get_db
from models import ErrorRecord, FeedbackSnapshot, Student, Submission
from serializers import student_brief

router = APIRouter(prefix="/api/students", tags=["students"])


class StudentPatch(BaseModel):
    name: str | None = None
    note: str | None = None


@router.patch("/{student_id}")
async def update_student(
    student_id: int,
    body: StudentPatch,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    s = await owned_student(db, student_id, user)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="学生姓名不能为空")
        s.name = name
    if body.note is not None:
        s.note = body.note
    await db.commit()
    return student_brief(s)


@router.delete("/{student_id}", status_code=204)
async def delete_student(
    student_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> None:
    s = await owned_student(db, student_id, user)
    # 连同该学生的批改数据一起清理，避免孤儿行
    await db.execute(delete(ErrorRecord).where(ErrorRecord.student_id == student_id))
    await db.execute(delete(Submission).where(Submission.student_id == student_id))
    await db.execute(delete(FeedbackSnapshot).where(FeedbackSnapshot.student_id == student_id))
    await db.delete(s)
    await db.commit()
