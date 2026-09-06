import React from "react";

// 全局错误边界：渲染期崩溃不再白屏，显示可读错误（生产也显示摘要，便于远程排查）
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[Autograde] 渲染崩溃:", error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            maxWidth: 640,
            margin: "80px auto",
            padding: 24,
            fontFamily: "inherit",
          }}
        >
          <h2 style={{ fontFamily: "var(--font-display)" }}>页面出了点问题</h2>
          <p style={{ color: "var(--ink-2)", fontSize: 13 }}>
            刷新页面通常可以恢复；若持续出现请带着下面的信息联系开发者。
          </p>
          <pre
            style={{
              background: "var(--bg-soft)",
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: 12,
              fontSize: 12,
              overflow: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {String(this.state.error?.message || this.state.error)}
            {"\n"}
            {String(this.state.error?.stack || "").slice(0, 800)}
          </pre>
          <button
            className="btn primary"
            style={{ marginTop: 16 }}
            onClick={() => window.location.reload()}
          >
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
