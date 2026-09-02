# AGENTS.md — 给 AI agent 的操作手册

**v1.0.0**（变更见 [CHANGELOG.md](CHANGELOG.md)）。把这个项目丢给 AI 时，读这个文件就够了。

两块东西：`index.html` + `data/` 是数据站（成熟，直接用）；`outreach/` 是外链投放管道
（代码经 8 轮外审，但**尚未端到端真跑过**，首次务必 `--limit 5` 小批验证）。

## 跑起来（唯一需要做的事）

```bash
cd <本目录> && python3 -m http.server 8899
# 浏览器打开 http://127.0.0.1:8899/
```

- 纯静态，无依赖、无构建、无 npm。
- 必须用 HTTP 服务打开；`file://` 直接双击打不开数据（fetch 限制）。
- 验证方式：`curl -s http://127.0.0.1:8899/data/data.json | head -c 200` 返回 JSON 即正常。

## 结构

- `index.html` — 全部 UI（原生 JS，无框架）。四个视图：总榜/增长榜/新品雷达/外链库。
- `data/data.json` — 站点数组。每行字段：
  `domain, name, desc_zh, desc_en, categories[], free, signup, visits, clicks, bl, bl_blog, global_rank, sem_traffic, sem_positions, mix{organic,direct,…}, monthly[[YYYY-MM-DD,visits]…], mom, kw[{n,v,c}], listed_month, n_dirs, registered, organic, dr`
- `data/library.json` — 外链库页面数组：`url, src, title, plat, ascore, nt, targets[{d,a}], seen`
- `data/links/<domain>.json` — 单域 dofollow 明细：`[{u,s,a,p,s2,f}]`（u=来源页,s=标题,a=锚文本,p=平台,s2=权重分,f=首见 epoch 秒）。
  **每域按 s2 降序截 top 100，不是全量**（2,253 域共 22.3 万行）；对外别说"全部来源"。
- `data/links/index.json` — 有明细的域名清单（字符串数组，当前 2,253 个）。
- `data/verified_blog_comments.{csv,json}` — 博客评论库：377 个实测被 WP 评论接口受理的
  博客评论地址（含文章页 URL + 复核状态）；配套用法 `docs/blog-comment-sites-playbook.md`。

## 改 UI 时的注意点

- index.html 里 fetch 路径全部以 `data/` 开头，移动文件要同步改。
- 数据文件带 `?v=<DATA_VERSION>` 防缓存（常量在 index.html 顶部）。**换数据快照就改这个常量**；
  别改回 `?t=Date.now()` —— 那会让 11MB 的 data.json 每次打开页面都重下，HTTP 缓存彻底失效。
- 搜索框输入有 140ms 防抖：`render()` 要把 15k 个 `<tr>` 交给 innerHTML 建 DOM（实测约 327ms），
  每敲一键重渲一次会丢帧。新增高频触发点时照此办理。
- 新视图加进 `VIEWS` 数组 + `SORTS` 映射 + I18N 双语键（zh/en 都要）。
- 截图自测（有 playwright-core 的话）：起服务后访问四个 tab 各截一张。

## outreach/（外链投放工具）

用户看完数据要投放时用这个（LLM-in-the-loop 管道，详见 outreach/README.md）：

```bash
cd outreach && npm install   # playwright-core;另需本机 Chrome 或 npx playwright install chromium
python3 configure.py                     # LLM 端点 + 打码/收信 key(本机界面,带实测按钮)
python3 check_llm.py                     # 或纯命令行验端点(连通性 + json_object)
cp kit.example.json kit.json             # 产品资料包(填表槽位/forbidden_claims 红线)
cp identities.example.json identities.json  # persona 池
python3 targets.py && python3 driver.py --limit 5
```

**改 `outreach/` 任何代码，前后都跑 `bash outreach/tests/smoke.sh`**（语法 + Python 关键路径
29 项 + Node 关键路径 47 项 + 配置 py/js 对拍 43 组 + 12 进程并发认领）。
**"语法过 + import 过"不算回归**——这个脚本存在的原因是：曾经整段替换函数时连带删掉了
`state.py` 的 6 个函数，语法和 import 都照样通过，`NameError` 只在真调用到那行才炸。

