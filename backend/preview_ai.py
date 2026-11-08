"""独立预习答案拆分：固定 5 题，只整理答案与解析，不接触正式计分题库。"""

from collections.abc import AsyncGenerator

from ai import AIParseError, _client, _extract_json, _model, _StreamTimer, _usage_dict

_PREVIEW_SYSTEM = """你是英语助教的预习答案录入助手。用户粘贴的内容只包含一份预习答案与解析，请结构化为严格 JSON。

要求：
1. 固定输出 5 道题，seq 依次为 1、2、3、4、5；不得新增、遗漏或合并题目
2. 每题包含 standard_answer 与 explanation。standard_answer 只填原文明确给出的 A/B/C/D 选项字母；无法明确判断时留空字符串，交给老师验收，禁止猜测
3. explanation 逐字照抄该题解析原文，没有解析则留空字符串。你只负责分块，禁止改写、翻译、补全、概括或润色
4. 保留解析的原文换行；「词义」「句意」「解析」「Tip/小贴士」及分点说明等语义独立内容必须各占一行，JSON 字符串用 \\n 表达，禁止压成一段
5. 只能删除机构水印、页眉页脚、联系方式和广告等与题目无关的行
6. 只输出 JSON，不要额外文字、注释或 Markdown 代码块

输出格式：
{"questions": [{"seq": 1, "standard_answer": "A", "explanation": "解析原文"}]}"""


def _validate_preview(output: str) -> dict:
    data = _extract_json(output)
    questions = data.get("questions")
    if not isinstance(questions, list) or len(questions) != 5:
        raise AIParseError("预习输出必须恰好包含 5 道题", raw=output[:500])
    result = []
    for index, item in enumerate(questions, start=1):
        if not isinstance(item, dict) or item.get("seq") != index:
            raise AIParseError("预习题号必须依次为 1–5", raw=output[:500])
        answer = str(item.get("standard_answer") or "").strip().upper()
        explanation = item.get("explanation")
        if explanation is not None and not isinstance(explanation, str):
            raise AIParseError(f"第 {index} 题解析不是文本", raw=output[:500])
        result.append({
            "seq": index,
            "standard_answer": answer if answer in ("A", "B", "C", "D") else "",
            "explanation": explanation or "",
        })
    return {"questions": result}


async def parse_preview_stream(raw_text: str) -> AsyncGenerator[dict, None]:
    client = _client(max_retries=0)
    yield {"type": "stage", "stage": "connecting", "model": _model()}
    raw = await client.chat.completions.with_raw_response.create(
        model=_model(),
        messages=[
            {"role": "system", "content": _PREVIEW_SYSTEM},
            {"role": "user", "content": raw_text},
        ],
        temperature=0,
        stream=True,
        stream_options={"include_usage": True},
    )
    provider_request_id = raw.headers.get("x-request-id", "")
    yield {"type": "stage", "stage": "connected", "provider_request_id": provider_request_id}
    stream = raw.parse()
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
            delta = chunk.choices[0].delta
            timer.on_chunk(delta)
            if getattr(delta, "reasoning_content", None):
                yield {"type": "stage", "stage": "thinking"}
            content = delta.content
            if content:
                buf += content
                count = min(buf.count('"seq"'), 5)
                if count != done:
                    done = count
                yield {"type": "progress", "done": done, "recv_chars": len(buf), "stage": "receiving"}
        current_usage = _usage_dict(chunk)
        if current_usage:
            usage = current_usage
    yield {"type": "stage", "stage": "validating"}
    yield {
        "type": "done",
        "data": _validate_preview(buf),
        "usage": usage,
        "finish_reason": finish_reason,
        "text_chars": len(buf),
        "metrics": timer.metrics(),
        "provider_request_id": provider_request_id,
    }
