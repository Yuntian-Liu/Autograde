"""AI 接入：OpenAI 兼容协议，网关与模型走环境变量，代码层不绑定厂商。

- env：OPENAI_API_KEY（自行填入 .env）/ OPENAI_BASE_URL（预置 DeepSeek）/ AI_MODEL
- AI 只做一次性加工与起草：parse_questions_stream 流式拆题返回草稿（不落库），
  draft_explanation 基于题目+答案+错点起草讲解（人定稿后才入库）。
- key 未配置时抛 AIUnavailable，路由层转 503；超时 300s，路由层转 504，绝不让服务崩。
"""

import json
import os
from collections.abc import AsyncGenerator

from dotenv import load_dotenv
from openai import APITimeoutError, AsyncOpenAI

from models import Question

load_dotenv()

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-pro"
AI_TIMEOUT = 300  # 真实文档（20-40 题）拆分要跑几分钟，兜底 300 秒


class AIUnavailable(Exception):
    """API key 未配置。"""


class AIParseError(Exception):
    """AI 输出无法解析为预期 JSON；raw 存原始输出片段供排错。"""

    def __init__(self, message: str, raw: str = ""):
        super().__init__(message)
        self.raw = raw


def ensure_available() -> None:
    """路由层在起流之前调用，key 缺失时按 503 快速失败。"""
    if not os.getenv("OPENAI_API_KEY", "").strip():
        raise AIUnavailable("AI 功能未配置：请在 backend/.env 填入 OPENAI_API_KEY 后重启服务")


def _client() -> AsyncOpenAI:
    ensure_available()
    base_url = os.getenv("OPENAI_BASE_URL", "").strip() or DEFAULT_BASE_URL
    return AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY").strip(), base_url=base_url, timeout=AI_TIMEOUT)


def _model() -> str:
    return os.getenv("AI_MODEL", "").strip() or DEFAULT_MODEL


_PARSE_SYSTEM = """你是英语助教的题库录入助手。用户会粘贴一段从机构 PDF/Word 转换而来的作业答案原文，请把它结构化为严格 JSON。

要求：
1. 按原文板块分组；板块名逐字照抄原文的板块标题行（如 "Task 1 Vocabulary"、"Task 4 · Grammar"），原文标题行什么样就抄什么样——禁止翻译、改写、合并或自行美化板块名
2. 题号按板块独立编号：每个板块的 seq 都从 1 重新开始（如 Task 1 是 1-5，Task 2 重新从 1 开始是 1-6），禁止跨板块连续编号
3. 原文照抄原则：stem / standard_answer / explanation 必须逐字摘自原文，你只负责分块和归类——禁止改写、翻译、润色、补全、概括任何文字；拿不准的保留原文原样
4. 保留原文换行结构：stem / explanation 内部，凡语义独立的部分（如「词义：…」「句意：…」「Tip/小贴士：…」、分点说明）必须各占一行，JSON 字符串里用 \\n 表达，禁止把多行压成一段
   正例："词义：纪念碑，纪念像\\n句意：公园里有一座……\\n小贴士：先看空格前后词……"
   反例："词义：纪念碑，纪念像 句意：公园里有一座…… 小贴士：先看空格前后词……"（错误：三条压成一段）
5. 你唯一允许删除的内容：机构水印、页眉页脚、联系方式、广告等与题目无关的行
6. 每题输出字段：
   - seq：板块内题号（整数，从 1 开始，见第 2 条）
   - stem：题干（原文没有题干则留空字符串）
   - options：选项数组，逐字照抄原文（如 ["A. forest", "B. river", "C. mountain"]；判断题 ["T", "F"]；填空/造句等无选项题型输出空数组 []）
   - standard_answer：标准答案
   - explanation：解析原文（没有解析则留空字符串；换行规则见第 4 条）
   - mode：建议处理模式，三选一：
     verbatim=客观题且有解析可直出；ai_expand=有答案但无解析的造句/开放类；manual=答案为图片（连线/勾选等）或需人工个性化点评
   - score_weight：建议分值权重（1-10 的数字，按题目难度与题量估算，总和接近 100 为佳）
7. 只输出 JSON，不要任何额外文字、注释或 Markdown 代码块

输出格式：
{"sections": [{"section": "板块名", "questions": [{"seq": 1, "stem": "", "options": [], "standard_answer": "", "explanation": "", "mode": "verbatim", "score_weight": 5.0}]}]}"""

