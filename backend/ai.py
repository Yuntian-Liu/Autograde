"""AI 接入：OpenAI 兼容协议，网关与模型走环境变量，代码层不绑定厂商。

- env：OPENAI_API_KEY（碳碳自填）/ OPENAI_BASE_URL（预置 DeepSeek）/ AI_MODEL
- AI 只做一次性加工与起草：parse_questions 拆题返回草稿（不落库），
  draft_explanation 基于题目+答案+错点起草讲解（人定稿后才入库）。
- key 未配置时抛 AIUnavailable，路由层转 503，绝不让服务崩。
"""

import json
import os

from dotenv import load_dotenv

from models import Question

load_dotenv()

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-pro"


class AIUnavailable(Exception):
    """API key 未配置。"""


class AIParseError(Exception):
    """AI 输出无法解析为预期 JSON；raw 存原始输出片段供排错。"""

    def __init__(self, message: str, raw: str = ""):
        super().__init__(message)
        self.raw = raw


def _client():
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key:
        raise AIUnavailable("AI 功能未配置：请在 backend/.env 填入 OPENAI_API_KEY 后重启服务")
    from openai import AsyncOpenAI

    base_url = os.getenv("OPENAI_BASE_URL", "").strip() or DEFAULT_BASE_URL
    return AsyncOpenAI(api_key=key, base_url=base_url)


def _model() -> str:
    return os.getenv("AI_MODEL", "").strip() or DEFAULT_MODEL


_PARSE_SYSTEM = """你是英语助教的题库录入助手。用户会粘贴一段从机构 PDF/Word 转换而来的作业答案原文，请把它结构化为严格 JSON。

要求：
1. 按原文板块分组，板块名保留原文（如 "Task 1 · Vocabulary"、"Reading"）
2. 剔除机构水印、页眉页脚、联系方式、广告等一切与题目无关的行
3. 每题输出字段：
   - seq：板块内题号（整数，从 1 开始）
   - stem：题干（原文没有题干则留空字符串）
   - standard_answer：标准答案
   - explanation：解析原文（没有解析则留空字符串）
   - mode：建议处理模式，三选一：
     verbatim=客观题且有解析可直出；ai_expand=有答案但无解析的造句/开放类；manual=答案为图片（连线/勾选等）或需人工个性化点评
   - score_weight：建议分值权重（1-10 的数字，按题目难度与题量估算，总和接近 100 为佳）
4. 只输出 JSON，不要任何额外文字、注释或 Markdown 代码块

输出格式：
{"sections": [{"section": "板块名", "questions": [{"seq": 1, "stem": "", "standard_answer": "", "explanation": "", "mode": "verbatim", "score_weight": 5.0}]}]}"""

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


async def parse_questions(raw_text: str) -> dict:
    """把粘贴的答案原文拆成结构化题库草稿（不落库，人工验收后才冻结）。"""
    client = _client()
    resp = await client.chat.completions.create(
        model=_model(),
        messages=[
            {"role": "system", "content": _PARSE_SYSTEM},
            {"role": "user", "content": raw_text},
        ],
        temperature=0,
    )
    output = resp.choices[0].message.content or ""
    data = _extract_json(output)
    sections = data.get("sections")
    if not isinstance(sections, list) or not sections:
        raise AIParseError("输出缺少 sections 数组", raw=output[:500])
    for sec in sections:
        if not isinstance(sec.get("questions"), list):
            raise AIParseError("板块缺少 questions 数组", raw=output[:500])
    return {"sections": sections}


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
    return (resp.choices[0].message.content or "").strip()
