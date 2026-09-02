// Node 侧关键路径冒烟(被 smoke.sh 调用)。见 smoke.sh 顶部注释。
const D = process.env.OUTREACH_STATE_DIR;
const res = [];
const t = async (name, fn) => {
  try { await fn(); res.push([true, name, '']); }
  catch (e) { res.push([false, name, `${e.constructor.name}: ${String(e.message).split('\n')[0].slice(0, 80)}`]); }
};

const db = await import('../state.mjs');
await t('upsertSubmission', () => db.upsertSubmission({ domain: 'a.com', status: 'pending_review', source: 's' }));
await t('currentStatus', () => { if (db.currentStatus('a.com').status !== 'pending_review') throw new Error('读回不对'); });
await t('守卫拦截', () => { if (!db.upsertSubmission({ domain: 'a.com', status: 'blocked', source: 's' }).blockedRegression) throw new Error('投达态被打回了'); });
await t('历史 raw 键归一', () => { if (db.currentStatus('WWW.A.com').status !== 'pending_review') throw new Error('行侧未归一'); });
await t('claimDelivery 拒投达', () => { if (db.claimDelivery({ domain: 'a.com', source: 's' }).claimed) throw new Error('投达态不该放行'); });
await t('claimDelivery 放行', () => { if (!db.claimDelivery({ domain: 'new.com', source: 's' }).claimed) throw new Error('新域该放行'); });
await t('claimDelivery 二次挡', () => { if (db.claimDelivery({ domain: 'new.com', source: 's' }).claimed) throw new Error('二次认领必须挡住'); });
await t('recordEvent', () => db.recordEvent({ domain: 'a.com', event_type: 'note', source: 's' }));
await t('add/activeConstraints', () => { db.addConstraint({ domain: 'a.com', reason_code: 'entry_404' }); db.activeConstraints('a.com'); });
await t('humanTaskAdd/pending', () => { db.humanTaskAdd({ domain: 'a.com', blocker: 'x' }); db.pendingHumanTasks(); });
await t('ensureAmbiguousTask', () => db.ensureDeliveryAmbiguousTask({ domain: 'new.com' }));
await t('recordCost/spentToday', () => { db.recordCost({ provider: 'llm', amount_usd: 0.003 }); if (db.spentToday('llm') !== 0.003) throw new Error('成本读回不对'); });
await t('save/loadRecipe', () => { db.saveRecipe('a.com', [{ action: 'fill' }], 'success', 'n'); if (!db.loadRecipe('a.com')) throw new Error('recipe 读不回'); });
await t('recordVerification/rows', () => { db.recordVerification({ domain: 'a.com', result: 'online', source_url: 'u' }); db.verificationRows('a.com'); });
await t('knownOnlineDomains', () => db.knownOnlineDomains());
await t('domainsWithStatus', () => db.domainsWithStatus(['pending_review']));
await t('stateRows', () => db.stateRows('a.com'));
await t('withFileLock', () => db.withFileLock(`${D}/x`, () => 1));
await t('canonDomain', () => { if (db.canonDomain('WWW.A.com') !== 'a.com') throw new Error('canon 不对'); });
// 坏账本必须 fail-closed(曾经被静默跳过 → currentStatus 返回 null → 认领放行)。
// DIR 是模块加载时冻结的,必须起子进程换环境才测得到 —— 别在本进程里假装测过。
await t('坏行 fail-closed', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const bad = `${D}/bad`;
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(`${bad}/state.jsonl`, '{"src":"x.com","status":"success"');   // 截断的 success 行
  const out = execFileSync(process.execPath, ['-e', `
    import('${new URL('../state.mjs', import.meta.url).pathname}').then(d => {
      try { d.claimDelivery({ domain: 'x.com', source: 't' }); console.log('LEAKED'); }
      catch { console.log('THREW'); }
    });`], { env: { ...process.env, OUTREACH_STATE_DIR: bad }, encoding: 'utf8' }).trim();
  if (out !== 'THREW') throw new Error(`截断行没有 fail-closed(子进程输出 ${out})`);
});

