// UI 계층: DOM 조작과 화면 전환만 담당.
//   출제/채점/오답노트 규칙 → quiz-core.js (순수 함수)
//   서버 저장·인증 → supabase-store.js (SupabaseStore)
//   기기별 설정(문항 수·범위·타이머) → storage.js (LocalProgressStore.prefs)
import {
  buildPool, listSections, pickQuestion, grade, newRound, recordAnswer,
  isRoundOver, roundSummary, clampRoundSize, highlightOriginal,
  gradeTimeout, feedbackText, TIMER_OPTIONS, DEFAULT_TIMER_ID, getTimerOption,
  activeWrongNotes, buildWrongNotePool, wrongNoteRoundSize, findVariant, WRONG_NOTE_CLEAR_STREAK,
  missedVariantsForNote, attachCloze, hasVisibleCloze, poolCountForTypes, timerOptionsFor,
  QUESTION_TYPE_OPTIONS, DEFAULT_QUESTION_TYPES, BLANK_DISPLAY_OPTIONS, DEFAULT_BLANK_DISPLAY,
  clozeSegments, blankMask, clozeAnswerSegments, gradeCloze, gradeClozeGiveUp, overrideResult,
} from './quiz-core.js';
import { APP_VERSION, STORAGE_NS } from './config.js';
import { createCountdown } from './timer.js';
import { LocalProgressStore } from './storage.js';
import { SupabaseStore } from './supabase-store.js';

const DATA_URL = 'data/questions.json';
const CLOZE_URL = 'data/cloze.json';
const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  itemsById: new Map(),
  store: new LocalProgressStore(undefined, STORAGE_NS), // 기기별 설정(prefs)만
  server: new SupabaseStore({ onSyncChange: (n) => renderSyncBanner(n) }),
  mode: 'normal',                            // 'normal' | 'wrongnote'
  settings: {
    subjectId: null, sectionKey: '', roundSize: 15, timerId: DEFAULT_TIMER_ID,
    questionTypes: DEFAULT_QUESTION_TYPES, blankDisplay: DEFAULT_BLANK_DISPLAY,
  },
  clozeCount: 0,
  pending: null, // 단답형 응답은 피드백을 떠날 때 저장 ('정답으로 인정'을 반영하기 위해)
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

function segHtml(name, options, current) {
  return options.map((o) => `
    <label class="seg"><input type="radio" name="${name}" value="${o.id}"${o.id === current ? ' checked' : ''} />
    <span>${escapeHtml(o.label)}</span></label>`).join('');
}

function fillTypeOptions() {
  $('qtype-options').innerHTML = segHtml('qtype', QUESTION_TYPE_OPTIONS, state.settings.questionTypes);
  $('blank-options').innerHTML = segHtml('blank', BLANK_DISPLAY_OPTIONS, state.settings.blankDisplay);
  $('blank-field').hidden = state.settings.questionTypes === 'ox' || !state.clozeCount;
  $('qtype-field').hidden = !state.clozeCount; // 단답형 데이터를 못 읽었으면 OX만
}

function fillTimerOptions() {
  const box = $('timer-options');
  const cur = getTimerOption(state.settings.timerId, state.settings.questionTypes).id;
  box.innerHTML = timerOptionsFor(state.settings.questionTypes).map((o) => `
    <label class="seg"><input type="radio" name="timer" value="${o.id}"${o.id === cur ? ' checked' : ''} />
    <span>${escapeHtml(o.label)}</span></label>`).join('');
}

