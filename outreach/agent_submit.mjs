// agent_submit.mjs — LLM-in-the-loop 目录提交代理(2026-08-16 开源移植版)
// 观察页面 → LLM 决策 → 执行 → 再观察,像人一样处理变体。
// 用法:node agent_submit.mjs <域名或URL> [--kit kit.json] [--cdp] [--steps N] [--proxy URL]
// 红线由代码硬执行,LLM 无权越过:
//   1) 付费:LLM 选择付费/结账类动作 → 直接 skipped_paid 终止
//   2) 文案:所有填入值必须过 kit forbidden_claims;LLM 只能选预设槽位或改写自 kit 事实
//   3) 验证码:LLM 声明 captcha 类型后由代码走 CapSolver,不让 LLM 编答案;
//      my_site.json 没配 capsolver_key 时验证码域标记 manual 转人工,不硬刚
//
// 开源化改造点(与生产版 backlinks-v2/node-tools/agent_submit.js 的差异):
//   - LLM 端点走 llm_config(LLM_BASE_URL/LLM_API_KEY/LLM_MODEL/LLM_FALLBACKS,或 llm.json;
//     旧的 LLM_ENDPOINT/LLM_KEY 仍兼容);不再读任何私有网关配置
//   - 账本 dbw(SQLite)→ state.mjs(state.jsonl + events/costs/constraints/human_tasks),
//     状态枚举/迁移守卫/投递认领语义逐条对齐
//   - 代理:--proxy 参数或 HTTPS_PROXY 环境变量,默认直连;无住宅出口基建
//   - 站点注册凭据:outreach/creds.json(creds.mjs,排他锁+原子写)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import * as cs from './capsolver.mjs';
import * as dbw from './state.mjs';
import {
  isSubmitClassClick, hasSubmitVerb, classifyReceiptText, htmlText,
} from './submission_safety.mjs';
import {
  actionResult, normalizeActionResult,
  shouldObserveSubmit, shouldTrackSubmitNoDelta, makeWatchdogPlan,
} from './agent_submit_runtime.mjs';
import * as credsFile from './creds.mjs';
import * as wd from './wall_detect.mjs';
import * as og from './outbound_guard.mjs';
import { rootDomain } from './rootdomain.mjs';
import * as llmcfg from './llm_config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // outreach/ 目录
// 多产品:--kit <backlink-kit.json 路径> 指定产品资料包,默认 outreach/kit.json
// (cp kit.example.json kit.json 后改成自己的产品资料)
const _kitIdx = process.argv.indexOf('--kit');
const KIT_PATH = _kitIdx > 0 ? process.argv[_kitIdx + 1] : path.join(HERE, 'kit.json');
const KIT = JSON.parse(fs.readFileSync(KIT_PATH, 'utf8'));
const PY_BIN = process.env.PYTHON_BIN || 'python3';

// LLM 端点/key/模型统一走 llm_config(base URL 与完整地址都收,env 与 llm.json 都读;
// 规则见 llm_config.py 文件头,JS/Python 两份逐条一致)
const LLM = llmcfg.load();
const LLM_ENDPOINT = LLM.url;
const MODEL = LLM.models[0];
for (const w of LLM.warnings) console.log(`[llm] ${w}`);
// 预算纪律:单站时间/验证码上限,烧尽则降档(emailed→blocked),不死磕
const MAX_MINUTES = +(process.env.SUBMIT_MAX_MINUTES || 8);
const WATCHDOG_PLAN = makeWatchdogPlan(MAX_MINUTES, dbw.BUSY_TIMEOUT_MS || 30000);

/* ============================================================
   反检测(2026-07-27 收编)

   这些零件仓里早就有(submit-ebool.js 的 addInitScript 抹 webdriver、
   ts_solve.js 的 locale、submit-ebook.js 的逐字打字),但**主力通道一件没用上** ——
   非 CDP 分支只设了 viewport。#19 里 13 个站被 Cloudflare 拦在页面加载阶段,
   连出现 sitekey、进到打码环节的机会都没有。

   实证参照:ebool.com 走 CDP 接管真实 Chrome 成功了,同一个站走 LLM-in-loop 失败。
   真实浏览器天然带完整指纹,这里做的是尽量把 headless 拉近那个状态。

   ⚠️ 目的是"不被当成扫描器",不是伪装成特定的人。UA 用真实存在的 Chrome 版本串,
   与 sec-ch-ua / platform / timezone 必须自洽 —— 互相打架比不设还容易被识别。
   ============================================================ */
// ⚠️ 全链路必须用**同一个** UA,而且必须是 Windows 的:
// CapSolver 的 AntiCloudflareTask 只接受 Windows Chrome UA(macOS 会 ERROR_INVALID_TASK_DATA),
// 而它返回的 cf_clearance cookie 是**和解题时的 UA 绑定**的 ——
// 浏览器报 macOS、解题报 Windows,Cloudflare 一校验 clearance 就作废,
// 白花钱还是过不去(:441 那个分支的老问题)。统一成 Windows 就都自洽了。
const STEALTH_UA = process.env.SUBMIT_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 【07-31 修】httpLog 提升到模块级:原在 main IIFE 里 const,email_otp 分支(898 行)
// 引用它直接 ReferenceError(agentlocker.ai 实证,整站被打穿)。表单 POST 证据日志,
// 模块级共享,main 里的 response 监听往里写,各处读。
const httpLog = [];

/** 出站代理:--proxy 参数 > HTTPS_PROXY 环境变量 > 直连。
 *  注意:cf_challenge(AntiCloudflareTask)的 cf_clearance 绑定 IP+UA,
 *  浏览器与解题必须同一出口,不配代理时该动作不可用(返回文案指引)。 */
function publicProxyUrl() {
  const pi = process.argv.indexOf('--proxy');
  if (pi > 0) return process.argv[pi + 1];
  return process.env.HTTPS_PROXY || process.env.https_proxy || null;
}

/** socks5/http(s)://user:pass@host:port → Playwright 的 {server,username,password} */
function parseProxy(url) {
  try {
    const u = new URL(url);
    const o = { server: `${u.protocol}//${u.hostname}:${u.port}` };
    if (u.username) { o.username = decodeURIComponent(u.username); o.password = decodeURIComponent(u.password); }
    return o;
  } catch { return { server: url }; }
}

/** 像人一样填字段:先聚焦、清空、逐字敲。
 *
 * `el.fill()` 是一次性把整段值塞进去 —— 没有 keydown/keyup 序列、没有击键间隔,
 * 有的站(尤其挂了行为分析的)据此就能判出是脚本。submit-ebook.js 早就用
 * `keyboard.type(..., {delay:150})`,这里收编进主力通道。
 *
 * 长文本(描述几百字)逐字敲太慢,超过阈值就分块 —— 仍有击键事件,但不至于卡住流程。
 */
async function humanFill(pg, el, v) {
  try {
    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await el.click({ timeout: 4000 });
    await pg.waitForTimeout(120 + Math.floor(Math.random() * 220));
    await el.fill('');                                   // 清空已有内容
    if (v.length <= 120) {
      // 短字段:逐字敲,间隔随机(固定间隔本身就是机器指纹)
      for (const ch of v) {
        await pg.keyboard.type(ch, { delay: 28 + Math.floor(Math.random() * 85) });
      }
    } else {
      // 长文本:分块打,块间停顿 —— 像人粘贴后继续写
      for (let i = 0; i < v.length; i += 60) {
        await pg.keyboard.type(v.slice(i, i + 60), { delay: 6 });
        await pg.waitForTimeout(90 + Math.floor(Math.random() * 160));
      }
    }
  } catch {
    await el.fill(v);          // 拟人化失败不能挡住正事,退回一次性填
  }
}

/** 在每个页面(含 iframe)注入,抹掉最常被查的自动化痕迹。 */
function stealthInit() {
  // 1) navigator.webdriver:headless 下为 true,是最直白的标志
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  // 2) window.chrome:真 Chrome 有,headless 常缺
  window.chrome = window.chrome || { runtime: {}, loadTimes() {}, csi() {} };
  // 3) 语言:必须和 Accept-Language / locale 一致
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  // 4) 插件数为 0 是 headless 的经典指纹
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5].map((i) => ({ name: `Plugin ${i}` })),
  });
  // 5) 权限查询:headless 下 notifications 会返回矛盾结果
  const q = window.navigator.permissions && window.navigator.permissions.query;
  if (q) {
    window.navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : q.call(window.navigator.permissions, p);
  }
  // 6) WebGL 厂商串:headless 常报 SwiftShader/Google Inc.,真机是显卡名
  const gp = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (p) {
    // 与 Windows UA 自洽的显卡串(报 macOS 显卡会和 UA 打架)
    if (p === 37445) return 'Google Inc. (Intel)';                       // UNMASKED_VENDOR_WEBGL
    if (p === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    return gp.apply(this, [p]);
  };
}
const MAX_CAPTCHA = +(process.env.SUBMIT_MAX_CAPTCHA || 3);
// 产品指纹(核验/实锤用):域名主体,如 example.com → example
const PSLUG = (KIT.product.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('.')[0].toLowerCase();
const PNAME = KIT.product.name;
const PRODUCT_FACTS = (KIT.product.facts_for_screening ||
  `${PNAME} 是全新独立站:DR 低、月自然访客少,类目=${(KIT.product.categories || []).join('/')}`);
// 遥测/统计/广告/风控端点:一律不算提交证据(2026-07-24 假成功审计后补,LLM 主循环与 recipe 快放共用)
const TELEMETRY = /posthog|bugsnag|sentry\.io|plerdy|factors\.ai|mahon\.cloud|shopifysvc|monorail|cnzz|shujupie|fndrsp|pirsch\.io|doubleclick|googletagmanager|google-analytics|google\.com\/rmkt|\/rmkt\/collect|snapchat|facebook\.net|hotjar|clarity\.ms|mixpanel|amplitude|segment\.|heap\.io|umami|awswaf|datadog|newrelic|fullstory|mouseflow|logrocket|statcounter|histats|quantserve|scorecardresearch|cdn-cgi|challenge-platform|\/banner\/|impression|\/pixel|\/beacon|\/collect[?/]|\/api\/stats|\/api\/track|\/stat\.htm|telemetry|\/rum[?/]|analytics|pagead2\.googlesyndication|googlesyndication\.com\/pagead/i;
// 【修】验证码类拒收文案。裸 `captcha|recaptcha` 会命中成功页里 reCAPTCHA 的
// api.js 脚本标签 —— 同一个坑在 :871(fetch 直送分支)已经修过并写明"拒词要具体到
// 文案",但主响应监听与 recipe 复放这两处一直没跟上,真投达因此被判成拒收。
const CAPTCHA_REJECT = 'check the security|incorrect-?captcha|reCAPTCHA box|请勾选'
  + '|captcha (?:is )?(?:required|invalid|incorrect|failed)|invalid captcha|captcha 错误';
const FORBIDDEN = new RegExp(KIT.compliance.forbidden_claims_regex.map(p => p.replace(/^\(\?[a-z]+\)/, '')).map(p => `(?:${p})`).join('|'), 'i');

// ---------- 站点约束(2026-07-25)----------
// 命中约束时短路成什么状态
const CONSTRAINT_STATUS = {
  oauth_only: 'blocked', login_wall: 'blocked',
  captcha_unsolvable: 'blocked', http_500: 'blocked',
  badge_required: 'skipped_badge', paid_only: 'skipped_paid',
};
// 时效表已收进 wall_detect.js(CONSTRAINT_TTL_DAYS);政策注释一并迁走,这里只留指针。
/** 通道级约束 → 塞进 LLM 的 system,让它别往死路上退。
 *  典型:mail_channel_dead —— 该域退过信,邮件根本送不到,
 *  再"退步到联系表单/公开邮件"就是在制造假的 emailed 记录。 */
let advisory = [];
function advisoryNote() {
  const extra = [];
  // 【2026-07-30】CDP 受控浏览器模式:浏览器里有用户登录好的 Google 小号。
  // 不告诉 LLM 这件事,它看见 OAuth 墙就直接判 blocked(goodaitools 实证)。
  if (process.argv.includes('--cdp')) {
    extra.push('- 当前是受控真实浏览器。Google/OAuth 授权可能创建站点新账号,也属于新注册。'
      + '没有该站逐站批准时禁止点击 OAuth/Continue with Google/Sign up,必须停止并请求批准。'
      + '已有 creds.json 邮箱密码的站只走 Sign in/Login,不要改走 OAuth。');
  }
  if (!advisory || !advisory.length) return extra.length ? '\n\n【运行环境提示】\n' + extra.join('\n') : '';
  const lines = advisory.map(c => {
    if (c.reason_code === 'mail_channel_dead')
      return '- ⚠️ 该站邮件通道已死(此前退信):**禁止以"发了邮件"收尾**,'
           + 'done→emailed 这条退路对本站不可用;投不进就 giveup 带精确归因。';
    return `- 已知约束:${c.reason_code}(${(c.evidence || '').slice(0, 60)})`;
  });
  return (extra.length ? '\n\n【运行环境提示】\n' + extra.join('\n') : '')
       + '\n\n【本站已知约束】\n' + lines.join('\n');
}

/** 从终局理由里认出可复用的硬约束,记进 site_constraints,下次直接短路
 *  归因正则已收进 wall_detect.js(inferConstraint),这里只保留记库副作用。 */
function recordConstraint(dom, status, reason) {
  try {
    const code = wd.inferConstraint(status, reason);
    if (!code) return;
    dbw.addConstraint({
      domain: dom,
      reason_code: code, evidence: String(reason || '').slice(0, 400),
      ttl_days: wd.CONSTRAINT_TTL_DAYS[code] ?? 30,
    });
    console.log(`[${dom}] 已记约束 ${code}(${wd.CONSTRAINT_TTL_DAYS[code] ?? 30} 天内不再重试)`);
  } catch (e) { console.log(`[${dom}] 记约束失败(忽略):${String(e.message).slice(0, 80)}`); }
}
const VALUES = {
  name: PNAME, product_name: PNAME, url: KIT.product.url,
  email: (KIT.product.submitter && KIT.product.submitter.email) || '',
  submitter: (KIT.product.submitter && KIT.product.submitter.name) || PNAME + ' Team',
  tagline: KIT.copy.taglines[1] || KIT.copy.taglines[0],
  desc_short: KIT.copy.descriptions.s_150[0], desc_mid: KIT.copy.descriptions.m_300[0],
  desc_long: KIT.copy.descriptions.l_510[0], tags: KIT.product.tags.join(', '),
  categories: KIT.product.categories.join(', '), logo: KIT.product.og_image,
  // 收验证码/验证信的受控表单邮箱:env AGENT_EMAIL > kit submitter.email。
  // 地址可以是受控转发别名,只要最终进入 mail_sweeper.py 通过 agently-cli 读取的 QQ 信箱。
  agent_email: process.env.AGENT_EMAIL || (KIT.product.submitter && KIT.product.submitter.email) || '',
};
// 【08-01 用户定·反检测】身份轮换:每个域固定抽一个 persona(同域稳定、跨域轮换),
// 破 Akismet 跨站签名(几百个站同一名字+邮箱 = 全网亮红灯)。
// persona 必须使用真实、受控且与本产品政策一致的地址。目录表单也会读取这里的 email;
// 需要收验证码的注册流程始终走 kit submitter.email / agent_email。
// 覆盖:env IDENTITY_FORCE="Name|email@x" 或 "Name|email@x|https://author-url/"
// (第三段可选:覆盖评论作者网址,用于主域/Substack/Blogspot 三落点轮换)。
try {
  // 【08-11 四轮评审 P2-14.2】真实 persona 池(真名+自有域邮箱+域名矩阵)不再入库,
  // 真文件在 run/identities.json(gitignored);仓里只有 identities.example.json 脱敏示例。
  // 读取顺序:run/ → node-tools/identities.json(本地未跟踪副本,rolling_submit.py /
  // web/admin.py 仍按此路径直读,过渡期保留)→ identities.example.json(发布仓兜底,响亮告警)。
  const _idCandidates = [
    path.join(HERE, 'identities.json'),
    path.join(HERE, 'identities.example.json'),
  ];
  const _idSrc = _idCandidates.find(c => fs.existsSync(c));
  if (!_idSrc) throw new Error('no identities pool');
  if (_idSrc.endsWith('.example.json'))
    console.error('[identity] ⚠️ 在用 identities.example.json 脱敏示例池:姓名/邮箱全是占位符,'
      + '真实 persona 池应放 outreach/identities.json(gitignored)。示例池提交出去的身份不可信!');
  const pool = JSON.parse(fs.readFileSync(_idSrc, 'utf8'));
  const dom = (process.argv[2] || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  let h = 0;
  for (const ch of dom) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const pick = process.env.IDENTITY_FORCE
    ? (() => { const [name, email, url] = process.env.IDENTITY_FORCE.split('|'); return { name, email, url }; })()
    : pool[h % pool.length];
  if (pick && pick.name && pick.email) {
    VALUES.submitter = pick.name;
    VALUES.email = pick.email;
    if (pick.url) VALUES.url = pick.url;
  }
} catch {}

// 每站注册密码:一次生成永存 creds.json,不再重注册
// 【2026-07-25 并发修复】原实现是无锁的 读→改→整文件覆写:两个 agent 同时给不同站
// 注册账号时,后写的会把先写的那条抹掉,账号密码永久丢失且无声。改走 creds.update()
// (排他锁 + 锁内重读 + 临时文件 rename 原子替换)。
/* 账号按站共享;只有站方限制"一账号一产品"时才给本产品单开(见 creds.js 的策略注释)。
   PSLUG 复用文件顶部那个(由产品 URL 主机名推出,同时用于成功指纹匹配)。
   accountKey 会自动选:已存在专属账号就用专属,否则用共享。 */
function domainPassword(dom, accountEmail) {
  // 【2026-07-29 修】accountEmail 参数是新加的,原来这里硬写 VALUES.agent_email
  // 而调用方在**这一行之后**才去算"该用哪个邮箱"——
  // 于是 accountEmail() 读到的永远是这里刚写进去的 QQ 地址,
  // 那句"优先用产品自己的 contact@<产品域>"的回落**一次都没执行到**。
  // 实测代价:43 个已注册站里 42 个记的是 QQ 地址,产品域身份形同虚设,
  // 「一账号一产品」的 fork 也因此永远走不通。
  // 这跟今天修的熔断、代理轮换是同一个形状:代码全对,就是执行路径到不了。
  const key = credsFile.accountKey(dom, PSLUG);
  return credsFile.update((creds) => {
    if (creds[key] && creds[key].pass) return creds[key].pass;   // 锁内重读,不会重复生成
    const pass = 'Ls' + Math.random().toString(36).slice(2, 10) + '!a9Z';
    creds[key] = {
      user: PNAME, email: accountEmail || VALUES.agent_email, pass,
      via: key === dom ? 'agent自注册(按站共享)' : 'agent自注册(产品专属)',
      at: new Date().toISOString().slice(0, 10),
    };
    return pass;
  });
}

/** 站方明确限制一账号一产品时调用:给本产品分家,并记一条约束供下次直接走专属账号。 */
function forkAccountForProduct(dom, reason) {
  // 产品专属账号必须配**产品自己的**邮箱,否则站方看到的还是同一个地址,
  // 一账号一产品的限制根本没绕过(Codex 2026-07-26 [P1])。
  // 这个地址来自 kit 的 submitter.email,可以经 Email Routing 转发到 sweeper 读取的 QQ 信箱。
  const productEmail = (KIT.product.submitter && KIT.product.submitter.email) || '';
  if (!productEmail) {
    console.log(`[${dom}] ⚠️ 无法单开账号:kit 的 submitter.email 为空,请先配置受控收信地址`);
    return null;
  }
  // 身份迁移(产品联系邮箱成为共享注册身份)后,共享账号邮箱
  // 已与产品邮箱相同 —— fork 既无意义,creds.forkAccount 内部还会抛错打穿整个 run
  // (1000tools.best 实证)。catch 住,降级为继续用共享账号。
  let key;
  try {
    key = credsFile.forkAccount(dom, PSLUG, reason, productEmail);
  } catch (e) {
    console.log(`[${dom}] forkAccount 放弃(${(e.message || '').slice(0, 80)}),继续用共享账号`);
    return null;
  }
  try {
    dbw.addConstraint({ domain: dom, reason_code: 'account_per_product',
                        evidence: String(reason || '').slice(0, 300), ttl_days: 365 });
  } catch {}
  console.log(`[${dom}] 站方限制一账号一产品 → 已为 ${PNAME} 单开账号(${key})`);
  return key;
}

// 【2026-07-31 人机协同 v1(分支模式)】agent 独立过不去的站记入 human_tasks 队列
// **不等待、不打断主任务**,继续下一站;人空下来时用 Chrome 插件从队列接活完成。
// payload 带上已知的表单值,插件打开页面直接预填。
// 【08-11 十二轮评审 P1-3②】主流程的 pg 是 IIFE 里的 let,模块级函数看不到;
// 由主流程在每个赋值点登记到 curPg,供 queueForHuman 等取当前 URL(取不到留空)。
let curPg = null;
// 【修】看门狗走的是 process.exit(),**同步终止,pending 的 finally 一律不执行** ——
// 上一版把 browser.close() 挪进 finally 只覆盖了正常/异常收尾,强退这条路依然留孤儿
// Chromium(driver 的 timeout=900 只杀直接子进程)。这里登记浏览器句柄,强退前同步杀掉。
let curBrowser = null;
function killBrowserSync() {
  try {
    const proc = curBrowser && curBrowser.process && curBrowser.process();
    if (proc && proc.pid) process.kill(proc.pid, 'SIGKILL');   // close() 是异步的,来不及
  } catch { /* CDP 模式没有子进程句柄;连的是用户自己的浏览器,本来也不该杀 */ }
}
function safePgUrl() { try { return curPg ? String(curPg.url() || '') : ''; } catch { return ''; } }

function queueForHuman(dom, blocker, guidance, retry = {}) {
  // 【07-31 二修】撤掉"仅 CDP 模式才入队"的闸门:人是在自己的 Chrome 里用插件接活,
  // 只依赖 admin 8790 + 页面本身,与 agent 是否跑在 CDP 浏览器无关。批跑模式也该入队。
  // 【08-11 十一轮评审 P2】入队前 canon:显式 URL 场景的 dom 可带 www./尾点,
  // raw 键进 human_tasks 与账本/选品的 canon 键对不上(跨表键不一致)。
  // 非法域响亮失败、不入队 —— 静默写入脏键比不入队更糟。
  try {
    dom = dbw.canonDomain(dom);
  } catch (ce) {
    console.log(`[${dom}] ❌ 转人工队列拒绝:域名无法规范化(${String(ce.message || ce).slice(0, 80)}),不入队`);
    return false;
  }
  try {
    const payload = JSON.stringify({ fields: {
      name: VALUES.submitter, email: VALUES.email, url: VALUES.url,
      comment: (KIT.copy && KIT.copy.descriptions && (KIT.copy.descriptions.s_150 || [])[0]) || VALUES.tagline,
    } });
    if (blocker === 'delivery_ambiguous') {
      // 【08-11 十三轮评审 P2】单事务检查“总账仍 ambiguous + 无同类 pending”后入队。
      // delivered 已先升级时不补 stale task；两个终端观察者并发也只会有一条 pending。
      // 4×30s busy_timeout + 3×5s 退避最坏约 135s，必须小于看门狗触发后到
      // rolling_submit 15 分钟硬杀所剩的约 180s，确保失败标记与退出码来得及落盘。
      const attempts = Math.max(1, Number(retry.attempts || 4));
      const backoffMs = Math.max(0, Number(retry.backoffMs == null ? 5000 : retry.backoffMs));
      let r = null, lastErr = null;
      for (let i = 0; i < attempts; i++) {
        try {
          r = dbw.ensureDeliveryAmbiguousTask({
            domain: dom, url: safePgUrl(), guidance, payload,
          });
          break;
        } catch (e) {
          lastErr = e;
          if (!/locked|busy/i.test(String(e && e.message))) throw e;
          console.log(`[${dom}] ambiguous 人工任务入队撞锁,退避重试(${i + 1}/${attempts})`);
          if (i + 1 < attempts) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs);
          }
        }
      }
      if (!r) throw new Error(`HUMAN_TASK_ENQUEUE_FAILED: 重试后仍败: ${String(lastErr && lastErr.message).slice(0, 120)}`);
      if (!r.id) {
        const cur = dbw.currentStatus(dom);
        if (cur && cur.status === 'delivery_ambiguous') {
          throw new Error('HUMAN_TASK_ENQUEUE_FAILED: 总账仍 ambiguous 但任务未创建');
        }
        console.log(`[${dom}] delivery_ambiguous 人工任务未入队(总账已升级)`);
        return false;
      }
      console.log(`[${dom}] 🧑 ${r.queued ? '转人工队列' : '复用人工队列'} #${r.id}(不等待,继续下一站;见 human_tasks.jsonl)`);
      return true;
    }

    // upload/captcha 等既有人机协同保持原通用入队语义；只有 ambiguous
    // 需要额外核对总账终态，不能把这一新约束扩散到其他 blocker。
    const r = dbw.humanTaskAdd({
      domain: dom, url: safePgUrl(), blocker, guidance, payload,
    });
    console.log(`[${dom}] 🧑 转人工队列 #${r.id}(不等待,继续下一站;见 human_tasks.jsonl)`);
    return true;
  } catch (e) {
    if (blocker === 'delivery_ambiguous') {
      // ambiguous 会被选品永久排除；任务写不进必须响亮且非零退出，不能永久沉默。
      console.error(`[${dom}] DELIVERY_AMBIGUOUS HUMAN_TASK_ENQUEUE_FAILED ${String(e.message || e).slice(0, 120)}`);
      process.exitCode = 43;
    } else {
      console.log(`[${dom}] 转人工队列异常:${String(e.message || e).slice(0, 80)}`);
    }
    return false;
  }
}

