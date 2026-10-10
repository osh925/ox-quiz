// 서버(Supabase) 저장소. storage.js 의 LocalProgressStore 와 같은 역할(기록 저장/조회)을 하며,
// 추가로 인증과 오답노트를 담당. 모든 쓰기는 SyncQueue 를 거쳐서 실패해도 localStorage 에 남았다가 재시도됨.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_JS_URL, RECENT_ROUNDS } from './config.js';
import { nicknameToEmail, displayNickname, validateNickname, validatePin } from './auth-utils.js';
import { applyWrongNote, dismissWrongNote, WRONG_NOTE_CLEAR_STREAK } from './quiz-core.js';
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
    this._rev = 0;         // 로컬 변경 카운터 (refresh 가 낙관적 변경을 덮어쓰지 않도록)
    this.hiddenList = [];  // [{ variant_id, item_id, created_at }] 이 사용자가 숨긴 오지문
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
    this.user = null; this.profile = null; this.rounds = []; this.notes = {}; this.hiddenList = []; this.queue = null;
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
      if (c) { this.profile = c.profile; this.rounds = c.rounds || []; this.notes = c.notes || {}; this.hiddenList = c.hidden || []; }
    } catch { /* 무시 */ }
  }
  _saveCache() {
    try {
      this.storage.setItem(this._cacheKey, JSON.stringify({ profile: this.profile, rounds: this.rounds, notes: this.notes, hidden: this.hiddenList }));
    } catch { /* 무시 */ }
  }

  /** 서버에서 프로필·최근 라운드·오답노트를 새로 읽음. 먼저 큐를 비워서 서버가 최신이 되게 함 */
  async refresh() {
    if (!this.user) return false;
    const left = await this.flush();
    const rev = this._rev; // 읽는 도중 로컬 변경(응답·삭제·되돌리기)이 생기면 덮어쓰지 않음
    try {
      const [p, r, n, h] = await Promise.all([
        this.client.from('profiles').select('nickname').eq('user_id', this.user.id).maybeSingle(),
        this.client.from('rounds').select('*').not('finished_at', 'is', null)
          .order('started_at', { ascending: false }).limit(RECENT_ROUNDS),
        this.client.from('wrong_notes').select('*'),
        this.client.from('hidden_variants').select('variant_id,item_id,created_at').order('created_at', { ascending: false }),
      ]);
      for (const x of [p, r, n, h]) if (x.error) throw x.error;
      if (p.data) this.profile = p.data;
      const fresh = left === 0 && rev === this._rev && this.queue.size === 0;
      if (fresh) this.rounds = r.data;
      if (fresh) { // 보내지 못한 응답이 남아 있으면 로컬(낙관적) 오답노트를 유지
        this.notes = Object.fromEntries(n.data.map((x) => [x.item_id, x]));
        this.hiddenList = h.data;
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
    if (op.kind === 'dismiss') {
      const { error } = await this.client.rpc('dismiss_wrong_note', op.args);
      return classifyError(error);
    }
    if (op.kind === 'unhide') {
      const { error } = await this.client.from('hidden_variants').delete()
        .eq('user_id', this.user.id).eq('variant_id', op.variant_id);
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
    this._rev++;
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
    this._rev++;
    this._saveCache();
    this.queue.push({ kind: 'round', row });
    this.flush();
  }

  // ------------------------------------------------------------------ 오답노트 삭제 / 숨긴 오지문
  /** 숨긴 오지문 ID 집합 (출제 시 제외) */
  get hidden() { return new Set(this.hiddenList.map((h) => h.variant_id)); }

  /** 해당 정지문에서 틀렸던 응답들 (삭제 확인창용). 오프라인이면 빈 배열 → note.last_variant_id 만 사용 */
  async missedAttempts(itemId) {
    try {
      const { data, error } = await this.client.from('attempts').select('variant_id,correct,created_at')
        .eq('item_id', itemId).eq('correct', false).not('variant_id', 'is', null)
        .order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      return data;
    } catch { return []; }
  }

  /** 오답노트에서 삭제 (+ 선택한 오지문 숨김). 로컬 즉시 반영 후 서버에는 dismiss_wrong_note 로 원자적 처리 */
  dismissNote(itemId, hideVariantIds = []) {
    const at = new Date().toISOString();
    if (this.notes[itemId]) this.notes[itemId] = dismissWrongNote(this.notes[itemId], at);
    const have = this.hidden;
    for (const v of hideVariantIds) {
      if (!have.has(v)) this.hiddenList = [{ variant_id: v, item_id: itemId, created_at: at }, ...this.hiddenList];
    }
    this._rev++;
    this._saveCache();
    this.queue.push({ kind: 'dismiss', args: { p_item_id: itemId, p_hide_variants: hideVariantIds } });
    this.flush();
  }

  /** 숨긴 오지문 되돌리기 */
  unhideVariant(variantId) {
    this.hiddenList = this.hiddenList.filter((h) => h.variant_id !== variantId);
    this._rev++;
    this._saveCache();
    this.queue.push({ kind: 'unhide', variant_id: variantId });
    this.flush();
  }

  get pending() { return this.queue ? this.queue.size : 0; }
}
