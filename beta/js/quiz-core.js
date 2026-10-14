// 퀴즈 핵심 로직 (순수 함수, DOM/저장소 의존 없음) — node --test 로 단위 테스트함.

/** 시드 고정 난수 (테스트 재현용). 반환: () => [0,1) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (n, rng) => Math.floor(rng() * n);

/**
 * 출제 대상 정지문 목록 만들기.
 * filter: { subjectId?: string, sectionPrefix?: string[] } — sectionPrefix 는 section 경로의 앞부분과 일치해야 함.
 */
export function buildPool(dataset, filter = {}) {
  const out = [];
  for (const s of dataset.subjects) {
    if (filter.subjectId && s.id !== filter.subjectId) continue;
    for (const it of s.items) {
      const pre = filter.sectionPrefix;
      if (pre && pre.length && !pre.every((h, i) => it.section[i] === h)) continue;
      out.push({ ...it, subjectId: s.id });
    }
  }
  return out;
}

/** 섹션 트리(필터 UI용): [{path:[...], label, depth, count}] — depth 1~maxDepth */
export function listSections(dataset, subjectId, maxDepth = 2) {
  const map = new Map();
  for (const s of dataset.subjects) {
    if (subjectId && s.id !== subjectId) continue;
    for (const it of s.items) {
      for (let d = 1; d <= Math.min(maxDepth, it.section.length); d++) {
        const path = it.section.slice(0, d);
        const key = path.join('\u0001');
        if (!map.has(key)) map.set(key, { path, label: path[d - 1], depth: d, count: 0 });
        map.get(key).count++;
      }
    }
  }
  return [...map.values()];
}

/**
 * 문제 1개 뽑기 (규칙):
 *  1) 정지문을 균등 확률로 선택
 *  2) 50%: 정지문 그대로 (정답 O)
 *  3) 50%: 그 정지문의 오지문 중 하나를 균등 확률로 (정답 X)
 *     - 사용자가 숨긴 오지문(hidden: Set<오지문ID>)은 후보에서 제외
 *     - 남은 오지문이 없으면(원래 없거나 전부 숨김) 정지문을 그대로 출제 (정답 O)
 */
export function pickQuestion(pool, rng = Math.random, hidden = null, types = 'ox') {
  if (!pool.length) throw new Error('출제할 문항이 없습니다.');
  if (types === 'cloze') {
    // 단답형만: 단답형이 있는(숨기지 않은) 정지문 중 균등
    const cands = pool.filter((it) => hasVisibleCloze(it, hidden));
    if (!cands.length) throw new Error('출제할 단답형 문항이 없습니다.');
    return clozeQuestion(cands[randInt(cands.length, rng)]);
  }
  const item = pool[randInt(pool.length, rng)];
  if (types === 'mixed' && hasVisibleCloze(item, hidden) && rng() < 0.5) return clozeQuestion(item);
  return oxQuestion(item, rng, hidden);
}

/** 정지문 1개에서 OX 문제 만들기 (50% 정지문 / 50% 숨기지 않은 오지문 중 균등) */
function oxQuestion(item, rng, hidden) {
  const showWrong = rng() < 0.5;
  const candidates = visibleWrongs(item, hidden);
  if (showWrong && candidates.length) {
    const w = candidates[randInt(candidates.length, rng)];
    return {
      type: 'ox', itemId: item.id, statementId: w.id, no: w.no, kind: 'false', answer: 'X',
      text: w.text, original: item.answer, point: w.point || null, section: item.section,
    };
  }
  return {
    type: 'ox', itemId: item.id, statementId: item.id, no: String(item.no), kind: 'true', answer: 'O',
    text: item.answer, original: item.answer, point: null, section: item.section,
    fallback: showWrong, // 오지문이 없거나 전부 숨겨져 정지문으로 대체된 경우 true
  };
}

/** 단답형 문제 객체 (item.cloze = data/cloze.json 의 항목) */
function clozeQuestion(item) {
  const c = item.cloze;
  return {
    type: 'cloze', itemId: item.id, statementId: c.id, clozeId: c.id, no: String(item.no), kind: 'cloze',
    text: c.text, answers: c.answers, original: item.answer, point: null, section: item.section,
  };
}

