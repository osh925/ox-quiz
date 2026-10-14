// v2 단답형 E2E (실제 Supabase, 헤드리스 크롬). 임시 계정을 만들고, 삭제는 끝난 뒤 SQL 로 별도 수행.
//   NODE_PATH=<puppeteer-core>/node_modules node tools/e2e-cloze.cjs [URL]
const puppeteer = require('puppeteer-core');
const path = require('path');
const URL = process.argv[2] || 'http://localhost:8080/';
const OUT = path.join(__dirname, '..', 'screenshots');
const PFX = process.env.PFX || 'v2-';
const U = { nick: process.env.NICK || `e2ec${String(Date.now()).slice(-5)}`, pin: '246810' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); };
const ev = (page, fn, ...a) => page.evaluate(fn, ...a);
const shot = async (page, name) => { await sleep(450); await page.screenshot({ path: `${OUT}/${PFX}${name}` }); };
const typeInto = async (page, sel, text) => { await page.$eval(sel, (e) => { e.value = ''; }); await page.type(sel, text); };
const waitSynced = (page) => page.waitForFunction(() => window.__oxquiz.state.server.pending === 0, { timeout: 20000 });
const q = (page) => ev(page, () => { const x = window.__oxquiz.state.question; return x && { type: x.type, clozeId: x.clozeId, itemId: x.itemId, answer: x.answer, answers: x.answers }; });
const fbTitle = (page) => ev(page, () => document.querySelector('#fb-title').textContent);
const radio = (page, name, v) => page.click(`input[name=${name}][value="${v}"] + span`);
const setSize = (page, n) => ev(page, (n) => { const r = document.querySelector('#size-range'); r.value = n; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); }, n);
const waitQ = (page) => page.waitForFunction(() => { const s = window.__oxquiz.state; return s.question && !s.answered; });
async function next(page) { await page.click('#next-btn'); }
async function answerCloze(page, values, viaEnter = true) {
  const inputs = await page.$$('#cloze-inputs input');
  for (let i = 0; i < inputs.length; i++) { await inputs[i].type(values[i] ?? ''); if (viaEnter) await inputs[i].press('Enter'); }
  if (!viaEnter) await page.click('#cloze-form button[type=submit]');
  await page.waitForSelector('#feedback:not([hidden])');
}
async function finishRoundQuick(page) { // 남은 문항을 정답으로 끝냄
  for (;;) {
    const over = await ev(page, () => document.querySelector('#result-dialog').open);
    if (over) return;
    const vis = await ev(page, () => !document.querySelector('#next-btn').hidden);
    if (vis) { await next(page); await sleep(80); continue; }
    await waitQ(page);
    const x = await q(page);
    if (x.type === 'cloze') await answerCloze(page, x.answers.map((a) => a.canonical));
    else await page.click(`.btn.ox[data-choice="${x.answer}"]`);
  }
}