function updatePoolInfo() {
  state.pool = buildPool(state.data, { subjectId: state.settings.subjectId, sectionPrefix: sectionPrefixOf(state.settings.sectionKey) });
  const wrongs = state.pool.reduce((n, it) => n + it.wrongs.length, 0);
  const hidden = state.server.hidden;
  const clozes = state.pool.filter((it) => hasVisibleCloze(it, hidden)).length;
  const t = state.settings.questionTypes;
  $('pool-info').textContent = t === 'ox' ? `출제 범위: 정지문 ${state.pool.length}개 · 오지문 ${wrongs}개`
    : t === 'cloze' ? `출제 범위: 단답형 ${clozes}개`
      : `출제 범위: 정지문 ${state.pool.length}개 · 오지문 ${wrongs}개 · 단답형 ${clozes}개`;
  const startBtn = $('start-form').querySelector('button[type=submit]');
  startBtn.disabled = poolCountForTypes(state.pool, t, hidden) === 0;
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
    const qt = r.question_types || 'ox';
    const tags = [r.mode === 'wrongnote' ? '<span class="tag">오답노트</span>' : '',
      qt === 'cloze' ? '<span class="tag tag-cloze">단답형</span>' : qt === 'mixed' ? '<span class="tag tag-cloze">섞어서</span>' : '',
      r.timer_sec ? `<span class="tag">${r.timer_sec}초</span>` : ''].join('');
    const mix = qt === 'mixed' && r.attempted
      ? `<span class="small muted mix">OX ${r.correct - (r.cloze_correct || 0)}/${r.attempted - (r.cloze_attempted || 0)} · 단답형 ${r.cloze_correct || 0}/${r.cloze_attempted || 0}</span>` : '';
    return `<li><span>${fmtDate(r.finished_at || r.started_at)} ${tags}${mix}</span><b>${r.correct} / ${r.attempted}</b></li>`;
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
  const types = state.settings.questionTypes;
  const playable = poolCountForTypes(rows.map((r) => r.item), types, state.server.hidden);
  const size = wrongNoteRoundSize(state.settings.roundSize, playable);
  const timer = getTimerOption(state.settings.timerId, types);
  const typeLabel = QUESTION_TYPE_OPTIONS.find((o) => o.id === types).label;
  $('notes-help').textContent = rows.length
    ? `오답노트 모드에서 ${WRONG_NOTE_CLEAR_STREAK}번 연속 맞히면 빠집니다. 한 라운드 ${size}문항 · ${typeLabel} · 제한 시간 ${timer.label} (처음 화면에서 변경)`
    : '';
  const start = $('notes-start');
  start.disabled = size === 0;
  start.textContent = !rows.length ? '오답노트가 비어 있어요'
    : size ? `오답노트로 풀기 (${size}문항)` : '이 유형으로 낼 문항이 없어요';
  $('notes-list').innerHTML = rows.map(({ n, item }) => {
    const v = findVariant(item, n.last_variant_id);
    const missed = v && v.kind === 'cloze'
      ? `<p class="small muted">틀렸던 단답형 (정답 강조)</p><p>${clozeAnswerHtml(v.cloze)}</p>`
      : v
        ? `<p class="small muted">틀렸던 오지문 (바뀐 부분 강조)</p><p>${highlightOriginal(item.answer, v.text)
          .map((s) => (s.changed ? `<mark>${escapeHtml(s.text)}</mark>` : escapeHtml(s.text))).join('')}</p>`
          + (v.point ? `<p class="small muted">〔${escapeHtml(v.point.type)}〕 ${escapeHtml(v.point.change)}</p>` : '')
        : '<p class="small muted">정지문(옳은 지문)을 X로 답했거나 시간 초과로 틀렸어요.</p>';
    const typeTag = v && v.kind === 'cloze' ? '<span class="tag tag-cloze">단답형</span> ' : '';
    return `<li class="card note">
      <p class="section-path">${typeTag}${escapeHtml(item.section.join(' › '))}</p>
      <p class="note-text">${escapeHtml(item.answer)}</p>
      <p class="note-meta small muted">틀린 횟수 <b>${n.wrong_count}</b> · 마지막 ${fmtDate(n.last_wrong_at)} · 연속 정답 ${n.correct_streak}/${WRONG_NOTE_CLEAR_STREAK}</p>
      <div class="note-actions">
        <details><summary>틀렸던 지문 보기</summary>${missed}</details>
        <button type="button" class="btn ghost small-btn note-del" data-item="${escapeHtml(n.item_id)}" aria-label="오답노트에서 삭제">삭제</button>
      </div>
    </li>`;
  }).join('');
  renderHiddenList();
}

