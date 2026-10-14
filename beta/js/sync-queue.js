// 서버 저장 실패 시 재시도 큐 (localStorage 영속). 네트워크/서버 의존은 run(op) 으로 주입 → node 테스트 가능.
// - 순서 보장: 앞의 작업이 실패하면 뒤 작업은 보내지 않고 멈춤 (라운드 → 응답 FK 순서 유지)
// - run(op) 결과: 'ok' | 'retry'(일시적 오류: 네트워크 등) | 'drop'(영구 오류: 다시 보내도 실패 → 버림)
export class SyncQueue {
  constructor({ storage, key, run, onChange = () => {} }) {
    this.storage = storage;
    this.key = key;
    this.run = run;
    this.onChange = onChange;
    this.flushing = null;
    this.dropped = [];
  }
  _read() {
    try { return JSON.parse(this.storage.getItem(this.key) || '[]'); } catch { return []; }
  }
  _write(list) {
    try { this.storage.setItem(this.key, JSON.stringify(list)); } catch { /* 저장 공간 부족 등 */ }
    this.onChange(list.length);
  }
  get size() { return this._read().length; }
  push(op) {
    const list = this._read();
    list.push({ ...op, queuedAt: new Date().toISOString() });
    this._write(list);
  }
  /** 큐를 앞에서부터 처리. 동시에 여러 번 불려도 한 번만 돈다. 반환: 남은 개수 */
  flush() {
    if (this.flushing) return this.flushing;
    // 주의: finally 는 비동기로 실행되므로, 큐가 비어 즉시 끝나는 경우에도 this.flushing 이 남아 있지 않음
    const p = this._loop().finally(() => { if (this.flushing === p) this.flushing = null; });
    this.flushing = p;
    return p;
  }
  async _loop() {
    for (;;) {
      const list = this._read();
      if (!list.length) return 0;
      let res;
      try { res = await this.run(list[0]); } catch { res = 'retry'; }
      if (res === 'retry') return list.length;
      const rest = this._read();
      const head = rest.shift();
      if (res === 'drop') this.dropped.push(head);
      this._write(rest);
    }
  }
}
