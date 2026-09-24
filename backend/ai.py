"""AI 接入：OpenAI 兼容协议，网关与模型走环境变量，代码层不绑定厂商。

- env：OPENAI_API_KEY（自行填入 .env）/ OPENAI_BASE_URL（预置 DeepSeek）/ AI_MODEL
- AI 只做一次性加工与起草：parse_questions_stream 流式拆题返回草稿（不落库），
  draft_explanation 基于题目+答案+错点起草讲解（人定稿后才入库）。
- key 未配置时抛 AIUnavailable，路由层转 503；超时 300s，路由层转 504，绝不让服务崩。
"""

import json
import os
import time
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


def _client(max_retries: int | None = None) -> AsyncOpenAI:
    ensure_available()
    base_url = os.getenv("OPENAI_BASE_URL", "").strip() or DEFAULT_BASE_URL
    kwargs = {} if max_retries is None else {"max_retries": max_retries}
    return AsyncOpenAI(
        api_key=os.getenv("OPENAI_API_KEY").strip(), base_url=base_url, timeout=AI_TIMEOUT, **kwargs
    )


def _model() -> str:
    return os.getenv("AI_MODEL", "").strip() or DEFAULT_MODEL


_PARSE_SYSTEM = """你是英语助教的题库录入助手。用户会粘贴一段从机构 PDF/Word 转换而来的作业答案原文，请把它结构化为严格 JSON。

要求：
1. 按原文板块分组；板块名逐字照抄原文的板块标题行（如 "Task 1 Vocabulary"、"Task 4 · Grammar"），原文标题行什么样就抄什么样——禁止翻译、改写、合并或自行美化板块名
2. 题号照抄原文：seq 必须逐字使用原文中该题的真实题号，原文标几就写几，禁止重新编号。同一大板块拆成 A/B 等子板块时题号保持原文连续——如 Vocabulary A 是原文 1-5 题、Vocabulary B 是原文 6-8 题，则 A 的 seq 是 1-5、B 的 seq 是 6-8（禁止把 B 重编成 1-3）。仅当原文完全没有题号时，才按板块内从 1 开始顺序编号
3. 原文照抄原则：stem / standard_answer / explanation 必须逐字摘自原文，你只负责分块和归类——禁止改写、翻译、润色、补全、概括任何文字；拿不准的保留原文原样。「解析：」「答案：」「Tips：」这类字段前缀属于内容本身，必须原样保留——如原文是「解析：本句考查…」，explanation 必须以「解析：」开头，禁止因为"看起来像标签"就删掉
4. 保留原文换行结构：stem / explanation 内部，凡语义独立的部分（如「词义：…」「句意：…」「Tip/小贴士：…」、分点说明）必须各占一行，JSON 字符串里用 \\n 表达，禁止把多行压成一段
   正例："词义：纪念碑，纪念像\\n句意：公园里有一座……\\n小贴士：先看空格前后词……"
   反例："词义：纪念碑，纪念像 句意：公园里有一座…… 小贴士：先看空格前后词……"（错误：三条压成一段）
5. 你唯一允许删除的内容：机构水印、页眉页脚、联系方式、广告等与题目无关的行
6. 每题输出字段：
   - seq：原文真实题号（照抄，见第 2 条）
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

_ABILITY_DIMENSIONS = [
    ("vocabulary", "词汇掌握"),
    ("grammar", "语法运用"),
    ("spelling", "拼写与书写"),
    ("reading", "阅读理解"),
    ("sentence", "句型与表达"),
    ("habit", "学习习惯"),
]

_ABILITY_SYSTEM = """你是资深英语教研分析师。老师会给你一名学生一段时间内的三层材料：提交统计、错题明细（含错点/讲解记录）、历次作业反馈全文。请产出一份结构化能力分析报告，输出严格 JSON。

核心原则：
1. 从错点描述与反馈文本归纳真正的能力短板——板块归属只是表面。例如错题在「造句」板块，根因可能是单词拼写；错题在「词汇」板块，根因可能是词性判断。禁止按板块直接下结论
2. 每条结论必须有证据：evidence 的 quote 必须逐字摘自所给材料（错题记录或反馈原文），禁止杜撰、改写；source 标注出处（如「U7L1 · Task 4 · Grammar 第3题」或「U7L1 反馈」）
3. 禁止空泛措辞（「有待加强」「继续努力」这类没有信息量的句子禁入）；分析要具体到知识点与行为

