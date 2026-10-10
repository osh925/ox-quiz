// UI 계층: DOM 조작과 화면 전환만 담당.
//   출제/채점/오답노트 규칙 → quiz-core.js (순수 함수)
//   서버 저장·인증 → supabase-store.js (SupabaseStore)
//   기기별 설정(문항 수·범위·타이머) → storage.js (LocalProgressStore.prefs)
import {
  buildPool, listSections, pickQuestion, grade, newRound, recordAnswer,
  isRoundOver, roundSummary, clampRoundSize, highlightOriginal,
  gradeTimeout, feedbackText, TIMER_OPTIONS, DEFAULT_TIMER_ID, getTimerOption,
  activeWrongNotes, buildWrongNotePool, wrongNoteRoundSize, findVariant, WRONG_NOTE_CLEAR_STREAK,
} from './quiz-core.js';
import { createCountdown } from './timer.js';
import { LocalProgressStore } from './storage.js';
import { SupabaseStore } from './supabase-store.js';

const DATA_URL = 'data/questions.json';
const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  itemsById: new Map(),
  store: new LocalProgressStore(),           // 기기별 설정(prefs)만
  server: new SupabaseStore({ onSyncChange: (n) => renderSyncBanner(n) }),
  mode: 'normal',                            // 'normal' | 'wrongnote'
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

function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderHistory() {
  const rounds = state.server.rounds;
  $('history-list').innerHTML = rounds.map((r) => {
    const tags = [r.mode === 'wrongnote' ? '<span class="tag">오답노트</span>' : '',
      r.timer_sec ? `<span class="tag">${r.timer_sec}초</span>` : ''].join('');
    return `<li><span>${fmtDate(r.finished_at || r.started_at)} ${tags}</span><b>${r.correct} / ${r.attempted}</b></li>`;
  }).join('');
  $('history-empty').hidden = rounds.length > 0;
}

function renderNotesCount() {
  const n = activeWrongNotes(state.server.notes).length;
  $('notes-count').textContent = n;
  $('notes-sub').textContent = n ? `${WRONG_NOTE_CLEAR_STREAK}번 연속 맞히면 빠져요` : '틀린 문항을 모아 다시 풀어요';
}

function renderHome() {
  $('user-nickname').textContent = state.server.profile?.nickname || '';
  renderHistory();
  renderNotesCount();
}

// 저장 대기 알림: 정상 전송 중의 잠깐(수백 ms) 대기는 표시하지 않고, 3초 넘게 남아 있을 때만 표시
let syncBannerTimer = null;
function renderSyncBanner(n) {
  const el = $('sync-banner');
  if (!el) return;
  clearTimeout(syncBannerTimer);
  if (!n) { el.hidden = true; el.textContent = ''; return; }
  const paint = () => {
    const left = state.server.pending;
    el.hidden = !left;
    el.textContent = left ? `⚠ 저장 대기 ${left}건 · 연결되면 자동으로 다시 보냅니다` : '';
  };
  if (!el.hidden) paint(); else syncBannerTimer = setTimeout(paint, 3000);
}

// ------------------------------------------------------------------ 로그인 / 가입
function setAuthTab(which) {
  const login = which === 'login';
  $('tab-login').classList.toggle('active', login); $('tab-login').setAttribute('aria-selected', String(login));
  $('tab-signup').classList.toggle('active', !login); $('tab-signup').setAttribute('aria-selected', String(!login));
  $('login-form').hidden = !login; $('signup-form').hidden = login;
  $('login-error').hidden = true; $('signup-error').hidden = true;
  (login ? $('login-username') : $('signup-username')).focus({ preventScroll: true });
}

function showAuth() {
  for (const id of ['login-pin', 'signup-pin', 'signup-pin2']) $(id).value = '';
  setAuthTab('login');
  show('auth');
}

