// UI 계층: DOM 조작과 화면 전환만 담당. 출제/채점 규칙은 quiz-core.js, 저장은 storage.js.
import {
  buildPool, listSections, pickQuestion, grade, newRound, recordAnswer,
  isRoundOver, roundSummary, clampRoundSize, highlightOriginal,
  gradeTimeout, feedbackText, TIMER_OPTIONS, DEFAULT_TIMER_ID, getTimerOption,
} from './quiz-core.js';
import { createCountdown } from './timer.js';
import { LocalProgressStore } from './storage.js';

const DATA_URL = 'data/questions.json';
const $ = (id) => document.getElementById(id);

// 저장소 교체 지점: 백엔드 도입 시 여기서 다른 구현을 반환하면 됨.
function createStore() { return new LocalProgressStore(); }

const state = {
  data: null,
  store: createStore(),
  settings: { subjectId: null, sectionKey: '', roundSize: 15, timerId: DEFAULT_TIMER_ID },
  pool: [],
  round: null,
  question: null,
  answered: false,
  timer: null, // 현재 문항의 카운트다운 (무제한이면 null)
};

// ------------------------------------------------------------------ 공통
function show(screen) {
  for (const el of document.querySelectorAll('.screen')) el.classList.toggle('active', el.id === `screen-${screen}`);
  window.scrollTo(0, 0);
}
const SEP = '\u0001';
const sectionPrefixOf = (key) => (key ? key.split(SEP) : []);
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ 시작 화면
function fillSubjects() {
  const sel = $('subject-select');
  sel.innerHTML = state.data.subjects.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  $('subject-field').hidden = state.data.subjects.length < 2;
  if (!state.data.subjects.some((s) => s.id === state.settings.subjectId)) state.settings.subjectId = state.data.subjects[0].id;
  sel.value = state.settings.subjectId;
}

function fillSections() {
  const sel = $('section-select');
  const secs = listSections(state.data, state.settings.subjectId, 2);
  const total = buildPool(state.data, { subjectId: state.settings.subjectId }).length;
  sel.innerHTML = `<option value="">전체 (${total}문항)</option>` + secs.map((s) => {
    const indent = s.depth > 1 ? '\u00a0\u00a0\u00a0└ ' : '';
    return `<option value="${escapeHtml(s.path.join(SEP))}">${indent}${escapeHtml(s.label)} (${s.count})</option>`;
  }).join('');
  if (![...sel.options].some((o) => o.value === state.settings.sectionKey)) state.settings.sectionKey = '';
  sel.value = state.settings.sectionKey;
}

function fillTimerOptions() {
  const box = $('timer-options');
  box.innerHTML = TIMER_OPTIONS.map((o) => `
    <label class="seg"><input type="radio" name="timer" value="${o.id}"${o.id === state.settings.timerId ? ' checked' : ''} />
    <span>${escapeHtml(o.label)}</span></label>`).join('');
}

function updatePoolInfo() {
  state.pool = buildPool(state.data, { subjectId: state.settings.subjectId, sectionPrefix: sectionPrefixOf(state.settings.sectionKey) });
  const wrongs = state.pool.reduce((n, it) => n + it.wrongs.length, 0);
  $('pool-info').textContent = `출제 범위: 정지문 ${state.pool.length}개 · 오지문 ${wrongs}개`;
  const subj = state.data.subjects.find((s) => s.id === state.settings.subjectId);
  $('subject-title').textContent = subj ? subj.title || subj.name : '';
}

async function renderHistory() {
  const p = await state.store.load();
  const list = $('history-list');
  const recent = p.rounds.slice(-5).reverse();
  list.innerHTML = recent.map((r) => {
    const d = new Date(r.endedAt);
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `<li><span>${when}</span><b>${r.correct} / ${r.attempted}</b></li>`;
  }).join('');
  $('history-empty').hidden = recent.length > 0;
  $('reset-btn').hidden = recent.length === 0;
}

function stopTimer() {
  if (state.timer) state.timer.stop();
  state.timer = null;
}

function renderTimer(remainingMs, totalMs) {
  const sec = Math.ceil(remainingMs / 1000);
  $('timer-text').textContent = `${sec}초`;
  $('timer-bar').style.transform = `scaleX(${totalMs ? remainingMs / totalMs : 0})`;
  $('timer').classList.toggle('urgent', remainingMs <= 3000);
}

