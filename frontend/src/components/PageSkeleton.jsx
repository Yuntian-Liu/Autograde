import AppHeader from "./AppHeader";

// 数据未就绪时的骨架屏：标题 + 列表块占位，消灭白屏闪（灰色块全用 tokens 变量）
export default function PageSkeleton() {
  return (
    <>
      <AppHeader />
      <div className="wrap">
        <div className="skel skel-title" style={{ marginTop: "var(--s3)" }} />
        <div className="skel skel-line" style={{ marginTop: "var(--s2)" }} />
        <div className="skel skel-block" style={{ marginTop: "var(--s6)" }} />
        <div className="skel skel-block" style={{ marginTop: "var(--s3)" }} />
        <div className="skel skel-block" style={{ marginTop: "var(--s3)" }} />
      </div>
    </>
  );
}
