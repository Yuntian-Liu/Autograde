function cleanCell(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

export function buildTrackingTsv(tracking) {
  if (!tracking) return "";
  const headers = ["No.", "Name", ...tracking.items.map((item) => item.name)];
  const rows = tracking.students.map((student, index) => [
    index + 1,
    student.name,
    ...tracking.items.map((item) =>
      student.cells?.[String(item.id)]?.submitted ? "✓" : "待提交"
    ),
  ]);
  return [headers, ...rows]
    .map((row) => row.map(cleanCell).join("\t"))
    .join("\r\n");
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("复制失败，请检查浏览器剪贴板权限");
  }
}
