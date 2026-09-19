// 笔记存储格式：纯文本行 + 白名单内联标记（**加粗** / *倾斜* / ==高亮==）+ 图片占位符 [[img:key]]
// 渲染铁律：先全文转义再应用标记——<script>、<img onerror> 之类一律剥成纯文本（XSS 安全）

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 单行渲染：转义 → 图片占位符 → 内联标记（** 先于 *，避免互相吃掉）
// 加载失败的图片占位也带 data-key：进编辑态再保存时占位符能原样往返，不会退化成纯文本丢图
export function renderNoteLine(line, imageUrls = {}) {
  let html = escapeHtml(line).replace(/\[\[img:([^\]]+)\]\]/g, (_, key) =>
    imageUrls[key]
      ? `<img class="note-img" src="${imageUrls[key]}" data-key="${escapeHtml(key)}" alt="" />`
      : `<span class="note-img-missing" data-key="${escapeHtml(key)}">[图片未加载]</span>`
  );
  html = html
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/==([^=]+)==/g, "<mark>$1</mark>");
  return html;
}

export function contentToHtml(content, imageUrls) {
  return (content || "")
    .split("\n")
    .map((line) => `<div>${renderNoteLine(line, imageUrls) || "<br>"}</div>`)
    .join("");
}

// 列表摘要等无图场景的内联渲染（安全 HTML；图片标记显示为中性的 [图片]，不误导「未加载」）
// kw 非空时把命中关键词包 <mark class="search-hit">（主题色高亮；只在文本片段替换，不碰标签）
export function renderNoteInline(text, kw = "") {
  return (text || "")
    .split("\n")
    .map((l) => {
      let html = renderNoteLine(l.replace(/\[\[img:[^\]]+\]\]/g, "[图片]"), {});
      const k = escapeHtml(kw.trim());
      if (k) {
        const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        html = html
          .split(/(<[^>]+>)/g)
          .map((seg) => (seg.startsWith("<") ? seg : seg.replace(re, '<mark class="search-hit">$&</mark>')))
          .join("");
      }
      return html;
    })
    .join("<br>");
}

// 复制纯文本用：剥掉内联标记，图片占位符保留 key 可读形式
export function stripMarks(text) {
  return (text || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/==([^=]+)==/g, "$1");
}

// 反馈标题固定格式「学生名 + 单元进度 + 反馈类型」（如 Alice U7L1 练习反馈 / Linlin U7Day3&U8A Preview 伴学手册反馈），
// 据此从历史归档内容/标题抽学生名；不匹配标题格式返回空串（首行是问候语等正文时不硬抽）
export function studentNameFromTitle(text) {
  const firstLine = (text || "").split("\n").map((s) => s.trim()).find(Boolean) || "";
  const m = stripMarks(firstLine).match(/^(\S+)\s+U\d+(?:L|Day)\d+/);
  return m ? m[1] : "";
}

// 标题末尾的反馈类型反推班级系列（与后端 feedback.py SERIES_FEEDBACK_TYPE 一致）：
// 伴学手册反馈 → NG（厚中）、练习反馈 → WW（厚少）；识别不了返回空串（调用方应搜全部班级）
const SERIES_BY_FEEDBACK = { 伴学手册反馈: "NG", 练习反馈: "WW" };
export function seriesFromTitle(text) {
  const firstLine = (text || "").split("\n").map((s) => s.trim()).find(Boolean) || "";
  const clean = stripMarks(firstLine);
  for (const [keyword, series] of Object.entries(SERIES_BY_FEEDBACK)) {
    if (clean.includes(keyword)) return series;
  }
  return "";
}

// 编辑器 DOM → 存储格式：b/strong→**、i/em→*、mark→==，图片（含「图片未加载」占位）→占位符
export function inlineText(node) {
  let out = "";
  for (const n of node.childNodes ?? []) {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
    else if (n.nodeName === "IMG") out += n.dataset?.key ? `[[img:${n.dataset.key}]]` : "";
    else if (n.nodeName === "SPAN" && n.dataset?.key) out += `[[img:${n.dataset.key}]]`;
    else if (n.nodeName === "BR") out += "";
    else if (n.nodeName === "B" || n.nodeName === "STRONG") out += `**${inlineText(n)}**`;
    else if (n.nodeName === "I" || n.nodeName === "EM") out += `*${inlineText(n)}*`;
    else if (n.nodeName === "MARK") out += `==${inlineText(n)}==`;
    else out += inlineText(n);
  }
  return out;
}

// 纯空白行（含 &nbsp;）视为空行；笔记正文不留空行（紧凑排版），
// 连续换行全部坍缩——同时自愈 V0.7.1 前已存入的 \n\n 存量
const collapseLines = (text) =>
  text
    .split("\n")
    .map((l) => (/^[\s\u00A0]*$/.test(l) ? "" : l))
    .join("\n")
    .replace(/\n{2,}/g, "\n");

export function serializeEditor(root) {
  const lines = [];
  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) lines.push(child.textContent);
    // 顶层图片/占位也要收：insertHTML 拆块后内容可能落在顶层裸节点（不在 div 内），漏收即丢图
    else if (child.nodeName === "IMG") lines.push(child.dataset?.key ? `[[img:${child.dataset.key}]]` : "");
    else if (child.nodeName === "SPAN" && child.dataset?.key) lines.push(`[[img:${child.dataset.key}]]`);
    else lines.push(inlineText(child));
  }
  return collapseLines(lines.join("\n")).trim();
}

// 清洗式粘贴：只保留 b/strong/i/em/mark 四种格式，其余标签剥掉；
// 图片不在这里处理（走迁移通道），块级标签转换行
export function sanitizePastedHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const BLOCKS = new Set(["DIV", "P", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6"]);
  const walk = (node) => {
    let out = "";
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) out += escapeHtml(n.textContent);
      else if (n.nodeName === "B" || n.nodeName === "STRONG") out += `<b>${walk(n)}</b>`;
      else if (n.nodeName === "I" || n.nodeName === "EM") out += `<i>${walk(n)}</i>`;
      else if (n.nodeName === "MARK") out += `<mark>${walk(n)}</mark>`;
      else if (n.nodeName === "IMG") continue; // 图片走迁移通道
      else if (n.nodeName === "BR") out += "\n";
      else if (BLOCKS.has(n.nodeName)) out += `${walk(n)}\n`;
      else out += walk(n); // 其余标签剥壳留内容
    }
    return out;
  };
  return collapseLines(walk(doc.body)).replace(/^\n+|\n+$/g, "");
}