// 新目录注册必须是命令行上的逐站显式授权。故意不提供全局布尔开关或持久环境变量,
// 避免上一任务的宽授权泄漏到下一任务。可重复传:
//   --approve-registration exact-directory.example
function registrationApproved(dom, argv = process.argv) {
  let wanted;
  try { wanted = dbw.canonDomain(dom); } catch { return false; }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--approve-registration' || !argv[i + 1]) continue;
    try {
      if (dbw.canonDomain(argv[i + 1]) === wanted) return true;
    } catch { /* 非法批准值按未批准处理,fail closed */ }
  }
  return false;
}

/** 只认已经完整保存的邮箱/密码账号。pass:null 的 fork 占位不是可登录账号。 */
function storedCredentials(dom) {
  const key = credsFile.accountKey(dom, PSLUG);
  const row = credsFile.get(key);
  if (!row || !row.pass || !(row.email || row.user)) return null;
  return { key, email: String(row.email || ''), user: String(row.user || ''), pass: String(row.pass) };
}

/**
 * 未批准新注册的唯一终端:先入人工任务,再写 blocked + reason_code,最后抛出让主循环停站。
 * 绝不能在调用本函数之前生成密码、写 creds 或触碰 signup/OAuth DOM。
 */
function registrationApprovalStop(dom, detail) {
  const why = String(detail || '站点需要创建新目录账号').slice(0, 220);
  const queued = queueForHuman(dom, 'needs_registration_approval',
    `目录站 ${dom} 需要创建新账号(${why})。请 captain 单独审核该精确站点;批准后仅在该次命令传 `
    + `--approve-registration ${dom}。批准前不要填写/提交 signup,不要点击 Google/OAuth,不要写新 creds。`);
  const r = upsert(dom, 'blocked', `needs_registration_approval:${why}`,
    '新目录注册未获逐站批准,已停止且未触碰 signup',
    { reason_code: 'needs_registration_approval' });
  const e = new Error(`NEEDS_REGISTRATION_APPROVAL ${dom}: ${why}`);
  e.registrationApprovalRequired = true;
  e.queued = queued;
  e.stateWritten = Boolean(r && (r.written || r.to === 'blocked'));
  throw e;
}

