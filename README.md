# AI 工具榜 · AI Tools Radar

**v1.0.2** · 数据快照 2026-09-02 · [更新日志](CHANGELOG.md)

AI 工具站增长情报库：按**真实流量数据**排名的 AI 工具目录——不是投票榜，不是广告位。

An open growth-intelligence site for AI tools: real traffic estimates, growth curves, channel mix, backlink intel. Free & open, runs locally, zero dependencies.

## 快速开始 · Quickstart

```bash
git clone https://github.com/ppop123/ai-tools-radar.git
cd ai-tools-radar
python3 -m http.server 8899
# 打开 http://127.0.0.1:8899/
```

任何静态 HTTP 服务都行（`npx serve`、`nginx`、GitHub Pages…）。**不要**直接双击 `index.html`——浏览器不允许 `file://` 页面 fetch 本地 JSON。

## 四个视图 · Views

| 视图 | 内容 |
|---|---|
| **总榜** | 21,207 个 AI 工具站，月访问量/自然搜索流量/环比增长/反链/全球排名/域名注册时间，点行展开详情抽屉（12 月流量曲线、渠道构成、头部关键词） |
| **增长榜** | 按流量环比增速排序——谁在起飞一眼可见 |
| **新品雷达** | 近 90 天新注册的 AI 工具站，按域名注册时间排序 |
| **外链库** | 12,000 个真实给出过 dofollow 外链的页面；**输入竞品域名，查它的 dofollow 来源**（已覆盖 2,253 站，每站按权重分取 top 100），总榜反链列可下载单域 CSV |

中英双语（右上角切换）。All views available in English via the toggle.

## 博客评论库 · Verified blog comment sites

`data/verified_blog_comments.{csv,json}`：**377 个实测能投出去的博客评论地址**（WordPress 评论接口真实受理），每条附评论所在的文章页 URL；发布当天（2026-08-29）全量复核一遍——**324 个页面上评论今天还在**，22 个被博主清理，31 个反爬不可判。

说实话的部分：324 条存活里 dofollow 只有 6 条（WP 评论默认 ugc/nofollow）。它的价值在收录通道、链接画像自然度，以及"这批域被证明评论能过审"的情报本身。怎么用（只投活的、评论写法、节奏、红线）见配套文章
[`docs/blog-comment-sites-playbook.md`](docs/blog-comment-sites-playbook.md)，内嵌 324 条完整清单，可直接拿去论坛发布。

## 看完数据想动手 · Outreach tool

`outreach/` 是一套**生产验证过的外链投放管道**（LLM-in-the-loop 浏览器代理）：查竞品的 dofollow 来源 → 生成投放清单 → 浏览器代理自动提交 → 自动收验证邮件点链接 → 终核链接真上线。

```bash
cd outreach
npm install                                                # playwright-core 等
python3 configure.py                                       # 本机配置界面:LLM 端点 + 打码/收信 key
cp kit.example.json kit.json                               # 产品资料包(文案槽位/forbidden_claims)
cp identities.example.json identities.json                 # 投放 persona
python3 check_llm.py                                       # 实测端点(连通性 + json_object)
python3 targets.py                                         # 生成投放清单
python3 driver.py --limit 5                                # 小批试跑(先 5 个看状态)
python3 mail_sweeper.py --loop                             # 常驻:收验证邮件/点验证链接
node verify_link.mjs --pending --kit kit.json              # 终核:链接真上线才记 success
```

开工准备（缺了别跑）：免费 AgentMail 账号（agent.qq.com，收验证邮件）+ `npm i -g @tencent-qqmail/agently-cli` 授权一次；OpenAI 兼容 LLM 端点（`python3 configure.py` 有界面，填 base URL 即可，**模型须支持 `response_format: json_object`**）；persona 身份。详见 `outreach/README.md`。

