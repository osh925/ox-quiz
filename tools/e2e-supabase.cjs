// 실제 Supabase 프로젝트 대상 E2E (헤드리스 크롬). 테스트 계정을 만들고 검증 후, 정리는 SQL 로 별도 수행.
//   NODE_PATH=<puppeteer-core 설치 폴더>/node_modules node tools/e2e-supabase.cjs [URL]
const puppeteer = require('puppeteer-core');
const path = require('path');
const URL = process.argv[2] || 'http://localhost:8080/';
const OUT = path.join(__dirname, '..', 'screenshots');
const SHOTS = process.env.SHOTS !== '0';
const A = { nick: process.env.NICK_A || '테스트b', pin: '246810' };   // UI 로 새로 가입
const B = { nick: process.env.NICK_B || 'test용a', pin: '123456' };   // 이미 있는 계정으로 로그인 (없으면 가입)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok: !!ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); };

async function newPage(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.emulate({
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  return page;
}
const shot = async (page, name) => { if (SHOTS) { await sleep(300); await page.screenshot({ path: `${OUT}/${name}` }); } };
const typeInto = async (page, sel, text) => { await page.$eval(sel, (e) => { e.value = ''; }); await page.type(sel, text); };
const ev = (page, fn, ...a) => page.evaluate(fn, ...a);
const waitSynced = (page) => page.waitForFunction(() => window.__oxquiz.state.server.pending === 0, { timeout: 20000 });

async function login(page, { nick, pin }) {
  await page.waitForSelector('#screen-auth.active');
  await typeInto(page, '#login-username', nick);
  await typeInto(page, '#login-pin', pin);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#screen-start.active, #login-error:not([hidden])');
}
async function signup(page, { nick, pin }) {
  await page.waitForSelector('#screen-auth.active');
  await page.click('#tab-signup');
  await typeInto(page, '#signup-username', nick);
  await typeInto(page, '#signup-pin', pin);
  await typeInto(page, '#signup-pin2', pin);
  await page.click('#signup-form button[type=submit]');
  await page.waitForSelector('#screen-start.active, #signup-error:not([hidden])', { timeout: 20000 });
}

/** 한 라운드 진행. decide(q, i) → 'correct' | 'wrong' */
async function playRound(page, decide, onQuestion) {
  const log = [];
  for (let i = 0; ; i++) {
    await page.waitForSelector('#ox-buttons:not([hidden]), #result-dialog[open]');
    if (await page.$('#result-dialog[open]')) break;
    const q = await ev(page, () => { const q = window.__oxquiz.state.question; return { itemId: q.itemId, answer: q.answer, kind: q.kind }; });
    if (onQuestion) await onQuestion(q, i);
    const want = decide(q, i);
    const choice = want === 'correct' ? q.answer : (q.answer === 'O' ? 'X' : 'O');
    await page.click(`.btn.ox[data-choice="${choice}"]`);
    await page.waitForSelector('#feedback:not([hidden])');
    const title = await page.$eval('#fb-title', (e) => e.textContent);
    log.push({ ...q, want, title });
    await page.click('#next-btn');
  }
  const res = await page.$eval('#result-correct', (e) => e.textContent) + '/' + await page.$eval('#result-attempted', (e) => e.textContent);
  return { log, res };
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--lang=ko-KR'] });
  try {
    // ---------------- 1. 로그인 화면 / autocomplete 속성
    const pa = await newPage(browser);
    await pa.waitForSelector('#screen-auth.active');
    await shot(pa, '10-login.png');
    const attrs = await ev(pa, () => [...document.querySelectorAll('#screen-auth input')].map((i) => ({
      id: i.id, name: i.name, type: i.type, autocomplete: i.getAttribute('autocomplete'), inputmode: i.getAttribute('inputmode'), pattern: i.getAttribute('pattern'), form: i.form && i.form.id,
    })));
    check('로그인 폼: username/current-password', attrs.some((a) => a.form === 'login-form' && a.autocomplete === 'username' && a.type === 'text')
      && attrs.some((a) => a.form === 'login-form' && a.type === 'password' && a.autocomplete === 'current-password' && a.inputmode === 'numeric' && a.pattern === '[0-9]{6}'), attrs);
    check('가입 폼: username/new-password', attrs.filter((a) => a.form === 'signup-form' && a.autocomplete === 'new-password').length === 2
      && attrs.some((a) => a.form === 'signup-form' && a.autocomplete === 'username'));

    // ---------------- 2. A: UI 로 가입 (이미 있으면 로그인)
    await pa.click('#tab-signup');
    await shot(pa, '10b-signup.png');
    await pa.click('#tab-login');
    await signup(pa, A);
    if (!(await pa.$('#screen-start.active'))) {
      const msg = await pa.$eval('#signup-error', (e) => e.textContent);
      check('A 가입 (이미 존재 → 로그인으로 대체)', /이미/.test(msg), msg);
      await pa.click('#tab-login'); await login(pa, A);
    } else check('A 가입 후 홈 진입', true);
    check('A 닉네임 표시', (await pa.$eval('#user-nickname', (e) => e.textContent)) === A.nick);
    check('가입 성공 후 URL #home (pushState)', (await pa.url()).endsWith('#home'));

    // ---------------- 3. B: 잘못된 PIN → 오류, 올바른 PIN → 로그인. 중복 닉네임 가입 → 오류
    const pb = await newPage(browser);
    await signup(pb, { nick: A.nick.toUpperCase(), pin: '111111' });
    check('중복 닉네임 가입 거부', /이미 사용 중/.test(await pb.$eval('#signup-error', (e) => e.textContent)));
    await pb.click('#tab-login');
    await login(pb, { nick: B.nick, pin: '000000' });
    const bErr = await pb.$('#login-error:not([hidden])') ? await pb.$eval('#login-error', (e) => e.textContent) : '';
    if (/맞지 않/.test(bErr)) check('틀린 PIN 거부', true, bErr);
    await login(pb, B);
    if (!(await pb.$('#screen-start.active'))) { await signup(pb, B); }
    check('B 로그인', !!(await pb.$('#screen-start.active')));

    // ---------------- 4. A: 일반 라운드 (앞 4문항 일부러 틀림)
    await pa.$eval('#size-range', (e) => { e.value = 10; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
    await pa.click('#start-form button[type=submit]');
    await pa.waitForSelector('#screen-quiz.active');
    const r1 = await playRound(pa, (q, i) => (i < 4 ? 'wrong' : 'correct'));
    check('일반 라운드 결과 6/10', r1.res === '6/10', r1.res);
    check('피드백 문구', r1.log.every((l) => l.title === (l.want === 'correct' ? '정답입니다' : '오답입니다')));
    await pa.click('#home-btn');
    await waitSynced(pa);
    await ev(pa, () => window.__oxquiz.state.server.refresh());
    await pa.waitForSelector('#screen-start.active');
    const wrongItems = [...new Set(r1.log.filter((l) => l.want === 'wrong').map((l) => l.itemId))];
    const serverNotes = await ev(pa, () => Object.values(window.__oxquiz.state.server.notes).filter((n) => !n.cleared).map((n) => n.item_id).sort());
    check('오답노트 = 틀린 정지문들 (서버)', JSON.stringify(serverNotes) === JSON.stringify([...wrongItems].sort()), { serverNotes, wrongItems });
    await ev(pa, () => { document.querySelector('#notes-count'); });
    const cnt = await pa.$eval('#notes-count', (e) => e.textContent);
    check('홈 오답노트 개수 표시', Number(cnt) === wrongItems.length, cnt);
    const hist = await pa.$$eval('#history-list li', (l) => l.map((x) => x.textContent.trim()));
    check('풀이 기록(서버) 1건', hist.length === 1 && hist[0].includes('6 / 10'), hist);
    await shot(pa, '11-home-records.png');

    // ---------------- 5. 오답노트 화면
    await pa.click('#notes-card');
    await pa.waitForSelector('#screen-notes.active');
    const noteRows = await pa.$$eval('#notes-list li', (l) => l.length);
    check('오답노트 목록 개수', noteRows === wrongItems.length, noteRows);
    await pa.$$eval('#notes-list details', (ds) => { if (ds[0]) ds[0].open = true; });
    await shot(pa, '12-wrongnote-list.png');
    const startLabel = await pa.$eval('#notes-start', (e) => e.textContent);
    check('오답노트 라운드 길이 = min(10, 개수)', startLabel.includes(`(${Math.min(10, wrongItems.length)}문항)`), startLabel);

    // ---------------- 6. 오답노트 모드: 다시 틀리면 streak 리셋 / 2연속 정답이면 빠짐
    await pa.click('#notes-start');
    await pa.waitForSelector('#screen-quiz.active');
    check('오답노트 모드 배지', await pa.$eval('#mode-badge', (e) => !e.hidden));
    let firstItem = null; let shotDone = false;
    const r2 = await playRound(pa, (q, i) => (i === 0 ? 'wrong' : 'correct'), async (q, i) => {
      if (i === 0) firstItem = q.itemId;
      if (!wrongItems.includes(q.itemId)) check('오답노트 모드는 오답노트 항목만 출제', false, q.itemId);
      if (i === 1 && !shotDone) { shotDone = true; await shot(pa, '13-wrongnote-quiz.png'); }
    });
    check('오답노트 라운드 진행', r2.log.length === Math.min(10, wrongItems.length), r2.res);
    await pa.click('#home-btn');
    await waitSynced(pa);
    await ev(pa, () => window.__oxquiz.state.server.refresh());
    const n1 = await ev(pa, (id) => window.__oxquiz.state.server.notes[id], firstItem);
    check('오답노트 모드에서 다시 틀림 → wrong_count 증가', n1 && n1.wrong_count >= 2 && !n1.cleared, n1);

    // 모두 맞히는 라운드를 반복해 비워질 때까지 (항목당 2연속 정답 필요, 복원추출이라 여러 라운드)
    let rounds = 0; let left = await ev(pa, () => Object.values(window.__oxquiz.state.server.notes).filter((n) => !n.cleared).length);
    const leftHistory = [left];
    while (left > 0 && rounds < 25) {
      await pa.click('#notes-card'); await pa.waitForSelector('#screen-notes.active');
      await pa.click('#notes-start'); await pa.waitForSelector('#screen-quiz.active');
      await playRound(pa, () => 'correct');
      await pa.click('#home-btn');
      await waitSynced(pa);
      await ev(pa, () => window.__oxquiz.state.server.refresh());
      left = await ev(pa, () => Object.values(window.__oxquiz.state.server.notes).filter((n) => !n.cleared).length);
      leftHistory.push(left); rounds++;
    }
    check('2연속 정답으로 오답노트 비워짐', left === 0, { leftHistory });
    const allCleared = await ev(pa, () => Object.values(window.__oxquiz.state.server.notes).every((n) => n.cleared && n.cleared_at && n.correct_streak >= 2));
    check('서버 행: cleared=true, streak>=2', allCleared);
    await pa.click('#notes-card'); await pa.waitForSelector('#screen-notes.active');
    check('빈 오답노트: 시작 버튼 비활성', await pa.$eval('#notes-start', (e) => e.disabled));
    await pa.click('#notes-back');

    // 다시 틀리면 복귀 (일반 모드)
    await pa.click('#start-form button[type=submit]');
    await pa.waitForSelector('#screen-quiz.active');
    let reItem = null;
    await playRound(pa, (q, i) => {
      if (i === 0) return 'correct';
      if (!reItem && wrongItems.includes(q.itemId)) { reItem = q.itemId; return 'wrong'; }
      return i === 9 && !reItem ? 'wrong' : 'correct';
    });
    await pa.click('#home-btn'); await waitSynced(pa); await ev(pa, () => window.__oxquiz.state.server.refresh());
    const activeNow = await ev(pa, () => Object.values(window.__oxquiz.state.server.notes).filter((n) => !n.cleared).length);
    check('일반 모드에서 다시 틀리면 오답노트에 복귀/추가', activeNow >= 1, { activeNow, reItem });

    // ---------------- 7. RLS: B 는 A 의 데이터를 볼 수 없음
    const aId = await ev(pa, () => window.__oxquiz.state.server.user.id);
    await ev(pb, () => window.__oxquiz.state.server.refresh());
    const rls = await ev(pb, async (aId) => {
      const c = window.__oxquiz.state.server.client;
      const r = await c.from('rounds').select('id').eq('user_id', aId);
      const n = await c.from('wrong_notes').select('item_id').eq('user_id', aId);
      const at = await c.from('attempts').select('id').eq('user_id', aId);
      const p = await c.from('profiles').select('*');
      const ins = await c.from('wrong_notes').insert({ user_id: aId, item_id: 'hack-0001', wrong_count: 9 });
      const upd = await c.from('rounds').update({ correct: 999 }).eq('user_id', aId).select();
      const myRounds = await c.from('rounds').select('id');
      return { rounds: r.data?.length, notes: n.data?.length, attempts: at.data?.length, profiles: p.data,
        insertErr: ins.error?.code || null, updated: upd.data?.length ?? null, myRounds: myRounds.data?.length };
    }, aId);
    check('RLS: B 는 A 의 rounds/notes/attempts 0건', rls.rounds === 0 && rls.notes === 0 && rls.attempts === 0, rls);
    check('RLS: B 는 자기 프로필만', rls.profiles.length === 1 && rls.profiles[0].nickname === B.nick, rls.profiles);
    check('RLS: A 의 user_id 로 insert 거부 / update 0건', !!rls.insertErr && rls.updated === 0, { insertErr: rls.insertErr, updated: rls.updated });
    check('B 홈: 기록 0건 / 오답 0개', (await pb.$$eval('#history-list li', (l) => l.length)) === rls.myRounds && (await pb.$eval('#notes-count', (e) => e.textContent)) === '0');

    // ---------------- 8. 지속성: 새로고침 / 새 브라우저 컨텍스트
    const histA = await pa.$$eval('#history-list li', (l) => l.length);
    await pa.reload({ waitUntil: 'networkidle0' });
    await pa.waitForSelector('#screen-start.active', { timeout: 15000 });
    check('새로고침 후 세션 유지', (await pa.$eval('#user-nickname', (e) => e.textContent)) === A.nick);
    const pc = await newPage(browser);
    await login(pc, A);
    await pc.waitForFunction((n) => document.querySelectorAll('#history-list li').length === n, { timeout: 15000 }, histA).catch(() => {});
    check('새 컨텍스트 로그인: 기록 동일', (await pc.$$eval('#history-list li', (l) => l.length)) === histA, histA);
    check('새 컨텍스트 로그인: 오답노트 개수 동일', (await pc.$eval('#notes-count', (e) => e.textContent)) === String(activeNow));

    // ---------------- 9. 오프라인: 큐에 쌓였다가 복구 후 전송
    await pc.$eval('#size-range', (e) => { e.value = 10; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await pc.setOfflineMode(true);
    await pc.click('#start-form button[type=submit]');
    await pc.waitForSelector('#ox-buttons:not([hidden])');
    const q0 = await ev(pc, () => window.__oxquiz.state.question.answer);
    await pc.click(`.btn.ox[data-choice="${q0 === 'O' ? 'X' : 'O'}"]`);
    await pc.waitForSelector('#sync-banner:not([hidden])', { timeout: 10000 });
    const pending = await ev(pc, () => window.__oxquiz.state.server.pending);
    check('오프라인: 저장 대기 표시', pending >= 2, { pending, banner: await pc.$eval('#sync-banner', (e) => e.textContent) });
    await shot(pc, '14-offline-pending.png');
    await pc.setOfflineMode(false);
    await ev(pc, () => window.dispatchEvent(new Event('online')));
    await waitSynced(pc);
    check('온라인 복구 후 큐 전송 완료', (await ev(pc, () => window.__oxquiz.state.server.pending)) === 0);
    check('배너 숨김', await pc.$eval('#sync-banner', (e) => e.hidden));

    // ---------------- 10. 로그아웃
    await pc.click('#quit-btn');
    await pc.waitForSelector('#screen-start.active');
    await pc.click('#logout-btn');
    await pc.waitForSelector('#screen-auth.active');
    check('로그아웃 → 로그인 화면, PIN 비움', (await pc.$eval('#login-pin', (e) => e.value)) === '');

    for (const [n, p] of [['A', pa], ['B', pb], ['C', pc]]) check(`콘솔 오류 없음 (${n})`, p.errors.length === 0, p.errors);
  } catch (e) {
    check('예외 없이 완료', false, String(e && e.stack || e));
  } finally {
    await browser.close();
    const fail = results.filter((r) => !r.ok);
    console.log(`\n${results.length - fail.length}/${results.length} checks passed`);
    process.exit(fail.length ? 1 : 0);
  }
})();
