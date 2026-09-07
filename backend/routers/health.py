from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "version": "0.4.0"}