三条红线由代码硬执行，LLM 无权越过：付费站即停 / 文案过 forbidden_claims 闸门 / 验证码不让 LLM 编答案（两个打码 key 都没配就进人工队列）。单次核验不判死——终核连续 3 次 offline 才算掉链。

**防重复投递有两道独立的闸**：账本的状态迁移守卫 + `claims/<域>.claim` 的 O_EXCL 一次性标记。后者由内核保证只有一个创建者成功，不依赖任何存活检测或陈旧判断——所以"会不会重复 POST"不依赖文件锁的正确性。

### 改代码前先跑这个

```bash
bash outreach/tests/smoke.sh
```

语法 / Python 关键路径 29 项 / Node 关键路径 47 项 / 配置解析 py-js 对拍 43 组 / 12 进程并发认领。**"语法过 + import 过"不算回归**——曾经整段替换函数时连带删掉了 `state.py` 的 6 个函数，语法和 import 都照样通过。

## 项目状态 · Status

数据站可以直接用。**`outreach/` 尚未端到端真跑过**——代码经过 8 轮独立外审（Codex）+ 多轮自审，累计修掉 90+ 条问题（P1 级 30+，外审 P1 数量收敛过程 `5→6→7→5→5→3→0→0`），但所有验证都是读代码 + 定向复现 + 冒烟，没有用真 key 对真实站点跑完整流程。

首次使用请务必 `driver.py --limit 5` 小批验证，亲眼看完整个过程再放量。逐轮的 finding、修法与实测记录在 [`docs/CODEX_REVIEW.md`](docs/CODEX_REVIEW.md)，已知限制见 [CHANGELOG](CHANGELOG.md#已知限制)。

## 数据说明 · Data notes

- 流量/排名/渠道数据为第三方流量估算服务的估计值（SimilarWeb 口径），仅供研究参考
- 反链明细来自 Semrush 口径的 dofollow 索引快照（2026-08）
- **单域明细是 top 100，不是全量**：`data/links/<domain>.json` 每站按权重分（ascore）
  降序截前 100 条（2,253 站共 22.3 万行），下载的 CSV 同此口径。要全量得自己接数据源
- 博客评论库是自有投放系统的实测产出：受理口径 = WP 评论接口 302 接受；存活口径 = 复核日逐页抓取确认链接仍在页面上。评论存活是动态的，用之前对目标页再抽查一次最稳
- 数据快照日期见页面数据；本项目**只含数据快照**，采集管道依赖私有账号体系，未包含在本仓库
- `scripts/` 里的构建脚本展示了数据如何聚合（供参考/复刻），需要自己的数据源才能跑；
  脚本里的输入/输出路径是作者本机的绝对路径，复刻时先改 `DATA` / `SITE` / `OUT`

## 目录结构 · Layout

```
index.html                      # 单文件站点(全部 UI 逻辑,408 行)
data/data.json                  # 站点榜单数据(21,207 行)
data/library.json               # 外链库(12,000 页面)
data/links/<domain>.json        # 单域 dofollow 明细(2,253 域 / 22.3 万行,按需加载)
data/links/index.json           # 有明细的域名清单
data/verified_blog_comments.*   # 博客评论库(377 条,csv + json)
outreach/                       # 外链投放管道(目标生成/LLM 投放代理/收信/终核)
outreach/tests/smoke.sh         # 关键路径冒烟 —— 改代码前后都跑它
docs/CODEX_REVIEW.md            # 8 轮外审的完整记录(finding / 修法 / 实测)
docs/blog-comment-sites-playbook.md  # 博客评论库用法手册(论坛发布格式)
scripts/                        # 数据聚合脚本(需要私有数据源,仅参考)
```

## 作者

由 [LensUp](https://lensup.ai/)（免费纯浏览器文档扫描器，照片 → PDF）背后的团队维护。
Maintained by the team behind [LensUp](https://lensup.ai/) — a free in-browser document scanner.

## License

代码 MIT。数据为第三方估算值的聚合快照，版权归原作者所有，仅供研究参考。
