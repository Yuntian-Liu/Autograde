# Autograde

A personal grading workbench for English teaching assistants — classes → assignment batches → question banks → one-click error picking → assembled parent-ready feedback.

英语作业批改工作台：客观题零 AI 自动拼装，批改过程自动沉淀数据资产。

![version](https://img.shields.io/badge/version-0.28.0-0d9aa7)
![license](https://img.shields.io/badge/license-Apache--2.0%20%2B%20Commons%20Clause-c05a45)
![python](https://img.shields.io/badge/python-3.13%2B-3d9a72)
![react](https://img.shields.io/badge/react-18-0d9aa7)
![fastapi](https://img.shields.io/badge/fastapi-0.115%2B-3d9a72)

## Features

- **Class-centric workflow** — classes → assignment batches → question banks → per-student grading, all data in one place
- **Standard & quick grading** — sectioned error picking, partial credit, preview answers, answer floating window, batch quick-entry matrix, and guarded student switching
- **Submission tracking** — per-batch custom submission items, two-state class matrix, automatic main-assignment checks, manual completion confirmation, and TSV copy for spreadsheets
- **Mid-term transfers** — mark completed pre-transfer batches as absent during roster import, or preview and resolve them later from each student's history action without touching current grading
- **Sectioned question entry** — AI review and batch editing provide section navigation, highlighted sticky headers, live question/score summaries, and row-level validation with precise error focusing
- **Zero-AI deterministic assembly** — feedback text is assembled from frozen database entries: titles follow per-series naming rules, scores and 12-tier ratings are computed server-side
- **Score & GPA views** — switch between exact percentages and a 4.33-scale observational GPA without changing grading data or parent feedback
- **AI as one-shot assistant** — paste raw answer text, AI splits it into a structured draft with task-based real stages and progress; humans review and freeze. AI never touches frozen content
- **Reports & workspaces** — class/student statistics, batch analysis, weekly assistant reports, image notes, and isolated temporary grading batches
- **Three question modes** — `verbatim` (frozen explanation rendered as-is), `ai_expand` (teacher describes the error point → AI drafts → human finalizes), `manual`
- **Accounts & security** — email code / password / UID login, invite-code registration, admin dashboard (AI usage with peak/off-peak pricing, phrases, invite codes, security events, backup), rate limiting, sanitized diagnostics export

## Tech Stack

- **Frontend**: React 18 + Vite + Ant Design 5 (design tokens → theme), Recharts, DiceBear (local avatars)
- **Backend**: FastAPI + SQLAlchemy 2.0 + SQLite (aiosqlite), self-healing schema on startup (`_ensure_columns`)
- **AI**: OpenAI-compatible protocol (DeepSeek by default; gateway & model via env vars)
- **Mail**: Resend HTTP API (verification codes)

## Quick Start

### Backend (port 8000)

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in JWT_SECRET / RESEND_* / OPENAI_* as needed
python seed.py         # demo data (optional; --fresh to rebuild)
uvicorn main:app --port 8000
```

Verify: `curl localhost:8000/api/health`

### Frontend (port 5173)

```bash
cd frontend
npm install
npm run dev
```

The dev server proxies `/api` to `localhost:8000`. Open http://localhost:5173 — the first registered account becomes admin (no invite code needed when the system has zero users).

## Deploy (self-hosted)

Single-service deployment: FastAPI serves the built frontend (`frontend/dist`) with SPA fallback. Coolify or any Docker-compatible host can run the service.

1. Build the frontend: `cd frontend && npm run build`
2. Set env vars: `JWT_SECRET` (strong random), `IS_PROD=true`, `RESEND_API_KEY`, `RESEND_FROM`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AI_MODEL`; configure COS variables only if image notes are needed
3. Mount a persistent volume at `/app/data` and point `DATABASE_PATH` there so SQLite survives redeploys
4. If using Coolify, connect the repository's `main` branch to the deployment webhook and verify that each new container becomes healthy
5. Before deployment, create an online SQLite backup and run `PRAGMA integrity_check`; after deployment verify `/api/health`, key pages, and database integrity
6. Register the first account with the operator's own email right after going live — it becomes admin and adopts existing data
7. Download a full backup (Admin → 数据) as soon as real data lands

## Acknowledgments

React · Vite · Ant Design · React Router · Recharts · DiceBear (avatars, MIT) · FastAPI · SQLAlchemy · Pydantic · PyJWT · bcrypt — 感谢这些优秀的开源项目。

## License

Apache License 2.0 + Commons Clause (source-available, non-commercial).

You may view, modify, self-host and redistribute the source code; you may not **sell** the software itself (including paid hosting of substantially this software). See [LICENSE](LICENSE) for the full text.
