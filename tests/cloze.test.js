// 단답형(빈칸) 순수 로직 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mulberry32, buildPool, pickQuestion, normalizeAnswer, clozeSegments, blankMask, renderCloze,
  clozeAnswerSegments, gradeCloze, gradeClozeGiveUp, overrideResult, timerOptionsFor, getTimerOption,
  HIDDEN_BLANK, hasVisibleCloze, poolCountForTypes, isClozeId, findVariant, applyWrongNote,
  missedVariantsForNote, newRound, recordAnswer, roundSummary, attachCloze, activeWrongNotes,
} from '../js/quiz-core.js';

const near = (a, e, tol, msg) => assert.ok(Math.abs(a - e) <= tol, `${msg}: ${a.toFixed(4)} vs ${e} (±${tol})`);

const C1 = { id: 's-0001-c1', item_id: 's-0001', text: '소를 제기하려는 자는 법원에 {{0}}을 제출하여야 한다.',
  answers: [{ canonical: '소장', accept: ['소장'], len: 2 }] };
const C2 = { id: 's-0002-c1', item_id: 's-0002', text: '{{0}}이란 특정 소송물에 대한 판결절차가 계속된 상태이고 {{0}}은 송달로 생긴다.',
  answers: [{ canonical: '소송계속', accept: ['소송계속'], len: 4 }] };
const C3 = { id: 's-0003-c1', item_id: 's-0003', text: '{{0}}에 대한 {{1}}의 효력.',
  answers: [{ canonical: '변론 집중', accept: ['변론집중'], len: 4 }, { canonical: '주장·증명', accept: ['주장·증명', '주장증명'], len: 5 }] };

function fixture() {
  const ds = { subjects: [{ id: 's', name: 'S', items: [
    { id: 's-0001', no: 1, section: ['A'], answer: '소를 제기하려는 자는 법원에 소장을 제출하여야 한다.', wrongs: [{ id: 's-0001-1', no: '1-1', text: '…피고에게 소장을…' }] },
    { id: 's-0002', no: 2, section: ['A'], answer: 'x', wrongs: [{ id: 's-0002-1', no: '2-1', text: 'y' }, { id: 's-0002-2', no: '2-2', text: 'z' }] },
    { id: 's-0003', no: 3, section: ['B'], answer: 'w', wrongs: [] },
    { id: 's-0004', no: 4, section: ['B'], answer: '단답형 없음', wrongs: [{ id: 's-0004-1', no: '4-1', text: 'v' }] },
  ] }] };
  attachCloze(ds, { items: [C1, C2, C3] });
  return ds;
}

test('정규화: 공백은 모두 무시, 가운뎃점·쉼표·마침표·빗금 통일, NFC', () => {
  assert.equal(normalizeAnswer('  소송 계속 '), '소송계속');
  assert.equal(normalizeAnswer('소\t송\n계\u3000속'), '소송계속', '탭·줄바꿈·전각 공백도 제거');
  assert.equal(normalizeAnswer('주장ㆍ증명'), '주장·증명');
  assert.equal(normalizeAnswer('주장, 증명'), '주장·증명');
  assert.equal(normalizeAnswer('주장/증명'), '주장·증명');
  assert.equal(normalizeAnswer('소장'.normalize('NFD')), '소장', '자모 분리(NFD) 입력도 같게');
  assert.equal(normalizeAnswer(null), '');
});

test('채점: 띄어쓰기만 다른 답은 정답 (저장된 정답은 공백 없음)', () => {
  const q = { answers: C2.answers };
  for (const s of ['소송계속', '소송 계속', ' 소 송 계 속 ', '소송\u00a0계속']) assert.equal(gradeCloze(q, [s]).correct, true, s);
  const q3 = { answers: C3.answers };
  assert.equal(gradeCloze(q3, ['변론집중', '주장 · 증명']).correct, true, '정답 표기에 공백이 있어도 붙여 쓰면 정답');
  assert.equal(gradeCloze(q3, ['변 론 집 중', '주장증명']).correct, true, 'accept 변형');
});

