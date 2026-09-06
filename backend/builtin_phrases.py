"""内置话术：全部品类（问候语/Issue 模板/催交/评级话术）统一在此维护，启动幂等补种。

- seed.py 演示库与老库升级共用本模块，单一事实来源
- 补种走 settings 标记制（v1）：首次补种后打标记不再逐条插入（话术管理里编辑/删除不会被重启拉回）；
  后续版本新增内置话术走 v2 标记增量补种
- 评级话术的 {lost_sections} 占位符由前端按勾选错题板块自动替换；Issue 模板的
  {preview_unit_full}/{preview_unit} 同理（[太阳] 等为微信表情占位符，照留）
"""

from models import Setting

# 版本化增量补种：每个版本一个标记，标记缺失才补对应品类（编辑/删除不被重启拉回）。
# v1 = 评级话术（V0.1.x 已补）；v2 = 问候语 / Issue 模板 / 催交（V0.2.0 新增，老库升级自动获得）
SEEDED_MARKERS = {
    "v1": "builtin_phrases_seeded_v1",
    "v2": "builtin_phrases_seeded_v2",
}

# 旧版 Gradify 问候语迁移：按发反馈的时段分池，前端按时段取用
GREETING_PHRASES: dict[str, list[str]] = {
    "早上": [
        "早上好[太阳]这是孩子本次的练习反馈，辛苦查收[玫瑰]",
        "上午好[太阳]这是孩子本次的练习反馈，辛苦查收[爱心]",
    ],
    "中午": [
        "中午好[太阳]这是孩子本次的练习反馈，辛苦查收[玫瑰]",
        "中午好[太阳]这是孩子本次的练习反馈，辛苦查收[爱心]",
    ],
    "下午": [
        "下午好[太阳]这是孩子本次的练习反馈，辛苦查收[爱心]",
        "下午好[太阳]这是孩子本次的练习反馈，辛苦查收[玫瑰]",
    ],
    "晚上": [
        "晚上好[月亮]这是孩子本次的练习反馈，辛苦查收[玫瑰]",
        "晚上好[月亮]这是孩子本次的练习反馈，辛苦查收[爱心]",
    ],
}

# {preview_unit_full} / {preview_unit} 在拼装时替换为本批次预习单元（如 U7B / U7）
ISSUE_PHRASES: list[tuple[str, str]] = [
    ("未交预习", "{preview_unit_full} Preview部分\n小朋友没有提交预习作业哦，看看是不是忘记啦~"),
    ("缺作业页面", "小朋友还缺一页作业没有交，看一看是不是忘记啦~"),
    ("判断不规范", "判断题部分\n这部分小朋友答案没有问题，主要注意题干要求需要用T、F表达正误哦，而不是用勾叉~"),
    ("预习有错题", "{preview_unit_full} Preview部分\n预习部分小朋友错了1个小题，可以结合材料再看看哦💗！"),
    ("单词拼写错误", "Vocabulary部分\n这部分小朋友答案没有问题，但是需要注意单词拼写不要出错哟~"),
    ("听记未交", "听记作业\n小朋友没有提交听记作业哦，看看是不是忘记啦"),
]

# 提交状态切到「未交」时自动匹配的整体催交话术
URGING_PHRASE = "小朋友这次作业还没有提交哦，看看是不是忘记啦~"

RATING_PHRASE_CATEGORY = "评级话术"