/** 이 정지문에 사용자가 숨기지 않은 단답형이 있는지 */
export function hasVisibleCloze(item, hidden = null) {
  return !!(item.cloze && !(hidden && hidden.has(item.cloze.id)));
}

/** 출제 범위 안에서 실제로 낼 수 있는 정지문 수 (시작 화면 표시·버튼 비활성화용) */
export function poolCountForTypes(pool, types, hidden = null) {
  return types === 'cloze' ? pool.filter((it) => hasVisibleCloze(it, hidden)).length : pool.length;
}

export const isClozeId = (id) => /-c\d+$/.test(String(id || ''));

/** 숨기지 않은 오지문 목록 */
export function visibleWrongs(item, hidden = null) {
  const ws = item.wrongs || [];
  return hidden && hidden.size ? ws.filter((w) => !hidden.has(w.id)) : ws;
}

/**
 * 채점. choice: 'O' | 'X'
 * 반환 feedback:
 *   'correct'     — 정답
 *   'wrong-true'  — 정지문을 X 라고 답함 → '오답'만 표시
 *   'wrong-false' — 오지문을 O 라고 답함 → '오답' + 원래 정지문 표시
 */
export function grade(question, choice) {
  if (choice !== 'O' && choice !== 'X') throw new Error('choice must be O or X');
  const correct = choice === question.answer;
  const feedback = correct ? 'correct' : question.kind === 'true' ? 'wrong-true' : 'wrong-false';
  return { correct, feedback, showOriginal: feedback === 'wrong-false', choice };
}

/**
 * 시간 초과 채점: 항상 오답. 오답 규칙은 grade() 와 동일
 * (오지문이면 원래 정지문 표시, 정지문이면 '오답'만).
 */
export function gradeTimeout(question) {
  const feedback = question.kind === 'true' ? 'wrong-true' : 'wrong-false';
  return { correct: false, feedback, showOriginal: feedback === 'wrong-false', choice: null, timedOut: true };
}

// ------------------------------------------------------------ 단답형 (빈칸)
export const QUESTION_TYPE_OPTIONS = Object.freeze([
  { id: 'ox', label: 'OX만' },
  { id: 'cloze', label: '단답형만' },
  { id: 'mixed', label: '섞어서' },
]);
export const DEFAULT_QUESTION_TYPES = 'ox';
export const BLANK_DISPLAY_OPTIONS = Object.freeze([
  { id: 'count', label: '글자 수 표시' },
  { id: 'hidden', label: '글자 수 숨기기' },
]);
export const DEFAULT_BLANK_DISPLAY = 'count';
export const HIDDEN_BLANK = '＿＿＿＿＿';

/**
 * 채점용 정규화: NFC → 모든 공백 제거 → 가운뎃점류(ㆍ‧・∙)·쉼표·마침표·빗금을 '·' 로 통일.
 * 데이터의 정답(accept)은 빌드할 때 같은 규칙으로 이미 정규화되어 있음(tools/build_cloze.py norm).
 * 따라서 띄어쓰기만 다른 답은 모두 정답. 조사·어미 차이는 인정하지 않음(엄격).
 */
export function normalizeAnswer(s) {
  return String(s ?? '').normalize('NFC').replace(/\s+/g, '').replace(/[ㆍ‧・∙,，/.]/g, '·');
}

/** 템플릿 '…법원에 {{0}}을 …' → [{ text }, { blank: 0 }, { text }] */
export function clozeSegments(template) {
  const out = [];
  const re = /\{\{(\d+)\}\}/g;
  let pos = 0, m;
  while ((m = re.exec(template))) {
    if (m.index > pos) out.push({ text: template.slice(pos, m.index) });
    out.push({ blank: Number(m[1]) });
    pos = m.index + m[0].length;
  }
  if (pos < template.length) out.push({ text: template.slice(pos) });
  return out;
}

/**
 * 빈칸 표시. 'count': 정답 글자마다 O 하나(공백은 세지 않고 그 자리에 공백을 그대로 둠: '변론 집중' → 'OO OO').
 * 'hidden': 길이와 관계없이 고정 폭 '＿＿＿＿＿'.
 */
