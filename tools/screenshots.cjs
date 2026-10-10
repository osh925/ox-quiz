// 헤드리스 크롬으로 모바일 화면 스크린샷 + 간단 E2E 확인.
// 준비: puppeteer-core 설치된 폴더를 NODE_PATH 로 지정, 로컬 서버 실행 중이어야 함.
// 로그인이 필요하므로 테스트 계정을 환경변수로: OX_NICK=... OX_PIN=...
//   (임의 폴더에서) npm i puppeteer-core  →  NODE_PATH=<그 폴더>/node_modules node tools/screenshots.cjs [http://localhost:8080/]
//   크롬 경로는 CHROME 환경변수로 지정(기본 /usr/bin/google-chrome)
const puppeteer = require('puppeteer-core');
const path = require('path');
const URL = process.argv[2] || 'http://localhost:8080/';
const OUT = path.join(__dirname, '..', 'screenshots');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--lang=ko-KR'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.emulate({
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screen-start.active, #screen-auth.active');
  if (await page.$('#screen-auth.active')) {
    if (!process.env.OX_NICK || !process.env.OX_PIN) throw new Error('OX_NICK / OX_PIN 환경변수가 필요합니다');
    await page.type('#login-username', process.env.OX_NICK);
    await page.type('#login-pin', process.env.OX_PIN);
    await page.click('#login-form button[type=submit]');
  }
  await page.waitForSelector('#screen-start.active');
  await page.screenshot({ path: `${OUT}/01-start.png` });

  await page.tap('#start-form button[type=submit]');
  await page.waitForSelector('#screen-quiz.active');
  await page.screenshot({ path: `${OUT}/02-question.png` });

  const shots = { 'wrong-false': '03-wrong-ojimun.png', 'wrong-true': '04-wrong-jeongjimun.png', correct: '05-correct.png' };
  const done = new Set();
  const log = [];
  for (let i = 0; i < 15; i++) {
    const q = await page.evaluate(() => { const q = window.__oxquiz.state.question; return { kind: q.kind, text: q.text }; });
    // 아직 못 찍은 피드백 종류를 우선 만들도록 답 선택
    let choice;
    if (q.kind === 'false' && !done.has('wrong-false')) choice = 'O';
    else if (q.kind === 'true' && !done.has('wrong-true')) choice = 'X';
    else choice = q.kind === 'true' ? 'O' : 'X';
    await page.tap(`.btn.ox[data-choice="${choice}"]`);
    await page.waitForSelector('#feedback:not([hidden])');
    const fb = await page.evaluate(() => ({
      title: document.getElementById('fb-title').textContent,
      original: !document.getElementById('fb-original').hidden,
      marks: [...document.querySelectorAll('#fb-original-text mark')].map((m) => m.textContent),
    }));
    const kind = fb.title.includes('정답') ? 'correct' : q.kind === 'false' ? 'wrong-false' : 'wrong-true';
    log.push({ i: i + 1, kind: q.kind, choice, ...fb });
    if (!done.has(kind)) {
      done.add(kind);
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: `${OUT}/${shots[kind]}` });
    }
    await page.tap('#next-btn');
  }
  await page.waitForSelector('#result-dialog[open]');
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `${OUT}/06-result-modal.png` });
  const result = await page.evaluate(() => `${document.getElementById('result-correct').textContent}/${document.getElementById('result-attempted').textContent}`);
  await page.tap('#again-btn');
  await page.waitForSelector('#screen-quiz.active');
  const afterAgain = await page.$eval('#progress-text', (e) => e.textContent);
  const timerHiddenUntimed = await page.$eval('#timer', (e) => e.hidden);

  // ---------------- 10초 타이머 라운드
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await page.tap('#quit-btn').catch(() => {});
  page.once('dialog', (d) => d.accept());
  await page.evaluate(() => document.getElementById('quit-btn').click());
  await page.waitForSelector('#screen-start.active');
  await page.tap('#timer-options input[value="10s"]');
  await page.$eval('#size-range', (e) => { e.value = 10; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.screenshot({ path: `${OUT}/01b-start-timer-10s.png` });
  await page.tap('#start-form button[type=submit]');
  await page.waitForSelector('#screen-quiz.active');
  const timed = { checks: [] };
  let timeoutDone = false, runningShot = false;
  for (let i = 0; i < 10; i++) {
    await page.waitForSelector('#ox-buttons:not([hidden])');
    const q = await page.evaluate(() => window.__oxquiz.state.question.kind);
    const t0 = await page.$eval('#timer-text', (e) => e.textContent);
    if (!timeoutDone && q === 'false') {
      await sleep(3000);
      if (!runningShot) { runningShot = true; await page.screenshot({ path: `${OUT}/07-timer-running.png` }); }
      await page.waitForSelector('#feedback:not([hidden])', { timeout: 15000 });
      const fb = await page.evaluate(() => ({
        title: document.getElementById('fb-title').textContent,
        label: document.getElementById('fb-label').hidden ? '' : document.getElementById('fb-label').textContent,
        original: !document.getElementById('fb-original').hidden,
        timer: document.getElementById('timer-text').textContent,
        answered: window.__oxquiz.state.round.answered.length,
      }));
      // 시간 초과 후 늦은 탭(중복 입력) 무시 확인
      await page.evaluate(() => { window.__oxquiz.answer('O'); window.__oxquiz.answer('X'); });
      const answeredAfterTaps = await page.evaluate(() => window.__oxquiz.state.round.answered.length);
      await sleep(1500);
      const timerAfter = await page.$eval('#timer-text', (e) => e.textContent);
      timed.timeout = { startTimer: t0, ...fb, answeredAfterTaps, timerAfter1500ms: timerAfter };
      await sleep(200);
      await page.screenshot({ path: `${OUT}/08-timeout-feedback.png` });
      timeoutDone = true;
    } else {
      await sleep(2300);
      await page.tap(`.btn.ox[data-choice="${q === 'true' ? 'O' : 'X'}"]`);
      await page.waitForSelector('#feedback:not([hidden])');
      const frozen1 = await page.$eval('#timer-text', (e) => e.textContent);
      await sleep(1200);
      const frozen2 = await page.$eval('#timer-text', (e) => e.textContent);
      timed.checks.push({ i: i + 1, startTimer: t0, frozen1, frozen2 });
    }
    await page.tap('#next-btn');
  }
  await page.waitForSelector('#result-dialog[open]');
  timed.resultRate = await page.$eval('#result-rate', (e) => e.textContent);
  await page.tap('#again-btn');
  await page.waitForSelector('#ox-buttons:not([hidden])');
  timed.afterAgain = { progress: await page.$eval('#progress-text', (e) => e.textContent), timer: await page.$eval('#timer-text', (e) => e.textContent) };
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#screen-start.active');
  await page.waitForFunction(() => window.__oxquiz.state.server.pending === 0, { timeout: 20000 });
  timed.prefRestored = await page.$eval('#timer-options input:checked', (e) => e.value);
  await page.evaluate(() => window.__oxquiz.state.server.refresh());
  timed.lastRound = await page.evaluate(() => window.__oxquiz.state.server.rounds.find((r) => r.timer_sec === 10));
  timed.storedTimeouts = timed.lastRound && timed.lastRound.timeouts;

  console.log(JSON.stringify({
    untimed: { feedbackTitles: [...new Set(log.map((l) => l.title))], result, afterAgain, timerHiddenUntimed, captured: [...done] },
    timed, errors,
  }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
