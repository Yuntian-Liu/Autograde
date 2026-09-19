// 内容指纹（djb2 → 8 位 hex）：诊断时对比「内容变了没」不用带原文
export function fp(s) {
  const str = String(s ?? "");
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(-8);
}