function startQuestionTimer() {
  stopTimer();
  const opt = getTimerOption(state.round.timerId);
  $('timer').hidden = !opt.seconds;
  if (!opt.seconds) return;
  const q = state.question;
  state.timer = createCountdown({
    seconds: opt.seconds,
    onTick: renderTimer,
    onExpire: () => { if (state.question === q && !state.answered) showResult({ ...gradeTimeout(q), ms: opt.seconds * 1000 }); },
  });
  state.timer.start();
}

function goHome() {
  stopTimer();
  if ($('result-dialog').open) $('result-dialog').close();
  state.round = null;
  renderHistory();
  show('start');
}

// ------------------------------------------------------------------ 퀴즈 진행
function startRound() {
  if (!state.pool.length) { alert('선택한 범위에 문항이 없습니다.'); return; }
  stopTimer();
  state.round = newRound(state.settings.roundSize, {
    subjectId: state.settings.subjectId, sectionKey: state.settings.sectionKey, dataVersion: state.data.version,
    timerId: getTimerOption(state.settings.timerId).id,
  });
  show('quiz');
  nextQuestion();
}

function nextQuestion() {
  if (isRoundOver(state.round)) { finishRound(); return; }
  state.question = pickQuestion(state.pool);
  state.answered = false;
  const q = state.question;
  const n = state.round.answered.length + 1;
  $('progress-text').textContent = `${n} / ${state.round.size}`;
  $('progress-bar').style.width = `${((n - 1) / state.round.size) * 100}%`;
  $('q-section').textContent = q.section.join(' › ');
  $('q-text').textContent = q.text;
  $('feedback').hidden = true;
  $('next-btn').hidden = true;
  for (const b of document.querySelectorAll('.btn.ox')) { b.disabled = false; b.classList.remove('chosen'); }
  $('ox-buttons').hidden = false;
  startQuestionTimer(); // 문제가 화면에 표시된 뒤에 시작
}

function answer(choice) {
  if (state.answered || !state.question) return;
  let ms = null;
  if (state.timer) {
    const inTime = state.timer.stop(); // 만료 후 늦은 탭이면 false → 무시 (만료 처리는 onExpire 가 함)
    if (!inTime) return;
    ms = state.timer.elapsedMs();
  }
  showResult({ ...grade(state.question, choice), ms });
}

