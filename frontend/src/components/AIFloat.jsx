import { useEffect, useRef, useState } from "react";
import { getToken } from "../api";
import { clientLog } from "../utils/clientLog";
import MdContent from "./MdContent";
import assistantIcon from "../assets/ai-assistant.png";

// AI 助教浮窗（仅批改场景挂载）：右下默认、可拖拽、hover 出 × 消掉（本次访问内）、
// 点开通用问答。聊天页面临时（离开/消掉即清空）。SSE 流式直答，回答带耗时/tokens/成本。

const ICON_SIZE = 56;
const PANEL_W = 400;
const PANEL_H = 480;
const MARGIN = 16;

function clampPos(x, y, w, h) {
  return {
    x: Math.min(Math.max(MARGIN, x), window.innerWidth - w - MARGIN),
    y: Math.min(Math.max(MARGIN, y), window.innerHeight - h - MARGIN),
  };
}

function fmtMs(ms) {
  if (!ms) return "—";
  return ms < 60000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;
}

export default function AIFloat({ assignmentId = null }) {
  const [pos, setPos] = useState(() =>
    clampPos(window.innerWidth - ICON_SIZE - 24, window.innerHeight - ICON_SIZE - 24, ICON_SIZE, ICON_SIZE)
  );
  const [gone, setGone] = useState(false); // 本次页面访问内消掉
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // {role, text, meta?}
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const dragRef = useRef(null); // {startX,startY,baseX,baseY,moved}
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  // 拖拽：pointerdown 记录起点，move 超 5px 才算拖（否则当点击）
  function onPointerDown(e) {
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > 5) d.moved = true;
    if (d.moved) setPos(clampPos(d.baseX + dx, d.baseY + dy, ICON_SIZE, ICON_SIZE));
  }
  function onPointerUp() {
    const wasDrag = dragRef.current?.moved;
    dragRef.current = null;
    if (!wasDrag) setOpen((o) => !o);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    clientLog.add("ui", `chat_send len=${text.length}`);
    const history = [...messages, { role: "user", text }];
    setMessages([...history, { role: "assistant", text: "" }]);
    const started = Date.now();
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.text })).slice(-20),
          assignment_id: assignmentId,
        }),
      });
      if (!res.ok) {
        let detail = `${res.status}`;
        try {
          const b = await res.json();
          if (typeof b?.detail === "string") detail = b.detail;
        } catch { /* 保留状态码 */ }
        throw new Error(detail);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop();
        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data:")) continue;
          let ev;
          try {
            ev = JSON.parse(line.slice(5));
          } catch {
            continue;
          }
          if (ev.type === "delta") {
            setMessages((ms) => {
              const next = [...ms];
              next[next.length - 1] = { ...next[next.length - 1], text: next[next.length - 1].text + ev.text };
              return next;
            });
          } else if (ev.type === "done") {
            const u = ev.usage || {};
            const meta = {
              elapsed: fmtMs(ev.metrics?.total_ms || Date.now() - started),
              tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0),
              cost: ev.cost_yuan,
              tier: ev.price_tier,
            };
            setMessages((ms) => {
              const next = [...ms];
              next[next.length - 1] = { ...next[next.length - 1], meta };
              return next;
            });
            clientLog.add("ui", `chat_done tokens=${meta.tokens} ${meta.elapsed}`);
          } else if (ev.type === "error") {
            throw new Error(ev.message);
          }
        }
      }
    } catch (e) {
      clientLog.add("ui", `chat_error ${e.message}`.slice(0, 200));
      setMessages((ms) => {
        const next = [...ms];
        next[next.length - 1] = { role: "assistant", text: `出错了：${e.message}`, meta: null };
        return next;
      });
    } finally {
      setBusy(false);
    }
  }

  if (gone) return null;

  // 面板锚定图标上方；空间不足时夹紧回视口
  const panelPos = clampPos(
    pos.x + ICON_SIZE - PANEL_W,
    pos.y - PANEL_H - 12,
    PANEL_W,
    PANEL_H
  );

  return (
    <>
      {open && (
        <div className="ai-panel" style={{ left: panelPos.x, top: panelPos.y, width: PANEL_W, height: PANEL_H }}>
          <div className="ai-panel-head">
            <img src={assistantIcon} alt="" className="ai-panel-icon" />
            <span>AI 助教</span>
            <button className="ai-panel-close" onClick={() => setOpen(false)} aria-label="收起">×</button>
          </div>
          <div className="ai-panel-body" ref={listRef}>
            {messages.length === 0 && <div className="ai-empty">有什么想聊的？</div>}
            {messages.map((m, i) => {
              // 流式中的空占位泡不渲染（由「思考中」顶替，出字即替换）
              if (busy && i === messages.length - 1 && m.role === "assistant" && !m.text) return null;
              return (
                <div key={i} className={`ai-msg ${m.role}`}>
                  <div className="ai-bubble">
                    {m.role === "assistant" ? <MdContent text={m.text} /> : m.text}
                  </div>
                  {m.meta && (
                    <div className="ai-meta">
                      用时 {m.meta.elapsed} · tokens {m.meta.tokens.toLocaleString()}
                      {m.meta.cost ? ` · ¥${Number(m.meta.cost).toFixed(4)}` : ""}
                      {m.meta.tier ? `（${m.meta.tier === "offpeak" ? "谷" : "峰"}）` : ""}
                    </div>
                  )}
                </div>
              );
            })}
            {busy && messages[messages.length - 1]?.text === "" && (
              <div className="ai-msg assistant"><div className="ai-bubble ai-thinking">思考中</div></div>
            )}
          </div>
          <div className="ai-panel-foot">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="输入问题，Enter 发送"
              rows={2}
              disabled={busy}
            />
            <button className="btn primary" onClick={send} disabled={busy || !input.trim()}>
              发送
            </button>
          </div>
        </div>
      )}
      <div
        className="ai-float"
        style={{ left: pos.x, top: pos.y }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="button"
        aria-label="AI 助教"
      >
        <img src={assistantIcon} alt="AI 助教" draggable={false} />
        <button
          className="ai-float-x"
          aria-label="消掉助教"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
            setGone(true);
          }}
        >
          ×
        </button>
      </div>
    </>
  );
}
