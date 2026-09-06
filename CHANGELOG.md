# CHANGELOG

## 0.1.0 — 2026-09-06

**从只读演示走向可真实批改：反馈标题按两班规则自动拼装，批次/题库/学生写接口全开，批改落库，AI 录题代码就绪。**

- 反馈标题规则结构化落地：厚少（WW）`{学生} U{n}L{m} 练习反馈`，厚中（NG）`{学生} U{n}Day{m} 伴学手册反馈`，含预习追加 `&U{n}{A|B} Preview`；批次单元进度改为结构化字段，单元号按册范围自动校验
- 后端写接口：学生 CRUD、批次 CRUD（课型按班级系列预填）、题库批量冻结与单题增改、批改落库（分数/等级后端复算，错题记录与反馈快照事务写入）
- AI 接入（OpenAI 兼容，默认 DeepSeek deepseek-v4-pro）：`POST /api/ai/parse-questions` 粘贴文本拆分题库草稿（含水印剔除、赋分预填，不落库）、`POST /api/ai/draft-explanation` 错点描述起草讲解；key 未配置时优雅降级 503
- 前端：批次创建/编辑 modal（预习开关仅 Day 课型显示）、手工录题与 AI 录题双入口（共用可编辑验收表格）、批改页统一编辑窗按题目模式分态、「保存批改」落库后状态灯/分数由后端驱动
- 站标「Autograde」字号放大（--t-display 22px，衬线不变）
- 工程化：GitHub 公开仓库开通；DEVELOPMENT.md / AGENTS.md 转为本地文档不进公开仓库（对齐 Stellaris 惯例）

## 0.0.1 — 2026-09-06

**工程骨架落地：FastAPI + SQLite 后端九表建模，React + AntD 前端四级页面贯通，演示数据开箱即用。**

- 后端：9 张表全量建模（classes / students / assignments / questions / error_records / submissions / feedback_snapshots / phrases / settings），`_ensure_columns` 启动自愈
- 后端：访问口令中间件（ACCESS_TOKEN）、CORS 放行 Vite 5173、只读接口覆盖四级页面
- 演示数据：厚少 WW5A（8 名学生）+ 厚中 NG3B（6 名学生），U7Day1 批次 4 个 Task 共 20 题（verbatim / ai_expand / manual 三种 mode），提交四态示例齐全
- 前端：tokens.css 1:1 落地并映射 AntD ConfigProvider 主题（colorPrimary #0d9aa7、圆角 6、三字体栈）
- 前端：工作台 / 班级 / 批次 / 批改四个路由页，批改页三栏布局复刻概念稿，勾选芯片按 score_weight 实时算分（两位小数），十档等级自动预选 + 手动覆盖
- 勾选状态仅存前端内存，不落库；不接任何 AI 调用