/** 채점 결과 표시 (사용자 응답 / 시간 초과 공통). 이 화면에서는 타이머가 돌지 않음. */
function showResult(res) {
  if (state.answered) return;
  state.answered = true;
  if (state.timer && state.timer.status === 'running') state.timer.stop();
  state.timer = null; // 피드백 화면에선 타이머 없음 (마지막 남은 시간 표시만 유지)
  const q = state.question;
  state.round = recordAnswer(state.round, q, res);
  state.store.recordAttempt(q, res);

  for (const b of document.querySelectorAll('.btn.ox')) {
    b.disabled = true;
    b.classList.toggle('chosen', b.dataset.choice === res.choice);
  }
  const fb = $('feedback');
  fb.className = `feedback ${res.correct ? 'ok' : 'ng'}`;
  const txt = feedbackText(res);
  $('fb-title').textContent = txt.title;
  $('fb-label').textContent = txt.label;
  $('fb-label').hidden = !txt.label;
  const orig = $('fb-original');
  orig.hidden = !res.showOriginal;
  if (res.showOriginal) {
    const segs = highlightOriginal(q.text, q.original);
    $('fb-original-text').innerHTML = segs
      .map((s) => (s.changed ? `<mark>${escapeHtml(s.text)}</mark>` : escapeHtml(s.text))).join('');
    const pt = $('fb-point');
    pt.hidden = !q.point;
    // 오지문이 단어를 '추가'한 경우 정지문 쪽엔 강조할 글자가 없으므로 변형 포인트를 펼쳐 보여줌
    pt.open = !segs.some((s) => s.changed);
    if (q.point) $('fb-point-text').textContent = `〔${q.point.type}〕 ${q.point.change}`;
  }
  fb.hidden = false;
  $('progress-bar').style.width = `${(state.round.answered.length / state.round.size) * 100}%`;
  $('ox-buttons').hidden = true;
  const next = $('next-btn');
  next.textContent = isRoundOver(state.round) ? '결과 보기' : '다음';
  next.hidden = false;
  next.focus({ preventScroll: true });
  fb.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function finishRound() {
  stopTimer();
  const sum = roundSummary(state.round);
  state.store.saveRound({
    startedAt: new Date(state.round.startedAt).toISOString(), size: state.round.size,
    attempted: sum.attempted, correct: sum.correct, timeouts: sum.timeouts, timerId: state.round.timerId,
    subjectId: state.round.subjectId,
    sectionKey: state.round.sectionKey, dataVersion: state.round.dataVersion,
  });
  $('result-correct').textContent = sum.correct;
  $('result-attempted').textContent = sum.attempted;
  $('result-rate').textContent = `정답률 ${Math.round(sum.rate * 100)}%` + (sum.timeouts ? ` · 시간 초과 ${sum.timeouts}` : '');
  const dlg = $('result-dialog');
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

// ------------------------------------------------------------------ 이벤트
function bind() {
  $('subject-select').addEventListener('change', (e) => {
    state.settings.subjectId = e.target.value; state.settings.sectionKey = '';
    fillSections(); updatePoolInfo(); state.store.savePrefs(state.settings);
  });
  $('section-select').addEventListener('change', (e) => {
    state.settings.sectionKey = e.target.value; updatePoolInfo(); state.store.savePrefs(state.settings);
  });
  $('size-range').addEventListener('input', (e) => {
    state.settings.roundSize = clampRoundSize(e.target.value);
    $('size-value').textContent = state.settings.roundSize;
  });
  $('size-range').addEventListener('change', () => state.store.savePrefs(state.settings));
  $('timer-options').addEventListener('change', (e) => {
    if (e.target.name !== 'timer') return;
    state.settings.timerId = getTimerOption(e.target.value).id;
    state.store.savePrefs(state.settings);
  });
  // 탭이 다시 보이면 즉시 남은 시간 재계산 (숨겨진 동안 만료됐으면 바로 시간 초과 처리)
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.timer) state.timer.check(); });
  $('start-form').addEventListener('submit', (e) => { e.preventDefault(); startRound(); });
  for (const b of document.querySelectorAll('.btn.ox')) b.addEventListener('click', () => answer(b.dataset.choice));
  $('next-btn').addEventListener('click', nextQuestion);
  $('quit-btn').addEventListener('click', () => {
    if (!state.round || state.round.answered.length === 0 || confirm('이번 라운드를 그만둘까요? (푼 문항의 오답 기록은 남습니다)')) goHome();
  });
  $('again-btn').addEventListener('click', () => { $('result-dialog').close(); startRound(); });
  $('home-btn').addEventListener('click', goHome);
  $('result-dialog').addEventListener('cancel', (e) => { e.preventDefault(); goHome(); });
  $('reset-btn').addEventListener('click', async () => {
    if (confirm('이 기기에 저장된 풀이 기록을 모두 지울까요?')) { await state.store.reset(); renderHistory(); }
  });
  // 키보드(데스크톱): O/X 또는 ←/→, Enter/Space = 다음
  document.addEventListener('keydown', (e) => {
    if (!$('screen-quiz').classList.contains('active') || $('result-dialog').open) return;
    const k = e.key.toLowerCase();
    if (!state.answered && (k === 'o' || k === 'arrowleft')) answer('O');
    else if (!state.answered && (k === 'x' || k === 'arrowright')) answer('X');
    else if (state.answered && (k === 'enter' || k === ' ') && document.activeElement !== $('next-btn')) { e.preventDefault(); nextQuestion(); }
  });
}

// ------------------------------------------------------------------ 시작
async function init() {
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (e) {
    $('screen-loading').innerHTML = `<div class="center">문항 데이터를 불러오지 못했습니다.<br><span class="small muted">${escapeHtml(String(e))}</span></div>`;
    return;
  }
  const prefs = await state.store.getPrefs();
  state.settings = {
    subjectId: prefs.subjectId || state.data.subjects[0].id,
    sectionKey: prefs.sectionKey || '',
    roundSize: clampRoundSize(prefs.roundSize ?? 15),
    timerId: getTimerOption(prefs.timerId).id,
  };
  $('size-range').value = state.settings.roundSize;
  $('size-value').textContent = state.settings.roundSize;
  fillSubjects(); fillSections(); fillTimerOptions(); updatePoolInfo();
  $('data-version').textContent = `데이터 ${state.data.version} · ${state.data.generatedAt.slice(0, 10)}${state.store.volatile ? ' · ⚠ 기록 저장 불가(개인정보 보호 모드)' : ''}`;
  bind();
  await renderHistory();
  show('start');
  // 디버그/스크린샷용 훅 (UI 동작에는 영향 없음)
  window.__oxquiz = { state, answer, nextQuestion, startRound };
}

init();
