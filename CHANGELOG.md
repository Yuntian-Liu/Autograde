# CHANGELOG

## 0.0.1 — 2026-09-06

**工程骨架落地：FastAPI + SQLite 后端九表建模，React + AntD 前端四级页面贯通，演示数据开箱即用。**

- 后端：9 张表全量建模（classes / students / assignments / questions / error_records / submissions / feedback_snapshots / phrases / settings），`_ensure_columns` 启动自愈
- 后端：访问口令中间件（ACCESS_TOKEN）、CORS 放行 Vite 5173、只读接口覆盖四级页面
- 演示数据：厚少 WW5A（8 名学生）+ 厚中 NG3B（6 名学生），U7Day1 批次 4 个 Task 共 20 题（verbatim / ai_expand / manual 三种 mode），提交四态示例齐全
- 前端：tokens.css 1:1 落地并映射 AntD ConfigProvider 主题（colorPrimary #0d9aa7、圆角 6、三字体栈）
- 前端：工作台 / 班级 / 批次 / 批改四个路由页，批改页三栏布局复刻概念稿，勾选芯片按 score_weight 实时算分（两位小数），十档等级自动预选 + 手动覆盖
- 勾选状态仅存前端内存，不落库；不接任何 AI 调用
