"""笔记库接口：CRUD + 搜索筛选 + 图片直传签发。全部走 owner_uid 校验，越权 404。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from auth.dependencies import get_current_user
from auth.models import User
from cos_store import (
    MAX_IMAGE_BYTES,
    cos_enabled,
    delete_objects,
    extract_image_keys,
    make_image_key,
    presign_download,
    presign_upload,
    upload_bytes,
)
from database import get_db
from models import Assignment, Class, Note, NoteImage, Student

router = APIRouter(prefix="/api/notes", tags=["notes"])


def _title_of(content: str) -> str:
    """标题 = 内容首行（微信笔记规则），空内容兜底「无标题」。"""
    first = (content or "").strip().split("\n", 1)[0].strip()
    return first[:128] or "无标题"


def _excerpt(content: str) -> str:
    """列表摘要：跳过首行标题，取后续三行并保留换行（前端 pre-line + line-clamp 截断）。"""
    lines = [l.strip() for l in (content or "").split("\n")[1:] if l.strip()]
    return "\n".join(lines[:3])[:180]


def _note_brief(n: Note, names: dict, sizes: dict[int, int]) -> dict:
    return {
        "id": n.id,
        "title": n.title,
        "excerpt": _excerpt(n.content),
        "image_count": len(extract_image_keys(n.content)),
        "image_size": sizes.get(n.id, 0),  # 该笔记图片总字节（note_images 对账后口径）
        "class_id": n.class_id,
        "student_id": n.student_id,
        "assignment_id": n.assignment_id,
        "class_name": names.get("classes", {}).get(n.class_id),
        "student_name": names.get("students", {}).get(n.student_id),
        "assignment_label": names.get("assignments", {}).get(n.assignment_id),
        "user_edited": n.user_edited,
        "updated_at": n.updated_at.isoformat() if n.updated_at else None,
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }


async def _sizes_map(db: AsyncSession, notes: list[Note]) -> dict[int, int]:
    """批量取每笔记图片总字节（一次 group-by，无 N+1）。"""
    ids = [n.id for n in notes]
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(NoteImage.note_id, func.coalesce(func.sum(NoteImage.size), 0))
            .where(NoteImage.note_id.in_(ids))
            .group_by(NoteImage.note_id)
        )
    ).all()
    return {nid: int(total) for nid, total in rows}


async def _reconcile_images(db: AsyncSession, note: Note) -> None:
    """保存时对账：内容里存在的占位符归属本笔记；本笔记名下但已不在内容里的清掉
    （防「上传了但没贴进正文」与「贴了后来又删掉」的孤儿行）。"""
    keys = extract_image_keys(note.content)
    if keys:
        await db.execute(
            update(NoteImage)
            .where(NoteImage.key.in_(keys), NoteImage.owner_uid == note.owner_uid)
            .values(note_id=note.id)
        )
    stmt = delete(NoteImage).where(NoteImage.note_id == note.id)
    if keys:
        stmt = stmt.where(NoteImage.key.not_in(keys))
    await db.execute(stmt)


async def _names_map(db: AsyncSession, uid: int, notes: list[Note]) -> dict:
    """批量解析关联名（三次 in 查询，无 N+1）。"""
    class_ids = {n.class_id for n in notes if n.class_id}
    student_ids = {n.student_id for n in notes if n.student_id}
    assignment_ids = {n.assignment_id for n in notes if n.assignment_id}
    classes = (
        (await db.execute(select(Class).where(Class.id.in_(class_ids)))).scalars().all()
        if class_ids
        else []
    )
    students = (
        (await db.execute(select(Student).where(Student.id.in_(student_ids)))).scalars().all()
        if student_ids
        else []
    )
    assignments = (
        (await db.execute(select(Assignment).where(Assignment.id.in_(assignment_ids))))
        .scalars()
        .all()
        if assignment_ids
        else []
    )
    return {
        "classes": {c.id: c.name for c in classes},
        "students": {s.id: s.name for s in students},
        "assignments": {a.id: a.unit_label for a in assignments},
    }


async def _owned_note(db: AsyncSession, note_id: int, user: User) -> Note:
    n = await db.get(Note, note_id)
    if n is None or n.owner_uid != user.uid:
        raise HTTPException(status_code=404, detail="笔记不存在")
    return n


async def _validate_links(db: AsyncSession, user: User, class_id, student_id, assignment_id):
    """有关联时顺带校验归属（防把笔记挂到别人班上）；游离笔记（全空）直接过。"""
    if class_id is not None:
        c = await db.get(Class, class_id)
        if c is None or c.owner_uid != user.uid:
            raise HTTPException(status_code=404, detail="班级不存在")
    if student_id is not None:
        s = await db.get(Student, student_id)
        if s is None:
            raise HTTPException(status_code=404, detail="学生不存在")
        c = await db.get(Class, s.class_id)
        if c is None or c.owner_uid != user.uid:
            raise HTTPException(status_code=404, detail="学生不存在")
        if class_id is not None and s.class_id != class_id:
            raise HTTPException(status_code=400, detail="学生不属于该班级")
    if assignment_id is not None:
        a = await db.get(Assignment, assignment_id)
        if a is not None:
            c = await db.get(Class, a.class_id)
            if c is None or c.owner_uid != user.uid:
                raise HTTPException(status_code=404, detail="批次不存在")
        else:
            raise HTTPException(status_code=404, detail="批次不存在")
        if class_id is not None and a.class_id != class_id:
            raise HTTPException(status_code=400, detail="批次不属于该班级")


@router.get("")
async def list_notes(
    q: str = "",
    class_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """搜索（标题/学生名）+ 班级筛选，时间倒序。"""
    notes = (
        (
            await db.execute(
                select(Note).where(Note.owner_uid == user.uid).order_by(Note.updated_at.desc())
            )
        )
        .scalars()
        .all()
    )
    if class_id is not None:
        notes = [n for n in notes if n.class_id == class_id]
    names = await _names_map(db, user.uid, notes)
    sizes = await _sizes_map(db, notes)
    briefs = [_note_brief(n, names, sizes) for n in notes]
    if q.strip():
        kw = q.strip().lower()
        briefs = [
            b
            for b in briefs
            if kw in b["title"].lower()
            or (b["student_name"] and kw in b["student_name"].lower())
        ]
    return briefs


class NoteCreate(BaseModel):
    content: str = ""
    class_id: int | None = None
    student_id: int | None = None
    assignment_id: int | None = None


@router.post("", status_code=201)
async def create_note(
    body: NoteCreate, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    await _validate_links(db, user, body.class_id, body.student_id, body.assignment_id)
    n = Note(
        owner_uid=user.uid,
        class_id=body.class_id,
        student_id=body.student_id,
        assignment_id=body.assignment_id,
        content=body.content,
        title=_title_of(body.content),
    )
    db.add(n)
    await db.commit()
    await _reconcile_images(db, n)
    await db.commit()
    names = await _names_map(db, user.uid, [n])
    return _note_brief(n, names, await _sizes_map(db, [n]))


@router.get("/{note_id}")
async def get_note(
    note_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    """详情：内容 + 图片占位符批量签成短时效预签名 GET URL。"""
    n = await _owned_note(db, note_id, user)
    names = await _names_map(db, user.uid, [n])
    sizes = await _sizes_map(db, [n])
    image_urls = {}
    if cos_enabled():
        for key in extract_image_keys(n.content):
            image_urls[key] = await presign_download(key)
    return {**_note_brief(n, names, sizes), "content": n.content, "image_urls": image_urls}


class NotePatch(BaseModel):
    content: str
    class_id: int | None = None
    student_id: int | None = None
    assignment_id: int | None = None
    relink: bool = False  # True 时才改关联（避免 PATCH 正文时误清关联）


@router.patch("/{note_id}")
async def update_note(
    note_id: int,
    body: NotePatch,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    n = await _owned_note(db, note_id, user)
    # 笔记编辑页是 PATCH 的唯一入口：改字/贴图都算手动编辑，置位后批改联动永久脱钩
    n.user_edited = True
    n.content = body.content
    n.title = _title_of(body.content)  # 首行自动重算
    if body.relink:
        await _validate_links(db, user, body.class_id, body.student_id, body.assignment_id)
        n.class_id = body.class_id
        n.student_id = body.student_id
        n.assignment_id = body.assignment_id
    await _reconcile_images(db, n)
    await db.commit()
    names = await _names_map(db, user.uid, [n])
    return _note_brief(n, names, await _sizes_map(db, [n]))


@router.delete("/{note_id}", status_code=204)
async def delete_note(
    note_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> None:
    n = await _owned_note(db, note_id, user)
    keys = extract_image_keys(n.content)
    await db.execute(delete(NoteImage).where(NoteImage.note_id == n.id))
    await db.delete(n)
    await db.commit()
    if cos_enabled() and keys:
        await delete_objects(keys)


class UploadUrlIn(BaseModel):
    filename: str = Field(..., max_length=128)
    size: int = Field(..., gt=0)
    note_id: int | None = None


@router.post("/upload-url")
async def create_upload_url(
    body: UploadUrlIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """签发图片直传 COS 的预签名 PUT URL；COS 未配置时 503 优雅降级。"""
    if not cos_enabled():
        raise HTTPException(status_code=503, detail="图片存储未配置，暂只支持纯文本笔记")
    if body.size > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="图片不能超过 10MB")
    key = make_image_key(user.uid, body.note_id, body.filename)
    if key is None:
        raise HTTPException(status_code=400, detail="仅支持 jpg / png / webp 图片")
    # 签发即入库追踪（note_id 可空=临时件，贴进正文保存时对账归属）
    db.add(NoteImage(note_id=body.note_id, owner_uid=user.uid, key=key, size=body.size))
    await db.commit()
    return {"key": key, "upload_url": await presign_upload(key)}


_CONTENT_TYPE_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


def _assert_public_url(url: str) -> str:
    """SSRF 防护：只允许 http/https 公网地址；解析域名后拒绝内网/环回/保留网段。
    返回 host（供日志）。重定向后的最终 URL 也要过这道闸。"""
    import ipaddress
    import socket
    from urllib.parse import urlparse

    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise HTTPException(status_code=400, detail="仅支持 http/https 图片链接")
    host = u.hostname
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        raise HTTPException(status_code=400, detail="图片链接域名无法解析")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise HTTPException(status_code=400, detail="图片链接指向不允许的地址")
    return host


class FetchImageIn(BaseModel):
    url: str = Field(..., max_length=2048)
    note_id: int | None = None


@router.post("/fetch-image")
async def fetch_image(
    body: FetchImageIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """外链图片迁移：后端取回字节（10MB 上限 / 15s 超时 / 仅 image/*）→ 传 COS → 返回 key + 签名读 URL。"""
    import httpx

    if not cos_enabled():
        raise HTTPException(status_code=503, detail="图片存储未配置，暂不支持图片迁移")
    _assert_public_url(body.url)

    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            async with client.stream("GET", body.url) as resp:
                if resp.status_code != 200:
                    raise HTTPException(status_code=400, detail=f"图片拉取失败（HTTP {resp.status_code}）")
                _assert_public_url(str(resp.url))  # 重定向落点再过闸
                ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                ext = _CONTENT_TYPE_EXT.get(ctype)
                if ext is None:
                    raise HTTPException(status_code=400, detail="链接内容不是图片")
                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.aiter_bytes(65536):
                    total += len(chunk)
                    if total > MAX_IMAGE_BYTES:
                        raise HTTPException(status_code=400, detail="图片不能超过 10MB")
                    chunks.append(chunk)
        data = b"".join(chunks)
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="图片拉取超时")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"图片拉取失败：{str(e)[:120]}")

    key = make_image_key(user.uid, body.note_id, f"fetch.{ext}")
    await upload_bytes(key, data, ctype)
    db.add(NoteImage(note_id=body.note_id, owner_uid=user.uid, key=key, size=total))
    await db.commit()
    return {"key": key, "url": await presign_download(key)}