const markDiff = (from, to) => highlightOriginal(from, to)
  .map((s) => (s.changed ? `<mark>${escapeHtml(s.text)}</mark>` : escapeHtml(s.text))).join('');
/** 단답형: 정답을 채운 원문 (정답 부분 강조) */
const clozeAnswerHtml = (c) => clozeAnswerSegments(c)
  .map((s) => (s.changed ? `<mark>${escapeHtml(s.text)}</mark>` : escapeHtml(s.text))).join('');
/** 오지문 또는 단답형 변형 1개를 표시용 HTML 로 */
const variantHtml = (item, v) => (v.kind === 'cloze'
  ? `<span class="tag tag-cloze">단답형</span> ${clozeAnswerHtml(v.cloze)}`
  : `<span class="tag">오지문</span> ${markDiff(item.answer, v.text)}`);

function renderHiddenList() {
  const list = state.server.hiddenList;
  $('hidden-count').textContent = `(${list.length})`;
  $('hidden-empty').hidden = list.length > 0;
  $('hidden-list').innerHTML = list.map((h) => {
    const item = state.itemsById.get(h.item_id);
    const v = item && findVariant(item, h.variant_id);
    const body = v
      ? `<p class="section-path">${escapeHtml(item.section.join(' › '))}</p><p>${variantHtml(item, v)}</p>`
      : `<p class="small muted">${escapeHtml(h.variant_id)} (현재 데이터에 없는 문제)</p>`;
    return `<li>${body}<button type="button" class="btn ghost small-btn unhide" data-variant="${escapeHtml(h.variant_id)}">되돌리기</button></li>`;
  }).join('');
}

// ------------------------------------------------------------------ 오답노트 삭제 (+ 오지문 숨김)
let dismissCtx = null;