// ── 认领闸的生命周期(R13 的 4 条 P1 全在这里,回归必须覆盖)──
await t('终态一律不可再认领', () => {
  for (const [st, dom] of [['manual','m1.com'],['skipped_paid','sp.com'],['skipped_badge','sb.com'],
                           ['skipped_fit','sf.com'],['success','su.com'],['pending_review','pr.com'],
                           ['emailed','em.com']]) {
    db.upsertSubmission({ domain: dom, status: st, source: 't' });
    if (db.claimDelivery({ domain: dom, source: 't' }).claimed) throw new Error(`${st} 竟可再认领`);
  }
});
await t('可重试态仍可认领', () => {
  for (const [st, dom] of [['blocked','b1.com'],['failed','f1.com'],['email_verified','ev.com']]) {
    db.upsertSubmission({ domain: dom, status: st, source: 't' });
    if (!db.claimDelivery({ domain: dom, source: 't' }).claimed) throw new Error(`${st} 该可认领`);
  }
});
// **穷举**,不要逐个状态列举 —— 列举正是漏掉 email_verified / draft 的原因。
// 不变式:一个域一旦投达过,后续无论被写成什么状态,都不能再被认领。
await t('已投达域:遍历全部状态都不复活', () => {
  const bad = [];
  let i = 0;
  for (const st of db.STATUSES) {
    const dom = `ex${i++}.com`;
    db.claimDelivery({ domain: dom, source: 'a' });
    db.upsertSubmission({ domain: dom, status: 'success', source: 'a', reason_code: 'published' });
    db.upsertSubmission({ domain: dom, status: st, source: 'm' });
    if (db.claimDelivery({ domain: dom, source: 'a2' }).claimed) bad.push(st);
  }
  if (bad.length) throw new Error(`这些状态会让已投达的域复活: ${bad.join(', ')}`);
});
// 认领过的域走不到任何可重试态 —— 这是"不需要自动撤标记"的前提,前提塌了要立刻知道
await t('认领后走不到可重试态', () => {
  const bad = [];
  let i = 0;
  for (const st of ['blocked', 'failed', 'email_verified', 'draft']) {
    const dom = `rt${i++}.com`;
    db.claimDelivery({ domain: dom, source: 'a' });
    if (db.upsertSubmission({ domain: dom, status: st, source: 'a' }).written) bad.push(st);
  }
  if (bad.length) throw new Error(`认领后竟能迁到可重试态 ${bad.join(', ')} —— `
    + `"不需要自动撤标记"的前提不成立了,见 releaseClaim 注释`);
});
// delivery_ambiguous 的唯一正常出路:确认链接上线 → 标 success。
// 它**不该**被放回池(那可能给站方发两份),所以这里断言的是"标 success 之后
// 依然投不出去",而不是"怎么放回池"。
await t('ambiguous → 确认上线标 success', () => {
  db.claimDelivery({ domain: 'ok1.com', source: 'agent' });
  const r = db.upsertSubmission({ domain: 'ok1.com', status: 'success', source: 'human', reason_code: 'published' });
  if (!r.written) throw new Error('确认上线后该能标 success');
  if (db.claimDelivery({ domain: 'ok1.com', source: 'x' }).claimed) throw new Error('标 success 后仍不该可认领');
});
// 两道闸互相独立:只撤标记不放行。这是安全属性,不是操作流程 ——
// releaseClaim 是逃生阀,日常不该用(见 state.mjs 该函数注释)。
await t('只撤标记不放行(两道闸独立)', () => {
  db.claimDelivery({ domain: 'rc.com', source: 'a' });
  if (!db.releaseClaim('rc.com')) throw new Error('撤销标记该返回 true');
  if (db.claimDelivery({ domain: 'rc.com', source: 'a' }).claimed) {
    throw new Error('只撤标记就放行了 —— 账本仍是 delivery_ambiguous,状态闸该拦住');
  }
});
await t('email_verified 两边都认', () => db.upsertSubmission({ domain: 'ev2.com', status: 'email_verified', source: 't' }));
// 落账失败必须把标记撤回,否则该域此后永远认领不了
await t('写账失败 → 标记回滚', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const dir = `${D}/rollback`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/state.jsonl.lock`, `tok pid=${process.pid} now\n`);   // 活进程占住锁
  const url = new URL('../state.mjs', import.meta.url).pathname;
  const out = execFileSync(process.execPath, ['-e', `
    import('${url}').then(d => {
      try { d.claimDelivery({ domain: 'x.com', source: 't' }); } catch {}
      console.log(require('fs').existsSync('${dir}/claims/x.com.claim') ? 'LEAKED' : 'ROLLED');
    });`], { env: { ...process.env, OUTREACH_STATE_DIR: dir }, encoding: 'utf8' }).trim();
  if (out !== 'ROLLED') throw new Error('标记没回滚,该域将永远认领不了');
});
// 锁路径损坏必须抛,不能忙循环(曾经挂到 driver 的 900s 外层超时)
await t('锁路径损坏不忙循环', async () => {
  const fs = await import('node:fs');
  const dir = `${D}/badlock`;
  fs.mkdirSync(`${dir}/s.lock`, { recursive: true });         // 锁路径是目录
  const t0 = Date.now();
  try { db.withFileLock(`${dir}/s`, () => {}, 1000); throw new Error('竟拿到锁'); }
  catch (e) { if (Date.now() - t0 > 3000) throw new Error(`耗时 ${Date.now() - t0}ms,疑似忙循环`); }
});

// 审计写失败不该让已完成的状态迁移作废(状态行已落盘,后面只是 events/人工任务善后)
await t('审计写失败不作废状态迁移', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const dir = `${D}/auditfail`;
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(`${dir}/events.jsonl`, { recursive: true });   // 把 events 变成目录 → append 必失败
  const url = new URL('../state.mjs', import.meta.url).pathname;
  const out = execFileSync(process.execPath, ['-e', `
    import('${url}').then(d => {
      let r; try { r = d.upsertSubmission({ domain: 'a.com', status: 'blocked', source: 't' }); }
      catch { console.log('THREW'); return; }
      console.log(r.written && d.currentStatus('a.com').status === 'blocked' ? 'OK' : 'LOST');
    });`], { env: { ...process.env, OUTREACH_STATE_DIR: dir }, encoding: 'utf8' }).trim();
  if (out !== 'OK') throw new Error(`events 写不进时状态迁移被作废了(${out})`);
});
// .gitignore 必须真的忽略 claims/ —— 误提交会让干净 checkout 拒绝投递。
// 注意 .gitignore **不支持行尾注释**,注释写在模式后面会让整行失效(踩过)。
await t('claims/ 确实被 gitignore', async () => {
  const { execFileSync } = await import('node:child_process');
  const repo = new URL('../..', import.meta.url).pathname;
  try {
    execFileSync('git', ['check-ignore', '-q', 'outreach/claims/x.claim'], { cwd: repo });
  } catch { throw new Error('outreach/claims/ 没有被 .gitignore 忽略'); }
});

const lc = await import('../llm_config.mjs');
await t('llm_config.load', () => lc.load());
await t('chatUrl 归一', () => { if (lc.chatUrl('https://x.com') !== 'https://x.com/v1/chat/completions') throw new Error('base URL 未归一'); });
await t('originOf', () => { if (lc.originOf('https://x.com/v1') !== 'https|x.com|443') throw new Error('origin 归一不对'); });
await t('originOf 拒畸形', () => { if (/^https?\|/.test(lc.originOf('https://a\\@b.com/v1'))) throw new Error('畸形地址未拒'); });
await t('mask 不回显全量', () => { if (lc.mask('sk-abcdefghijklmn').includes('defghij')) throw new Error('key 泄漏'); });

const og = await import('../outbound_guard.mjs');
await t('outbound 拒内网', () => { if (og.validateUrlLite('http://127.0.0.1/x')) throw new Error('内网未拦'); });
await t('outbound 拒碰瓷域', () => { if (og.hostInRoot('evil-x.com', 'x.com')) throw new Error('碰瓷域未拦'); });
const ss = await import('../submission_safety.mjs');
await t('回执分类', () => { if (ss.classifyReceiptText('Your submission has been received') !== 'success') throw new Error('回执判不出'); });
await t('回执否定优先', () => { if (ss.classifyReceiptText('Your submission was not received') !== null) throw new Error('否定句未过滤'); });
await t('hasSubmitVerb', () => { if (!ss.hasSubmitVerb('Submit')) throw new Error('x'); });
const wd = await import('../wall_detect.mjs');
await t('hostAllowed 拒外域', () => { if (wd.hostAllowed('evil.com', 'x.com')) throw new Error('未拦'); });
await t('inferConstraint', () => wd.inferConstraint('skipped_paid', ''));
const rt = await import('../agent_submit_runtime.mjs');
await t('makeWatchdogPlan 钳制', () => { if (rt.makeWatchdogPlan(20, 30000).triggerMs >= 20 * 60000) throw new Error('未按硬杀预算钳住'); });
await t('actionResult', () => rt.normalizeActionResult('x'));
const rd = await import('../rootdomain.mjs');
await t('rootDomain(PSL)', () => { if (rd.rootDomain('a.b.example.co.uk') !== 'example.co.uk') throw new Error('得到 ' + rd.rootDomain('a.b.example.co.uk')); });
const cs = await import('../capsolver.mjs');
await t('capsolver.hasKey', () => cs.hasKey());

// ── 新目录注册逐站审批硬闸 ──
// 直接导入生产 actImpl,用内存 page double 验证:未批准时不触碰 signup DOM、不写 creds,
// 同时必须入 human_tasks 并落 blocked/needs_registration_approval。
const fsReg = await import('node:fs');
const regKit = `${D}/registration-kit.json`;
const regCreds = `${D}/registration-creds.json`;
fsReg.writeFileSync(regKit, JSON.stringify({
  product: {
    name: 'Test Product', url: 'https://product.example/', og_image: '',
    submitter: { name: 'Test Owner', email: 'support@product.example' },
    categories: ['Tools'], tags: ['test'],
  },
  copy: {
    taglines: ['Test product', 'Test product'],
    descriptions: { xs_50: ['Test'], s_150: ['Test product'], m_300: ['Test product'], l_510: ['Test product'] },
  },
  compliance: { forbidden_claims_regex: ['never-match-this-fixture'] },
}));
process.env.OUTREACH_CREDS = regCreds;
process.argv.push('--kit', regKit);
const submitAgent = await import('../agent_submit.mjs');

await t('未批准 register/signup/OAuth/fork 硬停且零 creds', async () => {
  let signupSubmits = 0;
  const untouchedPage = new Proxy({}, {
    get() { return async () => { signupSubmits++; throw new Error('未批准路径触碰了 signup page'); }; },
  });
  const assertStopped = async (dom, action, pg = untouchedPage) => {
    let stopped = false;
    try { await submitAgent.actImpl(pg, action, dom); }
    catch (e) { stopped = Boolean(e && e.registrationApprovalRequired); }
    if (!stopped) throw new Error(`${dom} 未以 needs_registration_approval 停止`);
    const cur = db.currentStatus(dom);
    if (!cur || cur.status !== 'blocked' || !/needs_registration_approval/.test(JSON.stringify(cur))) {
      throw new Error(`${dom} 没有 blocked/needs_registration_approval 终局`);
    }
    if (!db.pendingHumanTasks().some(x => x.domain === dom && x.blocker === 'needs_registration_approval')) {
      throw new Error(`${dom} 没进入注册审批人工队列`);
    }
  };
  for (const [dom, action] of [
    ['new-register.example', { action: 'register', reason: 'signup required' }],
    ['new-fork.example', { action: 'fork_account', reason: 'one account per product' }],
    ['new-signup.example', { action: 'click', target: 'Sign up' }],
    ['new-oauth.example', { action: 'click', target: 'Continue with Google' }],
  ]) await assertStopped(dom, action);

  // LLM 常输出不带语义的 b0。代码必须从真实按钮/表单识别 signup,不能只匹配 target 文案。
  let opaqueClicks = 0;
  const signupForm = {
    innerText: 'Create your account',
    querySelector: (q) => q.includes('password') || q.includes('email') ? {} : null,
  };
  const opaqueButton = {
    isVisible: async () => true,
    getAttribute: async () => '',
    click: async () => { opaqueClicks++; },
    evaluate: async (fn) => fn({
      innerText: 'Continue', value: '',
      getAttribute: () => '', closest: () => signupForm,
    }),
  };
  const opaquePage = { $$: async () => [opaqueButton] };
  await assertStopped('new-opaque-signup.example', { action: 'click', target: 'b0' }, opaquePage);
  if (opaqueClicks) throw new Error('不透明 b0 signup 按钮被提交');
  if (signupSubmits) throw new Error(`未批准路径触碰 signup page ${signupSubmits} 次`);
  if (fsReg.existsSync(regCreds)) throw new Error('未批准注册竟创建了 creds.json');
});

await t('stored creds 只允许明确 Login,不改凭据', async () => {
  const original = JSON.stringify({
    'existing.example': { user: 'owner', email: 'owner@example.com', pass: 'existing-test-password' },
  }, null, 2);
  fsReg.writeFileSync(regCreds, original);
  const filled = [];
  let clicked = 0;
  const input = (type, name) => ({
    getAttribute: async (key) => key === 'type' ? type : key === 'name' ? name : '',
    fill: async (value) => { filled.push([type, value]); },
  });
  const pg = {
    $: async () => ({ click: async () => { clicked++; } }),
    $$: async () => [input('email', 'email'), input('password', 'password')],
    waitForTimeout: async () => {},
  };
  const out = await submitAgent.actImpl(pg, { action: 'login' }, 'existing.example');
  if (!/stored creds/.test(out) || clicked !== 1 || filled.length !== 2) {
    throw new Error('已有凭据没有走明确 login');
  }
  if (fsReg.readFileSync(regCreds, 'utf8') !== original) throw new Error('login 改写了已有 creds');
});

await t('批准必须精确到站,批准站才可 register', async () => {
  process.argv.push('--approve-registration', 'approved.example');
  let clicked = 0;
  const input = (type, name) => ({
    getAttribute: async (key) => key === 'type' ? type : key === 'name' ? name : '',
    fill: async () => {},
  });
  const pg = {
    $$: async () => [input('email', 'email'), input('password', 'password')],
    $: async () => ({ click: async () => { clicked++; } }),
    waitForTimeout: async () => {},
  };
  try {
    await submitAgent.actImpl(pg, { action: 'register' }, 'approved.example');
    if (clicked !== 1) throw new Error('精确批准站未提交 signup');
    const creds = JSON.parse(fsReg.readFileSync(regCreds, 'utf8'));
    if (!creds['approved.example'] || !creds['approved.example'].pass) throw new Error('精确批准站未保存凭据');
  } finally {
    process.argv.splice(-2, 2);
  }
});

const bad = res.filter((r) => !r[0]);
for (const [good, name, err] of res) if (!good) console.log(`   ❌ ${name} → ${err}`);
console.log(`   ${res.length - bad.length}/${res.length} 通过${bad.length ? '' : ' ✅'}`);
process.exit(bad.length ? 1 : 0);
