"""演示数据：厚少 WW5A + 厚中 NG3B 两个班，覆盖提交四态与三种题目模式。

用法：
    python seed.py          # 已有数据则跳过
    python seed.py --fresh  # 删除数据库后重建
"""

import asyncio
import json
import sys
from datetime import date, timedelta
from pathlib import Path

from sqlalchemy import func, select

from database import DATABASE_PATH, SessionLocal, init_db
from feedback import sync_unit_label
from auth.models import User
from auth.utils import hash_password
from models import (
    Assignment,
    Class,
    ErrorRecord,
    FeedbackSnapshot,
    Question,
    Setting,
    Student,
    Submission,
)
from rating import DEFAULT_THRESHOLDS, SETTINGS_KEY, rating_for


# 班级 schedule 里的星期 → date.weekday()
WEEKDAY = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}


def next_class_time(schedule: str, weeks_ahead: int = 0) -> str:
    """由「周六 14:00」推算下一次上课时间（本地日期，YYYY-MM-DD HH:MM）。"""
    day_text, _, time_text = schedule.partition(" ")
    target = WEEKDAY[day_text.replace("周", "").replace("星期", "")]
    today = date.today()
    days = (target - today.weekday()) % 7
    if days == 0 and weeks_ahead == 0:
        days = 7
    d = today + timedelta(days=days + 7 * weeks_ahead)
    return f"{d.isoformat()} {time_text}"


def sub(student: Student, assignment: Assignment, status: str, score: float | None) -> Submission:
    return Submission(
        student_id=student.id,
        assignment_id=assignment.id,
        status=status,
        score=score,
        rating=rating_for(score) if score is not None else "",
    )


