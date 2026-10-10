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
 *     - 오지문이 없으면 정지문을 그대로 출제 (정답 O)
 */
export function pickQuestion(pool, rng = Math.random) {
  if (!pool.length) throw new Error('출제할 문항이 없습니다.');
  const item = pool[randInt(pool.length, rng)];
  const showWrong = rng() < 0.5;
  if (showWrong && item.wrongs && item.wrongs.length) {
    const w = item.wrongs[randInt(item.wrongs.length, rng)];
    return {
      itemId: item.id, statementId: w.id, no: w.no, kind: 'false', answer: 'X',
      text: w.text, original: item.answer, point: w.point || null, section: item.section,
    };
  }
  return {
    itemId: item.id, statementId: item.id, no: String(item.no), kind: 'true', answer: 'O',
    text: item.answer, original: item.answer, point: null, section: item.section,
    fallback: showWrong, // 오지문이 없어 정지문으로 대체된 경우 true
  };
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
]);
export const DEFAULT_TIMER_ID = 'none';
export function getTimerOption(id) {
  return TIMER_OPTIONS.find((o) => o.id === id) || TIMER_OPTIONS.find((o) => o.id === DEFAULT_TIMER_ID);
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
      statementId: question.statementId, itemId: question.itemId, kind: question.kind,
      choice: result.choice, correct: result.correct, timedOut: !!result.timedOut,
      ms: result.ms ?? null, at: Date.now(),
    }],
  };
}
export const isRoundOver = (round) => round.answered.length >= round.size;
export function roundSummary(round) {
  const attempted = round.answered.length;
  const correct = round.answered.filter((a) => a.correct).length;
  const timeouts = round.answered.filter((a) => a.timedOut).length;
  return { attempted, correct, wrong: attempted - correct, timeouts, rate: attempted ? correct / attempted : 0 };
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
