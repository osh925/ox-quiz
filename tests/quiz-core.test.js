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

// ---------------------------------------------------------------- 오답노트 / 동기화 큐 / 닉네임
import {
  applyWrongNote, activeWrongNotes, buildWrongNotePool, wrongNoteRoundSize, WRONG_NOTE_CLEAR_STREAK, findVariant,
} from '../js/quiz-core.js';
import { SyncQueue } from '../js/sync-queue.js';
import { normalizeNickname, validateNickname, validatePin, nicknameToEmail, emailToNickname } from '../js/auth-utils.js';

const att = (o) => ({ itemId: 's-0002', correct: false, mode: 'normal', variantId: null, at: '2026-10-10T00:00:00Z', ...o });

test('오답노트: 오답이면 추가, 맞히면 일반 모드에서는 변화 없음', () => {
  let n = applyWrongNote(null, att({ variantId: 's-0002-1' }));
  assert.deepEqual(n, { item_id: 's-0002', wrong_count: 1, last_wrong_at: '2026-10-10T00:00:00Z', correct_streak: 0, cleared: false, cleared_at: null, last_variant_id: 's-0002-1' });
  assert.equal(applyWrongNote(n, att({ correct: true })), n, '일반 모드 정답 → 그대로');
  assert.equal(applyWrongNote(null, att({ correct: true, mode: 'wrongnote' })), null, '노트에 없던 항목 정답 → 없음');
  n = applyWrongNote(n, att({ variantId: null, at: '2026-10-11T00:00:00Z' }));
  assert.equal(n.wrong_count, 2); assert.equal(n.last_variant_id, null, '정지문을 틀리면 variant null');
});

test(`오답노트: 오답노트 모드에서 ${WRONG_NOTE_CLEAR_STREAK}연속 정답이면 빠지고, 다시 틀리면 복귀`, () => {
  assert.equal(WRONG_NOTE_CLEAR_STREAK, 2);
  let n = applyWrongNote(null, att({}));
  n = applyWrongNote(n, att({ correct: true, mode: 'wrongnote' }));
  assert.equal(n.correct_streak, 1); assert.equal(n.cleared, false);
  n = applyWrongNote(n, att({ correct: false, mode: 'wrongnote' }));   // 중간에 틀림 → 리셋
  assert.equal(n.correct_streak, 0); assert.equal(n.wrong_count, 2);
  n = applyWrongNote(n, att({ correct: true, mode: 'wrongnote' }));
  n = applyWrongNote(n, att({ correct: true, mode: 'wrongnote', at: '2026-10-12T00:00:00Z' }));
  assert.equal(n.cleared, true); assert.equal(n.cleared_at, '2026-10-12T00:00:00Z');
  assert.equal(applyWrongNote(n, att({ correct: true, mode: 'wrongnote' })), n, '빠진 뒤 정답 → 변화 없음');
  n = applyWrongNote(n, att({ correct: false, mode: 'normal' }));    // 일반 모드에서 다시 틀림 → 복귀
  assert.equal(n.cleared, false); assert.equal(n.correct_streak, 0); assert.equal(n.cleared_at, null); assert.equal(n.wrong_count, 3);
  assert.equal(applyWrongNote(applyWrongNote(null, att({})), att({ correct: true, mode: 'wrongnote' }), 1).cleared, true, '기준값 설정 가능');
});

test('오답노트 풀/라운드 길이: 활성 항목만, 데이터셋에 없는 ID 무시, min(N, 개수)', () => {
  const notes = {
    's-0002': { item_id: 's-0002', cleared: false, last_wrong_at: '2026-10-10' },
    's-0003': { item_id: 's-0003', cleared: true, last_wrong_at: '2026-10-11' },
    'gone-0009': { item_id: 'gone-0009', cleared: false, last_wrong_at: '2026-10-12' },
  };
  assert.deepEqual(activeWrongNotes(notes).map((n) => n.item_id), ['gone-0009', 's-0002']);
  const pool = buildWrongNotePool(fixture, notes);
  assert.deepEqual(pool.map((p) => p.id), ['s-0002']);
  assert.equal(wrongNoteRoundSize(15, 1), 1);
  assert.equal(wrongNoteRoundSize(15, 40), 15);
  assert.equal(wrongNoteRoundSize(15, 0), 0);
  // 오답노트 모드도 같은 50/50 규칙 (pickQuestion 재사용)
  const rng = mulberry32(5); let x = 0;
  for (let i = 0; i < 20000; i++) if (pickQuestion(pool, rng).answer === 'X') x++;
  near(x / 20000, 0.5, 0.02, '오답노트 X 비율');
  assert.equal(findVariant(fixture.subjects[0].items[1], 's-0002-1').text, 'B는 거짓이다.');
  assert.equal(findVariant(fixture.subjects[0].items[1], null), null);
});

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('동기화 큐: 순서 보장, 일시 오류면 멈추고 보존, 영구 오류는 버림, 재시작 후에도 유지', async () => {
  const storage = memStorage();
  const sent = []; let online = false;
  const run = async (op) => {
    if (!online) return 'retry';
    if (op.bad) return 'drop';
    sent.push(op.n); return 'ok';
  };
  const q = new SyncQueue({ storage, key: 'q', run });
  q.push({ n: 1 }); q.push({ n: 2, bad: true }); q.push({ n: 3 });
  assert.equal(await q.flush(), 3); assert.deepEqual(sent, []);
  const q2 = new SyncQueue({ storage, key: 'q', run });   // 새로고침 후
  assert.equal(q2.size, 3);
  online = true;
  assert.equal(await q2.flush(), 0);
  assert.deepEqual(sent, [1, 3]);
  assert.equal(q2.dropped.length, 1);
  const q3 = new SyncQueue({ storage, key: 'q', run: async () => { throw new Error('network'); } });
  q3.push({ n: 4 });
  assert.equal(await q3.flush(), 1, '예외는 retry 로 취급');
});

test('동기화 큐: 빈 큐 flush 후에도 다음 flush 가 정상 동작 (회귀 테스트)', async () => {
  const sent = [];
  const q = new SyncQueue({ storage: memStorage(), key: 'q', run: async (op) => { sent.push(op.n); return 'ok'; } });
  assert.equal(await q.flush(), 0);
  assert.equal(q.flushing, null);
  q.push({ n: 1 });
  assert.equal(await q.flush(), 0);
  assert.deepEqual(sent, [1]);
  const [a, b] = [q.flush(), q.flush()];
  assert.equal(a, b, '동시 호출은 같은 작업 공유');
  await a;
});

test('닉네임/PIN: 정규화·검증·내부 이메일 변환', () => {
  assert.equal(normalizeNickname('  Test 용A '), 'test용a');
  assert.equal(nicknameToEmail('TEST용A'), nicknameToEmail('test용a'));
  assert.match(nicknameToEmail('테스트b'), /^u[0-9a-f]+@ox-quiz\.invalid$/);
  assert.equal(emailToNickname(nicknameToEmail('테스트b')), '테스트b');
  assert.ok(nicknameToEmail('가나다라마바사아자차').split('@')[0].length <= 64);
  assert.equal(validateNickname('test용a'), null);
  assert.ok(validateNickname('a'));
  assert.ok(validateNickname('가나다라마바사아자차카'));
  assert.ok(validateNickname('a b!'));
  assert.equal(validatePin('012345'), null);
  assert.ok(validatePin('12345')); assert.ok(validatePin('12345a')); assert.ok(validatePin(''));
});
