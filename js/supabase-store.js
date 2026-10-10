// 서버(Supabase) 저장소. storage.js 의 LocalProgressStore 와 같은 역할(기록 저장/조회)을 하며,
// 추가로 인증과 오답노트를 담당. 모든 쓰기는 SyncQueue 를 거쳐서 실패해도 localStorage 에 남았다가 재시도됨.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_JS_URL, RECENT_ROUNDS } from './config.js';
import { nicknameToEmail, displayNickname, validateNickname, validatePin } from './auth-utils.js';
import { applyWrongNote, WRONG_NOTE_CLEAR_STREAK } from './quiz-core.js';
import { SyncQueue } from './sync-queue.js';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));

// Postgres/PostgREST 오류 중 다시 보내도 소용없는 것 → 큐에서 버림. 인증 만료(PGRST301, 28000)·네트워크 오류는 재시도.
function classifyError(error) {
  if (!error) return 'ok';
  const code = String(error.code || '');
  if (code === 'PGRST301' || code === '28000' || code === '401' || /JWT/i.test(error.message || '')) return 'retry';
  if (/^(22|23|42)[0-9A-Z]{3}$/.test(code) || /^PGRST(1|2)\d\d$/.test(code)) return 'drop';
  return 'retry';
}

export class SupabaseStore {
  constructor({ storage = globalThis.localStorage, onSyncChange = () => {} } = {}) {
    this.storage = storage;
    this.onSyncChange = onSyncChange;
    this.client = null;
    this.user = null;
    this.profile = null;
    this.rounds = [];      // 최근 라운드 (최신순)
    this.notes = {};       // item_id → wrong_note
    this.queue = null;
    this.lastError = null;
    this._retryTimer = null;
  }

