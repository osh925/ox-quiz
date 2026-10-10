// 헤드리스 크롬으로 모바일 화면 스크린샷 + 간단 E2E 확인.
// 준비: puppeteer-core 설치된 폴더를 NODE_PATH 로 지정, 로컬 서버 실행 중이어야 함.
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
  const progress = await page.$eval('#progress-text', (e) => e.textContent);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('oxquiz.v1')));
  console.log(JSON.stringify({
    feedbackLog: log, result, afterAgain: progress,
    storedRounds: stored.rounds.length, storedStats: Object.keys(stored.stats).length,
    captured: [...done], errors,
  }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
