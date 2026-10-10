import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mulberry32, buildPool, listSections, pickQuestion, grade, newRound, recordAnswer,
  isRoundOver, roundSummary, clampRoundSize, highlightOriginal,
} from '../js/quiz-core.js';
import { LocalProgressStore } from '../js/storage.js';

const fixture = {
  subjects: [{
    id: 's', name: 'S', items: [
      { id: 's-0001', no: 1, section: ['Ⅰ. A', '1. a'], answer: 'A는 참이다.', wrongs: [] },
      { id: 's-0002', no: 2, section: ['Ⅰ. A', '2. b'], answer: 'B는 참이다.', wrongs: [{ id: 's-0002-1', no: '2-1', text: 'B는 거짓이다.' }] },
      { id: 's-0003', no: 3, section: ['Ⅱ. C'], answer: 'C는 참이다.', wrongs: [
        { id: 's-0003-1', no: '3-1', text: 'C는 거짓1.' }, { id: 's-0003-2', no: '3-2', text: 'C는 거짓2.' }] },
    ],
  }],
};

function simulate(pool, N, seed = 42) {
  const rng = mulberry32(seed);
  const counts = {};
  for (let i = 0; i < N; i++) {
    const q = pickQuestion(pool, rng);
    counts[q.itemId] ??= { total: 0, O: 0, X: 0, by: {} };
    const c = counts[q.itemId];
    c.total++; c[q.answer]++; c.by[q.statementId] = (c.by[q.statementId] || 0) + 1;
  }
  return counts;
}
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual.toFixed(4)} vs ${expected} (±${tol})`);

test('정지문은 균등 확률로 선택된다', () => {
  const N = 150000;
  const c = simulate(buildPool(fixture), N);
  for (const id of ['s-0001', 's-0002', 's-0003']) near(c[id].total / N, 1 / 3, 0.01, id);
});

test('오지문이 있는 정지문: O 50% / X 50%, 오지문끼리는 균등', () => {
  const c = simulate(buildPool(fixture), 200000, 7);
  const b = c['s-0002'];
  near(b.O / b.total, 0.5, 0.01, 'B O비율');
  near(b.by['s-0002-1'] / b.total, 0.5, 0.01, 'B 오지문');
  const cc = c['s-0003'];
  near(cc.O / cc.total, 0.5, 0.01, 'C O비율');
  near(cc.by['s-0003-1'] / cc.total, 0.25, 0.01, 'C 오지문1');
  near(cc.by['s-0003-2'] / cc.total, 0.25, 0.01, 'C 오지문2');
});

test('오지문이 없는 정지문은 항상 정지문(O)으로 출제된다', () => {
  const pool = buildPool(fixture, { sectionPrefix: ['Ⅰ. A', '1. a'] });
  const rng = mulberry32(1);
  let fallback = 0;
  for (let i = 0; i < 2000; i++) {
    const q = pickQuestion(pool, rng);
    assert.equal(q.answer, 'O'); assert.equal(q.kind, 'true'); assert.equal(q.text, 'A는 참이다.');
    if (q.fallback) fallback++;
  }
  near(fallback / 2000, 0.5, 0.05, '대체 출제 비율');
});

test('실제 데이터셋 전체 분포: O 비율 ≈ 50% (오지문 없는 정지문이 없을 때)', () => {
  const data = JSON.parse(readFileSync(new URL('../data/questions.json', import.meta.url)));
  const pool = buildPool(data);
  const zero = pool.filter((it) => !it.wrongs.length).length;
  const rng = mulberry32(99);
  let O = 0; const N = 100000;
  for (let i = 0; i < N; i++) if (pickQuestion(pool, rng).answer === 'O') O++;
  near(O / N, 0.5 + 0.5 * (zero / pool.length), 0.01, 'O 비율');
});

test('채점 분기: 정답 / 정지문 오답 / 오지문 오답', () => {
  const t = { kind: 'true', answer: 'O', statementId: 'a', itemId: 'a', text: 'x', original: 'x' };
  const f = { kind: 'false', answer: 'X', statementId: 'a-1', itemId: 'a', text: 'y', original: 'x' };
  assert.deepEqual(grade(t, 'O'), { correct: true, feedback: 'correct', showOriginal: false, choice: 'O' });
  assert.deepEqual(grade(f, 'X'), { correct: true, feedback: 'correct', showOriginal: false, choice: 'X' });
  assert.deepEqual(grade(t, 'X'), { correct: false, feedback: 'wrong-true', showOriginal: false, choice: 'X' });
  assert.deepEqual(grade(f, 'O'), { correct: false, feedback: 'wrong-false', showOriginal: true, choice: 'O' });
  assert.throws(() => grade(t, 'maybe'));
});

test('라운드: N문항 후 종료, 맞은 수/시도 수 집계', () => {
  let r = newRound(clampRoundSize(15));
  const q = { kind: 'true', answer: 'O', statementId: 'a', itemId: 'a' };
  for (let i = 0; i < 15; i++) {
    assert.equal(isRoundOver(r), false);
    r = recordAnswer(r, q, grade(q, i % 3 === 0 ? 'X' : 'O'));
  }
  assert.equal(isRoundOver(r), true);
  assert.deepEqual(roundSummary(r).correct, 10);
  assert.deepEqual(roundSummary(r).attempted, 15);
  assert.equal(clampRoundSize(3), 10); assert.equal(clampRoundSize(99), 20); assert.equal(clampRoundSize('abc'), 15);
});

test('섹션 필터와 섹션 목록', () => {
  assert.equal(buildPool(fixture, { sectionPrefix: ['Ⅰ. A'] }).length, 2);
  assert.equal(buildPool(fixture, { sectionPrefix: ['Ⅱ. C'] }).length, 1);
  assert.equal(buildPool(fixture, { subjectId: 'none' }).length, 0);
  const secs = listSections(fixture, 's', 2);
  assert.deepEqual(secs.find((s) => s.label === 'Ⅰ. A').count, 2);
  assert.throws(() => pickQuestion([]));
});

test('diff 하이라이트: 이어 붙이면 정지문과 같고 바뀐 부분이 표시된다', () => {
  const from = '소를 제기하려는 자는 피고에게 소장을 제출하여야 한다.';
  const to = '소를 제기하려는 자는 법원에 소장을 제출하여야 한다.';
  const segs = highlightOriginal(from, to);
  assert.equal(segs.map((s) => s.text).join(''), to);
  const changed = segs.filter((s) => s.changed).map((s) => s.text).join('');
  assert.ok(changed.includes('법원'), changed);
  assert.ok(!changed.includes('소장을'), changed);
});

test('저장소: 응답/라운드 기록이 statementId 기준으로 쌓인다', async () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const st = new LocalProgressStore(storage, 'test');
  const q = { statementId: 's-0002-1' };
  await st.recordAttempt(q, { correct: false });
  await st.recordAttempt(q, { correct: true });
  await st.saveRound({ attempted: 2, correct: 1 });
  const st2 = new LocalProgressStore(storage, 'test'); // 새로 읽어도 유지
  const p = await st2.load();
  assert.equal(p.stats['s-0002-1'].seen, 2);
  assert.equal(p.stats['s-0002-1'].wrong, 1);
  assert.equal(p.rounds.length, 1);
  assert.match(p.userId, /^u-/);
});

test('실제 데이터셋 전체: 모든 오지문 diff 결과를 이어 붙이면 정지문과 같고, 바뀐 부분이 존재', () => {
  const data = JSON.parse(readFileSync(new URL('../data/questions.json', import.meta.url)));
  for (const it of buildPool(data)) for (const w of it.wrongs) {
    const segs = highlightOriginal(w.text, it.answer);
    assert.equal(segs.map((s) => s.text).join(''), it.answer, w.id);
    assert.ok(segs.some((s) => s.changed) || it.answer.length < w.text.length, `${w.id} 표시할 차이 없음`);
  }
});

// ---------------------------------------------------------------- 피드백 문구 / 시간 초과 / 타이머
import { gradeTimeout, feedbackText, TIMER_OPTIONS, DEFAULT_TIMER_ID, getTimerOption } from '../js/quiz-core.js';
import { createCountdown } from '../js/timer.js';

test('피드백 문구: O/X 기호 없이 정답입니다 / 오답입니다, 시간 초과 라벨', () => {
  const t = { kind: 'true', answer: 'O' }, f = { kind: 'false', answer: 'X' };
  assert.deepEqual(feedbackText(grade(t, 'O')), { title: '정답입니다', label: '' });
  assert.deepEqual(feedbackText(grade(t, 'X')), { title: '오답입니다', label: '' });
  assert.deepEqual(feedbackText(grade(f, 'O')), { title: '오답입니다', label: '' });
  assert.deepEqual(feedbackText(gradeTimeout(f)), { title: '오답입니다', label: '시간 초과' });
});

test('시간 초과 채점: 항상 오답, 오지문이면 정지문 표시 / 정지문이면 오답만', () => {
  const t = { kind: 'true', answer: 'O', statementId: 'a', itemId: 'a' };
  const f = { kind: 'false', answer: 'X', statementId: 'a-1', itemId: 'a' };
  assert.deepEqual(gradeTimeout(t), { correct: false, feedback: 'wrong-true', showOriginal: false, choice: null, timedOut: true });
  assert.deepEqual(gradeTimeout(f), { correct: false, feedback: 'wrong-false', showOriginal: true, choice: null, timedOut: true });
  let r = newRound(10);
  r = recordAnswer(r, t, gradeTimeout(t));
  r = recordAnswer(r, f, grade(f, 'X'));
  assert.deepEqual(roundSummary(r), { attempted: 2, correct: 1, wrong: 1, timeouts: 1, rate: 0.5 });
});

test('제한 시간 옵션: 기본 무제한, 모르는 id 는 기본값으로', () => {
  assert.equal(DEFAULT_TIMER_ID, 'none');
  assert.deepEqual(TIMER_OPTIONS.map((o) => o.seconds), [0, 10, 30]);
  assert.equal(getTimerOption('10s').seconds, 10);
  assert.equal(getTimerOption('bogus').id, 'none');
  assert.equal(getTimerOption(undefined).id, 'none');
});

/** 가짜 시계 + 가짜 setInterval */
function fakeEnv() {
  let t = 1_000_000;
  const timers = new Map(); let seq = 0;
  return {
    now: () => t,
    setIntervalFn: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; },
    clearIntervalFn: (h) => timers.delete(h),
    /** ms 만큼 시간을 흘리며 interval 콜백 실행. skipTicks=true 면 콜백 없이 시간만 흐름(백그라운드 탭) */
    advance(ms, step = 100, skipTicks = false) {
      for (let k = 0; k < ms; k += step) { t += step; if (!skipTicks) for (const { fn } of [...timers.values()]) fn(); }
    },
    get active() { return timers.size; },
  };
}

test('카운트다운: 타임스탬프 기준 만료, onExpire 한 번, 만료 후 interval 해제', () => {
  const env = fakeEnv(); const ticks = []; let expired = 0;
  const c = createCountdown({ seconds: 10, ...env, onTick: (r) => ticks.push(r), onExpire: () => expired++ });
  c.start();
  assert.equal(ticks[0], 10000); assert.equal(env.active, 1);
  env.advance(9900);
  assert.equal(expired, 0); assert.equal(c.remainingMs(), 100);
  env.advance(100);
  assert.equal(expired, 1); assert.equal(c.status, 'expired'); assert.equal(env.active, 0);
  env.advance(5000);
  assert.equal(expired, 1, '두 번 만료되지 않음');
  assert.equal(c.stop(), false, '만료 후 늦은 탭은 무효');
});

test('카운트다운: 답하면 즉시 멈추고, 피드백 화면 동안 tick/expire 없음', () => {
  const env = fakeEnv(); let ticks = 0; let expired = 0;
  const c = createCountdown({ seconds: 10, ...env, onTick: () => ticks++, onExpire: () => expired++ });
  c.start();
  env.advance(3000);
  assert.equal(c.stop(), true);
  assert.equal(c.elapsedMs(), 3000);
  const ticksAtStop = ticks;
  env.advance(20000);           // 피드백 화면에서 오래 머묾
  c.check();                    // visibilitychange 등으로 불려도
  assert.equal(ticks, ticksAtStop, 'tick 없음');
  assert.equal(expired, 0, '만료 없음');
  assert.equal(c.remainingMs(), 7000, '남은 시간 고정');
  assert.equal(env.active, 0, 'interval 누수 없음');
  assert.equal(c.stop(), false, '중복 stop 무해');
  assert.throws(() => c.start(), '재사용 불가 → 다음 문제는 새 타이머');
});

test('카운트다운: 백그라운드 탭(interval 멈춤) 후 복귀 시 check() 로 정확히 만료', () => {
  const env = fakeEnv(); let expired = 0;
  const c = createCountdown({ seconds: 10, ...env, onExpire: () => expired++ });
  c.start();
  env.advance(12000, 100, true); // interval 이 전혀 돌지 않음
  assert.equal(expired, 0);
  assert.equal(c.remainingMs(), 0, '남은 시간은 시계 기준');
  assert.equal(c.stop(), false, '복귀 직후 탭해도 이미 시간 초과');
  assert.equal(expired, 1, 'stop 시점에 만료 처리됨');
  assert.equal(env.active, 0);
});
