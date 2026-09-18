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
export function renderNoteInline(text) {
  return (text || "")
    .split("\n")
    .map((l) => renderNoteLine(l.replace(/\[\[img:[^\]]+\]\]/g, "[图片]"), {}))
    .join("<br>");
}

// 复制纯文本用：剥掉内联标记，图片占位符保留 key 可读形式
export function stripMarks(text) {
  return (text || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/==([^=]+)==/g, "$1");
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