export function blankMask(answer, display = DEFAULT_BLANK_DISPLAY) {
  if (display === 'hidden') return HIDDEN_BLANK;
  return String(answer.canonical).trim().replace(/\s+/g, ' ').replace(/\S/g, 'O');
}

/** 문제 문장 (빈칸을 마스크로 바꾼 문자열). 같은 답이 여러 번 나오면 모든 자리가 같은 마스크 */
export function renderCloze(question, display = DEFAULT_BLANK_DISPLAY) {
  return clozeSegments(question.text).map((s) => ('blank' in s ? blankMask(question.answers[s.blank], display) : s.text)).join('');
}

/** 정답을 채운 원문 조각 (피드백에서 정답 부분 강조용): [{ text, changed }] */
export function clozeAnswerSegments(question) {
  return clozeSegments(question.text).map((s) => ('blank' in s
    ? { text: question.answers[s.blank].canonical, changed: true } : { text: s.text, changed: false }));
}

/**
 * 단답형 채점. inputs[i] = i번째 빈칸 입력. 빈칸마다 정규화한 입력이 accept 목록 중 하나와 같으면 정답,
 * 모든 빈칸이 맞아야 문항 정답.
 */
export function gradeCloze(question, inputs) {
  const blanks = question.answers.map((a, i) => {
    const input = String((inputs || [])[i] ?? '');
    const n = normalizeAnswer(input);
    return { input, correct: n.length > 0 && a.accept.includes(n) };
  });
  const correct = blanks.length > 0 && blanks.every((b) => b.correct);
  return {
    correct, feedback: correct ? 'correct' : 'wrong-cloze', showOriginal: !correct, choice: null,
    blanks, userText: blanks.map((b) => b.input.trim()).join(' / '),
  };
}

/** 단답형 시간 초과 / '모르겠어요' = 오답 */
export function gradeClozeGiveUp(question, { timedOut = false } = {}) {
  return {
    correct: false, feedback: 'wrong-cloze', showOriginal: true, choice: null,
    blanks: question.answers.map(() => ({ input: '', correct: false })), userText: '',
    ...(timedOut ? { timedOut: true } : { gaveUp: true }),
  };
}

/** '정답으로 인정' — 오답 결과를 정답으로 바꿈 (overridden 표시). 시간 초과는 인정 대상 아님 */
export function overrideResult(result) {
  if (result.correct || result.timedOut) return result;
  return { ...result, correct: true, feedback: 'correct', showOriginal: false, overridden: true };
}

/** 문제 유형에 따라 고를 수 있는 제한 시간 (60초는 단답형이 포함될 때만) */
export function timerOptionsFor(types) {
  return TIMER_OPTIONS.filter((o) => !o.clozeOnly || types !== 'ox');
}

/** 피드백 문구 (UI 표시용, 테스트 가능하도록 여기 둠) */
export function feedbackText(result) {
  return {
    title: result.correct ? '정답입니다' : '오답입니다',
    label: result.timedOut ? '시간 초과' : '',
  };
}

// ------------------------------------------------------------ 문항당 제한 시간 옵션
// 옵션 추가는 이 배열에만 하면 됨 (seconds: 0 = 무제한, 타이머 UI 없음). id 는 localStorage 에 저장되므로 바꾸지 말 것.
export const TIMER_OPTIONS = Object.freeze([
  { id: 'none', label: '무제한', seconds: 0 },
  { id: '10s', label: '10초', seconds: 10 },
  { id: '30s', label: '30초', seconds: 30 },
  { id: '60s', label: '60초', seconds: 60, clozeOnly: true }, // 입력이 필요한 단답형용
]);
export const DEFAULT_TIMER_ID = 'none';
export function getTimerOption(id, types = 'mixed') {
  return timerOptionsFor(types).find((o) => o.id === id) || TIMER_OPTIONS.find((o) => o.id === DEFAULT_TIMER_ID);
}