test('채점: 엄격 — 조사·다른 단어·빈 입력은 오답, 빈칸이 여러 개면 모두 맞아야 함', () => {
  const q = { answers: C1.answers };
  assert.equal(gradeCloze(q, ['소장을']).correct, false, '조사 붙이면 오답');
  assert.equal(gradeCloze(q, ['답변서']).correct, false);
  assert.equal(gradeCloze(q, ['   ']).correct, false, '빈 입력');
  assert.equal(gradeCloze(q, []).correct, false);
  const r = gradeCloze({ answers: C3.answers }, ['변론 집중', '주장']);
  assert.equal(r.correct, false);
  assert.deepEqual(r.blanks.map((b) => b.correct), [true, false]);
  assert.equal(r.userText, '변론 집중 / 주장');
  assert.equal(r.feedback, 'wrong-cloze');
  assert.equal(gradeCloze(q, ['소장']).feedback, 'correct');
});

test('빈칸 표시: 글자 수 표시(공백은 그대로)·글자 수 숨기기(고정 폭)', () => {
  assert.equal(blankMask(C1.answers[0], 'count'), 'OO');
  assert.equal(blankMask(C2.answers[0], 'count'), 'OOOO');
  assert.equal(blankMask(C3.answers[0], 'count'), 'OO OO', '공백은 O로 세지 않고 자리에 공백');
  assert.equal(blankMask(C3.answers[1], 'count'), 'OOOOO', '가운뎃점도 한 글자');
  for (const a of [C1.answers[0], C2.answers[0], C3.answers[0]]) assert.equal(blankMask(a, 'hidden'), HIDDEN_BLANK);
  assert.equal(renderCloze(C1, 'count'), '소를 제기하려는 자는 법원에 OO을 제출하여야 한다.', '조사는 원문 그대로');
  assert.equal(renderCloze(C2, 'count'), 'OOOO이란 특정 소송물에 대한 판결절차가 계속된 상태이고 OOOO은 송달로 생긴다.', '같은 답의 모든 자리를 가림');
  assert.equal(renderCloze(C1, 'hidden'), `소를 제기하려는 자는 법원에 ${HIDDEN_BLANK}을 제출하여야 한다.`);
  assert.deepEqual(clozeSegments('{{0}}과 {{1}}'), [{ blank: 0 }, { text: '과 ' }, { blank: 1 }]);
  assert.equal(clozeAnswerSegments(C1).map((s) => s.text).join(''), '소를 제기하려는 자는 법원에 소장을 제출하여야 한다.');
  assert.deepEqual(clozeAnswerSegments(C1).filter((s) => s.changed).map((s) => s.text), ['소장']);
});

test('단답형만: 단답형이 있는 정지문 중 균등, 숨긴 단답형 제외', () => {
  const pool = buildPool(fixture());
  const rng = mulberry32(5); const c = {}; const N = 30000;
  for (let i = 0; i < N; i++) { const q = pickQuestion(pool, rng, null, 'cloze'); assert.equal(q.type, 'cloze'); c[q.itemId] = (c[q.itemId] || 0) + 1; }
  assert.equal(c['s-0004'], undefined, '단답형 없는 문항은 안 나옴');
  for (const id of ['s-0001', 's-0002', 's-0003']) near(c[id] / N, 1 / 3, 0.012, id);
  const hidden = new Set(['s-0002-c1']);
  for (let i = 0; i < 3000; i++) assert.notEqual(pickQuestion(pool, rng, hidden, 'cloze').itemId, 's-0002');
  assert.equal(poolCountForTypes(pool, 'cloze', hidden), 2);
  assert.equal(poolCountForTypes(pool, 'mixed', hidden), 4);
  assert.throws(() => pickQuestion(pool, rng, new Set(['s-0001-c1', 's-0002-c1', 's-0003-c1']), 'cloze'));
});