function openDismiss(itemId) {
  const item = state.itemsById.get(itemId);
  const note = state.server.notes[itemId];
  if (!item || !note) return;
  const hidden = state.server.hidden;
  dismissCtx = {
    itemId,
    // 틀렸던 오지문 목록은 서버 응답 기록에서 미리 불러 둠 (오프라인이면 마지막으로 틀린 오지문만)
    variants: state.server.missedAttempts(itemId).then((atts) => missedVariantsForNote(item, note, atts, hidden)),
  };
  $('dismiss-item-text').textContent = item.answer;
  $('dismiss-step1').hidden = false;
  $('dismiss-step2').hidden = true;
  $('dismiss-yes').disabled = false;
  const dlg = $('dismiss-dialog');
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

async function confirmDismiss() {
  if (!dismissCtx) return;
  $('dismiss-yes').disabled = true;
  const item = state.itemsById.get(dismissCtx.itemId);
  const variants = await dismissCtx.variants;
  if (!variants.length) { finishDismiss([]); return; } // 정지문만 틀린 경우: 삭제만
  $('dismiss-variants').innerHTML = variants.map((v, i) => `
    <li><label class="pick">
      <input type="checkbox" value="${escapeHtml(v.id)}"${i === 0 ? ' checked' : ''} />
      <span>${variantHtml(item, v)}</span>
    </label></li>`).join('');
  const kinds = new Set(variants.map((v) => (v.kind === 'cloze' ? 'cloze' : 'ox')));
  $('hide-title').textContent = kinds.size > 1 ? '이 문제들이 앞으로 등장하지 않게 할까요?'
    : kinds.has('cloze') ? '이 단답형 문제가 앞으로 등장하지 않게 할까요?' : '이 오지문이 앞으로 등장하지 않게 할까요?';
  $('dismiss-step1').hidden = true;
  $('dismiss-step2').hidden = false;
}

function finishDismiss(hideIds) {
  const ctx = dismissCtx;
  dismissCtx = null;
  $('dismiss-dialog').close();
  if (!ctx) return;
  state.server.dismissNote(ctx.itemId, hideIds);
  renderNotes();
  renderNotesCount();
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
  const opt = getTimerOption(state.round.timerId, state.round.questionTypes);
  $('timer').hidden = !opt.seconds;
  if (!opt.seconds) return;
  const q = state.question;
  state.timer = createCountdown({
    seconds: opt.seconds,
    onTick: renderTimer,
    onExpire: () => {
      if (state.question !== q || state.answered) return;
      const res = q.type === 'cloze' ? gradeClozeGiveUp(q, { timedOut: true }) : gradeTimeout(q);
      showResult({ ...res, ms: opt.seconds * 1000 });
    },
  });
  state.timer.start();
}

/** 피드백을 떠날 때 보류 중이던 단답형 응답을 저장 */
function commitPending() {
  const p = state.pending;
  state.pending = null;
  if (p) state.server.recordAttempt(p.q, p.res, p.ctx);
}

function goHome() {
  commitPending();
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
  const types = state.clozeCount ? state.settings.questionTypes : 'ox';
  const hidden = state.server.hidden;
  if (mode === 'wrongnote') {
    pool = buildWrongNotePool(state.data, state.server.notes);
    size = wrongNoteRoundSize(state.settings.roundSize, poolCountForTypes(pool, types, hidden));
    if (!size) { alert(pool.length ? '이 문제 유형으로 낼 오답노트 문항이 없어요.' : '오답노트가 비어 있어요.'); goHome(); return; }
  } else {
    pool = state.pool;
    size = state.settings.roundSize;
    if (!poolCountForTypes(pool, types, hidden)) { alert('선택한 범위에 문항이 없습니다.'); return; }
  }
  stopTimer();
  state.mode = mode;
  state.roundPool = pool; // 라운드 도중 오답노트에서 빠진 항목도 이번 라운드에서는 계속 출제 대상
  state.roundHidden = hidden; // 사용자가 숨긴 오지문·단답형 (출제 후보에서 제외)
  const timer = getTimerOption(state.settings.timerId, types);
  const blankDisplay = types === 'ox' ? null : state.settings.blankDisplay;
  state.round = newRound(size, {
    id: state.server.newRoundId(), mode,
    subjectId: state.settings.subjectId, sectionKey: state.settings.sectionKey, dataVersion: state.data.version,
    timerId: timer.id, questionTypes: types, blankDisplay,
  });
  state.server.startRound({ id: state.round.id, mode, timerSec: timer.seconds, total: size, startedAt: state.round.startedAt,
    questionTypes: types, blankDisplay });
  $('mode-badge').hidden = mode !== 'wrongnote';
  show('quiz');
  nextQuestion();
}

function nextQuestion() {
  commitPending();
  if (isRoundOver(state.round)) { finishRound(); return; }
  state.question = pickQuestion(state.roundPool, Math.random, state.roundHidden, state.round.questionTypes);
  state.answered = false;
  const q = state.question;
  const n = state.round.answered.length + 1;
  $('progress-text').textContent = `${n} / ${state.round.size}`;
  $('progress-bar').style.width = `${((n - 1) / state.round.size) * 100}%`;
  $('q-section').textContent = q.section.join(' › ');
  $('feedback').hidden = true;
  $('next-btn').hidden = true;
  $('override-btn').hidden = true;
  const cloze = q.type === 'cloze';
  $('q-type').textContent = cloze ? '단답형 · 빈칸에 들어갈 말을 쓰세요' : 'OX';
  $('q-type').className = `q-type${cloze ? ' cloze' : ''}`;
  $('q-card').classList.toggle('cloze', cloze);
  $('ox-buttons').hidden = cloze;
  $('cloze-form').hidden = !cloze;
  if (cloze) renderClozeQuestion(q);
  else {
    $('q-text').textContent = q.text;
    for (const b of document.querySelectorAll('.btn.ox')) { b.disabled = false; b.classList.remove('chosen'); }
  }
  startQuestionTimer(); // 문제가 화면에 표시된 뒤에 시작
  if (cloze) $('cloze-inputs').querySelector('input').focus({ preventScroll: true });
}

/** 단답형 문제 문장(빈칸 표시)과 입력칸 그리기 */
function renderClozeQuestion(q) {
  const display = state.round.blankDisplay || DEFAULT_BLANK_DISPLAY;
  const multi = q.answers.length > 1;
  $('q-text').innerHTML = clozeSegments(q.text).map((s) => ('blank' in s
    ? `<span class="blank${display === 'hidden' ? ' hidden-len' : ''}" aria-label="빈칸${multi ? ` ${s.blank + 1}` : ''}">${multi ? `<sup>${s.blank + 1}</sup>` : ''}${escapeHtml(blankMask(q.answers[s.blank], display))}</span>`
    : escapeHtml(s.text))).join('');
  $('cloze-inputs').innerHTML = q.answers.map((a, i) => `
    <label class="cloze-field"><span class="small muted">${multi ? `빈칸 ${i + 1}` : '정답'}</span>
      <input type="text" class="cloze-input" data-i="${i}" autocomplete="off" autocapitalize="off" autocorrect="off"
             spellcheck="false" enterkeyhint="${i === q.answers.length - 1 ? 'done' : 'next'}" maxlength="60" /></label>`).join('');
  for (const b of $('cloze-form').querySelectorAll('button')) b.disabled = false;
}

function submitCloze(giveUp = false) {
  if (state.answered || !state.question || state.question.type !== 'cloze') return;
  let ms = null;
  if (state.timer) {
    const inTime = state.timer.stop();
    if (!inTime) return;
    ms = state.timer.elapsedMs();
  }
  const q = state.question;
  const inputs = [...$('cloze-inputs').querySelectorAll('input')].map((i) => i.value);
  showResult({ ...(giveUp ? gradeClozeGiveUp(q) : gradeCloze(q, inputs)), ms });
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
  const ctx = { mode: state.round.mode, roundId: state.round.id };
  if (q.type === 'cloze') state.pending = { q, res, ctx }; // '정답으로 인정' 가능성 때문에 다음으로 넘어갈 때 저장
  else state.server.recordAttempt(q, res, ctx);
  if (q.type === 'cloze') { renderClozeFeedback(q, res); return; }

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
  $('fb-cloze').hidden = true;
  $('override-btn').hidden = true;
  $('fb-original-label').textContent = '원래 정지문 (바뀐 부분 강조)';
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

/** 단답형 피드백: 정답/오답, 내 답, 정답, 원래 정지문(정답 강조), '정답으로 인정' 버튼 */
function renderClozeFeedback(q, res) {
  for (const i of $('cloze-inputs').querySelectorAll('input')) i.disabled = true;
  for (const b of $('cloze-form').querySelectorAll('button')) b.disabled = true;
  $('cloze-form').hidden = true;
  const fb = $('feedback');
  fb.className = `feedback ${res.correct ? 'ok' : 'ng'}`;
  const txt = feedbackText(res);
  $('fb-title').textContent = res.overridden ? '정답으로 인정했어요' : txt.title;
  const label = res.timedOut ? '시간 초과' : res.gaveUp ? '모르겠어요' : '';
  $('fb-label').textContent = label;
  $('fb-label').hidden = !label;
  const mine = res.userText ? escapeHtml(res.userText) : '<span class="muted">(입력 없음)</span>';
  $('fb-cloze').hidden = false;
  $('fb-cloze').innerHTML = `<p><span class="small muted">내 답</span> ${mine}</p>`
    + `<p><span class="small muted">정답</span> <b>${q.answers.map((a) => escapeHtml(a.canonical)).join(' / ')}</b></p>`;
  const orig = $('fb-original');
  orig.hidden = false; // 단답형은 맞아도 원문을 보여 줌 (정답 부분 강조)
  $('fb-original-label').textContent = '원래 정지문 (정답 강조)';
  $('fb-original-text').innerHTML = clozeAnswerHtml(q);
  $('fb-point').hidden = true;
  $('override-btn').hidden = res.correct || !!res.timedOut || !!res.gaveUp || !res.userText;
  fb.hidden = false;
  $('progress-bar').style.width = `${(state.round.answered.length / state.round.size) * 100}%`;
  const next = $('next-btn');
  next.textContent = isRoundOver(state.round) ? '결과 보기' : '다음';
  next.hidden = false;
  next.focus({ preventScroll: true });
  fb.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** '정답으로 인정': 방금 오답을 정답으로 바꿈 (아직 저장 전이므로 저장될 값 자체를 바꿈) */
function overrideLast() {
  const p = state.pending;
  if (!p || p.res.correct) return;
  p.res = overrideResult(p.res);
  state.round = { ...state.round, answered: state.round.answered.slice(0, -1) };
  state.round = recordAnswer(state.round, p.q, p.res);
  renderClozeFeedback(p.q, p.res);
}

function finishRound() {
  commitPending();
  stopTimer();
  const sum = roundSummary(state.round);
  state.server.saveRound({
    id: state.round.id, mode: state.round.mode, timerSec: getTimerOption(state.round.timerId, state.round.questionTypes).seconds,
    total: state.round.size, attempted: sum.attempted, correct: sum.correct, timeouts: sum.timeouts,
    startedAt: state.round.startedAt, questionTypes: state.round.questionTypes, blankDisplay: state.round.blankDisplay,
    clozeAttempted: sum.cloze.attempted, clozeCorrect: sum.cloze.correct,
  });
  $('result-title').textContent = state.round.mode === 'wrongnote' ? '오답노트 라운드 결과' : '라운드 결과';
  $('result-correct').textContent = sum.correct;
  $('result-attempted').textContent = sum.attempted;
  $('result-rate').textContent = `정답률 ${Math.round(sum.rate * 100)}%` + (sum.timeouts ? ` · 시간 초과 ${sum.timeouts}` : '');
  const parts = [];
  if (sum.ox.attempted) parts.push(`OX ${sum.ox.correct} / ${sum.ox.attempted}`);
  if (sum.cloze.attempted) parts.push(`단답형 ${sum.cloze.correct} / ${sum.cloze.attempted}`);
  if (sum.overrides) parts.push(`정답으로 인정 ${sum.overrides}`);
  $('result-mix').textContent = parts.join(' · ');
  $('result-mix').hidden = !(sum.cloze.attempted || sum.overrides);
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
    state.settings.timerId = getTimerOption(e.target.value, state.settings.questionTypes).id;
    state.store.savePrefs(state.settings);
  });
  $('qtype-options').addEventListener('change', (e) => {
    if (e.target.name !== 'qtype') return;
    state.settings.questionTypes = e.target.value;
    // 60초는 단답형용: OX만으로 바꾸면 무제한으로 표시 (저장된 선택값은 그대로 두어 다시 바꾸면 복원)
    fillTypeOptions(); fillTimerOptions(); updatePoolInfo(); state.store.savePrefs(state.settings);
  });
  $('blank-options').addEventListener('change', (e) => {
    if (e.target.name !== 'blank') return;
    state.settings.blankDisplay = e.target.value; state.store.savePrefs(state.settings);
  });
  // 단답형 입력: Enter = 다음 빈칸 / 마지막 빈칸이면 제출
  $('cloze-form').addEventListener('submit', (e) => { e.preventDefault(); submitCloze(false); });
  $('cloze-inputs').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const inputs = [...$('cloze-inputs').querySelectorAll('input')];
    const i = inputs.indexOf(e.target);
    if (i >= 0 && i < inputs.length - 1) { e.preventDefault(); inputs[i + 1].focus(); }
  });
  $('giveup-btn').addEventListener('click', () => submitCloze(true));
  $('override-btn').addEventListener('click', overrideLast);
  window.addEventListener('pagehide', commitPending);
  $('update-reload').addEventListener('click', () => { commitPending(); location.reload(); });
  $('update-close').addEventListener('click', () => { $('update-toast').hidden = true; });
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
  $('notes-list').addEventListener('click', (e) => {
    const b = e.target.closest('.note-del');
    if (b) openDismiss(b.dataset.item);
  });
  $('hidden-list').addEventListener('click', (e) => {
    const b = e.target.closest('.unhide');
    if (!b) return;
    state.server.unhideVariant(b.dataset.variant);
    renderHiddenList();
  });
  $('dismiss-yes').addEventListener('click', confirmDismiss);
  $('dismiss-cancel').addEventListener('click', () => { dismissCtx = null; $('dismiss-dialog').close(); });
  $('hide-yes').addEventListener('click', () => finishDismiss(
    [...document.querySelectorAll('#dismiss-variants input:checked')].map((i) => i.value)));
  $('hide-no').addEventListener('click', () => finishDismiss([]));
  $('dismiss-dialog').addEventListener('cancel', () => { dismissCtx = null; });
  window.addEventListener('popstate', () => { /* 화면 상태는 앱이 관리 (뒤로가기로 로그아웃되지 않게) */ });
  // 키보드(데스크톱): O/X 또는 ←/→, Enter/Space = 다음
  document.addEventListener('keydown', (e) => {
    if (!$('screen-quiz').classList.contains('active') || $('result-dialog').open) return;
    if (e.target.closest && e.target.closest('input, textarea')) return; // 단답형 입력 중엔 단축키 없음
    const k = e.key.toLowerCase();
    if (state.question?.type === 'cloze' && !state.answered) return;
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
  try { // 단답형 데이터 (없거나 실패하면 OX만 제공)
    const res = await fetch(CLOZE_URL, { cache: 'no-cache' });
    if (res.ok) state.clozeCount = attachCloze(state.data, await res.json());
  } catch (e) { console.warn('단답형 데이터를 불러오지 못했습니다', e); }
  const prefs = await state.store.getPrefs();
  state.settings = {
    subjectId: prefs.subjectId || state.data.subjects[0].id,
    sectionKey: prefs.sectionKey || '',
    roundSize: clampRoundSize(prefs.roundSize ?? 15),
    timerId: getTimerOption(prefs.timerId).id,
    questionTypes: QUESTION_TYPE_OPTIONS.some((o) => o.id === prefs.questionTypes) ? prefs.questionTypes : DEFAULT_QUESTION_TYPES,
    blankDisplay: BLANK_DISPLAY_OPTIONS.some((o) => o.id === prefs.blankDisplay) ? prefs.blankDisplay : DEFAULT_BLANK_DISPLAY,
  };
  $('size-range').value = state.settings.roundSize;
  $('size-value').textContent = state.settings.roundSize;
  fillSubjects(); fillSections(); fillTypeOptions(); fillTimerOptions(); updatePoolInfo();
  $('data-version').textContent = `v${APP_VERSION} · 데이터 ${state.data.version} · ${state.data.generatedAt.slice(0, 10)}`;
  bind();
  // 디버그/테스트용 훅 (UI 동작에는 영향 없음)
  window.__oxquiz = { state, answer, nextQuestion, startRound, submitCloze, overrideLast };

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

// 설치 가능(PWA) 조건을 위한 서비스 워커 등록. 설치는 브라우저 메뉴(Chrome ⋮ → 앱 설치)로만 함.
// beforeinstallprompt 는 가로채지 않음(preventDefault 호출 안 함) → 브라우저 기본 설치 UI 유지.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
      // 앱을 오래 열어 둔 경우(설치형 포함) 다시 볼 때 새 버전을 확인
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch((e) => console.warn('서비스 워커 등록 실패', e));
  });
  // 새 서비스 워커가 페이지를 넘겨받으면(=새 버전 배포) 새로고침 안내
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // 첫 설치는 안내하지 않음
    const t = document.getElementById('update-toast');
    if (t) t.hidden = false;
  });
}
