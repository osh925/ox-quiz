// 문항당 카운트다운 타이머. DOM 의존 없음 — 시계(now)와 스케줄러(setInterval)를 주입할 수 있어 node 테스트 가능.
//
// - 남은 시간은 항상 "시작 시각 + 제한 시간 - 현재 시각" 으로 계산(타임스탬프 기반).
//   setInterval 은 화면 갱신용일 뿐이라, 탭이 백그라운드에서 interval 이 늦어지거나 멈춰도 시간은 정확함.
// - 탭이 숨겨져 있는 동안에도 시간은 흐름(일시정지하지 않음). 돌아왔을 때 check() 를 부르면 즉시 반영/만료 처리.
// - stop() 이후나 만료 이후에는 onTick/onExpire 가 다시 불리지 않고 interval 도 해제됨(누수 없음).

export function createCountdown({
  seconds,
  now = () => Date.now(),
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (h) => clearInterval(h),
  intervalMs = 100,
  onTick = () => {},
  onExpire = () => {},
}) {
  if (!(seconds > 0)) throw new Error('seconds must be > 0');
  const totalMs = seconds * 1000;
  let status = 'idle'; // idle | running | stopped | expired
  let startedAt = 0;
  let frozenMs = totalMs;
  let handle = null;

  const live = () => Math.max(0, startedAt + totalMs - now());
  const clear = () => { if (handle !== null) { clearIntervalFn(handle); handle = null; } };

  function check() {
    if (status !== 'running') return;
    const r = live();
    if (r <= 0) {
      status = 'expired';
      frozenMs = 0;
      clear();
      onTick(0, totalMs);
      onExpire();
      return;
    }
    onTick(r, totalMs);
  }

  return {
    get status() { return status; },
    get totalMs() { return totalMs; },
    get hasInterval() { return handle !== null; },
    remainingMs() { return status === 'running' ? live() : frozenMs; },
    elapsedMs() { return totalMs - this.remainingMs(); },
    start() {
      if (status !== 'idle') throw new Error('countdown already used; create a new one');
      status = 'running';
      startedAt = now();
      onTick(totalMs, totalMs);
      handle = setIntervalFn(check, intervalMs);
    },
    /** 사용자가 답했을 때. 아직 진행 중이었으면 true (만료 후 늦은 탭이면 false) */
    stop() {
      if (status !== 'running') { clear(); return false; }
      // 정지 시점에 이미 시간이 지났다면 만료로 처리 (interval 이 늦게 돌아 놓친 경우)
      if (live() <= 0) { check(); return false; }
      frozenMs = live();
      status = 'stopped';
      clear();
      return true;
    },
    check,
  };
}