test('섞어서: 정지문 균등 → 단답형 있으면 50% 단답형 / 50% OX(그 안에서 기존 50/50)', () => {
  const pool = buildPool(fixture());
  const rng = mulberry32(9); const N = 80000; const s = {};
  for (let i = 0; i < N; i++) {
    const q = pickQuestion(pool, rng, null, 'mixed');
    const k = `${q.itemId}:${q.type === 'cloze' ? 'C' : q.answer}`; s[k] = (s[k] || 0) + 1;
  }
  const item = (id) => ['C', 'O', 'X'].reduce((a, t) => a + (s[`${id}:${t}`] || 0), 0);
  for (const id of ['s-0001', 's-0002', 's-0003', 's-0004']) near(item(id) / N, 0.25, 0.01, `${id} 선택 확률`);
  near(s['s-0001:C'] / item('s-0001'), 0.5, 0.015, 's-0001 단답형 비율');
  near(s['s-0001:O'] / item('s-0001'), 0.25, 0.015, 's-0001 정지문');
  near(s['s-0001:X'] / item('s-0001'), 0.25, 0.015, 's-0001 오지문');
  near(s['s-0003:C'] / item('s-0003'), 0.5, 0.015, '오지문 없는 문항: 단답형 50%');
  assert.equal(s['s-0003:X'], undefined, '오지문 없으면 X 없음');
  assert.equal(s['s-0004:C'], undefined, '단답형 없으면 OX만');
  near(s['s-0004:X'] / item('s-0004'), 0.5, 0.015, '단답형 없는 문항은 기존 50/50');
  // 단답형을 숨긴 문항은 섞어서 모드에서도 OX만
  const hidden = new Set(['s-0001-c1']);
  for (let i = 0; i < 2000; i++) { const q = pickQuestion(pool, rng, hidden, 'mixed'); if (q.itemId === 's-0001') assert.equal(q.type, 'ox'); }
});

test('OX만: 기존 동작과 완전히 같음 (같은 시드 → 같은 결과, type=ox)', () => {
  const pool = buildPool(fixture());
  const r1 = mulberry32(3), r2 = mulberry32(3);
  for (let i = 0; i < 500; i++) {
    const a = pickQuestion(pool, r1); const b = pickQuestion(pool, r2, null, 'ox');
    assert.deepEqual(a, b); assert.equal(a.type, 'ox');
  }
});

test('제한 시간: 60초는 단답형이 포함될 때만, 고를 수 없는 값이면 무제한', () => {
  assert.deepEqual(timerOptionsFor('ox').map((o) => o.id), ['none', '10s', '30s']);
  assert.deepEqual(timerOptionsFor('cloze').map((o) => o.id), ['none', '10s', '30s', '60s']);
  assert.deepEqual(timerOptionsFor('mixed').map((o) => o.id), ['none', '10s', '30s', '60s']);
  assert.equal(getTimerOption('60s', 'cloze').seconds, 60);
  assert.equal(getTimerOption('60s', 'ox').id, 'none');
  assert.equal(getTimerOption('30s', 'ox').seconds, 30);
});

test('시간 초과·모르겠어요 = 오답, 정답으로 인정 = overridden (시간 초과는 인정 불가)', () => {
  const q = { answers: C1.answers };
  const t = gradeClozeGiveUp(q, { timedOut: true });
  assert.equal(t.correct, false); assert.equal(t.timedOut, true);
  const g = gradeClozeGiveUp(q);
  assert.equal(g.gaveUp, true); assert.equal(g.correct, false);
  const w = gradeCloze(q, ['소장을']);
  const o = overrideResult(w);
  assert.equal(o.correct, true); assert.equal(o.overridden, true); assert.equal(o.userText, '소장을');
  assert.equal(overrideResult(t), t, '시간 초과는 그대로');
  const ok = gradeCloze(q, ['소장']);
  assert.equal(overrideResult(ok), ok);
});

test('라운드 요약: 유형별 개수·정답, 인정 횟수', () => {
  let r = newRound(3);
  r = recordAnswer(r, { statementId: 'a', itemId: 'a', kind: 'true', type: 'ox' }, { correct: true, choice: 'O' });
  r = recordAnswer(r, { statementId: 'b-c1', itemId: 'b', kind: 'cloze', type: 'cloze' }, { correct: false });
  r = recordAnswer(r, { statementId: 'c-c1', itemId: 'c', kind: 'cloze', type: 'cloze' }, { correct: true, overridden: true });
  const s = roundSummary(r);
  assert.deepEqual(s.ox, { attempted: 1, correct: 1 });
  assert.deepEqual(s.cloze, { attempted: 2, correct: 1 });
  assert.equal(s.overrides, 1);
  assert.equal(s.correct, 2);
});

