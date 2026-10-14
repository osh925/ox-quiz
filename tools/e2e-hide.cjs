// 오답노트 삭제 / 오지문 숨김 E2E (실제 Supabase, 헤드리스 크롬).
// 임시 계정을 새로 만들어 검증만 하고, 계정 삭제는 끝난 뒤 SQL 로 별도 수행(출력되는 닉네임 참고).
//   NODE_PATH=<puppeteer-core>/node_modules node tools/e2e-hide.cjs [URL]
const puppeteer = require('puppeteer-core');
const path = require('path');
const URL = process.argv[2] || 'http://localhost:8080/';
const OUT = path.join(__dirname, '..', 'screenshots');
const SHOTS = process.env.SHOTS !== '0';
const U = { nick: process.env.NICK || `e2eh${String(Date.now()).slice(-5)}`, pin: '135790' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); };
const ev = (page, fn, ...a) => page.evaluate(fn, ...a);
const shot = async (page, name, el) => {
  if (!SHOTS) return; await sleep(400);
  if (el) { const h = await page.$(el); await h.screenshot({ path: `${OUT}/${name}` }); } else await page.screenshot({ path: `${OUT}/${name}` });
};
const waitSynced = (page) => page.waitForFunction(() => window.__oxquiz.state.server.pending === 0, { timeout: 20000 });
const typeInto = async (page, sel, text) => { await page.$eval(sel, (e) => { e.value = ''; }); await page.type(sel, text); };

// 서버에서 직접(본인 세션으로) 읽기
const server = (page) => ev(page, async () => {
  const c = window.__oxquiz.state.server.client;
  const [n, h] = await Promise.all([c.from('wrong_notes').select('*'), c.from('hidden_variants').select('*')]);
  return { notes: n.data, hidden: h.data, err: n.error || h.error };
});

