import { useState } from "react";
import { App as AntApp } from "antd";
import { IconCopy } from "./icons";

// 业务编码 chip：复制图标 + SID/AID 前缀（从码内类型字母推导）+ 等宽小字；点胶囊任意位置复制纯码。
// 在 Link 内部使用时阻止冒泡/默认行为（复制不触发跳转）。无码（旧数据回填前）不渲染。
const KIND_LABEL = { S: "SID", A: "AID" };

export default function CodeChip({ code }) {
  const { message } = AntApp.useApp();
  const [copied, setCopied] = useState(false);
  if (!code) return null;
  const label = KIND_LABEL[code.split("-")[2]?.[0]] || "ID";

  async function copy(e) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      message.error("复制失败，请检查剪贴板权限");
    }
  }

  return (
    <button
      type="button"
      className={`code-chip${copied ? " copied" : ""}`}
      onClick={copy}
      title={`业务编码（${label}）· 点击复制`}
    >
      <IconCopy width={10} height={10} />
      {copied ? "已复制" : `${label}: ${code}`}
    </button>
  );
}
