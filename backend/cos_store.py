"""腾讯云 COS 对象存储（笔记图片）：SDK 模式照 Stellaris backup_store（惰性构造 + 空配置降级）。

- 流量不经过本服务：后端只签发预签名 URL，浏览器直传/直读 COS
- key 结构：notes/{uid}/{note_id}/{uuid}.{ext}
- 图片类型白名单（jpg/png/webp）+ 10MB 上限
"""

import asyncio
import re
import uuid

import config

ALLOWED_EXTS = {"jpg", "jpeg", "png", "webp"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024
SIGN_EXPIRE_SECONDS = 3600  # 下载签名 1 小时短时效

_client = None


def cos_enabled() -> bool:
    """COS 配置是否齐全（缺一项则图片功能整体禁用，文本笔记不受影响）。"""
    return bool(config.COS_SECRET_ID and config.COS_SECRET_KEY and config.COS_BUCKET and config.COS_REGION)


def _get_client():
    """惰性构造 CosS3Client（进程内单例）。"""
    global _client
    if _client is None:
        from qcloud_cos import CosConfig, CosS3Client

        _client = CosS3Client(
            CosConfig(
                Region=config.COS_REGION,
                SecretId=config.COS_SECRET_ID,
                SecretKey=config.COS_SECRET_KEY,
                Scheme="https",
            )
        )
    return _client


def make_image_key(uid: int, note_id: int | None, filename: str) -> str | None:
    """生成对象 key；扩展名不在白名单返回 None。"""
    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
    if ext not in ALLOWED_EXTS:
        return None
    part = note_id if note_id else "tmp"
    return f"notes/{uid}/{part}/{uuid.uuid4().hex[:16]}.{ext}"


async def presign_upload(key: str) -> str:
    """签发预签名 PUT URL（10 分钟有效）。"""
    return await asyncio.to_thread(
        _get_client().get_presigned_url,
        Method="PUT",
        Bucket=config.COS_BUCKET,
        Key=key,
        Expired=600,
    )


async def presign_download(key: str) -> str:
    """签发预签名 GET URL（1 小时短时效，私有桶读取）。"""
    return await asyncio.to_thread(
        _get_client().get_presigned_url,
        Method="GET",
        Bucket=config.COS_BUCKET,
        Key=key,
        Expired=SIGN_EXPIRE_SECONDS,
    )


async def delete_objects(keys: list[str]) -> None:
    """删除笔记时连 COS 对象一起清（失败只记日志，不阻断删除）。"""
    if not keys:
        return
    import logging

    def _del():
        client = _get_client()
        for key in keys:
            client.delete_object(Bucket=config.COS_BUCKET, Key=key)

    try:
        await asyncio.to_thread(_del)
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).error("COS 对象删除失败: %s", str(e)[:200])


IMG_PLACEHOLDER_RE = re.compile(r"\[\[img:([^\]]+)\]\]")


def extract_image_keys(content: str) -> list[str]:
    """从笔记内容提取图片占位符里的对象 key。"""
    return IMG_PLACEHOLDER_RE.findall(content or "")


async def bucket_stats(prefix: str = "notes/") -> tuple[int, int]:
    """桶内真实对象数与总字节（分页 list_objects，全量前缀扫描）。"""

    def _scan() -> tuple[int, int]:
        client = _get_client()
        count, total = 0, 0
        marker = ""
        while True:
            resp = client.list_objects(
                Bucket=config.COS_BUCKET, Prefix=prefix, Marker=marker, MaxKeys=1000
            )
            contents = resp.get("Contents", []) or []
            count += len(contents)
            total += sum(int(o.get("Size", 0)) for o in contents)
            if str(resp.get("IsTruncated", "false")).lower() != "true" or not contents:
                break
            marker = resp.get("NextMarker") or contents[-1]["Key"]
        return count, total

    return await asyncio.to_thread(_scan)