(async () => {
  console.log('임시 테스트 계정:', U.nick);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--lang=ko-KR'] });
  try {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.emulate({
      viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
    });
    await page.goto(URL, { waitUntil: 'networkidle0' });

    // 가입
    await page.waitForSelector('#screen-auth.active');
    await page.click('#tab-signup');
    await typeInto(page, '#signup-username', U.nick);
    await typeInto(page, '#signup-pin', U.pin);
    await typeInto(page, '#signup-pin2', U.pin);
    await page.click('#signup-form button[type=submit]');
    await page.waitForSelector('#screen-start.active', { timeout: 20000 });
    check('임시 계정 가입', true);

    // 테스트용 문항 고르기: A(오지문 2개 이상, 둘 다 틀림) / B(정지문만 틀림) / C(오지문 1개 틀림, 오프라인 삭제) / D(오지문 틀림, 숨기지 않고 삭제만)
    const pick = await ev(page, () => {
      const items = window.__oxquiz.state.data.subjects.flatMap((s) => s.items);
      const multi = items.filter((i) => i.wrongs.length >= 2);
      const one = items.filter((i) => i.wrongs.length >= 1 && !multi.slice(0, 1).includes(i));
      const [A] = multi; const [B, C, D] = one.filter((i) => i !== A);
      return { A: A.id, Aw: A.wrongs.map((w) => w.id), B: B.id, C: C.id, Cw: C.wrongs[0].id, D: D.id, Dw: D.wrongs[0].id };
    });

    // 실제 앱 경로(state.server.recordAttempt → record_attempt RPC)로 오답 기록 만들기
    await ev(page, async (p) => {
      const app = window.__oxquiz; const s = app.state.server;
      const items = new Map(app.state.data.subjects.flatMap((x) => x.items).map((i) => [i.id, i]));
      const id = s.newRoundId();
      s.startRound({ id, mode: 'normal', timerSec: 0, total: 6, startedAt: Date.now() });
      const q = (itemId, vid) => {
        const it = items.get(itemId);
        return vid ? { itemId, statementId: vid, kind: 'false', answer: 'X' } : { itemId, statementId: itemId, kind: 'true', answer: 'O', text: it.answer };
      };
      const wrong = (qq) => s.recordAttempt(qq, { correct: false, choice: qq.answer === 'O' ? 'X' : 'O' }, { mode: 'normal', roundId: id });
      wrong(q(p.A, p.Aw[0])); await new Promise((r) => setTimeout(r, 30));
      wrong(q(p.A, p.Aw[1])); await new Promise((r) => setTimeout(r, 30));
      wrong(q(p.B, null));
      wrong(q(p.C, p.Cw));
      wrong(q(p.D, p.Dw));
    }, pick);
    await waitSynced(page);
    let sv = await server(page);
    check('오답 기록 4건 서버 반영', sv.notes.length === 4 && sv.notes.every((n) => !n.dismissed && !n.cleared), sv.notes.length);

    // 오답노트 화면
    await page.click('#notes-card');
    await page.waitForSelector('#screen-notes.active');
    await sleep(300);
    const delCount = await page.$$eval('#notes-list .note-del', (b) => b.length);
    check('오답노트 항목마다 삭제 버튼', delCount === 4, delCount);
    await shot(page, '15-wrongnote-delete-buttons.png');

    // (1) 정지문만 틀린 B → 단순 삭제 확인 후 바로 삭제 (숨김 질문 없음)
    await page.click(`#notes-list .note-del[data-item="${pick.B}"]`);
    await page.waitForSelector('#dismiss-dialog[open] #dismiss-step1:not([hidden])');
    await page.click('#dismiss-yes');
    await page.waitForFunction(() => !document.querySelector('#dismiss-dialog').open, { timeout: 10000 });
    check('정지문만 틀린 항목: 숨김 질문 없이 삭제', !(await page.$(`#notes-list .note-del[data-item="${pick.B}"]`)));

    // (2) 오지문 2개를 틀린 A → 숨김 질문 + 체크박스 2개 (최근 것 체크됨)
    await page.click(`#notes-list .note-del[data-item="${pick.A}"]`);
    await page.waitForSelector('#dismiss-dialog[open]');
    await page.click('#dismiss-yes');
    await page.waitForSelector('#dismiss-step2:not([hidden])', { timeout: 10000 });
    const boxes = await page.$$eval('#dismiss-variants input', (els) => els.map((e) => ({ v: e.value, c: e.checked })));
    const title = await page.$eval('#dismiss-step2 h2', (e) => e.textContent);
    check('숨김 확인 문구', title === '이 오지문이 앞으로 등장하지 않게 할까요?', title);
    check('틀렸던 오지문 2개 체크박스, 마지막에 틀린 것 기본 체크',
      boxes.length === 2 && boxes[0].v === pick.Aw[1] && boxes[0].c && !boxes[1].c, boxes);
    await page.click('#dismiss-variants li:nth-child(2) input'); // 둘 다 숨김
    await shot(page, '16-hide-confirm.png');
    await page.click('#hide-yes');
    await page.waitForFunction(() => !document.querySelector('#dismiss-dialog').open);

    // (3) D → 숨김 질문에서 '아니요' (삭제만)
    await page.click(`#notes-list .note-del[data-item="${pick.D}"]`);
    await page.click('#dismiss-yes');
    await page.waitForSelector('#dismiss-step2:not([hidden])', { timeout: 10000 });
    await page.click('#hide-no');
    await page.waitForFunction(() => !document.querySelector('#dismiss-dialog').open);
    await waitSynced(page);
    sv = await server(page);
    const nA = sv.notes.find((n) => n.item_id === pick.A); const nB = sv.notes.find((n) => n.item_id === pick.B); const nD = sv.notes.find((n) => n.item_id === pick.D);
    check('서버: A·B·D dismissed', [nA, nB, nD].every((n) => n.dismissed && n.cleared && n.dismissed_at), [nA.dismissed, nB.dismissed, nD.dismissed]);
    check('서버: A의 오지문 2개만 숨김 (D는 숨기지 않음)', sv.hidden.length === 2 && pick.Aw.slice(0, 2).every((v) => sv.hidden.some((h) => h.variant_id === v)), sv.hidden.map((h) => h.variant_id));
    check('서버: 응답 기록(wrong_count)은 그대로', nA.wrong_count === 2 && nB.wrong_count === 1, [nA.wrong_count, nB.wrong_count]);

    // (4) 숨긴 오지문 목록
    await page.click('#hidden-section summary');
    const hiddenItems = await page.$$eval('#hidden-list .unhide', (b) => b.length);
    check('숨긴 오지문 목록 2개 + 되돌리기', hiddenItems === 2, hiddenItems);
    await page.$eval('#hidden-section', (e) => e.scrollIntoView({ block: 'start' }));
    await shot(page, '17-hidden-list.png');

    // (5) 출제에서 제외 (순수 로직 + 실제 라운드)
    const dist = await ev(page, async (p) => {
      const core = await import('./js/quiz-core.js');
      const app = window.__oxquiz; const items = app.state.data.subjects.flatMap((s) => s.items);
      const A = items.find((i) => i.id === p.A);
      const hidden = app.state.server.hidden; const c = {};
      for (let i = 0; i < 4000; i++) { const q = core.pickQuestion([A], Math.random, hidden); c[q.statementId] = (c[q.statementId] || 0) + 1; }
      return { c, nW: A.wrongs.length };
    }, pick);
    const hiddenShown = pick.Aw.slice(0, 2).some((v) => dist.c[v]);
    check('출제: 숨긴 오지문은 나오지 않음', !hiddenShown, dist.c);
    if (dist.nW === 2) check('출제: 오지문 전부 숨기면 정지문만', dist.c[pick.A] === 4000);
    else check('출제: 남은 오지문은 계속 나옴, 정지문 50% 유지', Math.abs(dist.c[pick.A] / 4000 - 0.5) < 0.05, dist.c);
    // 실제 라운드에서 nextQuestion 경로 확인 (풀을 A로 고정)
    const seen = await ev(page, async (p) => {
      const app = window.__oxquiz; const out = [];
      app.state.roundHidden = app.state.server.hidden;
      const items = app.state.data.subjects.flatMap((s) => s.items);
      app.state.roundPool = [items.find((i) => i.id === p.A)];
      return app.state.roundHidden.size;
    }, pick);
    check('라운드 시작 시 숨김 목록 전달', seen === 2, seen);

    // (6) 오프라인에서 C 삭제 + 숨김 → 큐 → 온라인 복귀 시 전송
    await page.setOfflineMode(true);
    await page.click(`#notes-list .note-del[data-item="${pick.C}"]`);
    await page.click('#dismiss-yes');
    await page.waitForSelector('#dismiss-step2:not([hidden])', { timeout: 10000 });
    const offBoxes = await page.$$eval('#dismiss-variants input', (els) => els.map((e) => e.value));
    check('오프라인: 마지막으로 틀린 오지문으로 확인창 표시', offBoxes.length === 1 && offBoxes[0] === pick.Cw, offBoxes);
    await page.click('#hide-yes');
    await page.waitForFunction(() => !document.querySelector('#dismiss-dialog').open);
    const offState = await ev(page, () => ({ pending: window.__oxquiz.state.server.pending, hidden: window.__oxquiz.state.server.hiddenList.length, q: localStorage.getItem(((location.pathname.includes('/beta/') ? 'oxquizbeta' : 'oxquiz') + '.queue.') + window.__oxquiz.state.server.user.id) }));
    check('오프라인: 로컬 즉시 반영 + 큐 대기', offState.pending >= 1 && offState.hidden === 3 && /dismiss/.test(offState.q), { pending: offState.pending, hidden: offState.hidden });
    await page.setOfflineMode(false);
    await ev(page, () => window.__oxquiz.state.server.flush());
    await waitSynced(page);
    sv = await server(page);
    check('온라인 복귀: 서버에 C dismissed + 숨김 3개', sv.notes.find((n) => n.item_id === pick.C).dismissed && sv.hidden.length === 3, sv.hidden.length);

    // (7) 되돌리기
    await page.click(`#hidden-list .unhide[data-variant="${pick.Cw}"]`);
    await waitSynced(page);
    sv = await server(page);
    check('되돌리기: 서버에서 숨김 해제', sv.hidden.length === 2 && !sv.hidden.some((h) => h.variant_id === pick.Cw), sv.hidden.length);
    check('되돌리기: 목록 갱신', (await page.$$eval('#hidden-list .unhide', (b) => b.length)) === 2);

    // (8) 삭제한 항목을 다시 틀리면 다시 오답노트로
    await ev(page, (p) => {
      const s = window.__oxquiz.state.server; const id = s.newRoundId();
      s.startRound({ id, mode: 'normal', timerSec: 0, total: 1, startedAt: Date.now() });
      s.recordAttempt({ itemId: p.B, statementId: p.B, kind: 'true', answer: 'O' }, { correct: false, choice: 'X' }, { mode: 'normal', roundId: id });
    }, pick);
    await waitSynced(page);
    sv = await server(page);
    const nB2 = sv.notes.find((n) => n.item_id === pick.B);
    check('다시 틀리면 오답노트 복귀 (dismissed=false, 횟수 누적)', !nB2.dismissed && !nB2.cleared && nB2.wrong_count === 2 && nB2.dismissed_at === null, nB2);

    // (9) 새로고침 후에도 유지 (서버에서 다시 불러오기)
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#screen-start.active', { timeout: 20000 });
    await ev(page, () => window.__oxquiz.state.server.refresh());
    const after = await ev(page, () => ({ h: window.__oxquiz.state.server.hiddenList.length, cache: JSON.parse(localStorage.getItem(((location.pathname.includes('/beta/') ? 'oxquizbeta' : 'oxquiz') + '.cache.') + window.__oxquiz.state.server.user.id)).hidden.length }));
    check('새로고침 후 숨김 목록 유지', after.h === 2 && after.cache === 2, after);

    // (10) 보안: RLS / 권한
    const sec = await ev(page, async (p) => {
      const c = window.__oxquiz.state.server.client;
      const other = await c.from('hidden_variants').insert({ user_id: '00000000-0000-0000-0000-000000000001', variant_id: 'x-1', item_id: 'x' });
      const bogus = await c.rpc('dismiss_wrong_note', { p_item_id: p.D, p_hide_variants: [p.Cw] }); // 다른 문항 오지문은 무시돼야 함
      const h = await c.from('hidden_variants').select('variant_id');
      const view = await c.schema('private').from('hidden_variant_counts').select('*');
      return { otherErr: other.error && other.error.code, bogusErr: bogus.error, hidden: h.data.map((x) => x.variant_id), viewErr: !!view.error };
    }, pick);
    check('RLS: 다른 사용자 이름으로 숨김 행 추가 불가', !!sec.otherErr, sec.otherErr);
    check('dismiss_wrong_note: 다른 문항의 오지문 ID는 무시', !sec.bogusErr && !sec.hidden.includes(pick.Cw), sec.hidden);
    check('관리자 집계 뷰는 앱(로그인 사용자)에서 접근 불가', sec.viewErr);
    const anon = await ev(page, async () => {
      const cfg = await import('./js/config.js');
      const { createClient } = await import(cfg.SUPABASE_JS_URL);
      const a = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
      const r = await a.from('hidden_variants').select('*');
      const f = await a.rpc('dismiss_wrong_note', { p_item_id: 'x', p_hide_variants: [] });
      return { rows: r.data ? r.data.length : null, err: !!r.error, rpcErr: !!f.error };
    });
    check('비로그인: 숨김 테이블 읽기·RPC 불가', (anon.err || anon.rows === 0) && anon.rpcErr, anon);

    check('페이지 오류 없음', errors.length === 0, errors);
  } catch (e) {
    check('예외 없이 완료', false, String(e && e.stack || e));
  } finally {
    await browser.close();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} PASS · 계정: ${U.nick}`);
    process.exitCode = failed.length ? 1 : 0;
  }
})();