test('오답노트: 단답형 오답도 정지문 단위로 모이고, 삭제 확인창에서 단답형 ID 를 찾음', () => {
  const ds = fixture(); const it = ds.subjects[0].items[0];
  assert.ok(isClozeId('s-0001-c1')); assert.ok(!isClozeId('s-0001-1')); assert.ok(!isClozeId(null));
  let n = applyWrongNote(null, { itemId: 's-0001', correct: false, mode: 'normal', variantId: 's-0001-c1', at: 't1' });
  assert.equal(n.last_variant_id, 's-0001-c1'); assert.equal(n.wrong_count, 1);
  n = applyWrongNote(n, { itemId: 's-0001', correct: false, mode: 'normal', variantId: 's-0001-1', at: 't2' });
  assert.equal(n.wrong_count, 2);
  assert.equal(activeWrongNotes({ 's-0001': n }).length, 1);
  assert.deepEqual(findVariant(it, 's-0001-c1'), { id: 's-0001-c1', kind: 'cloze', cloze: C1 });
  assert.equal(findVariant(it, 's-0002-c1'), null, '다른 문항 단답형 ID');
  const attempts = [
    { variant_id: 's-0001-c1', correct: false, created_at: '1' },
    { variant_id: 's-0001-1', correct: false, created_at: '2' },
  ];
  assert.deepEqual(missedVariantsForNote(it, n, attempts).map((v) => v.id), ['s-0001-1', 's-0001-c1']);
  assert.deepEqual(missedVariantsForNote(it, n, attempts, new Set(['s-0001-c1'])).map((v) => v.id), ['s-0001-1']);
  assert.ok(hasVisibleCloze(it)); assert.ok(!hasVisibleCloze(it, new Set(['s-0001-c1'])));
});

test('실제 데이터(data/cloze.json): 빈칸을 정답으로 채우면 정지문과 정확히 같고, 정답은 공백 없이 저장', () => {
  const qs = JSON.parse(readFileSync(new URL('../data/questions.json', import.meta.url)));
  const cz = JSON.parse(readFileSync(new URL('../data/cloze.json', import.meta.url)));
  const items = new Map(qs.subjects.flatMap((s) => s.items).map((i) => [i.id, i]));
  assert.ok(cz.items.length >= 600, `단답형 ${cz.items.length}개`);
  const ids = new Set();
  for (const c of cz.items) {
    const it = items.get(c.item_id);
    assert.ok(it, c.item_id);
    assert.equal(c.id, `${c.item_id}-c1`);
    assert.ok(!ids.has(c.id)); ids.add(c.id);
    assert.equal(clozeAnswerSegments(c).map((s) => s.text).join(''), it.answer, `${c.id} 원문 복원`);
    for (const a of c.answers) {
      assert.ok(a.accept.length >= 1);
      for (const x of a.accept) {
        assert.ok(!/\s/.test(x), `${c.id} accept 에 공백: "${x}"`);
        assert.equal(x, normalizeAnswer(x), `${c.id} accept 는 정규화된 형태`);
      }
      assert.equal(gradeCloze({ answers: [a] }, [a.canonical]).correct, true, `${c.id} 표시용 정답으로 정답 처리`);
      assert.ok(!/\d/.test(a.canonical) || /^\d+(일|주|월|개월|년)$/.test(a.canonical) || a.canonical === '제3채무자', `${c.id} 숫자 답 "${a.canonical}"`);
      // 정답 노출 방지: 빈칸을 뺀 나머지 문장에 정답이 그대로 보이지 않음
      const visible = normalizeAnswer(c.text.replace(/\{\{\d+\}\}/g, '|'));
      for (const x of a.accept) assert.ok(!visible.includes(x), `${c.id} 정답 "${x}" 노출`);
    }
  }
});
