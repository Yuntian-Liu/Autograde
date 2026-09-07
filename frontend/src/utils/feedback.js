// 反馈装配单一数据源：同一份结构化 doc 产出 预览数据 / 纯文本 / HTML 三形态，
// 三条路径物理上不可能不一致（货不对板的根因修复）。
//
// 加粗规格（碳碳定）：作业标题加粗、板块标题加粗、答案加粗（题号不加粗）；
// 解析、Issue、评级话术不加粗。HTML 只带 <b> 不带色（家长端克制，accent 仅预览）。
//
// 纯文本节奏（碳碳定：全程无空行，板块靠加粗标题区分，紧凑一体）：
//   {标题}
//   {评级话术}（可选）
//   {板块} 部分
//   {seq}. {答案}
//   {解析}
//   {Issue 话术}（可多行）

// 构造结构化 doc（sections 为批次题库，checkedSet/notes 为当前学生表单态或落库态）
export function buildFeedbackDoc({ title, ratingPhrase, sections, checkedSet, notes, issueTexts }) {
  const blocks = [];
  for (const sec of sections || []) {
    const picked = sec.questions.filter((q) => checkedSet.has(q.id));
    if (picked.length === 0) continue;
    blocks.push({
      section: sec.section,
      items: picked.map((q) => {
        if (q.mode === "verbatim" && q.explanation) {
          // verbatim：题号+答案一行，解析原文另起行照抄（不加任何标签骨架）
          return { id: q.id, kind: "answer", seq: q.seq, answer: q.standard_answer, explanation: q.explanation };
        }
        if (q.mode === "verbatim") {
          return { id: q.id, kind: "text", text: null, blank: `${sec.section} · 第 ${q.seq} 题 · 待填充` };
        }
        const note = (notes || {})[q.id];
        return {
          id: q.id,
          kind: "text",
          text: note ? `${q.seq}. ${note}` : null,
          blank: `${sec.section} · 第 ${q.seq} 题 · 待填充`,
        };
      }),
    });
  }
  return { title, ratingPhrase: ratingPhrase || "", blocks, issues: issueTexts || [] };
}

export function docToText(doc) {
  const lines = [doc.title];
  if (doc.ratingPhrase) lines.push(doc.ratingPhrase);
  for (const block of doc.blocks) {
    lines.push(sectionTitle(block.section)); // 板块标题无【】、已含「部分」不重复追加，与预览一致
    for (const item of block.items) {
      if (item.kind === "answer") {
        // 答案为空只留题号行；解析原样（内部「解析：」「词义」等结构是素材自己的）
        lines.push(item.answer ? `${item.seq}. ${item.answer}` : `${item.seq}.`);
        lines.push(item.explanation);
      } else {
        lines.push(item.text ?? item.blank);
      }
    }
  }
  for (const text of doc.issues) lines.push(text);
  return lines.join("\n").trim();
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 板块标题展示：素材板块名已含「部分」时不重复追加
export function sectionTitle(section) {
  return section.endsWith("部分") ? section : `${section} 部分`;
}

// HTML 形态（微信笔记粘贴的实证配方）：<b> 加粗（V1 实测在微信存活）+ 单层 <br> 分行、
// 无任何包裹 div（pre-wrap 会触发微信重排/吞换行）。不塞空行。
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
  for (const text of doc.issues) lines.push(...text.split("\n").map(esc));
  return lines.join("<br>");
}

// 快照判定：快照与当前数据是否同一份（= 正常保存可结构化重渲染；否则是补录/历史快照）
// 逐行比对太脆（评级话术随机、问候语已剥离），改为：每个板块标题与每题的内容标记
// 都以「行首锚定」逐字出现在快照里即视为一致。比较前两侧 trim，避免空白差异误判。
export function snapshotMatchesDoc(snapshot, doc) {
  if (!snapshot) return false;
  const hay = "\n" + snapshot.trim(); // 行首锚定，防「3.」误中「13.」
  for (const block of doc.blocks) {
    // 兼容新旧两种板块标题写法（【x 部分】为 V0.4.0 前存量）
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
  return true;
}

// 快照回退纯文本展示：连续空行全部去掉（存档原文不动，仅显示层）
export function collapseBlankLines(text) {
  return text.replace(/\n{2,}/g, "\n");
}