/** 라운드 상태 (불변 객체로 다룸) */
export function newRound(size, meta = {}) {
  const n = Math.max(1, Math.floor(size));
  return { size: n, answered: [], startedAt: Date.now(), ...meta };
}
export function recordAnswer(round, question, result) {
  return {
    ...round,
    answered: [...round.answered, {
      statementId: question.statementId, itemId: question.itemId, kind: question.kind, type: question.type || 'ox',
      choice: result.choice, correct: result.correct, timedOut: !!result.timedOut, overridden: !!result.overridden,
      ms: result.ms ?? null, at: Date.now(),
    }],
  };
}
export const isRoundOver = (round) => round.answered.length >= round.size;
export function roundSummary(round) {
  const attempted = round.answered.length;
  const correct = round.answered.filter((a) => a.correct).length;
  const timeouts = round.answered.filter((a) => a.timedOut).length;
  const by = (t) => {
    const xs = round.answered.filter((a) => (a.type || 'ox') === t);
    return { attempted: xs.length, correct: xs.filter((a) => a.correct).length };
  };
  const overrides = round.answered.filter((a) => a.overridden).length;
  return { attempted, correct, wrong: attempted - correct, timeouts, rate: attempted ? correct / attempted : 0,
    ox: by('ox'), cloze: by('cloze'), overrides };
}

export const clampRoundSize = (n, min = 10, max = 20, dflt = 15) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
};

// ------------------------------------------------------------ 간단 diff (단어 → 글자 2단계)
function tokenize(s) {
  return s.match(/\s+|[^\s]+/g) || [];
}
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push(['eq', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['del', a[i]]); i++; }
    else { ops.push(['ins', b[j]]); j++; }
  }
  while (i < n) ops.push(['del', a[i++]]);
  while (j < m) ops.push(['ins', b[j++]]);
  return ops;
}
function merge(ops) {
  const out = [];
  for (const [t, s] of ops) {
    if (out.length && out[out.length - 1].type === t) out[out.length - 1].text += s;
    else out.push({ type: t, text: s });
  }
  return out;
}
/**
 * from(오지문) → to(정지문) diff. 반환 [{type:'eq'|'del'|'ins', text}]
 * 'ins' = 정지문에만 있는 부분(하이라이트 대상), 'del' = 오지문에만 있던 부분.
 * 단어 단위 LCS 후, 바뀐 단어 덩어리는 글자 단위로 한 번 더 다듬음(조사 차이 등).
 */
export function diffStatements(from, to) {
  const ops = merge(lcsDiff(tokenize(from), tokenize(to)));
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const cur = ops[k], nxt = ops[k + 1];
    if (cur.type === 'del' && nxt && nxt.type === 'ins' && cur.text.length + nxt.text.length < 400) {
      for (const seg of merge(lcsDiff([...cur.text], [...nxt.text]))) out.push(seg);
      k++;
    } else out.push(cur);
  }
  return out;
}

/**
 * 정지문(to) 만 화면에 보여주면서, 오지문(from)과 다른 부분을 표시하기 위한 조각.
 * 반환 [{text, changed:boolean}] — 이어 붙이면 정확히 to 가 됨.
 * 바뀐 조각 사이의 공백 또는 1글자짜리 공통 조각은 읽기 쉽게 changed 로 흡수.
 */
export function highlightOriginal(from, to) {
  const segs = diffStatements(from, to).filter((s) => s.type !== 'del')
    .map((s) => ({ text: s.text, changed: s.type === 'ins' }));
  for (let k = 1; k < segs.length - 1; k++) {
    if (!segs[k].changed && (segs[k].text.length === 1 || segs[k].text.trim() === '') &&
        segs[k - 1].changed && segs[k + 1].changed) segs[k].changed = true;
  }
  const out = [];
  for (const s of segs) {
    if (out.length && out[out.length - 1].changed === s.changed) out[out.length - 1].text += s.text;
    else out.push({ ...s });
  }
  return out;
}

// ------------------------------------------------------------ 오답노트 (서버 record_attempt 함수와 같은 규칙)
// 묶음 단위 = 정지문(item). 정지문이든 그 오지문이든 틀리면 해당 정지문이 오답노트에 들어감.
// 오답노트 모드에서 WRONG_NOTE_CLEAR_STREAK 번 연속으로 맞히면 오답노트에서 빠짐(cleared).
// 어디서든 다시 틀리면 연속 정답 수가 0 이 되고 다시 활성화됨.
export const WRONG_NOTE_CLEAR_STREAK = 2;