评分锚（0-100 整数）：90-100 稳定掌握，极少出错 / 75-89 基本扎实，偶有小错 / 60-74 有明显短板，错误反复出现 / 0-59 薄弱，严重影响作业质量。材料中某维度完全无证据时，依据该生整体表现保守估计并在 analysis 中说明「材料中直接证据较少」

六个固定维度（key 必须逐字使用）：
- vocabulary 词汇掌握：词义、词性、词汇运用
- grammar 语法运用：时态、单复数、冠词、句法结构
- spelling 拼写与书写：单词拼写、大小写、标点
- reading 阅读理解：阅读题、词义猜测、信息定位
- sentence 句型与表达：造句、句式完整性、表达能力
- habit 学习习惯：主要依据提交统计打分（提交率、未交/缺项频率），反馈中与态度相关的描述为辅

输出格式（只输出 JSON，不要任何额外文字或代码块）：
{
  "overall": "总评，120-200 字，概括整体水平与最突出的 1-2 个特点",
  "dimensions": [
    {
      "key": "vocabulary",
      "score": 82,
      "analysis": "该维度分析，80-150 字，具体到知识点",
      "tags": ["子标签3-6个，如：漏冠词、双写字母错误"],
      "evidence": [{"source": "出处", "quote": "逐字摘录"}]
    }
  ],
  "suggestions": "教学建议，100-180 字，给出下次课重点与可执行的练习方向"
}
dimensions 必须恰好包含上述六个维度、顺序一致；每维 evidence 2-4 条（habit 维度可只用统计做证据，quote 摘录统计行即可）。"""


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


def _extract_cache_tokens(u) -> tuple[int, int]:
    """提取缓存命中/未命中 tokens（双字段兼容，照 Stellaris）：
    DeepSeek 顶层 prompt_cache_hit_tokens/miss_tokens → OpenAI 新标准
    prompt_tokens_details.cached_tokens → 都没有返回 (0, 0)（全按未命中计价兜底）。"""
    hit = getattr(u, "prompt_cache_hit_tokens", None)
    if hit is not None:
        return hit or 0, getattr(u, "prompt_cache_miss_tokens", 0) or 0
    details = getattr(u, "prompt_tokens_details", None)
    cached = (getattr(details, "cached_tokens", 0) or 0) if details else 0
    if cached:
        return cached, max((getattr(u, "prompt_tokens", 0) or 0) - cached, 0)
    return 0, 0


def _usage_dict(completion_or_chunk) -> dict | None:
    """从响应/末 chunk 提取 token 用量（含缓存拆分与思考 token），缺失返回 None。"""
    usage = getattr(completion_or_chunk, "usage", None)
    if usage is None:
        return None
    hit, miss = _extract_cache_tokens(usage)
    comp_details = getattr(usage, "completion_tokens_details", None)
    reasoning = (getattr(comp_details, "reasoning_tokens", 0) or 0) if comp_details else 0
    return {
        "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
        "completion_tokens": getattr(usage, "completion_tokens", 0) or 0,
        "cache_hit_tokens": hit,
        "cache_miss_tokens": miss,
        "reasoning_tokens": reasoning,
    }


class _StreamTimer:
    """流式延迟三指标：ttft=首个 chunk / think=开始→首个正文 delta / total=全程。"""

    def __init__(self) -> None:
        self.t0 = time.monotonic()
        self.ttft_ms = 0
        self.think_ms = 0
        self.seen_reasoning = False

    def on_chunk(self, delta) -> None:
        now = time.monotonic()
        if not self.ttft_ms:
            self.ttft_ms = int((now - self.t0) * 1000)
        if getattr(delta, "reasoning_content", None):
            self.seen_reasoning = True
        if not self.think_ms and getattr(delta, "content", None):
            self.think_ms = int((now - self.t0) * 1000)

    def total_ms(self) -> int:
        return int((time.monotonic() - self.t0) * 1000)

    def metrics(self) -> dict:
        return {
            "ttft_ms": self.ttft_ms,
            # 没见到正文（异常断流）时思考时间回落总时长，不留 0 假数据
            "think_ms": self.think_ms or self.total_ms(),
            "total_ms": self.total_ms(),
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
    timer = _StreamTimer()
    async for chunk in stream:
        if chunk.choices:
            fr = chunk.choices[0].finish_reason
            if fr:
                finish_reason = fr
            timer.on_chunk(chunk.choices[0].delta)
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
        "metrics": timer.metrics(),
    }


async def draft_explanation(question: Question, error_description: str) -> str:
    """基于题干 + 标准答案 + 老师描述的错点，起草讲解文本（窗内可改，人定稿）。"""
    client = _client()
    t0 = time.monotonic()  # 非流式短调用：只记 total_ms
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
        "metrics": {"ttft_ms": 0, "think_ms": 0, "total_ms": int((time.monotonic() - t0) * 1000)},
    }


def validate_ability_data(data: dict) -> dict:
    """校验能力报告结构：六维齐全、分数 0-100、证据结构完整。
    AI 输出与人工定稿存档共用同一套校验（存档接口直接传解析后的 dict）。"""
    dims = data.get("dimensions")
    if not isinstance(dims, list):
        raise AIParseError("输出缺少 dimensions 数组")
    expected = [k for k, _ in _ABILITY_DIMENSIONS]
    got = [d.get("key") for d in dims if isinstance(d, dict)]
    if got != expected:
        raise AIParseError(f"维度序列不符：期望 {expected}，实际 {got}")
    for d in dims:
        score = d.get("score")
        if not isinstance(score, (int, float)) or not 0 <= score <= 100:
            raise AIParseError(f"维度 {d.get('key')} 分数非法：{score}")
        d["score"] = round(float(score), 2)
        if not isinstance(d.get("analysis"), str) or not d["analysis"].strip():
            raise AIParseError(f"维度 {d.get('key')} 缺少 analysis")
        tags = d.get("tags")
        d["tags"] = [str(t) for t in tags] if isinstance(tags, list) else []
        ev = d.get("evidence")
        if not isinstance(ev, list) or not ev:
            raise AIParseError(f"维度 {d.get('key')} 缺少 evidence")
        d["evidence"] = [
            {"source": str(e.get("source", "")), "quote": str(e.get("quote", ""))}
            for e in ev
            if isinstance(e, dict) and str(e.get("quote", "")).strip()
        ]
        if not d["evidence"]:
            raise AIParseError(f"维度 {d.get('key')} evidence 全部为空")
    if not isinstance(data.get("overall"), str) or not data["overall"].strip():
        raise AIParseError("缺少 overall 总评")
    if not isinstance(data.get("suggestions"), str) or not data["suggestions"].strip():
        raise AIParseError("缺少 suggestions 教学建议")
    return {
        "overall": data["overall"].strip(),
        "suggestions": data["suggestions"].strip(),
        "dimensions": dims,
        "scores": {d["key"]: d["score"] for d in dims},
    }


async def analyze_ability_stream(student_name: str, class_label: str, evidence_text: str) -> AsyncGenerator[dict, None]:
    """基于三层证据材料流式生成能力分析报告草稿（严格 JSON，人定稿后才入库）。

    必须流式：推理模型产出完整报告要数分钟，非流式调用 300s 整体超时会误杀；
    流式下超时按 chunk 间隔计，思考再久也不断。边收边推 recv_chars 供进度展示。"""
    client = _client(max_retries=0)  # 超时不自动重试（重试 = 用户干等两轮），重试权交给用户
    user = (
        f"学生：{student_name}（{class_label}）\n\n"
        f"{evidence_text}\n\n"
        "请按系统要求输出能力分析报告 JSON。"
    )
    stream = await client.chat.completions.create(
        model=_model(),
        messages=[
            {"role": "system", "content": _ABILITY_SYSTEM},
            {"role": "user", "content": user},
        ],
        temperature=0.3,
        stream=True,
        stream_options={"include_usage": True},
    )
    buf = ""
    usage = None
    finish_reason = None
    timer = _StreamTimer()
    async for chunk in stream:
        if chunk.choices:
            fr = chunk.choices[0].finish_reason
            if fr:
                finish_reason = fr
            timer.on_chunk(chunk.choices[0].delta)
            delta = chunk.choices[0].delta.content
            if delta:
                buf += delta
                yield {"type": "progress", "recv_chars": len(buf)}
        u = _usage_dict(chunk)
        if u:
            usage = u
    try:
        data = validate_ability_data(_extract_json(buf))
    except AIParseError as e:
        raise AIParseError(str(e), raw=buf[:500]) from e
    yield {
        "type": "done",
        "data": data,
        "usage": usage,
        "finish_reason": finish_reason,
        "text_chars": len(buf),
        "metrics": timer.metrics(),
    }


__all__ = [
    "AIParseError",
    "APITimeoutError",
    "AIUnavailable",
    "analyze_ability_stream",
    "draft_explanation",
    "ensure_available",
    "parse_questions_stream",
    "validate_ability_data",
]
