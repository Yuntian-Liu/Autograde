import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clientLog } from "../utils/clientLog";
import { streamAI } from "../utils/aiStream";
import AICallStatus from "./AICallStatus";
import MdContent from "./MdContent";
import { IconCopy } from "./icons";
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
  const [webSearch, setWebSearch] = useState(false); // 网络搜索：默认关闭，用户主动开启
  const [thinkSec, setThinkSec] = useState(null);
  const [progress, setProgress] = useState(null);
  const [copiedIdx, setCopiedIdx] = useState(-1); // 刚复制过的消息序号
  const dragRef = useRef(null); // {startX,startY,baseX,baseY,moved}
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const thinkTimer = useRef(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => () => clearInterval(thinkTimer.current), []);

  async function copyMessage(i, text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(i);
      setTimeout(() => setCopiedIdx((v) => (v === i ? -1 : v)), 1200);
    } catch {
      clientLog.add("ui", "chat_copy_failed");
    }
  }

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
    setThinkSec(0);
    setProgress({ stage: "preparing", recv_chars: 0 });
    thinkTimer.current = setInterval(() => setThinkSec((s) => s + 1), 1000);
    clientLog.add("ui", `chat_send len=${text.length} web=${webSearch ? 1 : 0}`);
    const history = [...messages, { role: "user", text }];
    setMessages([...history, { role: "assistant", text: "" }]);
    const started = Date.now();
    try {
      const done = await streamAI("/api/ai/chat", {
        messages: history.map((m) => ({ role: m.role, content: m.text })).slice(-20),
        assignment_id: assignmentId,
        web_search: webSearch,
      }, {
        onEvent: (event) => {
          if (event.type === "stage") {
            setProgress((prev) => ({ ...prev, ...event, status: "running" }));
          } else if (event.type === "delta") {
            setProgress((prev) => ({ ...prev, stage: "receiving", recv_chars: event.recv_chars, status: "running" }));
            setMessages((ms) => {
              const next = [...ms];
              next[next.length - 1] = { ...next[next.length - 1], text: next[next.length - 1].text + event.text };
              return next;
            });
          }
        },
      });
      const usage = done.usage || {};
      const meta = {
        elapsed: fmtMs(done.metrics?.total_ms || Date.now() - started),
        tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        cost: done.cost_yuan,
        tier: done.price_tier,
        webSearchCount: done.web_search_count || 0,
      };
      setMessages((ms) => {
        const next = [...ms];
        next[next.length - 1] = { ...next[next.length - 1], meta };
        return next;
      });
      clientLog.add("ui", `chat_done tokens=${meta.tokens} ${meta.elapsed}`);
    } catch (e) {
      clientLog.add("ui", `chat_error ${e.message}`.slice(0, 200));
      setProgress((prev) => ({ ...prev, status: "error", error: e.message }));
      setMessages((ms) => {
        const next = [...ms];
        next[next.length - 1] = { role: "assistant", text: `出错了：${e.message}`, meta: null };
        return next;
      });
    } finally {
      clearInterval(thinkTimer.current);
      setThinkSec(null);
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

  return createPortal(
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
                      {m.meta.webSearchCount > 0 ? ` · 搜索 ${m.meta.webSearchCount} 次` : ""}
                      {m.meta.cost ? ` · ¥${Number(m.meta.cost).toFixed(4)}` : ""}
                      {m.meta.tier ? `（${m.meta.tier === "offpeak" ? "谷" : "峰"}）` : ""}
                      <button
                        type="button"
                        className={`ai-copy${copiedIdx === i ? " copied" : ""}`}
                        onClick={() => copyMessage(i, m.text)}
                        title="复制 Markdown 原文"
                      >
                        <IconCopy width={10} height={10} />
                        {copiedIdx === i ? "已复制" : "复制"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {busy && (
              <div className="ai-msg assistant">
                <div className="ai-bubble ai-thinking">
                  <AICallStatus progress={progress} elapsed={thinkSec || 0} compact />
                </div>
              </div>
            )}
          </div>
          <div className="ai-panel-tools">
            <button
              type="button"
              className={`ai-search-toggle${webSearch ? " on" : ""}`}
              onClick={() => setWebSearch((value) => !value)}
              disabled={busy}
              aria-pressed={webSearch}
            >
              网络搜索
            </button>
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
    </>,
    document.body
  );
}