/**
 * 오답노트 항목 1개 갱신 (순수 함수). note 가 없으면 null 로 전달.
 * attempt: { itemId, correct, mode: 'normal'|'wrongnote', variantId|null, at: ISO }
 * 반환: 새 note 객체 또는 (변화 없음이면) 기존 note 그대로 / null
 */
export function applyWrongNote(note, attempt, clearStreak = WRONG_NOTE_CLEAR_STREAK) {
  const at = attempt.at || new Date().toISOString();
  if (!attempt.correct) {
    return {
      item_id: attempt.itemId,
      wrong_count: (note?.wrong_count || 0) + 1,
      last_wrong_at: at,
      correct_streak: 0,
      cleared: false,
      cleared_at: null,
      last_variant_id: attempt.variantId ?? null,
      dismissed: false,
      dismissed_at: null,
    };
  }
  if (attempt.mode === 'wrongnote' && note && !note.cleared) {
    const streak = note.correct_streak + 1;
    const cleared = streak >= Math.max(1, clearStreak);
    return { ...note, correct_streak: streak, cleared, cleared_at: cleared ? at : null };
  }
  return note ?? null;
}

/** 활성(아직 안 빠진) 오답노트 항목, 최근 틀린 순 */
export function activeWrongNotes(notes) {
  return Object.values(notes || {}).filter((n) => n && !n.cleared)
    .sort((a, b) => String(b.last_wrong_at).localeCompare(String(a.last_wrong_at)));
}

/** 오답노트 모드 출제 풀: 활성 오답노트 항목 중 현재 데이터셋에 있는 정지문만 */
export function buildWrongNotePool(dataset, notes) {
  const active = new Set(activeWrongNotes(notes).map((n) => n.item_id));
  return buildPool(dataset).filter((it) => active.has(it.id));
}

/** 오답노트 라운드 길이 = min(설정값, 항목 수). 항목이 0 이면 0 (시작 불가) */
export const wrongNoteRoundSize = (requested, count) => Math.max(0, Math.min(requested, count));

/** 오지문/단답형 ID → 객체 찾기 (오답노트 화면 표시용). 단답형이면 { id, kind:'cloze', cloze } */
export function findVariant(item, variantId) {
  if (!variantId) return null;
  if (isClozeId(variantId)) return item.cloze && item.cloze.id === variantId ? { id: variantId, kind: 'cloze', cloze: item.cloze } : null;
  return (item.wrongs || []).find((w) => w.id === variantId) || null;
}

/** 사용자가 오답노트에서 직접 삭제 (서버 dismiss_wrong_note 와 같은 규칙). 다시 틀리면 applyWrongNote 가 되살림 */
export function dismissWrongNote(note, at = new Date().toISOString()) {
  if (!note) return null;
  return { ...note, cleared: true, dismissed: true, dismissed_at: at, correct_streak: 0 };
}

/**
 * 삭제 확인창에 보여 줄 '틀렸던 오지문' 목록 (최근 것부터, 중복 제거, 이미 숨긴 것·데이터에 없는 것 제외).
 * attempts: [{ variant_id, correct, created_at }] (해당 정지문의 응답들), note.last_variant_id 도 포함.
 */
export function missedVariantsForNote(item, note, attempts = [], hidden = null) {
  const ids = [];
  const seen = new Set();
  const push = (id) => { if (id && !seen.has(id)) { seen.add(id); ids.push(id); } };
  push(note?.last_variant_id);
  [...attempts].filter((a) => a && !a.correct && a.variant_id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .forEach((a) => push(a.variant_id));
  return ids.map((id) => findVariant(item, id)).filter((v) => v && !(hidden && hidden.has(v.id)));
}

/** data/cloze.json 을 정지문에 붙임 (item.cloze). 반환: 붙인 개수 */
export function attachCloze(dataset, clozeData) {
  const byItem = new Map((clozeData?.items || []).map((c) => [c.item_id, c]));
  let n = 0;
  for (const s of dataset.subjects) for (const it of s.items) {
    const c = byItem.get(it.id);
    if (c) { it.cloze = c; n++; } else delete it.cloze;
  }
  return n;
}