  /** supabase-js 를 동적으로 불러옴 (CDN 실패 시 예외 → UI 에서 안내) */
  async init() {
    const { createClient } = await import(SUPABASE_JS_URL);
    this.client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'oxquiz.auth' },
    });
    const { data } = await this.client.auth.getSession();
    if (data.session) await this._setUser(data.session.user);
    globalThis.addEventListener?.('online', () => this.flush());
    return !!this.user;
  }

  // ------------------------------------------------------------------ 인증
  async signIn(nickname, pin) {
    const err = validateNickname(nickname) || validatePin(pin);
    if (err) throw new Error(err);
    const { data, error } = await this.client.auth.signInWithPassword({ email: nicknameToEmail(nickname), password: pin });
    if (error) {
      if (/invalid login credentials/i.test(error.message)) throw new Error('닉네임 또는 PIN이 맞지 않습니다.');
      if (error.status === 429) throw new Error('시도가 너무 많습니다. 잠시 후 다시 해 주세요.');
      throw new Error(`로그인 실패: ${error.message}`);
    }
    await this._setUser(data.user);
  }

  async signUp(nickname, pin) {
    const err = validateNickname(nickname) || validatePin(pin);
    if (err) throw new Error(err);
    const res = await fetch(`${SUPABASE_URL}/functions/v1/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify({ nickname: displayNickname(nickname), pin }),
    }).catch(() => { throw new Error('서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.'); });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `가입 실패 (${res.status})`);
    await this.signIn(nickname, pin);
  }

  async signOut() {
    clearTimeout(this._retryTimer);
    await this.client.auth.signOut({ scope: 'local' }).catch(() => {});
    this.user = null; this.profile = null; this.rounds = []; this.notes = {}; this.queue = null;
  }

  async _setUser(user) {
    this.user = user;
    this.queue = new SyncQueue({
      storage: this.storage, key: `oxquiz.queue.${user.id}`,
      run: (op) => this._run(op),
      onChange: (n) => this.onSyncChange(n),
    });
    this._loadCache();
    this.profile = this.profile || { nickname: user.user_metadata?.nickname || '' };
    this.onSyncChange(this.queue.size);
  }

  // ------------------------------------------------------------------ 캐시 (오프라인에서도 화면 표시)
  get _cacheKey() { return `oxquiz.cache.${this.user.id}`; }
  _loadCache() {
    try {
      const c = JSON.parse(this.storage.getItem(this._cacheKey) || 'null');
      if (c) { this.profile = c.profile; this.rounds = c.rounds || []; this.notes = c.notes || {}; }
    } catch { /* 무시 */ }
  }
  _saveCache() {
    try {
      this.storage.setItem(this._cacheKey, JSON.stringify({ profile: this.profile, rounds: this.rounds, notes: this.notes }));
    } catch { /* 무시 */ }
  }

  /** 서버에서 프로필·최근 라운드·오답노트를 새로 읽음. 먼저 큐를 비워서 서버가 최신이 되게 함 */
  async refresh() {
    if (!this.user) return false;
    const left = await this.flush();
    try {
      const [p, r, n] = await Promise.all([
        this.client.from('profiles').select('nickname').eq('user_id', this.user.id).maybeSingle(),
        this.client.from('rounds').select('*').not('finished_at', 'is', null)
          .order('started_at', { ascending: false }).limit(RECENT_ROUNDS),
        this.client.from('wrong_notes').select('*'),
      ]);
      for (const x of [p, r, n]) if (x.error) throw x.error;
      if (p.data) this.profile = p.data;
      this.rounds = r.data;
      if (left === 0) { // 보내지 못한 응답이 남아 있으면 로컬(낙관적) 오답노트를 유지
        this.notes = Object.fromEntries(n.data.map((x) => [x.item_id, x]));
      }
      this._saveCache();
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e;
      return false;
    }
  }

  // ------------------------------------------------------------------ 쓰기 (큐 경유)
  async _run(op) {
    if (op.kind === 'round') {
      const { error } = await this.client.from('rounds').upsert(op.row, { onConflict: 'id' });
      return classifyError(error);
    }
    if (op.kind === 'attempt') {
      const { error } = await this.client.rpc('record_attempt', op.args);
      return classifyError(error);
    }
    return 'drop';
  }

  flush() {
    if (!this.queue) return Promise.resolve(0);
    return this.queue.flush().then((left) => {
      clearTimeout(this._retryTimer);
      if (left > 0) this._retryTimer = setTimeout(() => this.flush(), 30000);
      return left;
    });
  }

  newRoundId() { return uuid(); }

  /** 라운드 시작 (서버에 행을 먼저 만들어 응답이 참조할 수 있게) */
  startRound(r) {
    this.queue.push({ kind: 'round', row: {
      id: r.id, mode: r.mode, timer_sec: r.timerSec, total: r.total, started_at: new Date(r.startedAt).toISOString(),
    } });
    this.flush();
  }

  /** 문항 1개 응답: 로컬 오답노트를 즉시 갱신(낙관적)하고 서버에는 record_attempt 로 원자적 처리 */
  recordAttempt(question, result, ctx) {
    const at = new Date().toISOString();
    const variantId = question.kind === 'false' ? question.statementId : null;
    const next = applyWrongNote(this.notes[question.itemId] || null,
      { itemId: question.itemId, correct: result.correct, mode: ctx.mode, variantId, at });
    if (next) this.notes[question.itemId] = next;
    this._saveCache();
    this.queue.push({ kind: 'attempt', args: {
      p_client_id: uuid(), p_item_id: question.itemId, p_variant_id: variantId,
      p_shown_type: question.answer, p_user_answer: result.choice ?? null,
      p_correct: result.correct, p_timed_out: !!result.timedOut, p_mode: ctx.mode,
      p_round_id: ctx.roundId, p_created_at: at, p_clear_streak: WRONG_NOTE_CLEAR_STREAK,
    } });
    this.flush();
  }

  /** 라운드 종료 */
  saveRound(r) {
    const row = {
      id: r.id, mode: r.mode, timer_sec: r.timerSec, total: r.total, attempted: r.attempted,
      correct: r.correct, timeouts: r.timeouts, started_at: new Date(r.startedAt).toISOString(),
      finished_at: new Date().toISOString(),
    };
    this.rounds = [row, ...this.rounds.filter((x) => x.id !== row.id)].slice(0, RECENT_ROUNDS);
    this._saveCache();
    this.queue.push({ kind: 'round', row });
    this.flush();
  }

  get pending() { return this.queue ? this.queue.size : 0; }
}
