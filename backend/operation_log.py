import logging
import re
import uuid

from fastapi import Request

from auth.utils import decode_access_token
from database import SessionLocal
from models import OperationEvent

logger = logging.getLogger("autograde.operations")
logger.setLevel(logging.INFO)

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_SKIP_PATHS = {"/api/health", "/api/client-log"}


def request_id(raw: str | None = None) -> str:
    value = (raw or "").strip()
    return value if _REQUEST_ID_RE.fullmatch(value) else uuid.uuid4().hex


def should_record(method: str, path: str, status: int, duration_ms: int) -> bool:
    if not path.startswith("/api") or path in _SKIP_PATHS:
        return False
    return method in _WRITE_METHODS or status >= 400 or duration_ms > 3000


async def record_operation(
    request: Request,
    *,
    request_id: str,
    status: int,
    duration_ms: int,
    detail: str = "",
) -> None:
    if not should_record(request.method, request.url.path, status, duration_ms):
        return
    uid = None
    authorization = request.headers.get("Authorization", "")
    if authorization.startswith("Bearer "):
        payload = decode_access_token(authorization[7:])
        if payload and payload.get("uid") is not None:
            try:
                uid = int(payload["uid"])
            except (TypeError, ValueError):
                uid = None
    outcome = "error" if status >= 500 else "rejected" if status >= 400 else "success"
    logger.info(
        "operation rid=%s uid=%s method=%s path=%s status=%s outcome=%s ms=%d",
        request_id,
        uid,
        request.method,
        request.url.path,
        status,
        outcome,
        duration_ms,
    )
    try:
        async with SessionLocal() as db:
            db.add(
                OperationEvent(
                    uid=uid,
                    request_id=request_id,
                    method=request.method,
                    path=request.url.path[:300],
                    status=status,
                    duration_ms=max(0, duration_ms),
                    outcome=outcome,
                    detail=detail[:800],
                )
            )
            await db.commit()
    except Exception:
        logger.exception("operation_event_write_failed rid=%s path=%s", request_id, request.url.path)
