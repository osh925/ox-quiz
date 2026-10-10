// 사용자 진행 기록 저장소.
// 지금은 localStorage 구현(LocalProgressStore)만 있음. 나중에 Supabase/Firebase 등으로 바꿀 때는
// 같은 메서드(모두 Promise 반환)를 가진 클래스를 만들어 app.js 의 createStore() 에서 교체하면 됨.
//
// 저장 형태 (key: `${ns}.v1`):
// {
//   schema: 1,
//   userId: "u-xxxx",                // 기기별 익명 ID (백엔드 도입 시 계정 ID로 매핑)
//   createdAt: ISO,
//   prefs: { roundSize, subjectId, sectionKey },
//   rounds: [ { startedAt, endedAt, size, attempted, correct, subjectId, sectionKey, dataVersion } ],  // 최근 MAX_ROUNDS개
//   stats: { [statementId]: { seen, wrong, lastSeenAt, lastWrongAt } }   // statementId = 정지문 ID 또는 오지문 ID
// }

const MAX_ROUNDS = 200;
const SCHEMA = 1;

function uid() {
  if (globalThis.crypto?.randomUUID) return 'u-' + crypto.randomUUID();
  return 'u-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

export class LocalProgressStore {
  constructor(storage, ns = 'oxquiz') {
    try {
      this.storage = storage || globalThis.localStorage;
      const t = '__oxquiz_test__';
      this.storage.setItem(t, '1');
      this.storage.removeItem(t);
    } catch {
      this.storage = memoryStorage(); // 사파리 개인정보 보호 모드 등
      this.volatile = true;
    }
    this.key = `${ns}.v1`;
    this.state = null;
  }

  _read() {
    if (this.state) return this.state;
    let s = null;
    try { s = JSON.parse(this.storage.getItem(this.key) || 'null'); } catch { s = null; }
    if (!s || s.schema !== SCHEMA) {
      s = { schema: SCHEMA, userId: uid(), createdAt: new Date().toISOString(), prefs: {}, rounds: [], stats: {} };
    }
    this.state = s;
    return s;
  }
  _write() {
    try { this.storage.setItem(this.key, JSON.stringify(this.state)); } catch (e) { console.warn('저장 실패', e); }
  }

  async load() { return JSON.parse(JSON.stringify(this._read())); }
  async getPrefs() { return { ...this._read().prefs }; }
  async savePrefs(prefs) { const s = this._read(); s.prefs = { ...s.prefs, ...prefs }; this._write(); }

  /** 문항 1개 응답 기록 */
  async recordAttempt(question, result) {
    const s = this._read();
    const now = new Date().toISOString();
    const st = (s.stats[question.statementId] ||= { seen: 0, wrong: 0 });
    st.seen++;
    st.lastSeenAt = now;
    if (!result.correct) { st.wrong++; st.lastWrongAt = now; }
    this._write();
  }

  /** 라운드 종료 기록 */
  async saveRound(entry) {
    const s = this._read();
    s.rounds.push({ ...entry, endedAt: new Date().toISOString() });
    if (s.rounds.length > MAX_ROUNDS) s.rounds.splice(0, s.rounds.length - MAX_ROUNDS);
    this._write();
  }

  async reset() {
    const keepId = this._read().userId;
    this.state = { schema: SCHEMA, userId: keepId, createdAt: new Date().toISOString(), prefs: {}, rounds: [], stats: {} };
    this._write();
  }
}
