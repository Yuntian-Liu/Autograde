"""多租户访问控制：一切业务数据以 class.owner_uid 为唯一隔离锚点。

students/assignments 挂 class_id，questions/error_records/submissions/
feedback_snapshots 经 assignment 链路归属班级。越权访问一律 404（不泄露资源存在性）。
"""

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth.models import User
from models import Assignment, Class, Question, Student


async def owned_class(db: AsyncSession, class_id: int, user: User) -> Class:
    c = await db.get(Class, class_id)
    if c is None or c.owner_uid != user.uid:
        raise HTTPException(status_code=404, detail="班级不存在")
    return c


async def owned_assignment(db: AsyncSession, assignment_id: int | str, user: User) -> Assignment:
    """id-or-slug 双入口：纯数字按主键（存量链接兼容），否则按对外短码；越权一律 404。"""
    if isinstance(assignment_id, str) and not assignment_id.isdigit():
        a = (
            await db.execute(select(Assignment).where(Assignment.slug == assignment_id.lower()))
        ).scalar_one_or_none()
    else:
        a = await db.get(Assignment, int(assignment_id))
    if a is not None:
        c = await db.get(Class, a.class_id)
        if c is not None and c.owner_uid == user.uid:
            return a
    raise HTTPException(status_code=404, detail="批次不存在")


async def owned_question(db: AsyncSession, question_id: int, user: User) -> Question:
    q = await db.get(Question, question_id)
    if q is not None:
        a = await db.get(Assignment, q.assignment_id)
        if a is not None:
            c = await db.get(Class, a.class_id)
            if c is not None and c.owner_uid == user.uid:
                return q
    raise HTTPException(status_code=404, detail="题目不存在")


async def owned_student(db: AsyncSession, student_id: int, user: User) -> Student:
    s = await db.get(Student, student_id)
    if s is not None:
        c = await db.get(Class, s.class_id)
        if c is not None and c.owner_uid == user.uid:
            return s
    raise HTTPException(status_code=404, detail="学生不存在")