_DRAFT_SYSTEM = """你是英语助教，为老师起草发给家长的分题讲解。根据题目、标准答案与老师描述的学生错点，写一段亲切、具体、可读的讲解（中文为主，可引用英文原句），80-150 字，结尾给一个可执行的改进建议。只输出讲解正文。"""


def _extract_json(text: str) -> dict:
    """从模型输出中提取 JSON 对象，容忍代码块包裹与首尾杂文本。"""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        cleaned = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise AIParseError("输出中未找到 JSON 对象", raw=text[:500])
    try:
        return json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as e:
        raise AIParseError(f"JSON 解析失败：{e}", raw=text[:500]) from e


def _validate_sections(output: str) -> dict:
    data = _extract_json(output)
    sections = data.get("sections")
    if not isinstance(sections, list) or not sections:
        raise AIParseError("输出缺少 sections 数组", raw=output[:500])
    for sec in sections:
        if not isinstance(sec.get("questions"), list):
            raise AIParseError("板块缺少 questions 数组", raw=output[:500])
    return {"sections": sections}


def _usage_dict(completion_or_chunk) -> dict | None:
    """从响应/末 chunk 提取 token 用量（OpenAI 兼容字段，缺失返回 None）。"""
    usage = getattr(completion_or_chunk, "usage", None)
    if usage is None:
        return None
    return {
        "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
        "completion_tokens": getattr(usage, "completion_tokens", 0) or 0,
    }


async def parse_questions_stream(raw_text: str) -> AsyncGenerator[dict, None]:
    """流式拆题：边收边推 progress 事件（已闭合题目数，按 "seq" 出现次数近似），
    结束后推 done 事件带完整解析结果与 token 用量。不落库，人工验收后才冻结。"""
    client = _client()
    stream = await client.chat.completions.create(
        model=_model(),
        messages=[
            {"role": "system", "content": _PARSE_SYSTEM},
            {"role": "user", "content": raw_text},
        ],
        temperature=0,
        stream=True,
        stream_options={"include_usage": True},  # 末 chunk 带 usage，供成本记录
    )
    buf = ""
    done = 0
    usage = None
    finish_reason = None
    async for chunk in stream:
        if chunk.choices:
            fr = chunk.choices[0].finish_reason
            if fr:
                finish_reason = fr
            delta = chunk.choices[0].delta.content
            if delta:
                buf += delta
                count = buf.count('"seq"')
                if count != done:
                    done = count
                    yield {"type": "progress", "done": count}
        u = _usage_dict(chunk)  # 独立检查：usage 挂在末尾 chunk，不假定 choices 为空
        if u:
            usage = u
    yield {
        "type": "done",
        "data": _validate_sections(buf),
        "usage": usage,
        "finish_reason": finish_reason,
        "text_chars": len(buf),
    }


async def draft_explanation(question: Question, error_description: str) -> str:
    """基于题干 + 标准答案 + 老师描述的错点，起草讲解文本（窗内可改，人定稿）。"""
    client = _client()
    user = (
        f"题目：{question.stem or '（见原题）'}\n"
        f"标准答案：{question.standard_answer}\n"
        f"参考解析：{question.explanation or '（无）'}\n"
        f"学生错点：{error_description}\n"
        "请起草讲解。"
    )
    resp = await client.chat.completions.create(
        model=_model(),
        messages=[
            {"role": "system", "content": _DRAFT_SYSTEM},
            {"role": "user", "content": user},
        ],
        temperature=0.7,
    )
    text = (resp.choices[0].message.content or "").strip()
    return {
        "text": text,
        "usage": _usage_dict(resp),
        "finish_reason": resp.choices[0].finish_reason,
    }


__all__ = [
    "AIParseError",
    "APITimeoutError",
    "AIUnavailable",
    "draft_explanation",
    "ensure_available",
    "parse_questions_stream",
]