async def seed() -> None:
    await init_db()
    async with SessionLocal() as db:
        exists = (await db.execute(select(func.count(Class.id)))).scalar_one()
        if exists:
            print("数据库已有数据，跳过 seed（如需重建：python seed.py --fresh）")
            return

        # ---------- 演示账号（dev@autograde.local，多租户下演示数据归属它） ----------
        # 本地开发：IS_PROD=false 时给它发验证码会打印在日志里，用验证码登录即可
        demo_user = User(
            uid=100000,
            email="dev@autograde.local",
            nickname="演示教师",
            avatar_seed="autograde-demo",
            password_hash=hash_password("Dev1234!"),
            is_admin=True,
        )
        db.add(demo_user)
        await db.flush()

        # ---------- 班级与学生 ----------
        ww5a = Class(
            name="WW5A", series="WW", level=5, term="A", schedule="周六 14:00", owner_uid=100000
        )
        ng3b = Class(
            name="NG3B", series="NG", level=3, term="B", schedule="周四 18:30", owner_uid=100000
        )
        db.add_all([ww5a, ng3b])
        await db.flush()

        ww_names = ["Amy", "Ben", "Cindy", "Lisa", "Leo", "Max", "Nina", "Oscar"]
        ng_names = ["David", "Emma", "Frank", "Grace", "Henry", "Ivy"]
        ww = {n: Student(name=n, class_id=ww5a.id) for n in ww_names}
        ng = {n: Student(name=n, class_id=ng3b.id) for n in ng_names}
        ww["Lisa"].note = "家长希望反馈里多鼓励"
        db.add_all([*ww.values(), *ng.values()])
        await db.flush()

        # ---------- WW5A 上一批：U6L2（已完成，供「上批平均分 / 近 5 次平均」） ----------
        # 厚少用 L 课型、无预习；unit_label 由结构化字段自动生成
        u6 = Assignment(
            class_id=ww5a.id,
            unit_no=6,
            lesson_type="L",
            unit_lesson_no=2,
            lesson_no=6,
            class_time=next_class_time(ww5a.schedule, weeks_ahead=-1),
            content="练习",
            status="已完成",
        )
        sync_unit_label(u6)
        db.add(u6)
        await db.flush()

        def add_questions(assignment: Assignment, section: str, items: list[dict]) -> list[Question]:
            qs = []
            for i, item in enumerate(items, start=1):
                qs.append(
                    Question(
                        assignment_id=assignment.id,
                        seq=i,
                        mode=item.get("mode", "verbatim"),
                        section=section,
                        stem=item.get("stem", ""),
                        options=json.dumps(item.get("options", []), ensure_ascii=False),
                        standard_answer=item["answer"],
                        explanation=item.get("explanation", ""),
                        score_weight=item.get("weight", 5.0),
                    )
                )
            db.add_all(qs)
            return qs

        u6_t1 = add_questions(
            u6,
            "Task 1 · Vocabulary",
            [
                {"stem": "写出 child 的复数形式", "answer": "children", "explanation": "child 的复数是不规则变化 children~"},
                {"stem": "写出 sheep 的复数形式", "answer": "sheep", "explanation": "sheep 单复数同形~"},
                {"stem": "用 a / an 填空：___ hour", "answer": "an", "explanation": "hour 中 h 不发音，以元音音素开头，用 an~"},
            ],
        )
        u6_t2 = add_questions(
            u6,
            "Task 2 · Grammar",
            [
                {"stem": "They ___ (be) happy yesterday.", "answer": "were", "explanation": "yesterday 提示一般过去时，they 搭配 were~"},
                {"stem": "___ she go to school by bike?", "answer": "Does", "explanation": "三单疑问句借助 Does~"},
                {"stem": "We ___ (play) basketball now.", "answer": "are playing", "explanation": "now 提示现在进行时，be + doing~"},
            ],
        )
        await db.flush()

        u6_scores = {"Amy": 95, "Ben": 92, "Cindy": 88, "Lisa": 90, "Leo": 93, "Max": 86, "Nina": 91, "Oscar": 89}
        for name, score in u6_scores.items():
            db.add(sub(ww[name], u6, "已批改", float(score)))
        db.add_all(
            [
                ErrorRecord(student_id=ww["Lisa"].id, question_id=u6_t1[2].id),
                ErrorRecord(student_id=ww["Lisa"].id, question_id=u6_t2[1].id),
                ErrorRecord(student_id=ww["Cindy"].id, question_id=u6_t2[0].id),
                ErrorRecord(student_id=ww["Oscar"].id, question_id=u6_t1[0].id),
            ]
        )

        # ---------- WW5A 当前批：U7L1 练习（第 7 次课，4 个 Task 共 20 题） ----------
        u7 = Assignment(
            class_id=ww5a.id,
            unit_no=7,
            lesson_type="L",
            unit_lesson_no=1,
            lesson_no=7,
            class_time=next_class_time(ww5a.schedule),
            content="练习",
            status="批改中",
        )
        sync_unit_label(u7)
        db.add(u7)
        await db.flush()

        t1 = add_questions(
            u7,
            "Task 1 · Vocabulary",
            [
                {"stem": "写出 strawberry 的复数形式", "answer": "strawberries", "explanation": "本题考查名词复数，strawberry 的复数是 strawberries，辅音字母+y 结尾要变 y 为 i 再加 es~"},
                {"stem": "写出 tomato 的复数形式", "answer": "tomatoes", "explanation": "以 o 结尾的有生命名词加 es，如 tomatoes、potatoes~"},
                {"stem": "写出 library 的复数形式", "answer": "libraries", "explanation": "辅音字母+y 结尾，变 y 为 i 再加 es~"},
                {"stem": "用 a / an 填空：___ umbrella", "answer": "an", "explanation": "umbrella 以元音音素开头，用 an~"},
                {"stem": "There ___ some milk in the glass.", "answer": "A", "options": ["A. is", "B. are", "C. be", "D. am"], "explanation": "milk 是不可数名词，be 动词用 is~"},
                {"stem": "写出 photo 的复数形式", "answer": "photos", "explanation": "photo 是无生命名词，以 o 结尾直接加 s~"},
            ],
        )
        t2 = add_questions(
            u7,
            "Task 2 · Grammar",
            [
                {"stem": "She ___ (go) to school by bus every day.", "answer": "goes", "explanation": "一般现在时，主语 she 是第三人称单数，动词加 es~"},
                {"stem": "I ___ (not like) onions.", "answer": "don't like", "explanation": "第一人称否定借助助动词 don't~"},
                {"stem": "My father ___ (watch) TV every night.", "answer": "watches", "explanation": "三单，watch 以 ch 结尾要加 es~"},
                {"stem": "___ they play football on Sundays?", "answer": "A", "options": ["A. Do", "B. Does", "C. Are", "D. Is"], "explanation": "主语 they 是复数，疑问句用 Do 开头~"},
                {"stem": "He ___ (have) breakfast at seven.", "answer": "has", "explanation": "have 的三单形式是 has，特殊变化要记牢~"},
            ],
        )
        t3 = add_questions(
            u7,
            "Task 3 · 造句",
            [
                {"stem": "用 go to the park 造句", "answer": "I go to the park on Sundays.", "mode": "ai_expand"},
                {"stem": "用 like doing 造句", "answer": "I like reading books in the library.", "mode": "ai_expand"},
                {"stem": "用 there be 句型描述教室", "answer": "There are forty desks in our classroom.", "mode": "ai_expand"},
                {"stem": "用频度副词 always 造句", "answer": "She always helps her classmates.", "mode": "ai_expand"},
                {"stem": "用 because 造句", "answer": "I stayed at home because it rained heavily.", "mode": "ai_expand"},
            ],
        )
        t4 = add_questions(
            u7,
            "Task 4 · Reading",
            [
                {"stem": "Why didn't Tom visit the museum?", "answer": "Because it was closed.", "explanation": "细节定位题，答案在第二段第三行，注意题干问的是 why 而不是 what~"},
                {"stem": "What does \"enormous\" mean in Paragraph 3?", "answer": "Very large.", "explanation": "词义猜测题，联系上下文，enormous 与前面的 big 呼应~"},
                {"stem": "What's the best title of the passage?", "answer": "A Trip to the City", "explanation": "主旨大意题，首尾段都在讲城市之旅，排除只讲细节的选项~"},
                {"stem": "按图片完成连线（答案见答题卡）", "answer": "见答题卡图片", "mode": "manual", "weight": 6.0},
            ],
        )
        await db.flush()

        # 提交四态示例：已批改 / 缺作业 / 未交 / 待批改
        db.add_all(
            [
                sub(ww["Amy"], u7, "已批改", 100.00),
                sub(ww["Ben"], u7, "已批改", 94.50),
                sub(ww["Nina"], u7, "缺作业", 85.50),
                sub(ww["Max"], u7, "未交", None),
                sub(ww["Cindy"], u7, "待批改", None),
                sub(ww["Lisa"], u7, "待批改", None),
                sub(ww["Leo"], u7, "待批改", None),
                sub(ww["Oscar"], u7, "待批改", None),
            ]
        )
        db.add_all(
            [
                ErrorRecord(student_id=ww["Ben"].id, question_id=t1[2].id),
                ErrorRecord(student_id=ww["Ben"].id, question_id=t2[1].id),
                ErrorRecord(student_id=ww["Nina"].id, question_id=t1[3].id),
                ErrorRecord(student_id=ww["Nina"].id, question_id=t2[0].id),
                ErrorRecord(
                    student_id=ww["Nina"].id,
                    question_id=t3[1].id,
                    note="宝贝写的是 \"I go to park\"，漏了冠词，park 是可数名词，前面需要加上冠词 the~",
                ),
                ErrorRecord(student_id=ww["Nina"].id, question_id=t4[0].id),
            ]
        )
        db.add(
            FeedbackSnapshot(
                student_id=ww["Amy"].id,
                assignment_id=u7.id,
                final_text=(
                    "Amy U7L1 练习反馈\n"
                    "下午好[太阳]这是孩子本次的练习反馈，辛苦查收[玫瑰]\n"
                    "收到宝贝的作业喽~咱们这次作业完成非常棒！全部正确，继续保持！"
                ),
            )
        )

        # ---------- NG3B（厚中用 Day 课型；当前批带预习：U8Day1&U7B Preview） ----------
        ng_u7 = Assignment(
            class_id=ng3b.id,
            unit_no=7,
            lesson_type="Day",
            unit_lesson_no=1,
            lesson_no=7,
            class_time=next_class_time(ng3b.schedule, weeks_ahead=-1),
            content="伴学手册",
            status="已完成",
        )
        ng_u8 = Assignment(
            class_id=ng3b.id,
            unit_no=8,
            lesson_type="Day",
            unit_lesson_no=1,
            has_preview=True,
            preview_unit_no=7,
            preview_half="B",
            lesson_no=8,
            class_time=next_class_time(ng3b.schedule),
            content="伴学手册",
            status="未开始",
        )
        sync_unit_label(ng_u7)
        sync_unit_label(ng_u8)
        db.add_all([ng_u7, ng_u8])
        await db.flush()

        add_questions(
            ng_u7,
            "Reading",
            [
                {"stem": "Where does the story happen?", "answer": "In a small town.", "explanation": "细节题，答案在第一段第二行~"},
                {"stem": "What does \"delighted\" mean?", "answer": "Very happy.", "explanation": "词义猜测题，联系下文 smiles 可知是开心~"},
                {"stem": "Choose the best title.", "answer": "A", "options": ["A. A Helpful Neighbor", "B. A Trip to the City", "C. Lily's New Home", "D. The Small Town"], "explanation": "主旨题，全文围绕邻居的帮助展开~"},
                {"stem": "Lily moved away at last.", "answer": "F", "options": ["T", "F"], "explanation": "判断题，结尾 Lily 仍然住在小镇~"},
            ],
        )
        ng_scores = {"David": 92, "Emma": 90, "Frank": 86, "Grace": 88, "Henry": 84, "Ivy": 92}
        for name, score in ng_scores.items():
            db.add(sub(ng[name], ng_u7, "已批改", float(score)))

        # ---------- 全局配置 ----------
        # 内置话术（问候/Issue/催交/评级）由 init_db → builtin_phrases 补种，此处不重复插
        db.add(
            Setting(
                key=SETTINGS_KEY,
                value=json.dumps(
                    [{"rating": r, "min": m} for r, m in DEFAULT_THRESHOLDS],
                    ensure_ascii=False,
                ),
            )
        )

        await db.commit()
        print(
            f"seed 完成：{DATABASE_PATH}\n"
            f"  班级 2 个（WW5A 8 名学生 / NG3B 6 名学生）\n"
            f"  批次 4 个（WW5A 当前批 U7L1 含 {len(t1) + len(t2) + len(t3) + len(t4)} 题，三种 mode）\n"
            f"  提交状态四态示例齐全：已批改 / 缺作业 / 未交 / 待批改"
        )


def main() -> None:
    if "--fresh" in sys.argv:
        db_file = Path(DATABASE_PATH)
        if db_file.exists():
            db_file.unlink()
            print(f"已删除旧数据库：{db_file}")
    asyncio.run(seed())


if __name__ == "__main__":
    main()