LLM 配置收口在 `llm_config.py` / `llm_config.mjs`(两份规则逐条一致):
**填 base URL 就行**(`LLM_BASE_URL`,不用拼 `/chat/completions`),key 用
`LLM_API_KEY`,也认通用的 `OPENAI_BASE_URL` / `OPENAI_API_KEY` 和文件 `llm.json`;
旧名 `LLM_ENDPOINT` / `LLM_KEY` 仍可用但会提示改名。`python3 llm_config.py` 看当前解析结果。

**开工前确认用户已准备**（缺了别跑）：OpenAI 兼容 LLM 端点（LLM_* 环境变量）、
收信信箱（两条腿至少通一条，都免费：agent.qq.com 走 agently-cli `auth login`；
agentmail.to 拿 API key 填 my_site.json 的 agentmail_* 字段 + `pip install agentmail curl_cffi`）、
persona 身份池（identities.json）、产品资料包（kit.json）。
mail_sweeper.py 是生产文件逐字复制的最小改动移植，改它先读文件头移植说明。

- kit.json / identities.json / my_site.json 全是占位模板，必须替换成用户真实信息，别用示例值投
- 先 `driver.py --limit 5` 小批验证，没问题再放量；state.jsonl 是唯一状态源，别手改
- **写账本只能走 `state.upsert_submission` / `state.mjs upsertSubmission`**，不许直接
  往 state.jsonl 追加行：迁移守卫（投达态不许被打回 blocked/failed）就在那里，绕过去
  = 把已投达的域重新放回可重投池 = 重复提交。driver.py 的 `save_state()` 已收口到守卫，
  新加写入点照此办理
- **防重复投递的第二道闸是 `outreach/claims/<域>.claim`**（`claimDelivery` 用 O_EXCL 原子创建，
  内核保证只有一个创建者成功）。标记**不会自动释放**——投达即终态；确实需要放回只能人工
  `releaseClaim(domain)`，且必须先确认那个域真的没投出去
- 单站时间预算：`SUBMIT_MAX_MINUTES`（默认 8，driver 传 10）。看门狗触发点由
  `makeWatchdogPlan` 按 driver 的 900s 包装硬杀倒推，超过约 12 分钟会被**自动钳住**
  （启动时打一行日志说明）——想让单站跑更久，得先把 driver 的 `timeout=900` 一起抬
- 提交后验证邮件由 `mail_sweeper.py --loop` 自动处理（agently-cli 收信+LLM 判意图+点验证链接，
  四条安全闸别动）；先 `--dry-run` 演一遍再放--loop
- 验证码站没配 capsolver_key 会标 manual 进 human_tasks.jsonl，人工处理，不要尝试自动过码
- delivery_ambiguous = 提交可能已投达但终局未定，永不自动重投，只能人工裁决
- pending_review ≠ 上线：终核器 `verify_link.mjs --pending --update-status` 确认在线且
  dofollow 才抬 success（offline_confirmed 连续 ≥3 次才写 failed——单次核验不判死，
  unknown 不动）；建议每周跑一次
- LLM 端点/打码 key/代理全走环境变量或 my_site.json；私仓的任何 key/产品资料不得进本目录

## 审查记录

`docs/CODEX_REVIEW.md` 是 8 轮独立外审（Codex）的完整记录：逐轮 finding、修法、实测。
新 agent 接手 `outreach/` 前值得扫一眼——里面记了两类反复出现的错法：
「这个防御的代码路径真的会被走到吗」，以及「同一个 bug 在别处是不是已经修过了」。
再加一条：**动手写新实现前先 grep 仓库里有没有已经写对的**（文件锁就是先有 `creds.mjs`
写对了，我又重写了一遍错的）。

## 数据更新

本仓库只含数据快照。`scripts/` 下的聚合脚本（build_data / build_link_library / build_links_split）
演示了聚合逻辑，但它们读的是私有数据湖（backlinks-v2/datasets），外部跑不了。
要换自己的数据：按上面的 JSON 字段格式生成 `data/data.json` 即可，UI 不用动。

## 免责声明

流量/排名/反链数据为第三方服务估算值，仅研究参考，别当精确值引用。
