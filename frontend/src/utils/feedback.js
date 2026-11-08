// 反馈装配单一数据源：同一份结构化 doc 产出 预览数据 / 纯文本 / HTML 三形态，
// 三条路径物理上不可能不一致（货不对板的根因修复）。
//
// 加粗规格：作业标题加粗、板块标题加粗、答案加粗（题号不加粗）；
// 解析、Issue、评级话术不加粗。HTML 只带 <b> 不带色（家长端克制，accent 仅预览）。
//
// 纯文本节奏（正式板块紧凑排列；预习话术与参考解析之间仅普通换行）：
//   {标题}
//   {评级话术}（可选）
//   {板块} 部分
//   {seq}. {答案}
//   {解析}
//   {Issue 话术}（可多行）

// 构造结构化 doc（sections 为批次题库，checkedSet/notes 为当前学生表单态或落库态）
// issueTexts 为 [{text, format}]：format 来自话术库（title_bold 首行加粗 / body_italic 其余行倾斜）
export function buildFeedbackDoc({ title, ratingPhrase, sections, checkedSet, notes, issueTexts, preview }) {
  const blocks = [];
  for (const sec of sections || []) {
    const picked = sec.questions.filter((q) => checkedSet.has(q.id));
    if (picked.length === 0) continue;
    blocks.push({
      section: sec.section,
      items: picked.map((q) => {
        const note = (notes || {})[q.id];
        if (q.mode === "verbatim" && (note || q.explanation)) {
          // verbatim：题号+答案一行；有该生个别修订时用修订，否则照抄题库原解析
          return {
            id: q.id,
            kind: "answer",
            seq: q.seq,
            answer: q.standard_answer,
            explanation: note || q.explanation,
          };
        }
        if (q.mode === "verbatim") {
          return { id: q.id, kind: "text", text: null, blank: `${sec.section} · 第 ${q.seq} 题 · 待填充` };
        }
        return {
          id: q.id,
          kind: "text",
          text: note ? `${q.seq}. ${note}` : null,
          blank: `${sec.section} · 第 ${q.seq} 题 · 待填充`,
        };
      }),
    });
  }
  return { title, ratingPhrase: ratingPhrase || "", blocks, issues: issueTexts || [], preview: preview || null };
}

// Issue 话术按话术 format 渲染：首行/其余行分别包标记（预览 JSX 与 HTML 复制一致生效）
export function issueLinesOf(item) {
  const lines = item.text.split("\n");
  const tb = (item.format || "").includes("title_bold");
  const bi = (item.format || "").includes("body_italic");
  return lines.map((text, i) => ({
    text,
    bold: tb && i === 0,
    italic: bi && i > 0,
  }));
}

export function docToText(doc) {
  const lines = [doc.title];
  if (doc.ratingPhrase) lines.push(doc.ratingPhrase);
  for (const block of doc.blocks) {
    lines.push(sectionTitle(block.section));
    for (const item of block.items) {
      if (item.kind === "answer") {
        lines.push(item.answer ? `${item.seq}. ${item.answer}` : `${item.seq}.`);
        lines.push(item.explanation);
      } else {
        lines.push(item.text ?? item.blank);
      }
    }
  }
  for (const text of doc.issues) lines.push(text.text);
  if (doc.preview) {
    lines.push(doc.preview.text, "以下是参考解析，小朋友可以对照参考哦：");
    for (const item of doc.preview.items) {
      lines.push(`${item.seq}. ${item.answer}`);
      if (item.explanation) lines.push(item.explanation);
    }
  }
  return lines.join("\n").trim();
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 板块标题展示：素材板块名已含「部分」时不重复追加
export function sectionTitle(section) {
  return section.endsWith("部分") ? section : `${section} 部分`;
}

// 微信笔记粘贴只带 <b>/<i> 与 <br>；预习引导前仅普通换行。
export function docToHtml(doc) {
  const lines = [`<b>${esc(doc.title)}</b>`];
  if (doc.ratingPhrase) lines.push(esc(doc.ratingPhrase));
  for (const block of doc.blocks) {
    lines.push(`<b>${esc(sectionTitle(block.section))}</b>`);
    for (const item of block.items) {
      if (item.kind === "answer") {
        lines.push(item.answer ? `${item.seq}. <b>${esc(item.answer)}</b>` : `${item.seq}.`);
        lines.push(...item.explanation.split("\n").map(esc));
      } else {
        lines.push(esc(item.text ?? item.blank));
      }
    }
  }
  for (const it of doc.issues) {
    for (const l of issueLinesOf(it)) {
      let h = esc(l.text);
      if (l.bold) h = `<b>${h}</b>`;
      else if (l.italic) h = `<i>${h}</i>`;
      lines.push(h);
    }
  }
  if (doc.preview) {
    for (const l of issueLinesOf(doc.preview)) {
      let h = esc(l.text);
      if (l.bold) h = `<b>${h}</b>`;
      else if (l.italic) h = `<i>${h}</i>`;
      lines.push(h);
    }
    lines.push("以下是参考解析，小朋友可以对照参考哦：");
    for (const item of doc.preview.items) {
      lines.push(`${item.seq}. <b>${esc(item.answer)}</b>`);
      if (item.explanation) lines.push(...item.explanation.split("\n").map(esc));
    }
  }
  return lines.join("<br>");
}

// 快照匹配覆盖正式板块与预习反馈，任一当前内容缺失则回退存档原文。
export function snapshotMatchesDoc(snapshot, doc) {
  if (!snapshot) return false;
  const hay = "\n" + snapshot.trim();
  for (const block of doc.blocks) {
    if (!hay.includes(`\n【${block.section} 部分】`) && !hay.includes(`\n${block.section} 部分`)) {
      return false;
    }
    for (const item of block.items) {
      const marker =
        item.kind === "answer"
          ? item.answer
            ? `${item.seq}. ${item.answer}`
            : `${item.seq}.`
          : item.text ?? item.blank;
      if (!hay.includes(`\n${marker}`)) return false;
    }
  }
  if (doc.preview) {
    if (!hay.includes("\n以下是参考解析，小朋友可以对照参考哦：")) return false;
    for (const item of doc.preview.items) {
      if (!hay.includes(`\n${item.seq}. ${item.answer}`)) return false;
    }
  }
  return true;
}

// 快照展示最多保留一个空行，与当前预习反馈节奏一致。
export function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, "\n\n");
}