(async () => {
  console.log('임시 테스트 계정:', U.nick, 'URL:', URL);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--lang=ko-KR'] });
  try {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' });
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#screen-auth.active');
    await page.click('#tab-signup');
    await typeInto(page, '#signup-username', U.nick);
    await typeInto(page, '#signup-pin', U.pin);
    await typeInto(page, '#signup-pin2', U.pin);
    await page.click('#signup-form button[type=submit]');
    await page.waitForSelector('#screen-start.active', { timeout: 20000 });
    check('임시 계정 가입', true);
    const info = await ev(page, () => ({ cloze: window.__oxquiz.state.clozeCount, ver: document.querySelector('#data-version').textContent,
      qt: document.querySelector('input[name=qtype]:checked')?.value, timers: [...document.querySelectorAll('input[name=timer]')].map((i) => i.value) }));
    check('단답형 데이터 665개 로드 + 버전 표시', info.cloze === 665 && /^v2\.0\.0/.test(info.ver), info);
    check('기본 유형 OX만, 60초 없음', info.qt === 'ox' && !info.timers.includes('60s'), info.timers);

    // ---- 1) 단답형만 + 글자 수 표시 ----
    await radio(page, 'qtype', 'cloze');
    const t2 = await ev(page, () => ({ timers: [...document.querySelectorAll('input[name=timer]')].map((i) => i.value),
      blankShown: !document.querySelector('#blank-field').hidden, pool: document.querySelector('#pool-info').textContent }));
    check('단답형 선택 시 60초·빈칸 표시 옵션 노출', t2.timers.includes('60s') && t2.blankShown && /단답형/.test(t2.pool), t2);
    await radio(page, 'blank', 'count');
    await setSize(page, 10);
    await shot(page, 'start-options.png');
    await page.click('#start-form button[type=submit]');
    await waitQ(page);
    let x = await q(page);
    const blankInfo = await ev(page, () => ({ blanks: [...document.querySelectorAll('#q-text .blank')].map((b) => b.textContent.replace(/^\d/, '')),
      inputs: [...document.querySelectorAll('#cloze-inputs input')].map((i) => ({ ac: i.getAttribute('autocapitalize'), sc: i.spellcheck })),
      focused: document.activeElement?.classList.contains('cloze-input') }));
    const expectMask = x.answers[0].canonical.replace(/\S/g, 'O').replace(/\s+/g, ' ');
    check('글자 수 표시: 글자당 O', blankInfo.blanks.every((b) => b === expectMask || x.answers.length > 1) && blankInfo.blanks.length >= 1, { blankInfo, expectMask });
    check('입력칸: autocapitalize off, spellcheck off, 포커스', blankInfo.inputs.every((i) => i.ac === 'off' && !i.sc) && blankInfo.focused);
    // 키보드 단축키 가드: 입력칸에 o/x 를 써도 OX 답으로 처리되지 않음
    await page.keyboard.type('ox');
    check('입력 중 o/x 단축키 무시', !(await ev(page, () => window.__oxquiz.state.answered)));
    await page.$eval('#cloze-inputs input', (e) => { e.value = ''; });
    await shot(page, 'cloze-count.png');
    // 정답(띄어쓰기 바꿔서 입력: 공백 제거 + 끝 공백)
    await answerCloze(page, x.answers.map((a) => ` ${a.canonical.replace(/\s/g, '')} `));
    check('정답 입력(띄어쓰기 무시) → 정답입니다', (await fbTitle(page)) === '정답입니다');
    await next(page); await waitQ(page);

    // 오답 → 정답으로 인정
    x = await q(page);
    await answerCloze(page, x.answers.map(() => '전혀다른말'), false);
    const wrongFb = await ev(page, () => ({ t: document.querySelector('#fb-title').textContent, ov: !document.querySelector('#override-btn').hidden,
      orig: document.querySelector('#fb-original-text').innerHTML, mine: document.querySelector('#fb-cloze').textContent }));
    check('오답 → 오답입니다 + 정답·원문(강조) + 인정 버튼', wrongFb.t === '오답입니다' && wrongFb.ov && /<mark>/.test(wrongFb.orig) && /전혀다른말/.test(wrongFb.mine), wrongFb.t);
    await shot(page, 'cloze-wrong-feedback.png');
    const overrideItem = x.clozeId;
    await page.click('#override-btn');
    const ov = await ev(page, () => { const a = window.__oxquiz.state.round.answered.at(-1); return { c: a.correct, o: a.overridden, t: document.querySelector('#fb-title').textContent, btn: !document.querySelector('#override-btn').hidden }; });
    check('정답으로 인정 → 기록이 정답·overridden', ov.c && ov.o && ov.t === '정답으로 인정했어요' && !ov.btn, ov);
    await next(page); await waitQ(page);

    // 허용 답안(accept 목록의 다른 형태)
    x = await q(page);
    await answerCloze(page, x.answers.map((a) => a.accept[a.accept.length - 1]));
    check('accept 목록 답 → 정답', (await fbTitle(page)) === '정답입니다');
    await next(page); await waitQ(page);

    // 모르겠어요 → 오답, 인정 버튼 없음
    x = await q(page);
    const giveupItem = x.clozeId; const giveupItemId = x.itemId;
    await page.click('#giveup-btn');
    await page.waitForSelector('#feedback:not([hidden])');
    const gu = await ev(page, () => ({ t: document.querySelector('#fb-title').textContent, l: document.querySelector('#fb-label').textContent, ov: !document.querySelector('#override-btn').hidden }));
    check('모르겠어요 → 오답, 인정 불가', gu.t === '오답입니다' && gu.l === '모르겠어요' && !gu.ov, gu);
    await next(page);
    await finishRoundQuick(page);
    const res1 = await ev(page, () => ({ c: document.querySelector('#result-correct').textContent, mix: document.querySelector('#result-mix').textContent }));
    check('단답형 라운드 결과에 유형/인정 표시', /단답형 9 \/ 10/.test(res1.mix) && /정답으로 인정 1/.test(res1.mix), res1);
    await page.click('#home-btn');
    await page.waitForSelector('#screen-start.active');
    await waitSynced(page);

    // ---- 2) 글자 수 숨기기 + 10초 시간 초과 ----
    await radio(page, 'blank', 'hidden');
    await radio(page, 'timer', '10s');
    await page.click('#start-form button[type=submit]');
    await waitQ(page);
    const hb = await ev(page, () => [...document.querySelectorAll('#q-text .blank')].map((b) => b.textContent.replace(/^\d/, '')));
    check('글자 수 숨기기: 고정 길이 빈칸', hb.every((b) => b === '＿＿＿＿＿'), hb);
    await shot(page, 'cloze-hidden.png');
    x = await q(page);
    await page.waitForSelector('#feedback:not([hidden])', { timeout: 15000 });
    const to = await ev(page, () => ({ t: document.querySelector('#fb-title').textContent, l: document.querySelector('#fb-label').textContent, ov: !document.querySelector('#override-btn').hidden, a: window.__oxquiz.state.round.answered.at(-1) }));
    check('시간 초과 → 오답 + 시간 초과, 인정 불가', to.t === '오답입니다' && to.l === '시간 초과' && !to.ov && to.a.timedOut, to.l);
    await page.click('#quit-btn');
    await page.waitForSelector('#screen-start.active, #result-dialog[open]', { timeout: 5000 }).catch(() => {});
    if (await ev(page, () => document.querySelector('#result-dialog').open)) await page.click('#home-btn');
    await page.waitForSelector('#screen-start.active');

    // ---- 3) 섞어서 ----
    await radio(page, 'qtype', 'mixed');
    await radio(page, 'timer', 'none');
    await page.click('#start-form button[type=submit]');
    const types = [];
    for (;;) {
      if (await ev(page, () => document.querySelector('#result-dialog').open)) break;
      await waitQ(page); x = await q(page); types.push(x.type);
      if (x.type === 'cloze') await answerCloze(page, x.answers.map((a) => a.canonical));
      else { await page.click(`.btn.ox[data-choice="${x.answer === 'O' ? 'X' : 'O'}"]`); await page.waitForSelector('#feedback:not([hidden])'); } // OX는 일부러 틀림
      await next(page); await sleep(60);
    }
    const nc = types.filter((t) => t === 'cloze').length;
    const res3 = await ev(page, () => document.querySelector('#result-mix').textContent);
    check('섞어서: OX·단답형 모두 출제, 결과에 구분 표시', nc > 0 && nc < types.length && res3.includes(`단답형 ${nc} / ${nc}`) && res3.includes(`OX 0 / ${types.length - nc}`), { types, res3 });
    await shot(page, 'mixed-result.png');
    await page.click('#home-btn');
    await page.waitForSelector('#screen-start.active');
    await waitSynced(page);
    const hist = await ev(page, () => document.querySelector('#history-list').innerText);
    check('풀이 기록에 유형 표시', /섞어서/.test(hist) && /단답형/.test(hist), hist.slice(0, 200));

    // ---- 4) 서버 기록 확인 ----
    const sv = await ev(page, async (ids) => {
      const c = window.__oxquiz.state.server.client;
      const a = await c.from('attempts').select('question_type,cloze_id,user_text,overridden,correct,variant_id,shown_type,user_answer').eq('question_type', 'cloze');
      const r = await c.from('rounds').select('question_types,blank_display,cloze_attempted,cloze_correct,attempted,correct').order('started_at');
      const n = await c.from('wrong_notes').select('item_id,last_variant_id');
      return { a: a.data, r: r.data, n: n.data, err: a.error || r.error || n.error, ids };
    }, { overrideItem, giveupItem });
    const ovRow = sv.a.find((r) => r.cloze_id === overrideItem && r.overridden);
    check('서버: 인정 응답이 correct+overridden+user_text 로 저장', ovRow && ovRow.correct && ovRow.user_text === '전혀다른말' && ovRow.shown_type === 'O' && ovRow.user_answer === null, ovRow);
    check('서버: 라운드 유형·빈칸·단답형 집계 저장', sv.r.length >= 3 && sv.r[0].question_types === 'cloze' && sv.r[0].blank_display === 'count'
      && sv.r[0].cloze_attempted === 10 && sv.r[0].cloze_correct === 9 && sv.r.at(-1).question_types === 'mixed' && sv.r.at(-1).blank_display === 'hidden', sv.r);
    check('서버: 모르겠어요 → 오답노트(last_variant_id=단답형 id)', sv.n.some((r) => r.last_variant_id === giveupItem), sv.n.length);

    // ---- 5) 새로고침 후 설정 유지 ----
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#screen-start.active', { timeout: 20000 });
    const pr = await ev(page, () => ({ qt: document.querySelector('input[name=qtype]:checked')?.value, b: document.querySelector('input[name=blank]:checked')?.value }));
    check('새로고침 후 유형/빈칸 설정 유지', pr.qt === 'mixed' && pr.b === 'hidden', pr);

    // ---- 6) 오답노트: 단답형 항목 + 단답형만 오답노트 라운드 ----
    await page.click('#notes-card');
    await page.waitForSelector('#screen-notes.active');
    const nl = await ev(page, (id) => { const li = document.querySelector(`#notes-list .note-del[data-item="${id}"]`)?.closest('li'); return li && li.innerHTML; }, giveupItemId);
    check('오답노트에 단답형 항목(태그·정답 강조)', nl && /tag-cloze/.test(nl) && /<mark>/.test(nl));
    await page.$eval(`#notes-list .note-del[data-item="${giveupItemId}"]`, (e) => e.closest('li').scrollIntoView({ block: 'center' }));
    await shot(page, 'notes-cloze.png');
    await page.click('#notes-back'); await page.waitForSelector('#screen-start.active');
    await radio(page, 'qtype', 'cloze');
    await page.click('#notes-card'); await page.waitForSelector('#screen-notes.active');
    await page.click('#notes-start');
    await waitQ(page);
    const wq = await q(page);
    const noteIds = sv.n.map((r) => r.item_id);
    check('오답노트 + 단답형만 → 오답노트 문항의 단답형 출제', wq.type === 'cloze' && noteIds.includes(wq.itemId), wq.itemId);
    await page.click('#quit-btn');
    await sleep(500);
    if (await ev(page, () => document.querySelector('#result-dialog').open)) await page.click('#home-btn');
    await page.waitForSelector('#screen-start.active, #screen-notes.active');

    // ---- 7) 단답형 숨기기 ----
    await ev(page, () => { if (!document.querySelector('#screen-notes.active')) document.querySelector('#notes-card').click(); });
    await page.waitForSelector('#screen-notes.active');
    await page.click(`#notes-list .note-del[data-item="${giveupItemId}"]`);
    await page.waitForSelector('#dismiss-dialog[open]');
    await page.click('#dismiss-yes');
    await page.waitForSelector('#dismiss-step2:not([hidden])', { timeout: 10000 });
    const ht = await ev(page, () => ({ t: document.querySelector('#hide-title').textContent, v: [...document.querySelectorAll('#dismiss-variants input')].map((i) => i.value) }));
    check('삭제 → 단답형 숨김 질문', ht.t === '이 단답형 문제가 앞으로 등장하지 않게 할까요?' && ht.v[0] === giveupItem, ht);
    await shot(page, 'hide-cloze-dialog.png');
    await page.click('#hide-yes');
    await page.waitForFunction(() => !document.querySelector('#dismiss-dialog').open);
    await waitSynced(page);
    const hv = await ev(page, async (id) => {
      const s = window.__oxquiz.state; const c = s.server.client;
      const h = await c.from('hidden_variants').select('variant_id');
      return { server: h.data.map((r) => r.variant_id), local: s.server.hidden.has(id) };
    }, giveupItem);
    check('hidden_variants 에 단답형 id 저장', hv.server.includes(giveupItem) && hv.local, hv);
    const never = await ev(page, async (itemId) => {
      const core = await import('./js/quiz-core.js');
      const s = window.__oxquiz.state; const it = s.itemsById.get(itemId);
      let cl = 0; for (let i = 0; i < 400; i++) if (core.pickQuestion([it], Math.random, s.server.hidden, 'mixed').type === 'cloze') cl++;
      return { cl, vis: core.hasVisibleCloze(it, s.server.hidden) };
    }, giveupItemId);
    check('숨긴 단답형은 출제되지 않음(섞어서에서도 OX만)', never.cl === 0 && !never.vis, never);
    await page.click('#hidden-section summary');
    const hl = await ev(page, () => document.querySelector('#hidden-list').innerHTML);
    check('숨긴 문제 목록에 단답형 표시', /tag-cloze/.test(hl));
    check('페이지 오류 없음', errors.length === 0, errors);
  } catch (e) { console.error(e); check('예외 없음', false, String(e)); }
  finally { await browser.close(); }
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fail}/${results.length} 통과 · 계정 ${U.nick}`);
  process.exit(fail ? 1 : 0);
})();
