import { useRef, useState } from "react";

// 6 格验证码输入：输入自动跳格、退格回跳、粘贴整段填入
// 内部用 6 元素数组存状态（不用字符串补位——空格编码与去空格逻辑会互相打架）
export default function CodeInput({ value, onChange }) {
  // 外部 value（字符串）→ 6 格数组；不足位补空串
  const cells = useMemoCells(value);
  const refs = useRef([]);

  function setCells(next) {
    onChange(next.join(""));
  }

  function setAt(i, ch) {
    const next = [...cells];
    next[i] = ch;
    setCells(next);
    if (ch && i < 5) refs.current[i + 1]?.focus();
  }

  function onKeyDown(i, e) {
    if (e.key === "Backspace" && !cells[i] && i > 0) {
      e.preventDefault();
      const next = [...cells];
      next[i - 1] = "";
      setCells(next);
      refs.current[i - 1]?.focus();
    }
    if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
  }

  function onPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
    onChange(text);
    refs.current[Math.min(text.length, 5)]?.focus();
  }

  return (
    <div className="code-input" onPaste={onPaste}>
      {cells.map((v, i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          className="code-box"
          value={v}
          inputMode="numeric"
          maxLength={1}
          onChange={(e) => setAt(i, e.target.value.replace(/\D/g, "").slice(-1))}
          onKeyDown={(e) => onKeyDown(i, e)}
        />
      ))}
    </div>
  );
}

function useMemoCells(value) {
  const arr = String(value || "").replace(/\D/g, "").slice(0, 6).split("");
  while (arr.length < 6) arr.push("");
  return arr;
}
