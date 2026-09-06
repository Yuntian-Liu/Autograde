# AGENTS.md — Autograde

## 这个项目是什么

Autograde：英语助教（用户：**碳碳**）的个人批改工作台，Gradify 的重写升级版。
班级 → 作业批次 → 题库 → 学生错题勾选 → 自动拼装反馈文本。React + FastAPI + SQLite。

## 开工前必读（按顺序）

1. **`DEVELOPMENT.md`** — 单一事实来源：产品决策、数据模型、里程碑、开发日志。任何疑问以它为准
2. **`design/tokens.css`** — 设计令牌，含末尾硬性规则（无渐变/无玻璃拟态/无 emoji 图标/不写解释性灰色提示句）
3. `design/dashboard.html`、`design/grading.html` — 已验收的概念稿，页面照它做

## 硬性约定

- **UI 只能消费 `tokens.css` 变量**，禁止硬编码色值/字号/阴影
- 版本号纯 SemVer（本项目**不用**天文代号）；commit 格式：`Autograde V{x.y.z} 更新日志`，正文 = 加粗短引导句 + 小圆点，无 emoji
- 发版时同步更新 `CHANGELOG.md` 与 `DEVELOPMENT.md` 开发日志
- 称呼用户「碳碳」；公开文件（README/commit）不出现任何私人信息
- 工程改动交付前自检：改了什么 → 影响什么 → 怎么验证
