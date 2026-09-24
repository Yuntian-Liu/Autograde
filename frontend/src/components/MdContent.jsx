import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

// AI 助教气泡的 Markdown 渲染（管线照 Stellaris：react-markdown + gfm + math + katex）。
// 不开 rehype-raw——原文 HTML 一律按文本转义，XSS 天然安全。
// 样式全走 styles.css 的 .md-* 类（tokens 变量），不内联。

// LLM 常输出 LaTeX 标准分隔符 \(...\) \[...\]，归一成 $...$ / $$...$$（照 Stellaris normalizeLatex）
export function normalizeLatex(text) {
  if (!text) return text;
  return text
    .replace(/\\\[/g, "$$")
    .replace(/\\\]/g, "$$")
    .replace(/\\\(/g, "$")
    .replace(/\\\)/g, "$");
}

// th/td 注意（Stellaris 踩坑）：GFM 对齐标记 :-- 会让 react-markdown 传自己的 style，
// 直接 {...props} 展开会被覆盖——解构出 style 再合并回去
const MD_COMPONENTS = {
  table: ({ node, ...props }) => (
    <div className="md-table-wrap">
      <table className="md-table" {...props} />
    </div>
  ),
  th: ({ node, style, ...props }) => <th className="md-th" style={style} {...props} />,
  td: ({ node, style, ...props }) => <td className="md-td" style={style} {...props} />,
  code: ({ node, className, ...props }) =>
    className ? <code className={`md-pre-code ${className}`} {...props} /> : <code className="md-code" {...props} />,
  pre: ({ node, ...props }) => <pre className="md-pre" {...props} />,
  a: ({ node, ...props }) => <a className="md-a" target="_blank" rel="noreferrer" {...props} />,
  blockquote: ({ node, ...props }) => <blockquote className="md-quote" {...props} />,
  ul: ({ node, ...props }) => <ul className="md-list" {...props} />,
  ol: ({ node, ...props }) => <ol className="md-list md-list-ol" {...props} />,
  h1: ({ node, ...props }) => <h4 className="md-h" {...props} />,
  h2: ({ node, ...props }) => <h4 className="md-h" {...props} />,
  h3: ({ node, ...props }) => <h4 className="md-h" {...props} />,
  h4: ({ node, ...props }) => <h4 className="md-h" {...props} />,
  p: ({ node, ...props }) => <p className="md-p" {...props} />,
};

export default function MdContent({ text }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        components={MD_COMPONENTS}
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[rehypeKatex]}
      >
        {normalizeLatex(text)}
      </ReactMarkdown>
    </div>
  );
}