RATING_PHRASES: dict[str, list[str]] = {
    # 旧 A+ 三条原样：全对话术与 A+ 档位解耦后仍由「分数=100」触发
    "全对": [
        "收到宝贝的作业喽✌️~咱们这次作业完成非常棒哦👍！！！正确率百分百！全部都做对啦，继续保持呀💗~",
        "收到小朋友的作业啦😄，咱们这次作业完成得非常棒🎉！全都做对啦，继续保持哦💗~",
        "收到宝贝的作业啦☀️，咱们这次作业完成得超级棒！正确率100%，继续保持哦💗~",
    ],
    # 旧 A 话术改写：非全对的 A+ 不说「全对」，保留「差一点点」的临门一脚感
    "A+": [
        "收到宝贝的作业喽✌️~咱们这次作业完成得非常棒哦👍！正确率非常高，只有「{lost_sections}」差一点点就全对啦，继续保持哦💗~",
    ],
    # 旧 A 五条；写死的「百分之九十」软化为「很高」以匹配 A/A- 两档
    "A": [
        "收到宝贝的作业喽🎶~咱们这次作业完成很棒👍！正确率很高。只有「{lost_sections}」需要注意一下，知识掌握得不错！一起来看看吧⬇️：",
        "收到宝贝的作业喽🐾~咱们这次作业完成非常棒哦👍！！！正确率很高，「{lost_sections}」有一些小问题，我们一起看看吧⬇️：",
        "收到宝贝的作业啦😄~咱们这次作业完成啦🎉！正确率不错的💗~「{lost_sections}」部分各有一些问题，一起看看吧⬇️：",
        "收到宝贝的作业啦😄~咱们这次作业完成得很不错🎉！正确率蛮高的💗~只有「{lost_sections}」部分有一个小问题，一起看看吧⬇️：",
        "收到宝贝的作业喽✌️~咱们这次作业完成非常棒哦👍！！！正确率很高，在「{lost_sections}」部分有一些小问题，一起看看吧⬇️：",
    ],
    # 旧 B 两条原样
    "B": [
        "收到宝贝的作业啦😄~咱们这次作业完成啦🎉！正确率ok💗~「{lost_sections}」部分各有一些问题，一起看看吧⬇️：",
        "收到宝贝的作业啦😄~咱们这次作业完成得OK🎉！正确率整体不错噢💗~主要是「{lost_sections}」部分问题多点，可以看看哪里出问题啦，一起看看吧⬇️：",
    ],
    # 旧 C 一条原样
    "C": [
        "收到宝贝作业啦😄~咱们这次作业问题稍稍多一点，主要集中在「{lost_sections}」，不过没关系，我们一起来分析分析，下次就会更好啦！一起来看看吧⬇️：",
    ],
    # D/E/F 为十二档新增（旧版无此区间），仿旧风格新写
    "D": [
        "收到宝贝的作业啦😄~咱们这次作业「{lost_sections}」部分还需要多巩固一下哦，问题稍稍多了一点，没关系，我们一起来分析分析，把薄弱的地方补起来，下次一定会有进步的！一起来看看吧⬇️：",
    ],
    "E": [
        "收到宝贝的作业啦😄~咱们这次作业错题主要集中在「{lost_sections}」部分哦，别灰心，我们一起来分析分析，把这些问题一个个搞懂，进步就会很明显哒！一起来看看吧⬇️：",
    ],
    # F 不列板块：错题遍布所有板块时逐一列举没有信息量
    "F": [
        "收到宝贝的作业啦😄~咱们这次作业错题稍微多了一些，不过别担心，错题恰恰告诉我们重点要抓哪里，我们一起来分析分析，一步步来，下次一定会更好哒！一起来看看吧⬇️：",
    ],
}


async def ensure_builtin_rating_phrases() -> None:
    """版本化补种（init_db 末尾调用）：v1 评级话术、v2 问候/Issue/催交，各品类标记缺失才补。"""
    from sqlalchemy import select

    from database import SessionLocal
    from models import Phrase, Setting

    async def _marker(session, key: str) -> Setting | None:
        # settings 主键是自增 id，key 是 unique 列——必须 select 查（session.get 只按主键）
        return (
            await session.execute(select(Setting).where(Setting.key == key))
        ).scalar_one_or_none()

    async with SessionLocal() as session:
        # 行级去重（按 category+name+content）：防"标记制首启时旧版已补过"的库重复插入
        existing = set(
            (
                await session.execute(select(Phrase.category, Phrase.name, Phrase.content))
            ).all()
        )

        def _add(category: str, name: str, content: str) -> None:
            if (category, name, content) not in existing:
                session.add(Phrase(category=category, name=name, content=content, scope="内置"))

        # v1：评级话术
        if await _marker(session, SEEDED_MARKERS["v1"]) is None:
            for name, texts in RATING_PHRASES.items():
                for text in texts:
                    _add(RATING_PHRASE_CATEGORY, name, text)
            session.add(Setting(key=SEEDED_MARKERS["v1"], value="done"))
        # v2：问候语 / Issue 模板 / 催交
        if await _marker(session, SEEDED_MARKERS["v2"]) is None:
            for slot, texts in GREETING_PHRASES.items():
                for text in texts:
                    _add(f"问候语·{slot}", "", text)
            for name, text in ISSUE_PHRASES:
                _add("Issue 模板", name, text)
            _add("催交", "", URGING_PHRASE)
            session.add(Setting(key=SEEDED_MARKERS["v2"], value="done"))
        await session.commit()
