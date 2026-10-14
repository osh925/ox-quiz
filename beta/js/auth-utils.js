// 닉네임/PIN 규칙과 "닉네임 → 내부 이메일" 변환. DOM/네트워크 의존 없음 (node 테스트 가능).
// ⚠ supabase/functions/signup/index.ts 에 같은 로직이 복사되어 있음. 바꿀 때는 두 곳을 같이 바꿀 것.

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 10;          // 글자 수 (한글 10자 = UTF-8 30바이트)
export const NICKNAME_MAX_BYTES = 30;    // 이메일 local part(64자) 제한 때문: 'u' + hex(30바이트) = 61자
export const EMAIL_DOMAIN = 'ox-quiz.invalid'; // RFC 2606 예약 도메인 — 실제 메일은 절대 발송되지 않음
export const PIN_RE = /^[0-9]{6}$/;

/** 표시용 닉네임: 앞뒤 공백 제거, NFC 정규화 */
export function displayNickname(raw) {
  return String(raw ?? '').normalize('NFC').trim();
}

/** 비교/중복 검사용 닉네임: NFKC + 공백 제거 + 소문자 */
export function normalizeNickname(raw) {
  return String(raw ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** 문제가 있으면 한국어 오류 메시지, 없으면 null */
export function validateNickname(raw) {
  const n = normalizeNickname(raw);
  const len = [...n].length;
  if (len < NICKNAME_MIN) return `닉네임은 ${NICKNAME_MIN}자 이상이어야 합니다.`;
  if (len > NICKNAME_MAX) return `닉네임은 ${NICKNAME_MAX}자 이하로 해 주세요.`;
  if (!/^[\p{L}\p{N}_.-]+$/u.test(n)) return '닉네임에는 한글·영문·숫자와 _ . - 만 쓸 수 있습니다.';
  if (new TextEncoder().encode(n).length > NICKNAME_MAX_BYTES) return '닉네임이 너무 깁니다.';
  return null;
}

export function validatePin(pin) {
  return PIN_RE.test(String(pin ?? '')) ? null : 'PIN은 숫자 6자리입니다.';
}

/** 정규화된 닉네임 → Supabase Auth 용 내부 이메일 (예: '테스트b' → 'ued858c...62@ox-quiz.invalid') */
export function nicknameToEmail(raw) {
  const n = normalizeNickname(raw);
  const hex = [...new TextEncoder().encode(n)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `u${hex}@${EMAIL_DOMAIN}`;
}

/** 내부 이메일 → 정규화 닉네임 (관리자 확인용) */
export function emailToNickname(email) {
  const m = /^u([0-9a-f]+)@/.exec(String(email));
  if (!m) return null;
  const bytes = new Uint8Array(m[1].match(/../g).map((h) => parseInt(h, 16)));
  return new TextDecoder().decode(bytes);
}