function registrationIntentFromText(value) {
  const t = String(value || '').trim();
  return /(?:\bsign[-_\s]*up\b|\bcreate\s+(?:(?:an?|your|new)\s+)?account\b|\bjoin\s+(?:now|free)\b|\bregister\s+(?:account|now|free)\b|\bregister\b\s*$|\b(?:continue|sign\s*in|log\s*in)\s+with\s+(?:google|x|twitter|github|microsoft|apple)\b|\bgoogle\s*(?:oauth|account)\b|(?:^|[/?#=&_.-])(?:sign[-_]?up|register|create[-_]?account|oauth|auth\/(?:google|twitter|github|microsoft|apple))(?:[/?#=&_.-]|$)|注册(?:账号)?|创建账号|谷歌(?:授权|登录))/i.test(t);
}

/** 同时看按钮、href 与最近表单,拦住 target=b0 这类没有语义的 LLM 点击。 */
async function registrationIntentFromElement(el, target) {
  if (registrationIntentFromText(target)) return true;
  try {
    const meta = await el.evaluate((node) => {
      const form = node.closest && node.closest('form');
      return {
        text: `${node.innerText || node.value || ''} ${node.getAttribute?.('aria-label') || ''}`,
        href: node.getAttribute?.('href') || '',
        formText: form ? (form.innerText || '').slice(0, 600) : '',
        accountForm: Boolean(form && form.querySelector('input[type=password]')
          && form.querySelector('input[type=email],input[name*=mail i],input[name*=user i]')),
      };
    });
    const combined = `${meta.text || ''} ${meta.href || ''}`;
    if (registrationIntentFromText(combined)) return true;
    return Boolean(meta.accountForm
      && /sign\s*up|register|create\s+(?:(?:an?|your|new)\s+)?account|注册|创建账号/i.test(meta.formText || ''));
  } catch { return false; }
}

/** 只在真实终端仍为 ambiguous 时入队；writer 会在 delivered 升级时自动关闭。 */
function queueAmbiguousTerminal(dom, detail, retry) {
  return queueForHuman(dom, 'delivery_ambiguous',
    `submit 已派发但终局未定(${String(detail || '').slice(0, 160)})。`
    + `**要做的只有一件事:去 ${dom} 上看我们的链接在不在。**`
    + `在(且是 dofollow)→ 标成功:`
    + `node -e "import('./state.mjs').then(d=>d.upsertSubmission({domain:'${dom}',status:'success',source:'human',reason_code:'published'}))"`
    + `(其实 \`node verify_link.mjs --pending --update-status\` 会自动做这件事,人工只是提前确认)。`
    + `不在、或看不出来 → **什么都别动**。这个域会一直停在这里,不会被自动重投 —— 那正是我们要的:`
    + `它可能已经投达了,再投一次就是重复提交。少一个目标域的代价,远小于给站方发两份。`,
    retry);
}


// email_otp 动作:从 agent 邮箱取该站的验证码/验证链接
function link_preview(r) {
  try { const u = new URL(r.slice(12)); return u.hostname + u.pathname.slice(0, 30); }
  catch { return '(地址解析失败)'; }
}

// 本 run 的起跑时刻(emailOtp 只认这之后的来信,防读上次的死码)
let RUN_STARTED = null;

// ---- 验证链接浏览器侧带闸打开(2026-08-10)----
// 魔法链接登录的 session 只落在"打开链接的那个客户端"里:curl_cffi 服务端点开
// 等于白点(浏览器还是未登录),而且一次性 token 被我们自己提前烧掉。
// 所以链接要在 agent 自己的页面里 goto —— 但闸必须跟 mail_sweeper.safe_get 同级:
// 每一跳(含重定向)host 都必须在白名单里,出名单即 abort,token 永远出不了域。
// 【08-11 修】中转/落点分开判(与 mail_sweeper.safe_get 同语义):
//   中转(hop)  = 站方根域及子域 ∪ ESP 跳转域;
//   落点(final)= 只认站方域且路径含验证关键词,唯一例外 supabase.co/auth/。
//   旧实现落点也走 hop 名单,停在任意 ESP 域都算成功,与 safe_get 分叉。
// 白名单唯一来源 scripts/esp_hosts.json(与 mail_sweeper 同一份,别分叉)。
async function gatedOpen(pg, url, siteRoot) {
  // 用 page.route(页级,不碰共享 context):CDP 模式连着协作浏览器,context 级路由会误杀用户的页面
  let blockedBy = '';
  const guard = async (route) => {
    try {
      const req = route.request();
      const u = new URL(req.url());
      // 【08-11 P1-新4】route('**/*') 会拦到页面的一切子资源(Google Fonts/GA/jsDelivr…),
      // 这些第三方域本就不在白名单 —— 旧实现把它们也置 blockedBy,而 blockedBy 在最终落点
      // 检查之前判负,于是几乎每个验证链接都被冤枉成"跳转链出域"。
      // 现在:blockedBy 只记**导航请求**(document);子资源出域照旧 abort(安全闸语义不变),
      // 只是不再污染判定。userinfo 伪装规则同样只在导航时置 blockedBy,子资源静默拦。
      const isNav = req.isNavigationRequest() || req.resourceType() === 'document';
      // 【08-11 三轮评审 2】第三方 iframe 的 document 请求同样满足 isNavigationRequest():
      // iframe 跳出白名单的导航照旧 abort(安全闸语义不变),但不得置 blockedBy ——
      // 否则页面内嵌的任意第三方 iframe 都会把验证链接冤枉成"跳转链出域"。
      // blockedBy 只记主框架导航。frame() 个别请求会抛(service worker 等)。
      // 【08-11 四轮评审 P2-4 修】判不出主框架时按**非主框架**处理:isMainFrame 只影响
      // blockedBy 记不记、不影响拦不拦(下面两个 abort 都在 if 之外),所以保守方向是
      // false —— 默认 true 会把判不出的请求冤枉成"跳转链出域"(误报),false 不损失安全性。
      let isMainFrame = false;
      try { isMainFrame = req.frame() === pg.mainFrame(); } catch { /* 保守:按非主框架处理(abort 照旧) */ }
      if (u.username || u.password) {
        if (isNav && isMainFrame) blockedBy = 'userinfo 伪装:' + u.hostname;
        return route.abort();
      }
      if (!wd.hostAllowed(u.hostname, siteRoot)) {
        if (isNav && isMainFrame) blockedBy = u.hostname;
        return route.abort();
      }
    } catch { /* 解析不了的(data:/about:)放行,不携带我们的 token */ }
    return route.continue();
  };
  await pg.route('**/*', guard);
  try {
    const resp = await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    await pg.waitForTimeout(2500);
    const finalUrl = pg.url();
    let fh = '';
    try { fh = new URL(finalUrl).hostname; } catch {}
    if (blockedBy) return { ok: false, why: `跳转链出域被拦:${blockedBy}` };
    if (!wd.hostAllowed(fh, siteRoot, 'final', finalUrl)) {
      return { ok: false, why: `最终落点 ${fh}${new URL(finalUrl).pathname || ''} 不是 ${siteRoot} 的验证页(phase=final)` };
    }
    return { ok: true, status: resp && resp.status(), finalUrl };
  } finally {
    await pg.unroute('**/*', guard).catch(() => {});
  }
}
// 【08-11 七轮评审 P1】主入口 goto 的同根域导航闸(镜像 gatedOpen 的页级 route 模式):
// 发现出的入口 URL(HTML 链接/sitemap/LLM submit_url)即使过了 validateUrl,页面仍可在
// goto 期间 302 跳走 —— 恶意页一条重定向就能把浏览器带到 127.0.0.1/内网。
// goto 期间挂页级路由:主框架导航(host 出 allowedRoot 根域 / userinfo 伪装 / 内网目标)
// 一律 abort;子资源不拦(正式提交要加载站点自身的 JS/CSS,且出域子资源不带凭据)。
// 【08-11 八轮评审 P1-3 修】主框架导航校验升全档:与 curlGet/findEntry 同用
// og.validateUrl(lite + 本地 DNS 预检)。旧 lite 只挡 IP 字面量,302 到**解析为**
// 169.254.169.254/127.0.0.1/10.x 的主机名照样放行(完整 SSRF + observe 外泄链);
// route handler 本是 async,DNS 开销只在导航跳,可忽略。
// 【08-11 八轮评审 P2-2 修】闸戴过加载后等待再摘:meta-refresh/JS 跳转发生在
// domcontentloaded 之后,旧实现 finally 立刻 unroute,晚跳转裸奔、落点无人复核。
// 镜像 gatedOpen:守过 2500ms 等待,摘闸前复核最终落点;落点不合规返回
// { ok:false, why },调用方按"入口不可达"处理(主入口直接 throw,外层 catch 记 blocked)。
// 返回 { ok, resp?, why? }(goto 本身抛错仍原样上抛)。
async function gotoGuarded(pg, url, allowedRoot, opts) {
  const guard = async (route) => {
    try {
      const req = route.request();
      if (!req.isNavigationRequest()) return route.continue();
      // 判不出主框架时按非主框架放行:iframe 导航出域是常态(第三方登录/分享框),
      // 拦截面只收窄到主框架,安全性由 goto 前的 validateUrl 和这里的首跳/每跳校验保证。
      let isMainFrame = false;
      try { isMainFrame = req.frame() === pg.mainFrame(); } catch { /* 保守:按非主框架放行 */ }
      if (!isMainFrame) return route.continue();
      const reqUrl = req.url();
      // 非 http(s)(data:/about:)放行,不携带凭据;validateUrl 对它们一律判 null,
      // 不放前面这道会连 about:blank 都 abort 掉。
      if (!/^https?:/i.test(reqUrl)) return route.continue();
      const v = await og.validateUrl(reqUrl, { allowedRoot });
      if (!v) {
        let h = ''; try { h = new URL(reqUrl).hostname; } catch {}
        console.log(`[${allowedRoot}] 导航闸:主框架跳 ${h || reqUrl.slice(0, 60)} 出根域/解析到内网被拦`);
        return route.abort();
      }
    } catch { /* 解析不了的放行,不携带凭据 */ }
    return route.continue();
  };
  await pg.route('**/*', guard);
  try {
    const resp = await pg.goto(url, opts);
    await pg.waitForTimeout(2500);   // 闸内等待:拦住 load 后的 meta-refresh/JS 晚跳转
    const fin = await og.validateUrl(pg.url(), { allowedRoot });
    if (!fin) return { ok: false, why: `导航闸:最终落点 ${pg.url().slice(0, 120)} 出根域/解析不合规,按入口不可达处理` };
    return { ok: true, resp };
  } finally {
    await pg.unroute('**/*', guard).catch(() => {});
  }
}
// 站方根域(PSL 口径,rootdomain.mjs —— 与 mail_sweeper.py 的 rootdomain.py
// 同一份 PSL 数据、同一套规则,别各写一份)
function siteRootOf(dom) {
  try { return rootDomain(dom) || dom; } catch { return dom; }
}
// defer 标记:本 run 期间该域的验证信由浏览器接管,服务端(sweeper)只校验不点开,
// 免得一次性 token 被 curl_cffi 提前烧掉。TTL 靠 mtime,sweeper 侧超 20 分钟就无视。
function deferMark(dom) {
  try {
    const dir = path.join(HERE, 'run', 'agent_defer');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/${siteRootOf(dom)}`, String(Date.now()));
  } catch {}
}

function emailOtp(dom) {
  // 【2026-07-29 改】原实现直接 exec agently-cli —— 也就是**只读 QQ 信箱**。
  // 注册身份换成产品联系邮箱(如 contact@<产品域>,转发进 AgentMail 信箱)
  // 之后,验证码会落到 AgentMail 而这里还在 QQ 里找,每个需要填验证码的站
  // 都会卡在"未找到来信"直到步数烧完。换身份和换取信通道必须同时做。
  //
  // 改为委托 scripts/read_otp.py:它复用 mail_sweeper 的 list_msgs/read_msg,
  // **双信箱都读**,而且匹配规则用的是 mail_sweeper 那版严格匹配
  // (这里原来拿 domBare.split('.')[0] 配主题,对 ai.tools 会退化成 "ai",
  //  主题里带 ai 的信全被认成这个站的 —— agent 可能把别人的验证码填进表单)。
  // 【2026-07-30 再加 --since】同站旧验证码信会留在箱子里,不过滤会把上一次的
  // 死码填进新注册(foundrlist 实证:07-28 旧码进 07-30 注册,otp_expired)。
  try {
    const args = [path.join(HERE, 'read_otp.py'), '--domain', dom];
    if (RUN_STARTED) args.push('--since', RUN_STARTED);
    const out = execFileSync(PY_BIN, args, { timeout: 120000 }).toString().trim();
    return out || '取信脚本没有输出';
  } catch (e) {
    // exit 2 = 没找到(不是故障),脚本已把人话写在 stdout 上
    const so = (e.stdout && e.stdout.toString().trim()) || '';
    if (e.status === 2 && so) return so;
    return `取信失败:${String(e.message).slice(0, 80)}`;
  }
}

function llmKey() {
  // 【修】原来每次调用都 load() 一次:endpoint 在模块加载时就冻结了(LLM_ENDPOINT 常量),
  // key 却是实时读的 —— run 期间改配置(或换 llm.json)会把**新供应商的 key 发给旧 endpoint**。
  // 现在用模块加载时那一份,与 endpoint 同源同时刻;缺 key 的人话指引照旧。
  if (!LLM.key) llmcfg.requireLlm('agent_submit');   // 只为抛出带指引的错误
  return LLM.key;
}

// 降级链。**只放实测可用的** —— 2026-07-27 实测 gpt-5.6 返回 400(模型名已下线)、
// grok-4.5 返回 403(额度用尽),它们留在链里的唯一作用就是让每次主模型抖动
// 都白等两轮握手才轮到真能用的 claude。
// 加回来之前请先用 scripts/check_llm.py 实测。
const MODEL_FALLBACKS = LLM.models.slice(1);
/** LLM 调用记账。
 *
 * ⚠️ 2026-07-27 审查 #9:这个文件原来**一分钱不记** —— 1643 个 LLM-in-loop 步全没入账。
 * 单价是估算口径($0.003/次,对账以你的 LLM 提供商账单为准)。
 */
let CURRENT_DOM = null;      // 主流程拿到域名后设一次,给记账归属用
function billLLM(dom, kind) {
  // 单价是估算($0.003/次,vision $0.006),对账以你的 LLM 提供商账单为准;
  // 口径与生产版一致,日预算/成本盘点读 costs.jsonl。
  try {
    dbw.recordCost({ provider: 'llm', job: 'agent_submit', domain: dom || null,
                     amount_usd: kind === 'vision' ? 0.006 : 0.003, is_actual: 0,
                     note: kind });
  } catch { /* 记账失败不能挡住正事 */ }
}

async function llmOnce(model, messages, jsonMode) {
  const r = await fetch(LLM_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + llmKey() },
    body: JSON.stringify({ model, messages, ...(jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
  });
  const j = await r.json();
  if (j.error) throw new Error('LLM: ' + JSON.stringify(j.error).slice(0, 150));
  billLLM(CURRENT_DOM, jsonMode ? 'json' : 'text');
  return j.choices[0].message.content;
}
// 【08-05 实证】账号级限流(rate_limit_error)/上游网络抖动(upstream_network_error)
// 是瞬态基建错误:降级链同账号全军覆没,抛出去还被顶层 catch 标 blocked 永烧目标域。
// 识别出来给调用方退避重试的机会。
const LLM_TRANSIENT = /rate_limit|upstream_network|overloaded|ETIMEDOUT|ECONNRESET|socket hang up|\b429\b/i;
function llmTransient(e) { return LLM_TRANSIENT.test(String(e && e.message)); }

async function llm(messages, jsonMode = true) {
  // 主模型挂了就按序降级(用户 2026-07-25 授意:gpt 不正常可切 sonnet/grok)
  let lastErr = null;
  for (const m of [MODEL, ...MODEL_FALLBACKS]) {
    try {
      return await llmOnce(m, messages, jsonMode);
    } catch (e) {
      lastErr = e;
      // claude 系不支持 json_object,同模型降级为自由文本再试一次
      if (jsonMode && /response_format|json_object/i.test(String(e.message))) {
        try { return await llmOnce(m, messages, false); } catch (e2) { lastErr = e2; }
      }
      console.log(`[llm] ${m} 失败(${String(lastErr.message).slice(0, 60)}),降级下一模型`);
      // 限流/上游抖动:换模型无用(同账号),直接中断降级链交给外层退避
      if (llmTransient(lastErr)) break;
    }
  }
  throw lastErr;
}

// 视觉诊断:失败僵持时给 LLM 看截图
async function llmVision(pg, question) {
  const png = `/tmp/agent_vision_${Date.now()}.png`;
  await pg.screenshot({ path: png });
  const b64 = fs.readFileSync(png).toString('base64');
  return llm([
    { role: 'system', content: SYSTEM + advisoryNote() },
    { role: 'user', content: [
      { type: 'text', text: question + '\n看这张当前页面截图回答。' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
    ] },
  ]);
}

// ---------- 页面观察 ----------
async function observe(pg) {
  return pg.evaluate(() => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const inputs = [...document.querySelectorAll('input,textarea,select')]
      .filter(vis).slice(0, 30).map((el, i) => {
        const lab = el.labels && el.labels[0] ? el.labels[0].innerText :
          (el.closest('label')?.innerText || el.parentElement?.innerText || '').slice(0, 50);
        return {
          i: (el.tagName === 'SELECT' ? 's' : 'i') + i, tag: el.tagName.toLowerCase(), type: el.type || 'text',
          name: el.name || '', ph: (el.placeholder || '').slice(0, 40), label: lab.trim().slice(0, 50),
          required: el.required, value: (el.value || '').slice(0, 30), inForm: !!el.closest('form'),
          files: el.type === 'file' ? el.files.length : undefined,
          options: el.tagName === 'SELECT' ? [...el.options].map(o => o.textContent.trim()).slice(0, 15) : undefined,
        };
      });
    const buttons = [...document.querySelectorAll('button,[role=button],input[type=submit]')]
      .filter(vis).slice(0, 20).map((el, i) => ({
        i: 'b' + i, text: (el.innerText || el.value || '').trim().slice(0, 40), inForm: !!el.closest('form'),
      }));
    const iframes = [...document.querySelectorAll('iframe')].map(f => f.src.slice(0, 100));
    // 【2026-07-29】document.body 在 about:blank/跳转中/页面崩溃时是 null,
    // 裸读 innerText 直接 TypeError 中断整个投放(#30 两站同签名崩溃实证)。
    // 本文件所有单行 evaluate 统一加同样的空守卫。
    const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 1200);
    // 未完成的必办清单:空必填/未勾必选/未选必下拉,直接喂给决策端
    const todo = [];
    document.querySelectorAll('input[required],textarea[required],select[required]').forEach(el => {
      if (el.type === 'checkbox' && !el.checked) todo.push('未勾必选checkbox: ' + ((el.closest('label')?.innerText || el.name || '').slice(0, 40)));
      else if (el.tagName === 'SELECT' && !el.value) todo.push('未选必选下拉: ' + ((el.closest('label')?.innerText || el.name || '').slice(0, 40)));
      else if (['text','email','url','textarea','number'].includes(el.type || 'text') && !el.value) todo.push('未填必填: ' + ((el.closest('label')?.innerText || el.placeholder || el.name || '').slice(0, 40)));
    });
    // 验证码显性提示(2026-07-29):reCAPTCHA/Turnstile 在场时,仅靠在 iframes 里露脸,
    // LLM 会漏看、直接点提交 —— 服务端 200 回"check the security reCAPTCHA box"照样
    // 拒收(#30 两站实证)。写进必办清单,让决策端无法忽视。
    if (document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]')
        || (window.___grecaptcha_cfg && Object.keys(window.___grecaptcha_cfg.clients || {}).length))
      todo.push('⚠ 页面有 reCAPTCHA:点提交前必须先执行 captcha_recaptcha 注入 token,否则服务端必拒');
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile'))
      todo.push('⚠ 页面有 Turnstile:点提交前必须先执行 captcha_turnstile 注入 token,否则服务端必拒');
    return { url: location.href, title: document.title, inputs, buttons, iframes, text, todo };
  });
}

// ---------- 动作执行 ----------
// 【08-05 群友技巧/wix 实证】评论区懒加载要分段触发:一滚到底会跳过 IntersectionObserver
// 触发区,评论永远不出来(wix 系大面积如此)。20→40→60→80→100%,每段停 1s。
async function progressiveScroll(pg) {
  for (const pct of [0.2, 0.4, 0.6, 0.8, 1.0]) {
    await pg.evaluate((p) => window.scrollTo(0, Math.floor(
      (document.body ? document.body.scrollHeight : 0) * p)), pct);
    await pg.waitForTimeout(1000);
  }
}

// 【08-06 排期实证】JS 渲染评论表单:捷克杂志系(samsungmagazine/androidmagazine)的
// 评论表单不在初始 DOM,要点「写评论」触发器才挂载;零审核自动公开,是肥肉。
// reveal_form:找评论触发器(多语)→ 点击 → 等 2.5s JS 挂载 → 报告新控件数。
async function revealForm(pg) {
  const TRIGGER = /comment|reply|respond|discuss|koment|kommentar|comentar|评论|留言|回应|распис|React|add your|write a|leave a/i;
  const before = await pg.evaluate(() =>
    document.querySelectorAll('input,textarea,select').length).catch(() => 0);
  // 【08-06 实测】第一招:评论区容器 collapsed/display:none(samsungmagazine 实证
  // section#comments.collapsed 藏表单)——直接 JS 展开,比找触发器可靠。
  const expanded = await pg.evaluate(() => {
    let n = 0;
    const els = [...document.querySelectorAll(
      'section#comments, .comments, .comments-area, #comments, #respond, .comment-respond, [id*=comment], [class*=comment]')];
    for (const el of els) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.classList.contains('collapsed')) {
        el.style.display = 'block'; el.style.visibility = 'visible';
        el.classList.remove('collapsed'); n++;
      }
    }
    return n;
  }).catch(() => 0);
  if (expanded) {
    await pg.waitForTimeout(800);
    const now = await pg.evaluate(() =>
      [...document.querySelectorAll('input,textarea,select')]
        .filter(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)).length).catch(() => 0);
    if (now > 0) return `展开了 ${expanded} 个折叠评论容器,可见控件 ${before}→${now}`;
  }
  const clicked = await pg.evaluate((re) => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const RE = new RegExp(re, 'i');
    const els = [...document.querySelectorAll('button,a,[role=button],input[type=submit],summary')]
      .filter(vis);
    for (const el of els) {
      const t = ((el.innerText || el.value || '') + ' ' + (el.id || '') + ' ' + (el.className || '')).slice(0, 80);
      if (RE.test(t) && !/login|sign|share|social|search/i.test(t)) {
        el.scrollIntoViewIfNeeded?.(); el.click(); return t.trim().slice(0, 60);
      }
    }
    return null;
  }, TRIGGER.source).catch(() => null);
  if (!clicked) return '没找到评论触发器';
  await pg.waitForTimeout(2500);
  const after = await pg.evaluate(() =>
    document.querySelectorAll('input,textarea,select').length).catch(() => 0);
  return `点了「${clicked}」,控件 ${before}→${after}`;
}

export async function actImpl(pg, a, dom) {
  switch (a.action) {
    case 'reveal_form':
      return await revealForm(pg);
    case 'fill_many': {
      // 【2026-07-28 加】批量填充。实测数据:耗尽步数的 29 个站里,**36% 的步数花在 fill 上**,
      // 而每步只填一个字段;已核验站的表单字段数中位数 5、75 分位 10、最大 20 ——
      // 光填表就吃掉一半步数预算,真正决定成败的"点提交、过验证、看回执"反而没步数了。
      // 对照:成功案例最多只用了 13 步,而失败的是耗尽 24 步。
      //
      // 一次填一组,复用单字段那套逻辑(maxlength 适配、逐字敲、描述槽位换变体),
      // 所以不会因为"批量"就退化成粗暴的 el.fill()。
      const items = Array.isArray(a.fields) ? a.fields : [];
      if (!items.length) return '批量填失败:fields 为空';
      const done = [], failed = [];
      for (const it of items.slice(0, 25)) {
        const tgt = it.target || it.t;
        const val = it.value || it.v;
        if (!tgt || val === undefined) { failed.push(`${tgt || '?'}(缺参数)`); continue; }
        const r = await act(pg, { action: 'fill', target: tgt, value: val }, dom);
        const rText = r.text;   // act 结构化返回(十四轮 P2-3),判定/日志都用 .text
        (/失败/.test(rText) ? failed : done).push(`${tgt}${/失败/.test(rText) ? '(' + rText.slice(0, 20) + ')' : ''}`);
      }
      return `批量填 ${done.length}/${items.length} 成功` +
             (done.length ? `:${done.join(',')}` : '') +
             (failed.length ? ` | 失败:${failed.join(',')}` : '');
    }
    case 'fill': {
      const el = await locate(pg, a.target);
      if (!el) return `填失败:找不到 ${a.target}`;
      let v = resolveValue(a.value);
      // 【2026-07-26 加】按字段容量适配。原来一律填 descriptions.*[0],从不看 maxlength ——
      // 站方设了 maxlength 时浏览器**静默截断**,句子被切一半就提交上去了。
      // 实测 kit 里每条描述都超出自己标称的字数(m_300 实为 354-388、l_510 实为 524-533),
      // 所以这不是理论风险。
      const cap = await el.evaluate((e) => {
        const m = e.getAttribute('maxlength');
        const n = m ? parseInt(m, 10) : NaN;
        return Number.isFinite(n) && n > 0 ? n : 0;
      }).catch(() => 0);
      // ⚠️ 换变体**只对描述类槽位**有效:pickFitting 返回的是描述文案,
      // 拿它替换超长的 tagline/name/url 会填进完全错误的内容(Codex 2026-07-26 [P1])。
      // 判定看的是 a.value(槽位名),不是 a.target(页面控件序号)。
      const isDesc = /^desc(_|$)|description/i.test(String(a.value || ''));
      let fitNote = '';
      if (cap && v.length > cap) {
        const fitted = isDesc ? pickFitting(cap) : null;
        if (fitted !== null) { v = fitted; fitNote = ',已换用装得下的描述变体'; }
        else { v = trimToWord(v, cap); fitNote = ',按词边界截断'; }
      }
      // 双落点(借鉴经验帖):站方常把 url 字段渲染成 nofollow 跳转,但描述里的裸 URL
      // 会被保留成纯文本。描述字段有余量时把域名带上,多一个落点。
      if (cap && isDesc) {
        const mention = ` ${VALUES.url}`;
        if (v.length + mention.length <= cap && !v.includes(VALUES.url)) v += mention;
      }
      // ⚠️ 红线必须校验**最终值**:原实现在变换之前测,换出来的变体或追加内容
      // 若命中 forbidden_claims 就会绕过闸门直接落表单(Codex 2026-07-26 [P1])。
      if (FORBIDDEN.test(v)) return `红线拦截:值含 forbidden_claims`;
      try {
        await humanFill(pg, el, v);
      } catch (e) {
        // 【2026-07-29】LLM 偶把文案/URL 当 target 传进来,locate 盲匹配到提交按钮等
        // 不可填元素,el.fill 抛异常 —— 原来直接打穿整个 run(#31 unrola/coles 实证,
        // 同签名还有 #30 saasui.design)。降级成普通失败步,决策端下一步自己换目标。
        return `填失败:${String(e.message).slice(0, 90)}(目标 ${a.target},值槽 ${String(a.value).slice(0, 30)})`;
      }
      // 【2026-07-31】评论类内容回填可审性:textarea(评论正文)把实填内容回显进日志,
      // 便于抽查"agent 到底写了什么"(质量第一位);密码框绝不回显。
      const isPw = await el.evaluate(e => e.type === 'password').catch(() => false);
      const preview = (!isPw && (await el.evaluate(e => e.tagName === 'TEXTAREA').catch(() => false)))
        ? `:"${v.slice(0, 90)}${v.length > 90 ? '…' : ''}"` : '';
      return `已填 ${a.target}${preview}${cap ? `(cap=${cap},实填 ${v.length} 字${fitNote})` : ''}`;
    }
    case 'click': {
      // Sign up/Register/OAuth 都可能创建新账号。LLM prompt 只是第一道提示,
      // 这里在任何 DOM 点击前做代码硬闸,防止模型用通用 click 绕过 register 动作。
      if (registrationIntentFromText(a.target) && !registrationApproved(dom)) {
        registrationApprovalStop(dom, `未批准的新账号入口点击:${String(a.target || '').slice(0, 80)}`);
      }
      const el = await locate(pg, a.target, true);
      if (!el) {
        // 【2026-07-30】text= 兜底:Google 账号选择器这类行不是 button/input,
        // locate 按表单控件找永远找不到(实证:看得见 ten tent…@gmail.com 就是点不到)。
        // 人能看见的字就按字点,作为 locate 失败后的最后一条路。
        try {
          // 【08-11 十三轮评审 P1-2】先拿到 text locator 的真实命中元素再分类。
          // target 文案不能把 <a href="/submit"> 这类导航入口升级成真实提交。
          // 【08-11 十四轮 P2-6】先 count 再分类:零命中直接报找不到,
          // 别让 Locator.evaluate 干等 30s 默认超时。
          const textEl = pg.locator(`text=${JSON.stringify(String(a.target))}`).first();
          if (await textEl.count() === 0) return actionResult(`点失败:找不到 ${a.target}`);
          if (await registrationIntentFromElement(textEl, a.target) && !registrationApproved(dom)) {
            registrationApprovalStop(dom, `未批准的新账号入口点击:${String(a.target || '').slice(0, 80)}`);
          }
          const textSubmit = await isSubmitClassClick(textEl, a.target);
          if (textSubmit && !claimDelivery(dom, `text 兜底点击 ${a.target}`)) {
            return actionResult(`已有投递认领/投达终局,text 兜底不重复点提交类文案 ${a.target} → 交观察流判定`, true, false);
          }
          await textEl.click({ timeout: 2500 });
          await pg.waitForTimeout(2500);
          return actionResult(`已点(text兜底${textSubmit ? '·提交类,单次派发' : '·非提交类'}) ${a.target}`, textSubmit, textSubmit);
        } catch (e) {
          if (e && e.ledger) throw e;
          return actionResult(`点失败:找不到 ${a.target}`);
        }
      }
      if (await registrationIntentFromElement(el, a.target) && !registrationApproved(dom)) {
        registrationApprovalStop(dom, `未批准的新账号入口点击:${String(a.target || '').slice(0, 80)}`);
      }
      if (pg._recaptchaToken) {
        const inCaptchaForm = await el.evaluate(e => {
          const f = e.closest('form');
          if (!f || !/^(INPUT|BUTTON)$/.test(e.tagName)) return false;
          return !!f.querySelector('.g-recaptcha,[name=g-recaptcha-response],[name=g-recaptcha-response-widget]');
        }).catch(() => false);
        if (inCaptchaForm) {
          // 【08-11 十一轮评审 P1-7】fetch 直送 = 对外 POST 提交,派发前先落投递认领;
          // 认领写不进(账本故障)就抛 e.ledger 不派发,fail-closed。
          // 【08-11 十二轮评审 P2-3】已有认领/投达终局时不许重复直送(重复 POST)。
          if (!claimDelivery(dom, 'reCAPTCHA fetch 直送表单 POST')) {
            return actionResult(`已有投递认领/投达终局,禁止重复 fetch 直送表单 POST → 交观察流判定`, true, false);
          }
          const r = await el.evaluate(async (e, t) => {
            const form = e.closest('form');
            const fd = new FormData(form);
            fd.set('g-recaptcha-response', t);
            fd.delete('g-recaptcha-response-widget');
            // phpLD 等老模板靠提交按钮字段(submit=Continue)判定「真提交」,
            // 漏了会静默重渲表单、连个报错都不给(实测)。必须补上。
            const btn = form.querySelector('input[type=submit][name],button[type=submit][name]');
            if (btn) fd.append(btn.name, btn.value || '1');
            const resp = await fetch(form.action, { method: (form.method || 'POST').toUpperCase(), body: fd, credentials: 'include' });
            const body = (await resp.text()).slice(0, 3000);
            const txt = body.replace(/\s+/g, ' ');
            return { status: resp.status,
                     // 拒词要具体到文案:「captcha」会撞上页面重渲时的 api.js 脚本标签(误报过)
                     rejected: /go.?back|check the security|incorrect-captcha|reCAPTCHA box|请勾选/i.test(txt),
                     body,
                     head: txt.slice(0, 150) };
          }, pg._recaptchaToken).catch(() => null);
          if (r) {
            const receiptStatus = classifyReceiptText(htmlText(r.body));
            if (receiptStatus && !r.rejected) pg._recaptchaToken = null;
            return actionResult(`fetch直送提交(${r.status})${r.rejected ? '→仍被拒:' + r.head.slice(0, 80) : receiptStatus ? `→受理(${receiptStatus})` : '→未知:' + r.head.slice(0, 80)}`, true, true);
          }
        }
      }
      // 【08-11 十一轮评审 P1-6/P1-7】submit 类控件 single-shot:Playwright click()
      // 可能已派发点击/POST 后才因导航等待超时 reject,旧代码 catch 里再
      // el.evaluate(e => e.click()) 就是第二次提交(重复投递)。现在:派发前先落
      // 投递认领;只点一次;返回异常 = 结果不明,交下一轮 observe/LLM 判定
      // (看到回执→成功,看到校验错误→blocked 也会被守卫拦成 delivery_ambiguous),
      // 绝不盲点第二次。非提交类控件维持原 DOM 兜底(导航/展开类双击无害)。
      if (await isSubmitClassClick(el, a.target)) {
        // 【08-11 十二轮评审 P2-3】single-shot 教义补完:认领被拒(本进程已派发过,
        // 或上一轮的认领行/投达终局还在)= 绝不再点第二次,交观察流。
        if (!claimDelivery(dom, `点击提交 ${a.target}`)) {
          return actionResult(`已有投递认领/投达终局,禁止第二次提交点击 ${a.target} → 交观察流判定`, true, false);
        }
        const clickErr = await dispatchClickOnce(el);
        await pg.waitForTimeout(2500);
        if (clickErr) return actionResult(`提交点击返回异常(${String(clickErr.message).slice(0, 60)}),可能已派发,结果不明 → 交观察流判定,不再盲点第二次`, true, true);
        return actionResult(`已点 ${a.target}(提交类,单次派发)`, true, true);
      }
      // 【08-11 十四轮 P1-1】DOM 判不出提交类但文案带提交动词(如 form 外的
      // <button>Submit</button>):也要单发派发、禁 DOM 盲点第二次;此路径语义不定
      // 不认领、不计 submitClass(不触发主循环的空转计数),交给后续观察判。
      if (hasSubmitVerb(a.target)) {
        const clickErr = await dispatchClickOnce(el);
        await pg.waitForTimeout(2500);
        if (clickErr) return actionResult(`点击返回异常(${String(clickErr.message).slice(0, 60)}),动词兜底单发后交观察流,不再盲点第二次`);
        return actionResult(`已点 ${a.target}(动词兜底,单次派发)`);
      }
      await el.click().catch(async () => { await el.evaluate(e => e.click()); });
      await pg.waitForTimeout(2500);
      return actionResult(`已点 ${a.target}`);
    }
    case 'select': {
      const el = await locate(pg, a.target);
      if (!el) return `选失败:找不到 ${a.target}`;
      // 【2026-07-27 修】原来直接 [...s.options] —— LLM 让 select 的目标未必真是 <select>,
      // 很多站用 div/ul 自造下拉。非 select 元素没有 .options,展开就抛
      //   TypeError: s.options is not iterable
      // 而这个异常从 elementHandle.evaluate 冒出来会**打穿整个 run 循环**,
      // 整站直接判失败 —— 实测 goodfirms.co 已经填到第 7 步了,栽在这。
      // 现在:是原生 select 就照旧;不是就退化成"点开再点选项"的人肉路径。
      const ok = await el.evaluate((s, want) => {
        if (!s.options || typeof s.options.length !== 'number') return { kind: 'not-select' };
        const o = [...s.options].find(
          x => (x.textContent + x.value).toLowerCase().includes(want.toLowerCase()));
        if (!o) return { kind: 'no-option' };
        s.value = o.value;
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return { kind: 'ok', text: o.textContent.trim() };
      }, a.value).catch(e => ({ kind: 'err', msg: String(e.message).slice(0, 80) }));

      if (ok.kind === 'ok') return `已选 ${ok.text}`;
      if (ok.kind === 'no-option') return `选失败:无选项 ${a.value}`;
      if (ok.kind === 'err') return `选失败:${ok.msg}`;
      // 自造下拉:点开它,再在浮层里点包含目标文字的那一项
      try {
        await el.click({ timeout: 4000 });
        await pg.waitForTimeout(600);
        const opt = pg.locator(
          `[role=option], li, [class*=option], [class*=item]`
        ).filter({ hasText: new RegExp(a.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
        if (await opt.count()) {
          await opt.click({ timeout: 4000 });
          await pg.waitForTimeout(500);
          return `已选 ${a.value}(自造下拉)`;
        }
      } catch { /* 退化路径也失败就如实报,不假装成功 */ }
      return `选失败:${a.target} 不是原生 select,自造下拉也没点到 ${a.value}`;
    }
    case 'upload': {
      // 按观察序号直接定位到具体 file input,并读槽位尺寸要求选对应素材
      const files = await pg.$$('input[type=file]');
      if (!files.length) return '传失败:无 file input';
      let el = null;
      const m = /^i(\d+)$/.exec(a.target || '');
      if (m) {
        // 与 observe() 相同的可见 input 列表序号
        const all = await pg.$$('input,textarea,select');
        const vis = [];
        for (const e of all) if (await e.isVisible().catch(() => false)) vis.push(e);
        el = vis[+m[1]] || null;
        if (el && (await el.getAttribute('type')) !== 'file') el = null;
      }
      if (!el) {
        // 语义兜底:logo → 第一个,screenshot/thumbnail/gallery → 最后一个
        el = /screen|thumb|截图|gallery/i.test(a.target || '') && files.length > 1 ? files[files.length - 1] : files[0];
      }
      // 读槽位附近的尺寸提示选素材:256→logo256,1200x630→og630,1280/1480→大图
      // 素材位置:kit 同目录 assets/(logo-256.png / og-1200x630.png / hero-1480x900.png)。
      // 缺素材 = 明确失败并入人工队列;**禁止跨产品素材兜底**(表面成功、内容错)。
      const ctx = (await el.evaluate(e => (e.closest('label')?.innerText || '') + ' ' + (e.parentElement?.innerText || '') + ' ' + (e.closest('div')?.innerText || ''))).toLowerCase();
      const ADIR = path.dirname(KIT_PATH) + '/assets';
      const pick = (name) => fs.existsSync(`${ADIR}/${name}`)
        ? { f: `${ADIR}/${name}` } : { f: null, missing: name };
      let sel = pick('hero-1480x900.png');
      if (/256\s*[x×]\s*256/.test(ctx)) sel = pick('logo-256.png');
      else if (/1200\s*[x×]\s*630/.test(ctx)) sel = pick('og-1200x630.png');
      else if (/logo|icon|favicon/.test(ctx)) sel = pick('logo-256.png');
      if (!sel.f) {
        await queueForHuman(dom, 'upload',
          `缺素材 ${sel.missing}(kit 同目录 assets/ 下放好再投),请人工上传正确素材`);
        return `传失败:缺素材 ${sel.missing},已入人工队列`;
      }
      const f = sel.f;
      const already = await el.evaluate(e => e.files.length);
      if (already) return `该上传位已有文件(${already}个),跳过`;
      await el.setInputFiles(f);
      const n = await el.evaluate(e => e.files.length);
      return `已传 ${f} → 槽位(${ctx.replace(/\s+/g, ' ').slice(0, 50)})(现 ${n} 个)`;
    }
    case 'captcha_turnstile': {
      if (!cs.hasKey()) {
        // 没配打码 key:不硬刚。转人工队列并终态 manual(driver 不再自动重投)。
        const _q = queueForHuman(dom, 'captcha_turnstile',
          `请在 ${dom} 页面里过 Turnstile 人机验证再提交(字段已预填)`);
        const e = new Error('有 Turnstile 验证码但 my_site.json 未配 capsolver_key');
        e.noSolver = true;
        // 【修】原来无条件置 true,忽略返回值 —— human_tasks 写失败但状态账本可写时,
        // 顶层会永久写 manual 而人工队列里根本没有这条任务。按真实结果传。
        e.queued = _q;
        throw e;
      }
      const key = await findSitekey(pg);
      if (!key) return 'turnstile sitekey 未找到';
      let token;
      try {
        ({ token } = await cs.turnstile(pg.url(), key.key, key.action ? { metadata: { action: key.action } } : {}, { domain: dom }));
      } catch (e) {
        // 【08-01 实证】solver 拒收(幻影 key/数据畸形)不该打穿整站 —— 按幻影处理:
        // 进人工队列,本机先试裸提交(很多站点是服务端隐形防护,不需要 token)。
        if (e && e.junkKey) {
          await queueForHuman(dom, 'captcha_turnstile',
            `请在 ${dom} 页面里过 Turnstile 人机验证再提交(字段已预填)`);
          return 'turnstile sitekey 提取无效(幻影噪音)。**别死磕解码:直接点提交按钮试,被拒再想办法**';
        }
        throw e;
      }
      await pg.evaluate(t => {
        let ta = document.querySelector('[name=cf-turnstile-response]');
        if (!ta) { ta = document.createElement('textarea'); ta.name = 'cf-turnstile-response'; ta.style.display = 'none'; (document.querySelector('form') || document.body).appendChild(ta); }
        ta.value = t;
      }, token);
      return 'turnstile token 已注入';
    }
    case 'cf_challenge': {
      // 整页 Cloudflare Challenge("Just a moment..." 403):AntiCloudflareTask 拿 cf_clearance
      // CapSolver 只接受 Windows Chrome UA,macOS UA 会被 ERROR_INVALID_TASK_DATA 拒
      // 用与浏览器**完全相同**的 UA 解题 —— cf_clearance 与 UA 绑定,不一致就作废
      if (!cs.hasKey()) {
        const _q = queueForHuman(dom, 'cf_challenge',
          `请在 ${dom} 页面里过 Cloudflare 挑战页再提交(字段已预填)`);
        const e = new Error('有 Cloudflare 挑战页但 my_site.json 未配 capsolver_key');
        e.noSolver = true;
        // 【修】原来这个分支既没置 queued(成功入队后顶层还会再建一条泛化任务),
        // 也没看返回值。按真实结果传。
        e.queued = _q;
        throw e;
      }
      const ua = STEALTH_UA;
      // AntiCloudflareTask 必须从**我们的出口**去解题:
      // cf_clearance 绑定 IP+UA,CapSolver 用自己机房 IP 解出来的票对我们无效。
      // 给它配同一个代理(--proxy / HTTPS_PROXY),让它借我们的出口。
      const proxy = publicProxyUrl();
      if (!proxy) {
        // 【修】原来直接 return 一个普通字符串 —— 主循环把它当"这一步没成",继续烧步数,
        // 最后多半落 blocked。整页 CF 挑战没代理是**结构性过不去**(cf_clearance 绑 IP),
        // 和"没 solver"是同一类:该转人工,不该把域烧掉。
        const e = new Error('整页 Cloudflare 挑战需要与解题同出口的代理(--proxy / HTTPS_PROXY),当前未配');
        e.noSolver = true;
        throw e;
      }
      // CapSolver 要挑战页的 HTML 才认得出是哪种挑战(2026-07-27 实测:不给就
      // ERROR_INVALID_TASK_DATA "the 'html' field is required")。我们此刻正停在
      // 那一页上,直接取当前 DOM 给它 —— 比让它自己再抓一次更准,因为挑战页是
      // 绑 IP/UA 的,它抓到的和我们看到的可能不是同一份。
      const chalHtml = await pg.content().catch(() => '');
      const r = await cs.cloudflareChallenge(pg.url(), proxy, ua, chalHtml, { domain: dom });
      if (!r || !r.cookies) return 'AntiCloudflareTask 未拿到 cookie';
      const host = new URL(pg.url()).hostname.replace(/^www\./, '');
      const cookies = Object.entries(r.cookies).map(([name, value]) => ({ name, value, domain: '.' + host, path: '/' }));
      await pg.context().addCookies(cookies);
      await pg.reload({ waitUntil: 'domcontentloaded' });
      await pg.waitForTimeout(3000);
      const txt = await pg.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 300));
      return /just a moment|checking your browser|请稍候/i.test(txt) ? 'cf_clearance 注入后仍在挑战页' : 'cf_clearance 已注入并通过挑战页';
    }
    case 'captcha_recaptcha': {
      // 【2026-07-31】先验真身再花钱:页面上没有真 reCAPTCHA 组件时,
      // HTML 正则兜底会抓到 base64 噪音伪装成的"sitekey"(bakerella 实证:
      // `6Ly93d3cuYmFrZXJlbGxhLmNvbS95dW1teS1tdW1` 解出来就是 www.bakerella.com/…,
      // 而 .g-recaptcha/anchor iframe/grecaptcha_cfg 全都不存在 —— 那是 Akismet
      // 类隐形防护,不需要解)。三样全缺 = 幻影,直接回报"无需解码",别喂 CapSolver。
      // ⚠️ 探测异常**按无组件处理**(07-31 实证:smittenkitchen 无验证码,evaluate 一抛
      // 默认有组件 → 拿垃圾串喂了两次 solver)。错判"无组件"的代价是这站被服务端拒、
      // 归类 blocked 可重试;错解的代价是真金白银喂垃圾 key。
      const widget = await pg.evaluate(wd.probeRecaptchaWidget)
        .catch(() => ({ div: false, iframe: false, cfg: false }));
      if (!widget.div && !widget.iframe && !widget.cfg) {
        return '页面上没有真 reCAPTCHA 组件(隐形防护或幻影 key),无需解码,直接提交';
      }
      // 找 reCAPTCHA sitekey。
      //
      // 【2026-07-27 修】原实现三处都不够严:
      //   ① iframe 只匹配 /recaptcha/ —— 页面上除了真正的挑战框(api2/anchor?k=…),
      //      还有一个叫 **api2/aframe** 的空壳 iframe,它**没有 k 参数**。
      //      按 DOM 顺序 aframe 常在前面,于是抓到它、拿到一段不是 key 的东西,
      //      CapSolver 打回 `invalid websiteKey, its length should be 40`(实测 bpublic.com)。
      //   ② 正则 `6L[A-Za-z0-9_-]{25,}` 长度下限太松,会截到别的串。
      //      真 sitekey 恒为 **40 字符**(6L + 38)。
      //   ③ 没找 grecaptcha 的运行时配置 —— 有的站 key 只存在 JS 里,DOM 上没有。
      // 现在:候选全收集 → 只留长度正好 40 的 → 按可信度排序。
      // 提取函数本体(含幻影 key 的 base64 过滤)在 wall_detect.js:浏览器侧纯函数,pg.evaluate 序列化执行。
      if (!cs.hasKey()) {
        const _q = queueForHuman(dom, 'captcha_recaptcha',
          `请在 ${dom} 页面里过 reCAPTCHA 人机验证再提交(字段已预填)`);
        const e = new Error('有 reCAPTCHA 验证码但 my_site.json 未配 capsolver_key');
        e.noSolver = true;
        // 【修】原来无条件置 true,忽略返回值 —— human_tasks 写失败但状态账本可写时,
        // 顶层会永久写 manual 而人工队列里根本没有这条任务。按真实结果传。
        e.queued = _q;
        throw e;
      }
      const sitekey = await pg.evaluate(wd.extractRecaptchaSitekey);
      if (!sitekey) {
        // 【人机协同-分支模式】有可见组件但提取不到 key:进人工队列(不打断),本机先试裸提交
        await queueForHuman(dom, 'captcha_checkbox',
          `请在 ${dom} 页面里勾选 reCAPTCHA 复选框再提交(字段已预填)`);
        return 'reCAPTCHA sitekey 未找到(页面上没有 40 字符的 key)。**别死磕:很多站点是服务端隐形防护,不需要 token —— 下一步直接点提交按钮试,被拒再想办法**';
      }
      let token = null, err = null;
      // 【2026-07-29 实测】原实现恒先解 invisible 型 —— checkbox 型 widget 的站
      // 校验不过(phpLD 实证:载荷含 token 仍被规劝勾选)。判型别看 .g-recaptcha
      // 容器(服务端直出,同步可靠);别看 anchor iframe —— 它异步渲染,检查时常
      // 还没挂上,会误判成 invisible 先解(又白烧一发)。
      const hasCheckbox = await pg.evaluate(() => {
        const el = document.querySelector('.g-recaptcha');
        return !!el && el.getAttribute('data-size') !== 'invisible';
      });
      let usedInv = null;
      for (const inv of (hasCheckbox ? [false, true] : [true, false])) {
        try { token = await cs.recaptchaV2(pg.url(), sitekey, { invisible: inv }, { domain: dom }); usedInv = inv; break; }
        catch (e) {
          err = e;
          // 【08-11 P1-新2】基建/预算熔断(账本不可用/日预算尽)不是这站的错:
          // 不喂第二种类型、不落"出码失败"字符串(那会把域引向 blocked 烧掉),
          // 直达顶层按基建瞬态处理(不写 blocked、域留池;预算另停波)。
          if (e && (e.infra || e.budget)) throw e;
          // 【2026-07-31】「Invalid site key」= 提取到的是垃圾 key(幻影/企业版),
          // 换型重解只会把同一个垃圾再喂一遍(smittenkitchen 实证:同一 junk key
          // 被连喂两次)。立即收手,把真因说清楚,钱省在刀口上。
          // 【同日再实证】更关键的教训:很多"幻影验证码"其实**根本不用解** ——
          // smittenkitchen 裸提交直接 302 受理(comment-2741147),它的防护是
          // Akismet 类服务端隐形方案,不需要任何 token。所以指引是:直接提交试,
          // 被拒了再回来想别的办法,别在解码上死磕。
          if (/invalid site key/i.test(String(e && e.message || '')) || (e && e.junkKey)) {
            // 【人机协同-分支模式】有可见组件但 solver 拒 key:进人工队列(不打断),本机先试裸提交
            await queueForHuman(dom, 'captcha_checkbox',
              `请在 ${dom} 页面里勾选 reCAPTCHA 复选框再提交(字段已预填)`);
            return 'sitekey 提取无效(幻影噪音)。**别死磕解码:很多站点是服务端隐形防护,不需要 token —— 下一步直接点提交按钮试,被拒再想办法**';
          }
        }
      }
      if (!token) return 'CapSolver 出码失败: ' + (err && err.message || '').slice(0, 100);
      await pg.evaluate(t => {
        // 【2026-07-29 实测】api2 widget 在表单提交瞬间会把 g-recaptcha-response
        // 改写回内部状态(没走 UI 解题就是空)—— 直接 ta.value=t 会在 submit 时被
        // 清掉:FormData 快照里有 token,真实 POST 载荷里没有(改名前后对照实验证实)。
        // 对策:widget 的 textarea 改名(它持有元素引用,不查 name),
        // token 用正名另起字段 —— 提交时只有我们的值出去。
        const ta = document.querySelector('[name=g-recaptcha-response]');
        if (ta) {
          ta.name = 'g-recaptcha-response-widget';
          const h = document.createElement('textarea');
          h.name = 'g-recaptcha-response'; h.value = t; h.style.display = 'none';
          ta.after(h);
        } else {
          const h = document.createElement('textarea');
          h.name = 'g-recaptcha-response'; h.value = t; h.style.display = 'none';
          (document.querySelector('form') || document.body).appendChild(h);
        }
      }, token);
      pg._recaptchaToken = token;      // 供 click 的 fetch 直送分支取用
      return `reCAPTCHA token 已注入(key=${sitekey.slice(0, 8)}…,${usedInv ? 'invisible' : 'checkbox'}型)`;
    }
    case 'math': {
      const r = await pg.evaluate(() => {
        const inputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file])')];
        for (const inp of inputs) {
          let el = inp.parentElement, depth = 0, txt = '';
          while (el && depth < 3) { txt = el.innerText || ''; if (/\d+\s*[+\-×x*]\s*\d+\s*=/.test(txt)) break; el = el.parentElement; depth++; }
          const m = txt.match(/(\d+)\s*([+\-×x*])\s*(\d+)\s*=/);
          if (!m) continue;
          const ans = m[2] === '+' ? +m[1] + +m[3] : m[2] === '-' ? +m[1] - +m[3] : +m[1] * +m[3];
          inp.value = String(ans);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return `${m[1]}${m[2]}${m[3]}=${ans}`;
        }
        return null;
      });
      return r ? `数学题已解 ${r}` : '没找到数学题';
    }
    case 'scroll':
      await progressiveScroll(pg);
      return '已分段滚到底(20/40/60/80/100%)';
    case 'wait':
      await pg.waitForTimeout(4000);
      return '已等 4s';
    case 'login': {
      // 已存账号只允许走明确的 Sign in/Login 控件。不要用通用 submit 按钮兜底,
      // 否则模型在 signup 页误调 login 时仍可能把已有密码提交给注册端点。
      const account = storedCredentials(dom);
      if (!account) registrationApprovalStop(dom, '登录墙无 stored creds,禁止自动创建账号');
      const btn = await pg.$([
        'button:has-text("Sign in"):visible', 'button:has-text("Log in"):visible',
        'button:has-text("Login"):visible', 'button:has-text("登录"):visible',
        'input[type=submit][value*="sign in" i]:visible',
        'input[type=submit][value*="log in" i]:visible',
      ].join(', '));
      if (!btn) return '登录停止:当前页面没有明确 Sign in/Login 控件,禁止把凭据填进疑似 signup 表单';
      let filled = 0;
      for (const el of await pg.$$('input:visible')) {
        const type = String((await el.getAttribute('type')) || 'text').toLowerCase();
        const name = String((await el.getAttribute('name'))
          || (await el.getAttribute('placeholder')) || '').toLowerCase();
        if (type === 'email') { await el.fill(account.email); filled++; }
        else if (type === 'password') { await el.fill(account.pass); filled++; }
        else if (/^(username|user|login)/.test(name)) { await el.fill(account.user || account.email); filled++; }
      }
      if (!filled) return '登录停止:明确登录页里没找到邮箱/用户名/密码字段';
      await btn.click();
      await pg.waitForTimeout(4000);
      return `已用 stored creds 登录(字段${filled}个)`;
    }
    case 'fork_account': {
      // fork_account 会创建一个产品专属账号记录,本质仍是新目录注册。
      // 没有本次命令对该站的精确批准时,必须在写 creds 前停止。
      if (!registrationApproved(dom)) {
        registrationApprovalStop(dom, a.reason || '站方要求为新产品另开账号');
      }
      const forked = forkAccountForProduct(dom, a.reason || '站方提示需为新产品另开账号');
      return forked
        ? '已为本产品准备专属账号记录,请继续获批的注册流程'
        : '无法单开账号:本产品没有独立联系邮箱,请 giveup 并归因 needs_product_email';
    }
    case 'register': {
      // register 只能在 captain 对本次命令里的精确站点授权后执行。
      // 闸必须位于 accountEmail/domainPassword 之前,否则即使不点提交也会先把新密码写进 creds。
      if (!registrationApproved(dom)) {
        registrationApprovalStop(dom, a.reason || '站点需要创建新目录账号');
      }
      const regEmail = credsFile.accountEmail(dom, PSLUG,
        (KIT.product.submitter && KIT.product.submitter.email) || VALUES.agent_email);
      const pass = domainPassword(dom, regEmail);
      let filled = 0;
      for (const el of await pg.$$('input:visible')) {
        const type = (await el.getAttribute('type')) || 'text';
        const name = String((await el.getAttribute('name'))
          || (await el.getAttribute('placeholder')) || '').toLowerCase();
        if (type === 'email') { await el.fill(regEmail); filled++; }
        else if (type === 'password') { await el.fill(pass); filled++; }
        else if (/^(name|username|user|nickname)/.test(name)) { await el.fill(PNAME); filled++; }
      }
      const btn = await pg.$('button[type=submit]:visible, button:has-text("Register"):visible, button:has-text("Sign up"):visible, button:has-text("注册"):visible');
      if (btn) { await btn.click().catch(() => {}); await pg.waitForTimeout(4000); }
      return `已按逐站批准创建账号(字段${filled}个,邮箱 ${regEmail})`;
    }
    case 'email_otp': {
      // 【2026-07-30】站方已回「账号已存在」时,验证信永远不会来 —— 账号早已注册
      // 且已验证(smolhunt 实证:signup 422 USER_ALREADY_EXISTS,agent 干等 12 分钟)。
      // 给 LLM 指到登录路,别在信箱上空等。
      if (/already.?exists|already.?registered|USER_ALREADY_EXISTS|邮箱已被|已被注册|already in use/i
          .test(httpLog.slice(-6).join(' '))) {
        return '站方回「账号已存在」——别等验证信了(不会来),账号在 creds 里,直接找 Sign in/Login 登录后提交';
      }
      // 【2026-08-10 顺序倒转】原顺序:先主动收 90s 信(sweeper 会**服务端点开**链接)
      // 再读信 —— 等 agent 拿到 VERIFY_LINK,一次性 token 早被自己的 curl_cffi 烧掉,
      // 魔法链接登录站(yo.directory/ning 系)永远过不去。
      // 现在:先读信,拿到链接立刻**浏览器带闸 goto**(session 落在本页面);
      // 没信才主动收(defer 标记在,这期间 sweeper 只校验不点开)。
      let r = emailOtp(dom);
      if (!r.startsWith('OTP:') && !r.startsWith('VERIFY_LINK:')) {
        try {
          execFileSync(PY_BIN, [path.join(HERE, 'mail_sweeper.py'), '--for-domain', dom, '--wait', '90'],
                       { timeout: 120000, stdio: 'pipe' });
          console.log(`[${dom}] 已主动收信(验证链接若到会被自动处理)`);
        } catch (e) {
          // 退出码 2 = 等了没等到,不是错误;其它才值得记
          if (e.status !== 2) console.log(`[${dom}] 主动收信异常:${String(e.message).slice(0, 70)}`);
        }
        r = emailOtp(dom);
      }
      if (r.startsWith('OTP:')) {
        const code = r.slice(4);
        const el = await pg.$('input:visible');
        if (el) { await el.fill(code); return `验证码 ${code} 已填入`; }
        return `拿到验证码 ${code} 但页面无输入框`;
      }
      if (r.startsWith('VERIFY_LINK:')) {
        const link = r.slice(12).trim();
        const v = await gatedOpen(pg, link, siteRootOf(dom));
        if (v.ok) {
          return `验证链接已在浏览器打开(HTTP ${v.status || '?'}),落点 ${v.finalUrl.slice(0, 80)}。` +
                 `若页面显示已验证/已登录就直接继续提交;若提示链接失效,说明后台已服务端点过——刷新页面或改用密码登录继续`;
        }
        return `验证链接被安全闸拦下(${v.why}),不能打开。改用密码登录或换入口`;
      }
      return r;
    }
    default:
      return '未知动作:' + a.action;
  }
}

// 【08-11 十四轮 P2-3】act 统一返回 {text, submitClass, dispatched}(normalizeActionResult
// 归一):主循环按布尔判定,不再把中文日志文案当控制流契约;日志只取 r.text。
// actImpl 里 click 各分支已结构化,其余 action 的字符串返回由 normalize 兜底。
async function act(pg, a, dom) { return normalizeActionResult(await actImpl(pg, a, dom)); }

// ---------- act 结束(契约测试切片终点;切片含 actImpl+act,外部依赖经注入覆盖) ----------

async function locate(pg, target, isButton = false) {
  // target 是观察里的序号(按钮 b0/输入 i0/下拉 s0)或文本
  const m = /^([bis])(\d+)$/.exec(target || '');
  if (m) {
    const idx = +m[2];
    if (m[1] === 'b') {
      // 必须与 observe() 完全相同的选择器与可见性过滤,序号才对齐
      const els = await pg.$$('button,[role=button],input[type=submit]');
      const visEls = [];
      for (const e of els) if (await e.isVisible().catch(() => false)) visEls.push(e);
      return visEls[idx] || null;
    }
    const els = await pg.$$('input,textarea,select');
    const visEls = [];
    for (const e of els) if (await e.isVisible().catch(() => false)) visEls.push(e);
    return visEls[idx] || null;
  }
  // 【修】target 是 LLM 产出的自由文本,而 LLM 是看着页面内容写的 —— 里面出现一个
  // 双引号就拼出非法选择器,Playwright 抛错穿出 actImpl/act/步循环,被最外层 catch
  // 判成整站 blocked。同文件 :830 的 text= 兜底早就用 JSON.stringify 做对了,这里没跟上。
  // JSON.stringify 产出的是带引号且已转义的字符串字面量,Playwright 选择器引擎认它。
  const q = (t) => JSON.stringify(String(t ?? ''));
  if (isButton) {
    // 长文本目标:多半是 checkbox 的 label 文案,点 label 即可勾选
    if ((target || '').length > 15) {
      const lab = await pg.$(`label:has-text(${q(target.slice(0, 40))})`);
      if (lab) return lab;
      const cb = await pg.$('input[type=checkbox]:visible');
      if (cb) return cb;
    }
    return (await pg.$(`button:has-text(${q(target)})`)) || (await pg.$(`[role=button]:has-text(${q(target)})`)) || (await pg.$(`a:has-text(${q(target)})`));
  }
  return (await pg.$(`input[name=${q(target)}]`)) || (await pg.$(`textarea[name=${q(target)}]`)) || (await pg.$(`input[placeholder*=${q(target)}]`)) || (await pg.$(`label:has-text(${q(target)}) input`));
}

function resolveValue(v) {
  if (!v) return '';
  // 【修】v 来自 LLM,不可信:原来用 VALUES[v] 直查,"constructor"/"toString" 这类
  // 会拿到 Object.prototype 上的东西(最终退化成填充失败,但没必要留这个口子)。
  const own = (k) => Object.prototype.hasOwnProperty.call(VALUES, k);
  if (own(v)) return VALUES[v];
  if (v.startsWith('slot:')) { const k = v.slice(5); return own(k) ? VALUES[k] : ''; }
  return v; // LLM 基于 kit 事实的组合值,过 FORBIDDEN 闸门
}

/** 所有描述变体(四档 × 各变体),短的在前 —— 供按字段 maxlength 挑选。 */
function descVariants() {
  const d = (KIT.copy && KIT.copy.descriptions) || {};
  const all = [];
  for (const k of ['xs_50', 's_150', 'm_300', 'l_510']) {
    for (const t of (Array.isArray(d[k]) ? d[k] : [])) if (t) all.push(String(t));
  }
  return all.sort((a, b) => a.length - b.length);
}

/** 挑一条 ≤cap 的最长描述变体。全都装不下返回 null。 */
function pickFitting(cap) {
  const fit = descVariants().filter((t) => t.length <= cap);
  return fit.length ? fit[fit.length - 1] : null;
}

/** 按词边界截到 cap 以内,不切半个单词,不留尾部标点。 */
function trimToWord(s, cap) {
  if (s.length <= cap) return s;
  let cut = s.slice(0, cap);
  const sp = cut.lastIndexOf(' ');
  if (sp > cap * 0.6) cut = cut.slice(0, sp);
  return cut.replace(/[\s,;:—–\-]+$/, '');
}

async function findSitekey(pg) {
  const key = await pg.evaluate(() => document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || null);
  if (key) return { key, action: await pg.evaluate(() => document.querySelector('[data-sitekey]')?.getAttribute('data-action') || null) };
  const html = await pg.content();
  const m = html.match(/(0x4AAAAAAA[A-Za-z0-9_-]{5,})/);
  return m ? { key: m[1], action: null } : null;
}

// 【2026-07-25 安全修复】原实现把 SQL 拼进 execSync 的 shell 字符串,而 evidence 里含
// 外站响应体片段 / LLM 自由文本 / 异常消息 —— 完全不可信的输入。shell 双引号内
// $(...) 与反引号会被求值(已实测复现),NUL 字节还会直接炸掉整条命令(_task4.log:120)。
// 现全部改走 dbw:node:sqlite 真参数绑定,不起 shell,并带状态迁移守卫。
function upsert(dom, status, evidence, note = '', opts = {}) {
  // 【07-31 实证】与采集/复核波并发时,锁持有可超 dbw 的 30s busy_timeout,写库失败只打
  // 一行日志就丢账(32 高相关批 13 站无记录,含 4 个 pending_review 成功单)。终局写是
  // 账本,撞锁必须重试到进;非锁错误照旧快速失败。
  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    try {
      const r = dbw.upsertSubmission({
        domain: dom, status, evidence, note, source: 'agent_submit', ...opts,
      });
      // 守卫拦下的倒退(如 recipe 沉淀抛错后 catch 里想写 blocked)只提示,不静默
      if (r && r.blockedRegression) {
        console.log(`[${dom}] 状态守卫:拒绝 ${r.from} → ${status}(辅助步骤异常不改投递结论)`);
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (!/locked|busy/i.test(String(e && e.message))) break;
      console.log(`[${dom}] 写库撞锁,退避重试(${i + 1}/6)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);  // node 主线程可用的同步 sleep
    }
  }
  // 【08-11 九轮评审 P1-2】写账失败**不许返回 null 让流程正常退出**:表单可能已投达,
  // 旧行为下 recipe/主流程忽略返回值干净退出,驱动查不到近期账 → 无声兜底补记
  // blocked,投达单被烧成 blocked(域永不重试或被重投)。抛专用错误,顶层按基建
  // 故障处理:不写 blocked、exit 43、stderr 响亮;rolling_submit 认
  // LEDGER_WRITE_FAILED 标记,不补记(域留池未烧,下波自然重投)。
  const err = new Error(`LEDGER_WRITE_FAILED: 写库失败(重试 6 次后仍败): ${String(lastErr && lastErr.message).slice(0, 160)}`);
  err.ledger = true;
  throw err;
}

// 【08-11 十一轮评审 P1-7】投递认领 + delivery_ambiguous 终态。
// submit 类外部动作(提交按钮点击 / reCAPTCHA fetch 直送)派发**之前**落
// delivery_ambiguous 行:此后到终局落账之间的任何异常(页面关闭/evaluate 抛错/
// 看门狗/包装超时)都无权再把该域写成 blocked —— dbw 守卫把 delivery_ambiguous
// 视为投达态,拒绝回归 blocked/failed;rolling_submit 无声兜底看到近 25 分钟内
// 有 submissions 行即不补记。该状态**永不自动重投**(选品 NOT EXISTS 排除一切
// 有行的域),只能人工裁决 —— 重投比漏投更糟(重投 = 重复提交)。
// 认领写失败 = 账本不可用,fail-closed:不派发动作,upsert 抛 e.ledger 走 exit 43。
let SUBMIT_DISPATCHED = false;
function claimDelivery(dom, detail) {
  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    try {
      // 读当前态+写认领同一写路径;只有 claimed=true 才能派发。
      // (开源版是单进程追加日志,无跨进程事务,守卫语义由 state.mjs 保证)
      const r = dbw.claimDelivery({
        domain: dom, source: 'agent_submit', reason_code: 'unknown',
        evidence: `submit 类动作即将派发,终局未定(${String(detail || '').slice(0, 120)})`,
      });
      SUBMIT_DISPATCHED = !!(r && (r.claimed || (r.to && dbw.DELIVERED.has(r.to))));
      return !!(r && r.claimed);
    } catch (e) {
      lastErr = e;
      if (!/locked|busy/i.test(String(e && e.message))) break;
      console.log(`[${dom}] 投递认领撞锁,退避重试(${i + 1}/6)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
    }
  }
  const err = new Error(`LEDGER_WRITE_FAILED: 原子投递认领失败(重试后仍败): ${String(lastErr && lastErr.message).slice(0, 160)}`);
  err.ledger = true;
  throw err;
}

// 【08-11 十一轮评审 P1-6】submit 类控件判定与 single-shot 派发。
// Playwright click() 可能已派发点击/POST 后才因导航等待超时 reject ——
// 此时 catch 里再补 el.evaluate(e => e.click()) 就是第二次提交(重复投递)。
// 提交类控件只派发一次;返回错误 = 结果不明,调用方交观察流判定,绝不盲点。
/** 返回 null=干净派发;错误对象=已派发与否不确定,不许再点第二次。 */
async function dispatchClickOnce(el) {
  return await el.click().then(() => null, e => e);
}

// 语义分层:提交入口 404/无表单 = 站不收件(不可用),不是"卡住可重试"——出池标 no(三处写入点共用)
function markUnusableIf404(dom, status, reason) {
  if (status !== 'blocked' || !/404|not.?found|不存在|无表单|无可用.{0,4}入口|无提交入口/i.test(reason || '')) return false;
  // 【2026-07-29】「卡流程」不是「站不收件」:relateddirectory.org 因判词里带"无表单
  // 控件可继续操作"(其实是打码没过的中间页状态)被误踢出池(link_directories=no +
  // 删 submit_friendly),白丢一个 DR≥10 已核验入口。带验证码/OAuth/付费信号的
  // blocked 属可重试,一律不出池。
  if (/captcha|recaptcha|turnstile|hcaptcha|oauth|打码|付费|paid/i.test(reason || '')) return false;
  // 开源版没有采集池 DB(quality_resources/directory_sites 是私仓的表):
  // 「站不收件」记一条约束(entry_404, TTL 30 天),driver 下轮选品自然跳过,
  // 与生产版"出池"等效 —— 都是通过持久标记防止重复烧。
  try {
    dbw.addConstraint({ domain: dom, reason_code: 'entry_404',
      evidence: `提交入口404/无表单,判不可用: ${String(reason || '').slice(0, 200)}`,
      ttl_days: 30 });
    console.log(`[${dom}] 判不可用:已记 entry_404 约束(30 天内不再重试)`);
    return true;
  } catch { return false; }
}

// ---------- 站点 recipe(成功一次,沉淀打法,下次快进;存 recipes.json,见 state.mjs) ----------
function initRecipes() { /* 开源版 JSON 存储,无需建表 */ }
function loadRecipe(dom) { return dbw.loadRecipe(dom); }
function saveRecipe(dom, recipe, status, notes) {
  try {
    dbw.saveRecipe(dom, recipe, status, notes);
  } catch (e) {
    // recipe 只是加速缓存,存不上不影响提交结论 —— 绝不让它把终局带崩
    console.log(`[${dom}] recipe 保存失败(不影响终局): ${String(e.message).slice(0, 120)}`);
  }
}
// 成功后让 LLM 把本次过程压成可复放的步骤清单
async function distillRecipe(dom, log) {
  const txt = await llm([
    { role: 'system', content: '你是流程沉淀器。把一次成功的网站提交过程压缩成可机械复放的 recipe。' },
    { role: 'user', content: `这是 agent 在 ${dom} 成功提交的完整动作日志:\n${log.join('\n')}\n\n提炼成 JSON:{"steps":[{"action":"fill|click|select|upload|math|captcha_turnstile|scroll","target_hint":"字段/按钮的识别文本(label/placeholder/name,尽量用语义文本别用序号)","value":"槽位名(如有)"}],"notes":"该站要点一句话"}。只保留必要步骤(忽略失败/重试/无效动作),按执行顺序。` },
  ]);
  try { return JSON.parse(txt); } catch { return null; }
}
// 快放:按 recipe 机械执行;recipe.success_http 存在时,HTTP 实锤即成功
async function replayRecipe(pg, dom, recipe) {
  const log = [];
  let httpHit = null, badHit = null;
  if (recipe.success_http && !TELEMETRY.test(recipe.success_http)) {
    pg.on('response', async (r) => {
      try {
        if (r.url().includes(recipe.success_http) && r.request().method() === 'POST' && r.status() < 300) {
          // 【2026-07-29】success_http 只看 2xx 不看内容:被拒的 submit.php 照样 200
          // ("check the security reCAPTCHA box"),毒 recipe 会无限伪成功。命中拒词 =
          // recipe 失效,回退 LLM 探路重打。body 截 3000 —— 拒收文案可能埋在整页中段。
          const body = (await r.text().catch(() => '')).slice(0, 3000);
          if (new RegExp('error|invalid|fail|denied|go.?back|' + CAPTCHA_REJECT
              + '|try.?again|please (go|check|fill|complete|verify)|required field|missing|incorrect',
              'i').test(body)) {
            badHit = `POST ${r.url().slice(0, 60)} → ${r.status()} ${body.replace(/\s+/g, ' ').slice(0, 120)}`;
            return;
          }
          const receiptStatus = classifyReceiptText(htmlText(body));
          if (!receiptStatus) return;
          httpHit = {
            status: receiptStatus,
            evidence: `POST ${r.url().slice(0, 60)} → ${r.status()} ${body.replace(/\s+/g, ' ').slice(0, 120)}`,
          };
        }
      } catch {}
    });
  }
  for (const s of recipe.steps) {
    let r;
    if (s.action === 'fill') {
      const h = JSON.stringify(String(s.target_hint ?? ''));   // 同 locate():别裸拼进选择器
      const el = await locate(pg, s.target_hint) || await pg.$(`input[name*=${h} i],textarea[name*=${h} i],input[placeholder*=${h} i],label:has-text(${h}) input,label:has-text(${h}) textarea`);
      if (!el) return { ok: false, log, fail: `复放失败:找不到字段 ${s.target_hint}` };
      const v = resolveValue(s.value);
      if (FORBIDDEN.test(v)) return { ok: false, log, fail: '红线拦截' };
      await el.fill(v); r = `fill ${s.target_hint}`;
    } else if (s.action === 'click') {
      const h = JSON.stringify(String(s.target_hint ?? ''));
      const el = await pg.$(`button:has-text(${h})`) || await pg.$(`[role=button]:has-text(${h})`) || await pg.$(`a:has-text(${h})`);
      if (!el) return { ok: false, log, fail: `复放失败:找不到按钮 ${s.target_hint}` };
      // 【08-11 十一轮评审 P1-6/P1-7】recipe 的 click 多为最终提交,同一个
      // 双投坑:click() 派发后 reject,catch 补 DOM click = 第二次提交。
      // 提交类:先认领、单次派发,返回异常即 ambiguous 收兵(调用方**不重导航**,
      // 原地交 LLM 观察流判定)。非提交类也改单次派发:旧 DOM 兜底补点对
      // 「下一步」类按钮是连点两次跳页,复放失败后 LLM  fallback 会自己找路。
      const submitClass = await isSubmitClassClick(el, s.target_hint);
      // 【08-11 十二轮评审 P2-3】认领被拒 = 已派发过/已有投达终局:不再点,
      // 按 ambiguous 收兵(调用方不重导航,原地交观察流),杜绝 recipe 双投。
      if (submitClass && !claimDelivery(dom, `recipe 复放点击提交 ${s.target_hint}`)) {
        return { ok: false, ambiguous: true, log,
          fail: `已有投递认领/投达终局,recipe 不重复派发提交点击:${s.target_hint}` };
      }
      const clickErr = await dispatchClickOnce(el);
      if (clickErr) {
        if (submitClass) return { ok: false, ambiguous: true, log,
          fail: `提交点击返回异常(${String(clickErr.message).slice(0, 60)}),可能已派发,结果不明` };
        return { ok: false, log, fail: `复放点击失败(${String(clickErr.message).slice(0, 60)}):${s.target_hint}` };
      }
      await pg.waitForTimeout(2500); r = `click ${s.target_hint}`;
    } else if (s.action === 'select') {
      r = await act(pg, { action: 'select', target: s.target_hint, value: s.value }, dom);
    } else if (s.action === 'upload') {
      r = await act(pg, { action: 'upload', target: s.target_hint }, dom);
    } else if (s.action === 'math') {
      r = await act(pg, { action: 'math' }, dom);
    } else if (s.action === 'captcha_turnstile') {
      r = await act(pg, { action: 'captcha_turnstile' }, dom);
    } else if (s.action === 'scroll') {
      await progressiveScroll(pg); r = 'scroll';
    } else {
      r = 'skip:' + s.action;
    }
    log.push(typeof r === 'string' ? r : r.text);   // act 结构化返回(十四轮 P2-3)
    // 命中拒收信号:recipe 失效,立即回退 LLM 探路(不再伪成功)
    if (badHit) return { ok: false, log, fail: `recipe 命中拒收信号:${badHit.slice(0, 100)}` };
    // recipe 定义了 HTTP 成功签名:实锤出现即提前收官
    if (httpHit) {
      log.push('HTTP 实锤:' + httpHit.evidence);
      return { ok: true, log, httpHit };
    }
  }
  // 步骤走完后再等 2 秒看 HTTP 实锤
  await pg.waitForTimeout(2000);
  if (badHit) return { ok: false, log, fail: `recipe 命中拒收信号:${badHit.slice(0, 100)}` };
  return { ok: true, log, httpHit };
}

// ---------- 侦察段:开浏览器前低成本预判(2026-07-24) ----------
// 【2026-07-25 安全修复】原实现把 url 插进 shell 命令。findEntry() 会把**远端 sitemap
// 的 <loc> 内容**当 URL 传进来 —— 那是外站完全可控的字符串,`$(...)`/反引号会被求值。
// execFileSync 直接把参数交给 curl,不经 shell;并加一道协议白名单。
// recon 抓页面也用同一个 UA:同一个域先后出现两种 UA 本身就是破绽
const CURL_UA = STEALTH_UA;
// 【08-11 五轮评审 P1-3】不再 curl -L 盲跟:逐跳取 redirect_url,每一跳先过出站闸
// (协议/userinfo/内网 IP 字面量)再连。findEntry 会把远端 sitemap <loc>、LLM 给的
// URL 传进来 —— 全是外站可控字符串。
// 【08-11 六轮评审 P3 修】curlGet 升全档校验:与 verify_link.js:93 同用 og.validateUrl
// (lite + 本地 DNS 预检),不再用 validateUrlLite —— lite 只挡 IP 字面量,解析到
// 127.0.0.1/10.x/169.254.169.254 的主机名照连,而这里的输入(远端 sitemap <loc>、
// LLM 吐的 URL)是全系统最不可信的。allowedRoot 由调用方按意图给出(侦察/找入口
// 都是冲着 dom 去的,跨根域跳转不跟),每一跳都带。
async function curlGet(url, sec = 12, allowedRoot = null) {
  let cur = url;
  for (let hop = 0; hop <= 5; hop++) {
    cur = await og.validateUrl(cur, { allowedRoot });
    if (!cur) return '';
    let out;
    try {
      out = execFileSync('curl',
        ['-sk', '-m', String(Number(sec) || 12), '-A', CURL_UA,
         '-w', '\n__CURL_META__%{http_code} %{redirect_url}', '--', cur],
        { maxBuffer: 8 << 20 }).toString('utf8');
    } catch { return ''; }
    const mi = out.lastIndexOf('\n__CURL_META__');
    if (mi < 0) return '';
    const m = out.slice(mi + 14).trim().match(/^(\d{3})\s*(\S*)$/);
    if (m && m[1][0] === '3' && m[2]) {
      try { cur = new URL(m[2], cur).href; } catch { return ''; }
      continue;
    }
    return out.slice(0, mi).slice(0, 200000);
  }
  return '';
}
// htmlText 已收进 submission_safety.js(剥注释+空值安全,十三轮 P3);本文件用顶部导入的版本。
const RECON_SYS = `你是目录站提交前的侦察员。根据站点首页+提交页文本,判断值不值得开浏览器正式提交。
产品事实:{{FACTS}}。
输出 JSON:{"verdict":"ok"|"skip","status":"skipped_paid"|"skipped_fit"|"blocked","reason":"一句话","submit_url":"看到的提交页URL或null"}
skip 仅限以下明文证据,不许脑补:
- 明文收费且没有免费档(如 "listing $39" 且无 free 选项)→ skipped_paid
- 明文硬性门槛产品明显不满足(DR/流量/粉丝数具体数字)→ blocked,reason 带数字
- 站点类目不收本品类(如纯游戏/纯视频/成人)→ skipped_fit
除此外一律 ok。拿不准就 ok,严禁凭感觉 skip。`.replace('{{FACTS}}', PRODUCT_FACTS);
async function recon(dom) {
  const home = htmlText(await curlGet(`https://${dom}/`, 12, dom)).slice(0, 2200);
  const sub = htmlText(await curlGet(`https://${dom}/submit`, 12, dom)).slice(0, 2200);
  const text = `首页:${home}\n提交页(/submit):${sub}`;
  if (text.length < 300) return { verdict: 'ok' };  // 抓不到内容就不预判,交给浏览器
  const reply = await llm([
    { role: 'system', content: RECON_SYS },
    { role: 'user', content: `站点 ${dom}:\n${text}` },
  ]);
  try {
    const j = JSON.parse(reply);
    if (j && (j.verdict === 'ok' || j.verdict === 'skip')) return j;
  } catch {}
  return { verdict: 'ok' };
}
// ---------- 提交入口发现:/submit 404 时找真入口 ----------
// 【08-11 六轮评审 P3】curlGet 升 async(DNS 预检),本函数随之 async;
// 两个调用点(recon 404 复核 / 落地 404 入口发现)都已 await。
async function findEntry(dom) {
  const CAND = ['/submit-tool', '/add-tool', '/submit-listing', '/get-listed', '/add-listing',
    '/submit-site', '/submit-website', '/list-your-tool', '/list-tool', '/add', '/submit/'];
  for (const p of CAND) {
    const h = await curlGet(`https://${dom}${p}`, 8, dom);
    if (h && !/404|not found|page.*(not|no).*exist/i.test(h.slice(0, 800))
        && /<form|<input|submit|提交|收录/i.test(h)) return `https://${dom}${p}`;
  }
  const home = await curlGet(`https://${dom}/`, 10, dom);
  const m = [...home.matchAll(/href=["']([^"']*(?:submit|add[-_]?tool|add[-_]?listing|get[-_]?listed|suggest[-_]?a?[-_]?site)[^"']*)["']/gi)];
  for (const x of m) {
    try {
      const u = new URL(x[1], `https://${dom}/`).href;
      // 【08-11 七轮评审 P1】页面给的 href 是不可信输入,统一过出站闸:
      // 旧的 hostname.endsWith(root) 会放 notexample.com 冒充 example.com;
      // 恶意页还能直接给 http://127.0.0.1/submit。validateUrl = 严格同根域 + DNS 预检。
      const v = await og.validateUrl(u, { allowedRoot: dom });
      if (v) return v;
    } catch {}
  }
  const sm = await curlGet(`https://${dom}/sitemap.xml`, 10, dom);
  const u = sm.match(/<loc>([^<]*(?:submit|add-tool|get-listed|add-listing)[^<]*)<\/loc>/i);
  // 【08-11 七轮评审 P1】sitemap <loc> 同样是站点提供的不可信输入,过闸再用(不合法即弃)
  return u ? await og.validateUrl(u[1], { allowedRoot: dom }) : null;
}
// ---------- 提交后自验证:LLM 判页面上是否真有本产品收录条目(规则判不准) ----------
const VERIFY_SYS = `你是收录核验员。给你某网页的可见文本,判断它是否真实展示了 ${PNAME}(${KIT.product.url},${(KIT.product.positioning && KIT.product.positioning.one_liner) || ''})的收录条目或详情页。
只回 JSON:{"online":true|false,"evidence":"一句话"}
- 404/页面不存在/搜索无结果/只有搜索框里回显关键词 → false
- 页面是 ${PNAME} 的详情页,或列表中有 ${PNAME} 条目(带链接)→ true
- 页面提到别的相似名字产品但非 ${PNAME} → false`;
async function verifyOnline(dom) {
  const s = PSLUG;
  const paths = [`/tool/${s}`, `/tools/${s}`, `/listing/${s}`, `/listings/${s}`,
    `/product/${s}`, `/products/${s}`, `/ai/${s}`, `/p/${s}`, `/app/${s}`,
    `/${s}`, `/${s}-ai`, `/tool/${s}-ai`, `/tools/${s}-ai`, `/site/${s}`,
    `/search?q=${s}`, `/?s=${s}`, `/?q=${s}`, `/search/${s}`];
  const finger = new RegExp(PSLUG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  for (const p of paths) {
    const h = await curlGet(`https://${dom}${p}`, 8, dom);
    if (!h || !finger.test(h)) continue;  // 便宜预筛:页面都没提产品就不用问 LLM
    const txt = htmlText(h).slice(0, 2200);
    try {
      const reply = await llm([
        { role: 'system', content: VERIFY_SYS },
        { role: 'user', content: `URL: https://${dom}${p}\n\n${txt}` },
      ]);
      const j = JSON.parse(reply);
      if (j && j.online) return `https://${dom}${p} (${(j.evidence || '').slice(0, 60)})`;
    } catch {}
  }
  return null;
}

// 【2026-07-30】博客评论嗓音块:kit 带 comment_voice 时注入 SYSTEM。
// 评论渠道 ≠ 目录填表 —— 要"就着博文写人话",嗓音模板由 kit 的 comment_voice 块
// 提供;kit 没有该块时注入为空、行为不变。
function cvBlock() {
  const cv = KIT.comment_voice;
  if (!cv) return '';
  const shots = (cv.few_shots || []).slice(0, 3)
    .map(s => `- (${s.scene || '示例'}) ${String(s.text || '').slice(0, 220)}`).join('\n');
  const stories = ((KIT.stories && KIT.stories.items) || []).slice(0, 2)
    .map(s => `- ${String(typeof s === 'string' ? s : (s.text || '')).slice(0, 160)}`).join('\n');
  return `

【博客评论写作规范(当前页面是博文/文章评论区时适用,优先级高于目录表单思维)】
调性:${(cv.tone || []).join(' / ')}
Do:${(cv.do || []).join(';')}
Don't:${(cv.dont || []).join(';')}
语气示范(学语气不学原文,**禁止照抄或近似复述**):
${shots || '(无)'}
可引用的事实弹药(自然化用,别照搬):
${stories || '(无)'}
写作规则:**必须引用当前博文的具体内容**(食材/地名/细节),1-3 句,第一人称;
产品最多提一次,且要自然(${VALUES.name} 或其用途);禁止通用好评、关键词堆砌、营销腔;
**正文里别放链接**(链接只进 url/website 字段;仅当确认该站 link_strategy=in_content 才自然带一句);
【07-31 偷自 AutoCommentAI】**结尾自然带一个和博文相关的小问题**(就内容问,不硬凹)——
博主更愿通过、更可能回复,评论有了互动才算活链,别交一锤子死评论。`;
}

const SYSTEM = `你是目录站提交代理,目标:把产品 ${PNAME} 提交进当前网站。${process.env.RESCUE_CONTEXT ? `
【救援模式(08-06 用户令)】该站上轮投放失败,败因:${process.env.RESCUE_CONTEXT}
你的任务不是重复上轮动作,而是:①先判断败因属于哪类(找错页/要注册/验证码/付费墙/JS表单未渲染/类目不符);
②找能成功的已授权路径——换提交入口(/submit、/add、页脚链接)、用 stored creds 登录、
等 JS 渲染后再找表单;③遇到未批准的新注册就停止请求批准,其余确认无路才 giveup。` : ''}
可用值(填表时只能选这些槽位,或基于它们组合,禁止引入未证实的声称如 AI/best/guaranteed):
name=${VALUES.name} / url=${VALUES.url} / email=${VALUES.email} / submitter=${VALUES.submitter}
tagline=${VALUES.tagline}
desc_short / desc_mid / desc_long(三种长度描述,按字段要求选)/ tags(逗号标签)/ categories / logo=${VALUES.logo}
每一步输出 JSON:{"action":"fill_many|fill|click|select|upload|scroll|wait|math|captcha_turnstile|captcha_recaptcha|cf_challenge|login|register|fork_account|email_otp|reveal_form|done|giveup",
 "target":"观察里的序号(按钮 b0/输入 i0/下拉 s0)或按钮文本", "value":"槽位名或组合值", "reason":"一句话"}
规则:
- 付费墙/必须付款 → {"action":"done","result":"skipped_paid","reason":"价格"}
- **新目录账号逐站审批**:register、fork_account、Sign up/Register/Create account、Google/OAuth 都可能创建新账号。只有本次命令明确批准当前精确域名时才允许;否则代码会入 human_tasks 并落 blocked/needs_registration_approval。
- **遇到登录墙**:只在本站已有 stored creds 时进入 Sign in/Login 页面并用 login 动作。没有 stored creds → 立即停止请求批准;禁止点击 Sign up/Register/Create account,禁止用 Google/OAuth 顺手建号。
- **站方限制「一个账号只能提交一个产品」时**:不要自动 fork_account。没有逐站批准就停止请求批准;有批准时才能 fork,且不得拿别的产品账号硬提交。
- 提交成功 → {"action":"done","result":"success"或"pending_review","reason":"页面证据"}
- **成功判据(严格)**:只有页面出现明确提交确认文案(已收到/进入审核/已收录),才算 success/pending_review;**仅注册/登录/OTP 验证/账号创建成功都不算提交成功**;统计/分析/广告/验证码类接口的 200 响应与提交无关,禁止当证据
- ⭐**填表一次填完,别一步一个字段**:看清整个表单后用
  {"action":"fill_many","fields":[{"target":"i0","value":"name"},{"target":"i1","value":"url"}]}
  一次把所有认得出的字段填掉。
  **这是默认做法,不是可选优化** —— 实测统计:失败站里 36% 的步数耗在逐个 fill 上,
  表单字段数中位数 5、75 分位 10、最大 20,一步一个的话光填表就用掉一半预算,
  等轮到"点提交、过验证、看回执"时步数已经没了。
  对照:成功的案例最多只用 13 步,失败的都是耗尽 24 步。
  填完再单独 click 提交 —— **不要把提交按钮混进 fill_many**。
- **退步纪律**:时间/步数预算将尽或确认提交路不通时,可改走**站内联系表单**(填完提交且页面出现回执文案才 done→"emailed"),再不行 giveup 带精确卡点;**禁止无进展死磕同一页面**
- **CF7 铁律(08-06 实证)**:Contact Form 7 返回 validation_failed 一次,可检查字段后重试**一次**;
  第二次仍 validation_failed 立即 giveup(reason 含 "CF7 validation_failed×2")——继续重试只是烧步数和 LLM 配额,
  该站会被回补成 form_rejected 约束,不靠你这单救回来
- **emailed 定义(严格,2026-07-26 收紧)**:仅限**站内联系表单提交成功且页面回执可见**。
  你没有发信能力 —— 页面上读到的公开邮箱地址(mailto/文本)**不是**你能用的通道;
  **禁止点击 mailto: 链接**——它会唤起操作系统的邮件客户端,把垃圾草稿窗口弹到用户屏幕上
  (2026-08-03 事故实证);要读邮箱地址直接从 href/文本里读,读得到;
  **禁止以"已发邮件到公开邮箱"收尾**;那种情况用 {"action":"giveup","reason":"needs_outreach: <邮箱地址>"},
  邮箱会进外联队列由真正的发信通道处理。谎称发过邮件=制造假投递记录,是最严重的违规
- 真过不去 → {"action":"done","result":"blocked","reason":"卡点"}
- 类目不匹配(纯视频/纯游戏目录、纯医学/政治/体育/法律内容站,且与本产品受众明显不搭) → {"action":"done","result":"skipped_fit"};
  受众适配指引:${(KIT.product && KIT.product.audience_note) || '评论区/社区页只要读者人群与产品受众有交集,就别以类目不匹配拒'}
- 一次只做一个动作;先填完必填再点提交;**有 turnstile 用 captcha_turnstile,有 reCAPTCHA(含 invisible)用 captcha_recaptcha,整页 "Just a moment..." Cloudflare 挑战用 cf_challenge**;有数学题先 math
- **只对 inForm=true 的控件动作**;导航链接(即使是 Submit/Submit tool 字样)会把人带离表单,只在你确定当前不在提交页时才点
- **链接双落点**:除了 url/website/link 字段,**如果表单里有第二个可放网址的位置**(如 "Website"
  与 "Link" 两个字段、或描述字段有余量),两处都带上 ${VALUES.url} —— 很多站把 url 字段渲染成
  nofollow 跳转,而描述里的纯文本网址会被保留。代码会在描述字段有余量时自动补,你只要别漏填第二个网址字段
- 描述超字段 maxlength 时代码会自动换用装得下的变体或按词边界截断,你不用手工缩写
- 已填过的字段(inputs[].value 非空)不要重复填
- **确认类 checkbox(同意条款/信息属实)必须勾上**(click 它);"关系/角色"类下拉选 Owner/Creator/我是创建者 类选项;平台类多选选 Web/Browser
- 看到"thanks/submitted/review/提交成功"才算成功;表单仍在且报错就找错因补
- **不要连续 scroll 超过 1 次**:提交按钮/剩余字段就在当前页,先回头检查未填项
- **JS 渲染表单(08-06 排期)**:滚到底仍无控件时,先 reveal_form(自动找「写评论/Comment/Reply」触发器点击挂载)再判死;
  一次 reveal 没出控件可再换一个触发器,两次仍无才 giveup` + cvBlock();

export async function main() {
  const target = process.argv[2];
  // 【08-08 实证】主循环内的预算检查挡不住「单个 await 挂死」(page.goto/evaluate
  // 不返回时循环永远不转,legrand-jp/winebooks 挂 54-65 分钟实证)。
  // 独立看门狗:MAX_MINUTES+2 分钟到点无条件强退,不依赖任何异步状态。
  // 【修】触发点用 WATCHDOG_PLAN.triggerMs,不再用裸的 (MAX_MINUTES+2)*60000:
  // 计划值把触发点钳在「收尾写账 + 人工入队最坏耗时」之前,保证一定赶在 driver
  // 的 900s 包装硬杀前落账。旧写法下 SUBMIT_MAX_MINUTES=20 时看门狗 22 分钟才响、
  // driver 15 分钟就杀 —— 这段落账逻辑一次都跑不到,域被兜底成 blocked。
  // 计划算好了却全文件没人引用,正是"代码全对、执行路径到不了"的又一例。
  const WD_MIN = Math.round(WATCHDOG_PLAN.triggerMs / 6000) / 10;
  if (WATCHDOG_PLAN.triggerMs < (MAX_MINUTES + 2) * 60000) {
    console.log(`[看门狗] 触发点按 900s 硬杀预算钳到 ${WD_MIN} 分钟`
      + `(SUBMIT_MAX_MINUTES=${MAX_MINUTES} 要求 ${MAX_MINUTES + 2} 分钟)`);
  }
  setTimeout(() => {
    // 【08-10 修】强退前必须落账:原来只打日志就 exit,域「无终局无落库」
    // 被驱动兜底成无声 blocked,真实原因(await 挂死)永远丢。
    // dom 在后面 1509 行才定义,但回调 12 分钟后才跑,闭包引用无碍;upsert 同步。
    // 【08-11 十一轮评审 P1-7】submit 已派发(认领行在库)时挂死:只许刷新
    // delivery_ambiguous 证据,绝不写 blocked(投达单被烧正是本 bug);
    // stderr 打 DELIVERY_AMBIGUOUS 标记,驱动兜底双保险不补记。
    try {
      if (SUBMIT_DISPATCHED) {
        // 【08-11 十二轮评审 P1-2 修】先查当前态:终局(success/pending_review/
        // emailed)可能已落账,只是之后卡在 distillRecipe 的裸 fetch llm 调用上
        // 拖进看门狗 —— 此时写 delivery_ambiguous 会把 success 打成"结果不明"
        // (R11 新引入的回归:旧写 blocked 会被守卫拦,新写不在 REGRESSIVE 里)。
        // 已投达终局:只记 event 不改状态;dbw 守卫同步加了双保险。
        let curSt = null;
        try {
          const row = dbw.currentStatus(dom);
          curSt = row ? row.status : null;
        } catch { /* 读不到走写路径,守卫兜底 */ }
        if (curSt && curSt !== 'delivery_ambiguous' && dbw.DELIVERED.has(curSt)) {
          try {
            dbw.recordEvent({
              domain: dom,
              event_type: 'note', prev_status: curSt, status: curSt,
              reason_code: 'unknown', source: 'agent_submit',
              evidence: `看门狗强退:submit 已派发,但终局 ${curSt} 已落账,不改状态`,
            });
          } catch {}
          console.error(`[${dom}] 看门狗强退:终局 ${curSt} 已落账,只记 event 不改状态`);
        } else {
          let actualStatus = curSt;
          if (curSt === 'delivery_ambiguous') {
            // 显式矩阵拒绝 ambiguous 自迁移；看门狗补充证据改记 note，不碰投影。
            try {
              dbw.recordEvent({
                domain: dom,
                event_type: 'note', prev_status: curSt, status: curSt,
                reason_code: 'unknown', source: 'agent_submit',
                evidence: `看门狗强退:submit 已派发、终局仍 ambiguous`,
              });
            } catch {}
          } else {
            const watchR = upsert(dom, 'delivery_ambiguous',
              `agent_submit 看门狗:超 ${WD_MIN} 分钟硬顶,submit 已派发、终局未定,人工裁决不重投`);
            actualStatus = watchR && watchR.to ? watchR.to : 'delivery_ambiguous';
          }
          if (actualStatus === 'delivery_ambiguous') {
            queueAmbiguousTerminal(dom, `看门狗超 ${WD_MIN} 分钟强退`);
            console.error(`[${dom}] DELIVERY_AMBIGUOUS 看门狗强退:submit 已派发终局未落账,不重投待人工`);
          } else {
            console.error(`[${dom}] 看门狗写 ambiguous 被守卫拒绝,实际终局 ${actualStatus}`);
          }
        }
        console.log(`[看门狗] 超 ${WD_MIN} 分钟硬顶,强退(submit 终态已对账)`);
      } else {
        upsert(dom, 'blocked', `agent_submit 看门狗:超 ${WD_MIN} 分钟硬顶(单步 await 挂死),按 blocked 记`);
        console.log(`[看门狗] 超 ${WD_MIN} 分钟硬顶,强退(已落账)`);
      }
    } catch {}
    killBrowserSync();                 // exit() 会跳过 finally,这里同步收
    process.exit(process.exitCode || 2);
  }, WATCHDOG_PLAN.triggerMs).unref();
  const useCdp = process.argv.includes('--cdp');
  const si = process.argv.indexOf('--steps');
  const maxSteps = si > 0 ? +process.argv[si + 1] : 24;
  // 【08-11 八轮评审 P2-1b 修】显式 URL 场景改用 new URL() 取 hostname:正则切串不剥端口、
  // 不剥无路径时的 ?/# —— dom 带端口(foo.com:8080)时 hostInRoot 恒 false,该域所有导航
  // 与 curlGet/findEntry 会被自家闸静默拦死。裸域兜底仍走字符串切(输入本就不是 URL)。
  const dom = (() => {
    if (target.startsWith('http')) { try { return new URL(target).hostname; } catch { /* 落到裸域兜底 */ } }
    return target.replace(/^https?:\/\//, '').replace(/[\/\?#:].*$/, '');
  })();
  // 【08-11 十轮评审 P2-3】DB 键统一走 canon 键(与 dbw.upsertSubmission/:1297 同口径,
  // canonDomain ≡ dbwpy.canon_domain):dom 来自 URL hostname,常带 www./尾点,裸 dom
  // 查 directory_sites/quality_resources 键不匹配 → rowcount=0,日志说"已出池"实际没出。
  // 只有 DB 键用 domKey;导航/页面逻辑(hostInRoot/弹窗豁免/截图名)继续用裸 dom。
  // 不用 siteRootOf:目录池有以子域 host 为键的行(如 ai.iao.app,08-11 实库
  // 核查),折到根域反而 miss;canonDomain 保 host、只剥 www/端口/尾点,与账本键同口径。
  // canonDomain 对非法输入抛错,回退裸 dom —— 代价与改前相同,不新增风险。
  let domKey = dom;
  try { domKey = dbw.canonDomain(dom); } catch { /* 非法域保持原样 */ }
  // 【2026-07-31】显式整页 URL(博文评论场景)= 目标就是这页,recon/findEntry
  // 是为目录站找提交口而生的 —— 会把人引到错误的门(bakerella 实证:博文页被
  // recon 判 404,然后被"复核"引去 /submit-tool 一个不相干页面)。显式 URL 时整段跳过。
  const explicitUrl = target.startsWith('http');
  CURRENT_DOM = dom;          // 之后所有 LLM 调用的花费都记在这个域头上
  // 【08-11 八轮评审 P2-1a 修】gotoGuarded 的 allowedRoot 用 PSL 站根(与 gatedOpen 同口径,
  // rootdomain.py 唯一来源)。裸 dom 在显式 URL 场景是完整主机名:blog.foo.com 做规范化
  // 301 到 foo.com 会被自家导航闸误杀(R7 引入的新误拦);siteRootOf 后两跳同根,放行。
  const domRoot = siteRootOf(dom);
  // 【2026-07-27 修】原来是 `https://${dom}/submit` 写死,**从不读库**。
  // 而核验流水线早就把目录站的真实入口存进了库(v1 时代是 submit_friendly.submit_url,
  // 【08-11 十一轮】v2 改读 directory_sites.submit_url,见下),
  // 实测 154 个站(已核验站的 **36.9%**)的入口根本不是 /submit ——
  // 比如 reverbico.com 真实入口是 /submit-your-company/,却被导去 /submit 吃 404,
  // 然后归因成"站方拦截"。这是个静默的错:日志上看是站的问题,其实是我们走错了门。
  // 优先级:命令行显式给的 > 库里核验过的 > LLM 侦察出来的 > 兜底猜 /submit。
  let url = target.startsWith('http') ? target : null;
  // 生产版这里还会查采集池 DB 里核验过的提交入口(directory_sites.submit_url);
  // 开源版没有池,入口优先级:命令行显式 URL > recon/findEntry 侦察 > 兜底 /submit。
  // driver.py 始终传显式 URL(worklist.jsonl),不受影响。
  if (!url) url = `https://${dom}/submit`;

  // ---- 站点约束短路(2026-07-25):已知此路不通的站直接跳,不再从零探路 ----
  // 替代 Codex 指出的"negative recipe"方案 —— loadRecipe 只读 recipe JSON 不读 status,
  // 写 status='negative' 根本不会短路。改用带**时效**的 site_constraints:
  // 500 是暂时故障、OAuth 可能被人工登录破局、badge 取决于产品策略,
  // 所以每条约束都有 expires_at,过期自动重试,不会把站永久钉死(那是 graveyard 的活)。
  advisory = [];                // 不短路、但要告诉 LLM 的约束(如"邮件通道已死")
  if (!process.argv.includes('--ignore-constraints')) {
    try {
      const all = dbw.activeConstraints(dom);
      // ⚠️ 只有 CONSTRAINT_STATUS 里显式列出的才短路整站。
      // 其余(如 mail_channel_dead)是**通道级**约束:邮件发不出去不代表表单不能投,
      // 一律短路会把还能投的站白白丢掉。原来写的是 `|| 'blocked'`,正好踩这个坑。
      const cons = all.filter(c => CONSTRAINT_STATUS[c.reason_code]);
      advisory = all.filter(c => !CONSTRAINT_STATUS[c.reason_code]);
      if (cons.length) {
        const c = cons[0];
        const st = CONSTRAINT_STATUS[c.reason_code];
        upsert(dom, st, `站点约束短路(${c.reason_code},${c.observed_at} 记录,至 ${c.expires_at || '永久'}):${(c.evidence || '').slice(0, 160)}`,
               '', { reason_code: 'constraint_active' });
        console.log(`[${dom}] 约束短路→${st}: ${c.reason_code}(过期 ${c.expires_at || '永久'},加 --ignore-constraints 可强试)`);
        return;
      }
    } catch (e) {
      // 【08-11 九轮评审 P1-2】写账专用错误不许吞(上面短路 upsert 可能抛),按基建故障上抛
      if (e && e.ledger) throw e;
      console.log(`[${dom}] 约束查询异常(忽略,继续):${e.message.slice(0, 80)}`);
    }
  }

  // ---- 侦察段:开浏览器前低成本预判(明确收费/硬门槛/类目不符直接 skip) ----
  if (!explicitUrl && !process.argv.includes('--no-recon')) {
    try {
      const rc = await recon(dom);
      if (rc.verdict === 'skip') {
        // 404 类 skip 给一次机械复核:LLM 可能漏看首页链接,findEntry 找到入口就继续,不许误判不可用
        if (/404|not.?found|不存在/i.test(rc.reason || '')) {
          const nu = await findEntry(dom);
          if (nu) {
            console.log(`[${dom}] recon 404 复核:发现真入口 ${nu},继续`);
            url = nu;
          } else {
            upsert(dom, 'blocked', `recon 预判:${(rc.reason || '').slice(0, 200)}(机械复核无入口)`);
            markUnusableIf404(dom, 'blocked', rc.reason || '');
            console.log(`[${dom}] recon skip→blocked(机械复核确认无入口)`);
            return;
          }
        } else {
          const st = rc.status || 'blocked';
          upsert(dom, st, `recon 预判:${(rc.reason || '').slice(0, 200)}`);
          markUnusableIf404(dom, st, rc.reason || '');
          console.log(`[${dom}] recon skip→${st}: ${(rc.reason || '').slice(0, 120)}`);
          return;
        }
      }
      if (rc.submit_url && /^https?:\/\//.test(rc.submit_url) && !target.startsWith('http')) {
        // 【08-11 七轮评审 P1】LLM 输出不可信(文本来自站点页面,可被注入):
        // submit_url 过闸(严格同根域 + IP 字面量/DNS 预检)才用,不合法就当没给。
        const v = await og.validateUrl(rc.submit_url, { allowedRoot: dom });
        if (v) url = v;
      }
    } catch (e) {
      // 【08-11 九轮评审 P1-2】写账专用错误不许吞(上面预判 upsert 可能抛),按基建故障上抛
      if (e && e.ledger) throw e;
      console.log(`[${dom}] recon 异常(忽略,继续):${e.message.slice(0, 80)}`);
    }
  }
  const t0 = Date.now();
  RUN_STARTED = new Date(t0).toLocaleString('sv-SE');   // 'YYYY-MM-DD HH:MM:SS' 本地时,给 emailOtp 的 --since 用
  deferMark(dom);   // 本 run 期间该域验证信由浏览器接管(sweeper 见 run/agent_defer 只校验不点开,TTL 20min)
  let captchaN = 0, retreatHinted = false;
  const pgRef = {};            // CDP 模式:agent 自己的页面引用,弹窗治理要豁免它
  let browser, ctx;
  if (useCdp) {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    ctx = browser.contexts()[0];
    // 弹广告治理:非目标域的新标签页自动关(OAuth 跳转的 google 域放行)
    ctx.on('page', async (p) => {
      try {
        if (pgRef.p && p === pgRef.p) return;            // 【2026-07-30】agent 自己的页面,别误杀
        await p.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
        const u = p.url();
        if (u === 'about:blank') return;                 // 刚创建还没导航 —— 上次连自己的首页都杀了
        if (!u.includes(dom) && !/google\.com|googleapis\.com|gstatic\.com|accounts\.google/i.test(u)) {
          await p.close();
          console.log(`[${dom}] 关掉弹窗标签:${u.slice(0, 60)}`);
        }
      } catch {}
    });
  } else {
    // 代理:--proxy 参数 > HTTPS_PROXY 环境变量 > 直连。
    // ⚠️ 用 cf_challenge 时出口必须与解题出口一致:cf_clearance 绑定 IP+UA。
    const proxyUrl = publicProxyUrl();
    if (proxyUrl) console.log(`[${dom}] 走代理 ${String(proxyUrl).replace(/\/\/.*@/, '//***@')}`);
    // 浏览器解析:CHROME_BIN 指定 > 本机 Chrome(channel) > playwright 管理的 chromium。
    const LAUNCH_ARGS = [
      // 这两条是 headless Chrome 最明显的自动化痕迹
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--lang=en-US,en',
    ];
    const launchOpts = {
      headless: !process.argv.includes('--show'),
      args: LAUNCH_ARGS,
      // Playwright 不接受 URL 里内嵌的账号密码,要拆开传
      ...(proxyUrl ? { proxy: parseProxy(proxyUrl) } : {}),
    };
    if (process.env.CHROME_BIN) {
      browser = await chromium.launch({ ...launchOpts, executablePath: process.env.CHROME_BIN });
    } else {
      try {
        browser = await chromium.launch({ ...launchOpts, channel: 'chrome' });
      } catch (e) {
        console.log(`[${dom}] 本机 Chrome 不可用(${String(e.message).slice(0, 60)}),`
          + `退回 playwright 管理的 chromium(先 npx playwright install chromium)`);
        browser = await chromium.launch(launchOpts);
      }
    }
    ctx = await browser.newContext({
      viewport: { width: 1280, height: 960 },
      userAgent: STEALTH_UA,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',   // 必须与 STEALTH_UA 一致,打架比不设更容易被识破
        'Upgrade-Insecure-Requests': '1',
      },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',   // 与 en-US 自洽
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      colorScheme: 'light',
    });
    await ctx.addInitScript(stealthInit);
    // 【08-13 流量治理】机场实测日耗 57-94GB(账单实证,不是我先估的 10GB)——
    // 主犯是整页渲染的图片/视频广告/字体。按 resourceType 整类拦(无扩展名的流也跑不掉),
    // stylesheet 不拦(布局崩了字段定位全废)。预期省 70-85%。
    await ctx.route('**/*', (r) => {
      const t = r.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return r.abort();
      const u = r.request().url();
      if (/(googlesyndication|doubleclick|googletagmanager|google-analytics|facebook\.net|adsystem|adservice|scorecardresearch|hotjar|clarity\.ms)/i.test(u)) return r.abort();
      return r.continue();
    });
    // 【08-03 事故护栏】mailto: 点击会唤起 macOS 邮件客户端,把草稿窗口弹到用户屏幕上。
    // prompt 里禁止过仍被点(buzz4ai/earthlink 实证),这里 DOM 层硬拦:捕获阶段截停,
    // href 里的邮箱地址照样可读(needs_outreach 归因不受影响)。
    await ctx.addInitScript(() => {
      document.addEventListener('click', (e) => {
        const a = e.target && e.target.closest && e.target.closest('a[href^="mailto:"]');
        if (a) { e.preventDefault(); e.stopPropagation(); }
      }, true);
    });
  }
  curBrowser = useCdp ? null : browser;   // CDP 连的是用户浏览器,不登记也不杀
  let pg = await ctx.newPage();
  curPg = pg;                  // 登记当前页,queueForHuman 等模块级函数取 URL 用
  pgRef.p = pg;                // 登记自己,弹窗治理豁免(CDP 模式下才有意义)
  // OAuth 弹窗接管的基线:开跑时已有的 tab 都不算弹窗(用户的 Gmail、上次 run 的残页)
  const pagesAtStart = new Set(useCdp ? ctx.pages() : []);
  // 【2026-07-30】CDP 模式收官自清:browser.close() 只是断开连接,run 开的 tab 全留着,
  // 59 站批量就堆上百个 tab(用户发现)。退出点统一调用,只关本 run 新开的,
  // pagesAtStart 里用户自己的 tab 一个不动。
  const closeCdpTabs = async () => {
    if (!useCdp) return;
    for (const p of ctx.pages()) {
      if (!pagesAtStart.has(p)) await p.close().catch(() => {});
    }
  };
  const log = [];
  // HTTP 层可见性:捕获表单 POST 的状态与响应片段(比 Surge MITM 安全的同效方案)
  // httpLog 是模块级共享(见文件头注释),这里只挂监听往里写。
  let httpSuccess = null;
  // 遥测/统计/广告/风控端点:一律不算提交证据,也不进证据日志(见全局 TELEMETRY)
  pg.on('response', async (r) => {
    try {
      if (r.request().method() !== 'POST' || r.status() >= 600) return;
      const u = r.url();
      if (TELEMETRY.test(u)) return;
      // 【2026-07-29】body 不能只截 300:phpLD 这类站把拒收文案埋在整页 HTML 中段,
      // 300 截断后 bad 拒词全落空、被拒也判成功(实证)。截 3000 供判定;展示另行截断。
      const body = (await r.text().catch(() => '')).slice(0, 3000);
      httpLog.push(`POST ${u.slice(0, 80)} → ${r.status()} ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
      // 【2026-07-31】WordPress 评论成功就是 302 跳回博文页(wp-comments-post.php),
      // 原实现 >=300 一律丢弃 —— 把博客圈最大的一块成功信号全扔了(bakerella 实证:
      // 评论已 302 受理,agent 还在等确认文案)。
      if (/wp-comments-post\.php/i.test(u) && r.status() >= 300 && r.status() < 400 && !httpSuccess) {
        // 【08-05 检讨实证】302 必须带 Location 锚点记账:WP 核心成功会跳 #comment-{id},
        // 但反垃圾插件(Antispam Bee 类)会"假收"——302 跳回博文页、评论静默丢弃。
        // 不记 Location 终核就分不清真受理 vs 假收,pending_review 全是水分(81/86 全灭实证)。
        const loc = (r.headers()['location'] || '');
        const anchor = /#comment-\d+/i.test(loc);
        httpSuccess = {
          status: 'success',
          evidence: `POST ${u.slice(0, 60)} → ${r.status()}(WP评论302${anchor ? '锚点受理' : '无锚点·疑假收'}) → ${loc.slice(0, 100)}`,
        };
        return;
      }
      if (r.status() >= 300 || httpSuccess) return;
      // 实锤双通道:①请求载荷或响应里带产品指纹 ②URL 有提交语义且响应是确认词;响应报错一律否
      const pd = (r.request().postData() || '').slice(0, 500);
      const mine = new RegExp(PSLUG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(pd + ' ' + body);
      const semanticEndpoint = /submit|submission|listing|directory|suggest|inclusion|add[-_]?tool|product|apply/i.test(u);
      const receiptStatus = classifyReceiptText(htmlText(body));
      // mine 通道载荷恒带产品指纹(我们自己发的),伪实锤唯一闸门是 bad ——
      // 但它不认识"Please go back and make sure you check the security reCAPTCHA box"
      // 这类规劝式拒收(#30 两站实证:被拒还判 success、还沉淀了毒 recipe)。补齐拒词。
      const bad = new RegExp('error|invalid|fail|denied|unauthor|forbidden|not.?logged|未登录|失败'
        + '|go.?back|' + CAPTCHA_REJECT + '|try.?again|required field'
        + '|please (go|check|fill|complete|verify)|missing|incorrect'
        + '|"code"\\s*:\\s*[45]\\d\\d|已经停止|已停止|不再接受|停止提交|暂停收录', 'i').test(body);
      // 生命周期前置接口(存在性检查/登录/注册/OTP/会话)不算提交实锤,即使载荷带产品名
      const preflight = /exist|check|validate|verify|otp|login|signin|register|signup|\/auth|session|refresh|captcha/i.test(u);
      if ((mine || semanticEndpoint) && receiptStatus && !bad && !preflight) {
        httpSuccess = {
          status: receiptStatus,
          evidence: `POST ${u.slice(0, 80)} → ${r.status()} ${body.replace(/\s+/g, ' ').slice(0, 120)}`,
        };
      }
    } catch {}
  });
  try {
    // 【08-11 七轮评审 P1】主入口 goto 挂同根域导航闸:重定向不许离开 dom 根域
    // 【08-11 八轮评审 P2-1a/P2-2】allowedRoot 用 PSL 站根;gotoGuarded 现在闸内等 2500ms
    // 并复核最终落点,落点出域 = 入口不可达,throw 给外层 catch 记 blocked。
    const land = await gotoGuarded(pg, url, domRoot, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!land.ok) throw new Error(land.why);
    // ---- 入口发现:落地 404/无表单时找真提交入口 ----
    const quick = await pg.evaluate(() => ({
      inputs: document.querySelectorAll('input,textarea,select').length,
      txt: (document.body ? document.body.innerText : '').slice(0, 400),
    })).catch(() => ({ inputs: 1, txt: '' }));
    if (quick.inputs === 0 || /404|not found|page.*(not|no).*exist|页面不存在/i.test(quick.txt)) {
      const nu = await findEntry(dom);
      if (nu && nu !== url) {
        console.log(`[${dom}] 入口发现:${nu}`);
        url = nu;
        // 【08-11 九轮评审 P2-1】不许 .catch(() => null):导航闸 abort 会让 goto reject,
        // 吞成 null 流程就留在旧页面继续走,闸拒语义丢失。与主入口同口径:原样上抛,
        // 外层 catch 记 blocked。
        const land2 = await gotoGuarded(pg, url, domRoot, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!land2.ok) throw new Error(land2.why);   // 发现的入口落点出域 = 入口不可达
        await pg.waitForTimeout(2000);
      }
    }
    // ---- recipe 快放:有沉淀打法先走捷径 ----
    initRecipes();
    const recipe = process.argv.includes('--fresh') ? null : loadRecipe(dom);
    if (recipe && recipe.steps) {
      console.log(`[${dom}] 有 recipe(${recipe.steps.length}步),快放…`);
      const rp = await replayRecipe(pg, dom, recipe);
      log.push(...rp.log);
      if (rp.ok) {
        await pg.waitForTimeout(2000);
        let st;
        if (rp.httpHit) {
          st = rp.httpHit.status;
        } else {
          const txt = await pg.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 500));
          // 【08-11 十三轮评审 P1-3】整页裸 success/review 会撞否定句和导航文案；
          // 复用严格回执，证据不足且已经 claim 时保持 ambiguous。
          st = classifyReceiptText(txt) || (SUBMIT_DISPATCHED ? 'delivery_ambiguous' : 'blocked');
        }
        await pg.screenshot({ path: `/tmp/agent_${dom}_final.png`, fullPage: true }).catch(() => {});
        const recipeR = upsert(dom, st, `agent_submit recipe 快放(${rp.log.length}步)${rp.httpHit ? ' | HTTP实锤:' + rp.httpHit.evidence : ''} | 目标:${explicitUrl || pg.url()}`);
        const actualRecipeStatus = recipeR && recipeR.to ? recipeR.to : st;
        if (recipeR && recipeR.blockedRegression) {
          console.error(`[${dom}] recipe 快放判 ${st} 被状态守卫拒绝,实际终局 ${actualRecipeStatus}`);
        }
        if (actualRecipeStatus === 'delivery_ambiguous') {
          queueAmbiguousTerminal(dom, `recipe 快放无严格回执(${st})`);
        }
        console.log(`[${dom}] recipe 快放终局:${actualRecipeStatus}`);
        await closeCdpTabs();
  await browser.close();
        return;
      }
      console.log(`[${dom}] recipe 快放失败(${rp.fail}),回退 LLM 探路`);
      // 【08-11 十一轮评审 P1-6】提交点击结果不明(ambiguous)时**不许重导航**:
      // 提交可能已投达,当前页就是回执/校验错误现场;拉回入口页重填 = 重复提交。
      // 原地交 LLM 观察流判定(认领行已在,观察出的 blocked 也会被守卫拦成
      // delivery_ambiguous,不会误烧投达单)。
      if (!rp.ambiguous) {
        // 【08-11 九轮评审 P2-1】同上:闸拒必须上抛进外层 blocked,不许吞成 null 在旧页面继续
        const land3 = await gotoGuarded(pg, url, domRoot, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!land3.ok) throw new Error(land3.why);   // 重进入口落点出域 = 入口不可达
        await pg.waitForTimeout(2000);
      } else {
        console.log(`[${dom}] 提交结果不明(delivery_ambiguous 已认领),不重导航,原地交 LLM 观察判定`);
      }
    }
    // ---- 渲染后侦察:开填前先看清门槛/价格(SPA 内容 curl 抓不到) ----
    try {
      const txt = await pg.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 2500));
      // 【2026-07-30】要外链站的机械识别(用户拍板:一律不理会)。两个模版家族通吃:
      // ① 三步向导(goodaitools/ashlist):Website→Badge→Details,第 2 步必挂徽标
      // ② 挂码在先(navs.site):表单内嵌回链代码,"add the above code to your homepage
      //    then submit"。不判模版血缘,只判「要求回链」这个需求特征。
      if (/generate (a )?badge|add (the )?badge before|verify badge|badge (is )?required|must (add|display|link)[^.]{0,40}badge|badge[^.]{0,40}(do-?follow|link back)|add it before continuing|徽标|回链验证|add (the )?(above|following|this|below) (code|link|badge|html)|place (this|the) (code|link|badge) (on|in|to) your|add (the )?(code|link|badge) to your (website )?(homepage|footer|site)|please add .{0,80}(homepage|your website|your site)|link back to us|backlink (is )?required/i.test(txt)) {
        // 【08-11 十二轮评审 P2-1 修】接 upsert 返回值:recipe 复放 ambiguous 后
        // 按设计不重导航、原地继续,本段渲染侦察照样会跑 —— 旧代码无条件把
        // 认领行(delivery_ambiguous)覆盖成 skipped_badge 并 return 终局。
        // 守卫拦下时(含投达终局):不写 3650 天约束、不 return,继续观察流。
        const badgeR = upsert(dom, 'skipped_badge', '渲染侦察:要回链站(按政策不理会)');
        if (badgeR && badgeR.blockedRegression) {
          console.error(`[${dom}] DELIVERY_AMBIGUOUS 要回链站判定被守卫拦下(投递认领在先),终局停 ${badgeR.to},原地交 LLM 观察流,不记 badge 约束`);
        } else {
          try { dbw.addConstraint({ domain: dom, reason_code: 'badge_required',
                                    evidence: '要回链站(机械识别)', ttl_days: 3650 }); } catch {}
          console.log(`[${dom}] 机械识别:要回链站 → skipped_badge 短路`);
          await closeCdpTabs();
  await browser.close();
          return;
        }
      }
      if (txt.length > 200 && !explicitUrl) {
        // 【2026-07-31】类目/门槛预判只对目录站成立。博文评论场景问的是
        // 「这站收不收 Entertainment 产品」是伪命题 —— 我们是去博文下写人话评论,
        // 不是投产品页(bakerella 被判 skipped_fit 实证:烘焙博客不给 quiz 类目过,
        // 但评论植入正是打法)。explicitUrl 跳过这段 LLM 预判。
        const rc2 = await llm([
          { role: 'system', content: RECON_SYS },
          { role: 'user', content: `站点 ${dom} 提交页渲染文本:\n${txt}` },
        ]);
        const j = JSON.parse(rc2);
        if (j && j.verdict === 'skip') {
          const st = j.status || 'blocked';
          // 【08-11 十二轮评审 P2-1 修】接 upsert 返回值,与 :2296-2300 同口径:
          // 守卫拦下(投递认领在先)时不 return 终局、不出池,原地交观察流。
          const skipR = upsert(dom, st, `渲染侦察预判:${(j.reason || '').slice(0, 200)}`);
          if (skipR && skipR.blockedRegression) {
            console.error(`[${dom}] DELIVERY_AMBIGUOUS 渲染侦察判 ${st} 被守卫拦下(投递认领在先),终局停 ${skipR.to},原地交 LLM 观察流,不出池`);
          } else {
            markUnusableIf404(dom, st, j.reason || '');
            console.log(`[${dom}] 渲染侦察 skip→${st}: ${(j.reason || '').slice(0, 120)}`);
            await closeCdpTabs();
  await browser.close();
            return;
          }
        }
      }
    } catch (e) {
      // 【08-11 十轮评审 P2-2】与约束短路(:1664)/curl 侦察(:1702)同口径:写账失败
      // (err.ledger,LEDGER_WRITE_FAILED)不许吞 —— 吞掉会绕过上面 skipped_badge/
      // skipped_fit 的短路 return,流程继续对一个该按政策跳过的站填表提交。
      // 渲染侦察的良性噪声(evaluate/LLM 解析失败)照旧忽略。
      if (e && e.ledger) throw e;
    }
    // ---- LLM 探路 ----
    let verdict = null;
    let failStreak = 0;
    let lastSig = '', sameStreak = 0;
    // 页面指纹 + 无进展计数(见循环里的说明)。4 步不动就收工。
    let lastFp = '', noProgress = 0;
    const NO_PROGRESS_LIMIT = +(process.env.SUBMIT_NO_PROGRESS || 4);
    let lastObsText = '', submitNoDelta = 0;
    // 【08-12 用户定】页面 JS 重载检测:重 JS 页会把 renderer 拉到 100% CPU 空转,
    // 之前只能等 12 分钟看门狗硬顶,整机负载被这些站推高。现在每步用 CDP
    // Performance.getMetrics 采 TaskDuration,主线程任务时长/墙钟 > 0.8 连续 3 步
    // = JS 满载死转,提前 blocked 收工,不烧负载不等硬顶。
    let cdpPerf = null, cdpPerfPg = null, prevTask = -1, prevWall = 0, jsBusyStreak = 0;
    const JS_BUSY_LIMIT = +(process.env.SUBMIT_JS_BUSY_STEPS || 3);
    async function jsBusySample() {
      try {
        if (!cdpPerf || cdpPerfPg !== pg) {
          cdpPerf = await pg.context().newCDPSession(pg); cdpPerfPg = pg;
          await cdpPerf.send('Performance.enable'); prevTask = -1;
        }
        const { metrics } = await cdpPerf.send('Performance.getMetrics');
        const t = (metrics.find(x => x.name === 'TaskDuration') || {}).value ?? 0;
        const now = Date.now();
        if (prevTask >= 0 && prevWall) {
          const ratio = (t - prevTask) / ((now - prevWall) / 1000);
          jsBusyStreak = ratio > 0.8 ? jsBusyStreak + 1 : 0;
        }
        prevTask = t; prevWall = now;
      } catch { cdpPerf = null; /* 采样失败不动 streak,下步重建会话重采 */ }
      return jsBusyStreak;
    }
    for (let step = 1; step <= maxSteps; step++) {
      // HTTP 层实锤优先:后端已确认收到,不再看页面脸色
      // 前提是我们已经动过手(log 非空)——页面加载期的请求再像提交也不算
      if (httpSuccess && log.length > 0) {
        verdict = { status: httpSuccess.status, reason: httpSuccess.evidence };
        log.push(`S${step}:HTTP 实锤→${verdict.status}`);
        break;
      }
      // ---- CDP:OAuth 弹窗接管(2026-07-30)----
      // Google OAuth 按钮通常**另开标签页**走 accounts.google.com —— agent 还盯着
      // 自己的主页面,自然永远"找不到账号选择器"(goodaitools 实证:选择器在弹窗里,
      // 主页面没有)。每轮先看有没有 google 域弹窗:有就切过去开;弹窗关了就回主页面。
      // ⚠️ 只接管**本次 run 开跑后**新开的 tab:用户在受控浏览器里常挂着 Gmail/
      // myaccount 等旧 tab,连上次 run 的 OAuth 残页也在 —— 不区分的话会把 run
      // 劫到 Gmail 收件箱去(实证)。起跑时快照了 pagesAtStart。
      if (useCdp) {
        try {
          if (pg.isClosed()) {
            pg = ctx.pages().find(p => !p.isClosed() && p.url().includes(dom)) || ctx.pages()[0];
            curPg = pg; pgRef.p = pg;
          } else {
            const gp = ctx.pages().find(p => p !== pg && !p.isClosed()
              && !pagesAtStart.has(p)
              && /accounts\.google\.com|oauth/i.test(p.url()));
            if (gp) {
              // OAuth 弹窗可能在首次授权时创建站点账号。即使受控 Chrome 已登录 Google,
              // 没有本次命令对精确站点的批准也不能机械点账号行或同意按钮。
              if (!registrationApproved(dom)) {
                await gp.close().catch(() => {});
                registrationApprovalStop(dom, '检测到 Google/OAuth 新账号授权弹窗');
              }
              const clicked = await gp.evaluate(() => {
                const els = [...document.querySelectorAll('div,li,span,a')]
                  .filter(e => /@gmail\.com/.test(e.textContent || '') && (e.textContent || '').length < 100);
                if (els.length) { els[els.length - 1].click(); return 'account'; }
                const btn = [...document.querySelectorAll('button,[role=button],input[type=submit]')]
                  .find(b => /允许|继续|Allow|Continue|同意/i.test(b.innerText || b.value || ''));
                if (btn) { btn.click(); return 'consent'; }
                return null;
              }).catch(() => null);
              if (clicked) {
                console.log(`[${dom}] 机械点选 Google ${clicked === 'account' ? '账号行' : '授权按钮'}成功`);
                await pg.waitForTimeout(4000);
              } else {
                pg = gp; curPg = gp; pgRef.p = pg;
                console.log(`[${dom}] 接管 OAuth 弹窗(机械点选未中,交 LLM):${gp.url().slice(0, 60)}`);
              }
            }
          }
        } catch {}
      }
      const obs = await observe(pg);
      // JS 重载闸(08-12):renderer 持续满转 3 步,提前收工
      if (await jsBusySample() >= JS_BUSY_LIMIT) {
        verdict = { status: 'blocked', reason: `页面 JS 满载(renderer 连续 ${jsBusyStreak} 步满转),提前放弃` };
        log.push(`S${step}:JS满载→blocked`);
        break;
      }
      // 最近的 POST 响应(含 4xx 校验错误)喂给决策端,让它看到服务器的真实理由
      const httpCtx = httpLog.length ? `\n最近网络往返:${httpLog.slice(-3).join(' ;; ')}` : '';
      const reply = await llm([
        { role: 'system', content: SYSTEM + advisoryNote() },
        { role: 'user', content: `当前页面状态(第${step}步):\n${JSON.stringify(obs)}\n历史动作:${log.slice(-6).join(' | ') || '无'}${httpCtx}` },
      ]);
      let a;
      try { a = JSON.parse(reply); } catch { log.push(`S${step}:LLM 输出非 JSON`); continue; }
      if (a.action === 'done') { verdict = { status: a.result || 'blocked', reason: a.reason || '' }; log.push(`S${step}:done→${verdict.status}(${verdict.reason})`); break; }
      // 【2026-07-26 修】giveup 一直写在 SYSTEM 的合法动作表里,但主循环只认 done ——
      // LLM 想放弃时掉进"未知动作"继续空转到步数上限。现在收紧 emailed 定义后
      // giveup(needs_outreach)是正路,必须干净退出。
      if (a.action === 'giveup') { verdict = { status: 'blocked', reason: a.reason || 'LLM 放弃,未给归因' }; log.push(`S${step}:giveup(${verdict.reason})`); break; }
      // 代码红线:付费动作拦截
      if (/pay|checkout|purchase|buy|付款|支付|购买/i.test(String(a.target) + String(a.value || ''))) {
        verdict = { status: 'skipped_paid', reason: 'LLM 欲点付费,代码拦截' };
        log.push(`S${step}:付费拦截`);
        break;
      }
      const r = await act(pg, a, dom);
      log.push(`S${step}:${a.action} ${a.target || ''}→${r.text}`);
      console.log(`[${dom}] S${step} ${a.action} ${a.target || ''} → ${r.text}`);
      // 【08-11 十二轮评审 P2-3】single-shot 教义:提交类动作被"已认领禁二击"
      // 拦下时(act 返回拒点文案),不再让 LLM 换着花样点第三次 —— 现场观察
      // 一次页面:见到回执抬 success/pending_review,否则收 delivery_ambiguous
      // 终局交人工,不空转烧步数。
      if (a.action === 'click' && shouldObserveSubmit(r)) {
        const txt = await pg.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 1200)).catch(() => '');
        const receiptStatus = classifyReceiptText(txt);
        if (receiptStatus) {
          verdict = { status: receiptStatus,
            reason: `提交已派发过(拒二击),观察页见回执:${txt.slice(0, 150)}` };
        } else {
          verdict = { status: 'delivery_ambiguous',
            reason: `submit 类动作此前已派发,拒绝二次点击(${String(a.target).slice(0, 60)}),页面未见回执,人工裁决不重投` };
        }
        log.push(`S${step}:已认领禁二击→${verdict.status}`);
        break;
      }
      // ---- 预算纪律:验证码花钱有上限,时间烧到 80% 注入降档提示,120% 硬停 ----
      if (a.action && a.action.startsWith('captcha')) {
        captchaN++;
        if (captchaN > MAX_CAPTCHA) {
          verdict = { status: 'blocked', reason: `验证码预算尽(${MAX_CAPTCHA}次,转人工或换 IP 再来)` };
          log.push(`S${step}:验证码预算尽`);
          break;
        }
      }
      const elapsed = Date.now() - t0;
      if (!retreatHinted && elapsed > MAX_MINUTES * 60000 * 0.8) {
        retreatHinted = true;
        log.push(`系统提示:时间预算已烧 80%(${MAX_MINUTES}分钟上限),若提交无望请立即降档:站内联系表单提交成功→done(emailed),页面只有公开邮箱→giveup(needs_outreach: 邮箱),禁止死磕`);
      }
      if (elapsed > MAX_MINUTES * 60000 * 1.2) {
        verdict = { status: 'blocked', reason: `时间预算尽(${MAX_MINUTES}分钟),未完成` };
        log.push(`S${step}:时间预算硬停`);
        break;
      }
      // 提交后无页面变化×2:抓取校验错误信息直接 giveup,不再空转
      // 【08-11 十三轮评审 P1-2】无变化计数也只看 act 对真实 DOM 的分类结果，
      // “Submit your product” 导航链接不能再凭 target 文案走提交失败分支。
      if (a.action === 'click' && shouldTrackSubmitNoDelta(r)) {
        const before = lastObsText || '';
        await pg.waitForTimeout(1500);
        const after = await pg.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 1200));
        if (before && before.slice(0, 600) === after.slice(0, 600)) {
          submitNoDelta++;
          if (submitNoDelta >= 2) {
            const errs = await pg.evaluate(() => [...document.querySelectorAll('[class*=error],[class*=invalid],[role=alert],[class*=require]')].map(e => e.innerText.trim()).filter(Boolean).slice(0, 5).join(' | '));
            verdict = { status: 'blocked', reason: `提交 2 次无响应(疑校验未过):${errs || '无可见错误'}` };
            log.push(`S${step}:提交空转退出`);
            break;
          }
        } else submitNoDelta = 0;
      }
      lastObsText = await pg.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200)).catch(() => '');
      // 连续 2 次动作失败:注入提示让 LLM 换路或 giveup,防死循环
      if (/失败|未找到|找不到/.test(r.text)) {
        failStreak++;
        if (failStreak >= 2) {
          const hint = await llm([
            { role: 'system', content: SYSTEM + advisoryNote() },
            { role: 'user', content: `连续${failStreak}次动作失败。历史:${log.slice(-6).join(' | ')}。请换思路(如 scroll/换目标)或 giveup 并说明卡点。` },
          ]);
          try {
            const h = JSON.parse(hint);
            if (h.action === 'done') { verdict = { status: h.result || 'blocked', reason: h.reason || '' }; log.push(`S${step}:连跪退出→${verdict.status}`); break; }
            // 2026-07-27 审查 P3:这里原来**只认 done**,其余一律丢弃 ——
            // 而 prompt 问的正是"请换思路(如 scroll/换目标)或 giveup"。
            // LLM 老老实实回了 scroll 或新目标,代码 parse 完就扔:钱花了、建议没用,
            // 卡死的循环继续卡着,直到耗完步数判 blocked。
            // 紧挨着的视觉诊断分支是对的(它会执行 h.action),照它办。
            if (h.action) {
              const r2 = await act(pg, h, dom);
              log.push(`S${step}b(换路):${h.action} ${h.target || ''}→${r2.text}`);
              console.log(`[${dom}] S${step}b(换路) ${h.action} ${h.target || ''} → ${r2.text}`);
              if (!/失败|未找到|找不到/.test(r2.text)) failStreak = 0;   // 换路成功就清零,别接着连跪
            }
          } catch (he) { if (he && (he.infra || he.budget || he.ledger || he.registrationApprovalRequired)) throw he; }   // 基建/预算/写账/注册审批硬停不许吞
        }
      } else failStreak = 0;
      // ---- 页面没动 = 没进展(2026-07-27 加)----
      //
      // 下面那个 sameStreak 只认"同一动作+同一目标连续 3 次",而 LLM 卡住时
      // 往往在几个目标之间来回换(Continue → b3 → Continue → b16 → Continue…),
      // 签名一直在变,streak 永远归零,于是**检测器形同虚设**。
      // 实测两次:findtheneedle.co.uk 9 步点了 6 次同一按钮、
      // toolindex.net 20 步点了 8 次 Continue,两次都把步数预算烧光才被 alarm 杀掉。
      //
      // 真正的信号不是"动作重复",是**页面根本没变**。这里按
      // (URL + 正文长度 + 可填字段数) 做指纹:连续 4 步指纹不动 = 无论点什么都没用,
      // 直接收工,把剩下的步数留给别的站。
      let fp = '';
      try {
        fp = await pg.evaluate(() => {
          // 【2026-07-28 修:我上一版写错了】原来的指纹是
          //   [URL, innerText.length, 字段数]
          // 但**填表单不改变这三样中的任何一个** —— 输入框的 value 不进 innerText、
          // URL 不变、字段数不变。于是"正在认真填表"和"呆着不动"在指纹下完全一样。
          // 实测当场打断了 llmstxt.site(fill i2→i3→i4)和 submitaitools.org(fill i2→i3→i4),
          // 它们都在正常填表,被判成卡死。本轮 50% 的失败是这么来的,是自伤不是站方问题。
          //
          // 现在把**已填内容**算进指纹:每填一个字段,指纹就变,不会误判。
          // 同时保留原来那三项 —— 页面真跳转/真变化时它们才是主信号。
          const vals = [...document.querySelectorAll('input,textarea,select')]
            .map(el => (el.type === 'password' ? el.value.length      // 密码只记长度,不入日志
                        : el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 1 : 0)
                        : (el.value || '').length))                   // 只记长度,不记内容
            .join(',');
          return [
            location.href,
            document.body.innerText.length,
            document.querySelectorAll('input,textarea,select').length,
            vals,                                       // ← 关键:填了字就变
            document.querySelectorAll('form').length,
          ].join('|');
        });
      } catch { /* 页面正在跳转就跳过这一轮判断 */ }
      if (fp && fp === lastFp) {
        // 【2026-07-30】等信步不算卡死:email_otp 本身已在站内等了 90s,页面本来就不
        // 该动 —— 计进「无进展」会把验证信在路上的站全冤杀(foundrlist 实证:码在
        // 投递途中,探测器先判了死刑)。email_otp 当步跳过计数;信到了页面一动,
        // fp 变化,计数自然归零恢复。
        if (a.action !== 'email_otp') {
          noProgress++;
          if (noProgress >= NO_PROGRESS_LIMIT) {
            verdict = { status: 'blocked',
              reason: `连续 ${noProgress + 1} 步页面无任何变化(URL/正文/字段数都没动),判定卡死` };
            log.push(`S${step}:页面${noProgress + 1}步无变化→退出`);
            console.log(`[${dom}] 页面连续 ${noProgress + 1} 步无变化,判定卡死,提前收工`);
            break;
          }
        }
      } else { noProgress = 0; lastFp = fp; }

      // 同一动作+目标连续 3 次:截图给 LLM 看,诊断到底卡在哪
      const sig = `${a.action}|${a.target || ''}`;
      if (sig === lastSig) sameStreak++; else { sameStreak = 1; lastSig = sig; }
      if (sameStreak === 3) {
        const hint = await llmVision(pg, `同一动作(${sig})已执行 3 次无进展。请诊断:页面现在是什么状态?是不是填错了槽位/有未过的校验/提交按钮另有其人?历史:${log.slice(-5).join(' | ')}。输出下一步 JSON 或 done。`);
        try {
          const h = JSON.parse(hint);
          if (h.action === 'done') { verdict = { status: h.result || 'blocked', reason: h.reason || '' }; log.push(`S${step}:视觉诊断退出→${verdict.status}`); break; }
          if (h.action) {
            const r2 = await act(pg, h, dom);
            log.push(`S${step}b(视觉):${h.action} ${h.target || ''}→${r2.text}`);
            console.log(`[${dom}] S${step}b(视觉) ${h.action} ${h.target || ''} → ${r2.text}`);
          }
        } catch (he) { if (he && (he.infra || he.budget || he.ledger || he.registrationApprovalRequired)) throw he; }   // 基建/预算/写账/注册审批硬停不许吞
        sameStreak = 0;
      }
      await pg.screenshot({ path: `/tmp/agent_${dom}_s${step}.png` }).catch(() => {});
    }
    if (!verdict) verdict = { status: 'blocked', reason: `超 ${maxSteps} 步未决` };
    // ---- 提交后自验证:success 必须实站可见,不可见降 pending_review ----
    // 【2026-07-26 修】此处原来漏 await:Promise 恒为真值 → 无条件抬 success,
    // "未核验到就降 pending_review" 永不可达,库里落过 "[object Promise]" 证据。
    if (verdict.status === 'success' || verdict.status === 'pending_review') {
      const v = await verifyOnline(dom);
      if (v) {
        verdict = { status: 'success', reason: `${verdict.reason} | 已核验在线:${v}` };
        console.log(`[${dom}] 自验证通过:${v}`);
      } else if (verdict.status === 'success') {
        verdict = { status: 'pending_review', reason: `${verdict.reason} | 接口确认但暂未检索到(审核/索引延迟)` };
        console.log(`[${dom}] 自验证未检索到,降为 pending_review`);
      }
    }
    await pg.screenshot({ path: `/tmp/agent_${dom}_final.png`, fullPage: true }).catch(() => {});
    const httpTail = httpLog.length ? ' || HTTP: ' + httpLog.slice(-3).join(' ;; ') : '';
    const termR = upsert(dom, verdict.status, `agent_submit(LLM-in-loop ${log.length}步) | ${verdict.reason} | ${log.slice(-4).join(' | ').slice(0, 300)}${httpTail} | 目标:${explicitUrl || pg.url()}`.slice(0, 780));
    const actualStatus = termR && termR.to ? termR.to : verdict.status;
    // 【08-11 十一轮评审 P1-7】投递认领在先时,观察出的 blocked 会被守卫拦下
    // (终局停 delivery_ambiguous):响亮打标记,且不再按"确认无入口"出池 ——
    // 提交可能已投达,出池语义不成立。
    if (termR && termR.blockedRegression) {
      console.error(`[${dom}] DELIVERY_AMBIGUOUS 观察到的 ${verdict.status} 被守卫拦下(投递认领在先),终局停 ${actualStatus},人工裁决不重投`);
    }
    if (actualStatus === 'delivery_ambiguous') {
      queueAmbiguousTerminal(dom, `正常终端判 ${verdict.status}:${verdict.reason}`);
    }
    // 语义分层:提交入口 404/无表单 = 站不收件(不可用),不是"卡住可重试"——出池标 no,不再占用重投
    if (!(termR && termR.blockedRegression)) markUnusableIf404(dom, actualStatus, verdict.reason);
    console.log(`[${dom}] 终局:${actualStatus}${actualStatus !== verdict.status ? `(请求 ${verdict.status} 被拒)` : ''} | ${verdict.reason}`);
    if (httpLog.length) console.log(`[${dom}] HTTP:\n  ` + httpLog.slice(-5).join('\n  '));
    // 终局若是可复用的硬约束(仅 OAuth / 必挂 badge / 提交即 500 / 验证码过不去 / 付费墙),
    // 记进 site_constraints,下次同站直接短路,不再从零探路烧 8 分钟 + LLM token
    if (!(termR && termR.blockedRegression)) recordConstraint(dom, actualStatus, verdict.reason);
    // 成功/待审 → 沉淀 recipe,下次快进
    if (!(termR && termR.blockedRegression)
        && (actualStatus === 'success' || actualStatus === 'pending_review')) {
      const rp = await distillRecipe(dom, log).catch(() => null);
      if (rp && rp.steps && rp.steps.length) {
        saveRecipe(dom, rp.steps, actualStatus, rp.notes || '');
        console.log(`[${dom}] recipe 已沉淀(${rp.steps.length}步):${(rp.notes || '').slice(0, 60)}`);
      }
    }
  } catch (e) {
    // 【08-05 实证】LLM 限流/上游抖动是基建瞬态,不是目标站的错 —— 写 blocked 会把
    // 该域永久烧出池(pick 排除一切有 submission 行的域)。瞬态错误:不写账,域留池,
    // 睡 60s 给账号限流窗口回气,驱动下一批自然重投。
    // 【08-11 P1-新2】打码侧的同类错误同口径:capsolver/dbw  fail-closed 抛的
    //   e.infra(账本不可用)/e.budget(日预算熔断)也不是目标站的错,旧代码落到 else
    //   分支写 blocked,把每个带验证码的域逐一永久烧出池。
    //   消息里保留「LLM 瞬态」字样:在跑的旧版 rolling_submit 无声退出兜底只认这个词,
    //   不带它旧驱动会把这两条路径当成无声崩溃补记 blocked(新驱动已加预算/基建标记)。
    // 已 claim 后走到任何异常分支都已是本次 run 的终端；仅当总账仍 ambiguous
    // 才幂等入队。若 delivered 已先升级，writer 条件 INSERT 会拒绝 stale task。
    if (SUBMIT_DISPATCHED) {
      queueAmbiguousTerminal(dom, `agent 异常终端:${String(e && e.message || e).slice(0, 160)}`);
    }
    if (e && e.ledger) {
      // 【08-11 九轮评审 P1-2】终局写账失败(表单可能已投达):按基建故障处理 ——
      // 绝不写 blocked(投达单被烧成 blocked 正是本 bug;且账本坏了也写不进),
      // 域留池未烧;exit 43 + stderr 响亮,rolling_submit 认 LEDGER_WRITE_FAILED
      // 标记跳过无声补记,下波自然重投。
      console.error(`[${dom}] LEDGER_WRITE_FAILED 终局写账失败(表单可能已投达),不写 blocked,域留池,exit 43`);
      process.exitCode = 43;
    } else if (e && e.noSolver) {
      // 有验证码但没有可用 solver:终态 manual,不烧步数不硬刚,driver 视 manual 为终态。
      // 【修】原注释说"人工队列已入" —— 只有 `!cs.hasKey()` 那几个分支入过队。
      // 只配 2Captcha 却撞上 CapSolver 独有任务(整页 CF 挑战)时,noSolver 从
      // solveWithFallback 抛出,人工队列是空的 → 状态 manual 但没人知道要去做。
      // 这里补一次幂等入队(humanTaskAdd 同域同 blocker 折叠,重复调用无害)。
      // 【修】queueForHuman 内部吞异常并**返回 false**,外面的 try/catch 捕不到 ——
      // 原来入队失败照样写 manual:driver 视 manual 为终态永久排除该域,而人工队列
      // 里根本没有这条任务 = 静默丢站。现在看返回值:入不了队就不落 manual,
      // 让它按普通失败留池,下波重试。
      // blocker 统一用 'captcha_manual'(no-key 路径用的是 captcha_turnstile 等),
      // 避免同一个域因名字不同留下两条 pending。
      // 【修】无 key 的 turnstile/cf_challenge/recaptcha 分支**已经**用具体 blocker 建过任务,
      // 这里再建一个 captcha_manual 就是两条 pending(任务按 domain|blocker 折叠,不会合并)。
      // 那些分支抛错前会置 e.queued —— 已入队就不重复建,只复用。
      const queued = e.queued || queueForHuman(dom, 'captcha_manual',
        `${String(e.message).slice(0, 120)} —— 请在 ${dom} 页面里人工过验证码再提交(字段已预填)`);
      if (queued) {
        try {
          upsert(dom, 'manual', `${String(e.message).slice(0, 120)}:已转人工队列(human_tasks.jsonl)`);
          console.log(`[${dom}] 验证码无 solver → manual(转人工)`);
        } catch (ue) { if (ue && ue.ledger) throw ue; }
      } else {
        // 入不了队就**不落 manual**:manual 是终态,driver 会永久排除该域,
        // 而人工队列里没有这条任务 = 静默丢站。域留池,下波重试。
        // 【修】driver 的无声退出兜底靠 SILENT_SKIP_MARKERS 文本匹配才会"不补记 blocked",
        // 原来这行不含任何标记 → driver 照样写 blocked,与"域留池下波重试"的意图相反。
        // 用 LEDGER_WRITE_FAILED(driver 的 SILENT_SKIP_MARKERS 里有它)。
        console.error(`[${dom}] LEDGER_WRITE_FAILED 人工入队失败,不落 manual`
          + `(否则该域被永久排除却无人处理),域留池,exit 43`);
        process.exitCode = process.exitCode || 43;
      }
    } else if (e && e.registrationApprovalRequired) {
      // human task 与 blocked/needs_registration_approval 已在触碰 signup/OAuth 前落好。
      // 这里不再补写普通 blocked,也不继续 LLM 步循环。
      console.log(`[${dom}] 新目录注册未获逐站批准 → blocked/needs_registration_approval`
        + `${e.queued ? '(已入人工队列)' : '(人工队列写入失败,请检查 human_tasks)'}`);
      if (!e.queued) process.exitCode = process.exitCode || 43;
    } else if (e && e.budget) {
      // 日预算熔断:写事件(reason_code=budget_exceeded,此前定义了没人用),不写
      // submissions 行(域留池),exit 42 通知驱动停波 —— 不然后面每个带验证码的域
      // 都要空跑一次才发现没钱了。
      console.log(`[${dom}] 打码日预算熔断(${String(e.message).slice(0, 80)}),不写 blocked,域留池(与 LLM 瞬态 同口径),exit 42 停波`);
      try {
        dbw.recordEvent({
          domain: dom, event_type: 'note', reason_code: 'budget_exceeded',
          source: 'agent_submit', evidence: String(e.message).slice(0, 300),
        });
      } catch {}
      process.exitCode = 42;
    } else if (e && e.infra) {
      console.log(`[${dom}] 打码基建故障(${String(e.message).slice(0, 80)}),不写 blocked,域留池(与 LLM 瞬态 同口径),睡 60s`);
      await new Promise(r => setTimeout(r, 60000));
    } else if (llmTransient(e)) {
      console.log(`[${dom}] LLM 瞬态(${String(e.message).slice(0, 80)}),不写 blocked,域留池,睡 60s`);
      await new Promise(r => setTimeout(r, 60000));
    } else {
      try {
        const ur = upsert(dom, 'blocked', `agent_submit 中断: ${e.message.slice(0, 200)} | ${log.slice(-3).join('|')}`);
        // 【08-11 十一轮评审 P1-7】投递认领在先(派发后、落账前异常):守卫拦下
        // blocked,该域停 delivery_ambiguous —— 永不自动重投,人工裁决。
        if (ur && ur.blockedRegression) {
          console.error(`[${dom}] DELIVERY_AMBIGUOUS submit 派发后异常(${String(e.message).slice(0, 80)}),终局未定,不重投待人工`);
        }
      } catch (ue) {
        // 【08-11 九轮评审 P1-2】连 blocked 补账都写不进:同 LEDGER_WRITE_FAILED 口径,
        // 域留池未烧,exit 43 + stderr 标记,驱动不补记
        if (ue && ue.ledger) {
          console.error(`[${dom}] LEDGER_WRITE_FAILED blocked 补账失败,域留池,exit 43`);
          process.exitCode = 43;
        } else throw ue;
      }
      console.log(`[${dom}] EXC ${e.message.slice(0, 150)}`);
    }
  } finally {
    // 【修】原来这两行在 try/catch **之后**裸放:catch 里有两条 `throw ue`(写账
    // 失败重抛)会跳过它们,Chromium 就此变成孤儿进程 —— 而 driver 的
    // subprocess.run(timeout=900) 只杀直接子进程,杀不到浏览器。放进 finally,
    // 无论正常收尾、异常收尾还是 catch 内重抛,都保证关掉。
    // (try 内几处提前 return 也各自关过一次;browser.close() 幂等,重复调用无害。)
    await closeCdpTabs().catch(() => {});
    await browser.close().catch(() => {});
  }
}

const IS_DIRECT_RUN = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_DIRECT_RUN) main().catch(e => {
  // 【08-11 九轮评审 P1-2】LEDGER_WRITE_FAILED 逃到顶层也要 exit 43(消息含标记,
  // 驱动按文本兜底识别),其余未捕获故障照旧 exit 1
  console.error('FATAL', e.message);
  // 【08-11 十一轮评审 P1-7】submit 派发后逃到顶层的异常:认领行已在库,
  // 驱动兜底见行不补记;再打一行标记双保险。
  if (SUBMIT_DISPATCHED) {
    if (CURRENT_DOM) queueAmbiguousTerminal(CURRENT_DOM, `顶层 FATAL:${String(e && e.message || e).slice(0, 160)}`);
    console.error(`DELIVERY_AMBIGUOUS submit 已派发,进程未落终局(FATAL),不重投待人工`);
  }
  killBrowserSync();                   // 同上:exit() 前同步收掉浏览器
  process.exit(process.exitCode || (e && e.ledger ? 43 : 1));
});