async function handleAuthSubmit(e, kind) {
  e.preventDefault();
  const form = e.currentTarget;
  const errEl = $(`${kind}-error`);
  const btn = form.querySelector('button[type=submit]');
  errEl.hidden = true;
  const nick = $(`${kind}-username`).value;
  const pin = $(`${kind}-pin`).value;
  if (kind === 'signup' && pin !== $('signup-pin2').value) {
    errEl.textContent = 'PIN 확인이 일치하지 않습니다.'; errEl.hidden = false; return;
  }
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = kind === 'login' ? '로그인 중…' : '가입 중…';
  try {
    if (kind === 'login') await state.server.signIn(nick, pin);
    else await state.server.signUp(nick, pin);
    // 비밀번호 관리자가 "로그인 성공"으로 인식하도록: 폼을 숨기고(same-document) 주소 이력을 바꿈
    history.pushState({ screen: 'home' }, '', '#home');
    await enterHome();
  } catch (err) {
    errEl.textContent = err.message || String(err);
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function enterHome() {
  renderHome();
  show('start');
  const ok = await state.server.refresh();
  renderHome();
  if (!ok && state.server.lastError) console.warn('서버 동기화 실패', state.server.lastError);
}

async function logout() {
  const n = state.server.pending;
  if (n && !confirm(`아직 서버에 저장되지 않은 기록이 ${n}건 있습니다. 이 기기에 보관했다가 다음에 로그인하면 보냅니다. 로그아웃할까요?`)) return;
  stopTimer();
  await state.server.signOut();
  renderSyncBanner(0);
  history.replaceState(null, '', location.pathname + location.search);
  showAuth();
}

// ------------------------------------------------------------------ 오답노트 화면
function renderNotes() {
  const notes = activeWrongNotes(state.server.notes);
  const rows = notes.map((n) => ({ n, item: state.itemsById.get(n.item_id) })).filter((r) => r.item);
  $('notes-title-count').textContent = `(${rows.length})`;
  $('notes-empty').hidden = rows.length > 0;
  const size = wrongNoteRoundSize(state.settings.roundSize, rows.length);
  const timer = getTimerOption(state.settings.timerId);
  $('notes-help').textContent = rows.length
    ? `오답노트 모드에서 ${WRONG_NOTE_CLEAR_STREAK}번 연속 맞히면 빠집니다. 한 라운드 ${size}문항 · 제한 시간 ${timer.label} (처음 화면에서 변경)`
    : '';
  const start = $('notes-start');
  start.disabled = rows.length === 0;
  start.textContent = rows.length ? `오답노트로 풀기 (${size}문항)` : '오답노트가 비어 있어요';
  $('notes-list').innerHTML = rows.map(({ n, item }) => {
    const v = findVariant(item, n.last_variant_id);
    const missed = v
      ? `<p class="small muted">틀렸던 오지문 (바뀐 부분 강조)</p><p>${highlightOriginal(item.answer, v.text)
        .map((s) => (s.changed ? `<mark>${escapeHtml(s.text)}</mark>` : escapeHtml(s.text))).join('')}</p>`
        + (v.point ? `<p class="small muted">〔${escapeHtml(v.point.type)}〕 ${escapeHtml(v.point.change)}</p>` : '')
      : '<p class="small muted">정지문(옳은 지문)을 X로 답했거나 시간 초과로 틀렸어요.</p>';
    return `<li class="card note">
      <p class="section-path">${escapeHtml(item.section.join(' › '))}</p>
      <p class="note-text">${escapeHtml(item.answer)}</p>
      <p class="note-meta small muted">틀린 횟수 <b>${n.wrong_count}</b> · 마지막 ${fmtDate(n.last_wrong_at)} · 연속 정답 ${n.correct_streak}/${WRONG_NOTE_CLEAR_STREAK}</p>
      <details><summary>틀렸던 지문 보기</summary>${missed}</details>
    </li>`;
  }).join('');
}

function openNotes() {
  renderNotes();
  show('notes');
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
  state.mode = 'normal';
  renderHome();
  show('start');
}

// ------------------------------------------------------------------ 퀴즈 진행
function startRound(mode = state.mode) {
  let pool, size;
  if (mode === 'wrongnote') {
    pool = buildWrongNotePool(state.data, state.server.notes);
    size = wrongNoteRoundSize(state.settings.roundSize, pool.length);
    if (!size) { alert('오답노트가 비어 있어요.'); goHome(); return; }
  } else {
    pool = state.pool;
    size = state.settings.roundSize;
    if (!pool.length) { alert('선택한 범위에 문항이 없습니다.'); return; }
  }
  stopTimer();
  state.mode = mode;
  state.roundPool = pool; // 라운드 도중 오답노트에서 빠진 항목도 이번 라운드에서는 계속 출제 대상
  const timer = getTimerOption(state.settings.timerId);
  state.round = newRound(size, {
    id: state.server.newRoundId(), mode,
    subjectId: state.settings.subjectId, sectionKey: state.settings.sectionKey, dataVersion: state.data.version,
    timerId: timer.id,
  });
  state.server.startRound({ id: state.round.id, mode, timerSec: timer.seconds, total: size, startedAt: state.round.startedAt });
  $('mode-badge').hidden = mode !== 'wrongnote';
  show('quiz');
  nextQuestion();
}

function nextQuestion() {
  if (isRoundOver(state.round)) { finishRound(); return; }
  state.question = pickQuestion(state.roundPool);
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
  state.server.recordAttempt(q, res, { mode: state.round.mode, roundId: state.round.id });

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
  state.server.saveRound({
    id: state.round.id, mode: state.round.mode, timerSec: getTimerOption(state.round.timerId).seconds,
    total: state.round.size, attempted: sum.attempted, correct: sum.correct, timeouts: sum.timeouts,
    startedAt: state.round.startedAt,
  });
  $('result-title').textContent = state.round.mode === 'wrongnote' ? '오답노트 라운드 결과' : '라운드 결과';
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
  $('start-form').addEventListener('submit', (e) => { e.preventDefault(); startRound('normal'); });
  for (const b of document.querySelectorAll('.btn.ox')) b.addEventListener('click', () => answer(b.dataset.choice));
  $('next-btn').addEventListener('click', nextQuestion);
  $('quit-btn').addEventListener('click', () => {
    if (!state.round || state.round.answered.length === 0 || confirm('이번 라운드를 그만둘까요? (푼 문항의 오답 기록은 남습니다)')) goHome();
  });
  $('again-btn').addEventListener('click', () => { $('result-dialog').close(); startRound(state.round?.mode || 'normal'); });
  $('home-btn').addEventListener('click', goHome);
  $('result-dialog').addEventListener('cancel', (e) => { e.preventDefault(); goHome(); });
  // 인증
  $('tab-login').addEventListener('click', () => setAuthTab('login'));
  $('tab-signup').addEventListener('click', () => setAuthTab('signup'));
  $('login-form').addEventListener('submit', (e) => handleAuthSubmit(e, 'login'));
  $('signup-form').addEventListener('submit', (e) => handleAuthSubmit(e, 'signup'));
  $('logout-btn').addEventListener('click', logout);
  // 오답노트
  $('notes-card').addEventListener('click', openNotes);
  $('notes-back').addEventListener('click', goHome);
  $('notes-start').addEventListener('click', () => startRound('wrongnote'));
  window.addEventListener('popstate', () => { /* 화면 상태는 앱이 관리 (뒤로가기로 로그아웃되지 않게) */ });
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
  let serverReady = false;
  const serverInit = state.server.init().then((loggedIn) => { serverReady = true; return loggedIn; })
    .catch((e) => { console.error(e); return null; });
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (e) {
    $('screen-loading').innerHTML = `<div class="center">문항 데이터를 불러오지 못했습니다.<br><span class="small muted">${escapeHtml(String(e))}</span></div>`;
    return;
  }
  for (const s of state.data.subjects) for (const it of s.items) state.itemsById.set(it.id, it);
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
  $('data-version').textContent = `데이터 ${state.data.version} · ${state.data.generatedAt.slice(0, 10)}`;
  bind();
  // 디버그/테스트용 훅 (UI 동작에는 영향 없음)
  window.__oxquiz = { state, answer, nextQuestion, startRound };

  const loggedIn = await serverInit;
  if (!serverReady) {
    showAuth();
    $('auth-status').textContent = '⚠ 서버 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.';
    for (const b of document.querySelectorAll('#screen-auth button[type=submit]')) b.disabled = true;
    return;
  }
  if (loggedIn) await enterHome();
  else showAuth();
}

init();
