// 가입 전용 Edge Function: 닉네임 + 6자리 PIN 으로 Supabase Auth 사용자 생성.
// - 이메일 인증 없이 바로 로그인할 수 있도록 Admin API 로 email_confirm: true 로 생성한다.
//   (대시보드의 "Confirm email" 설정을 바꾸지 않아도 됨. 내부 이메일은 ox-quiz.invalid 라 메일이 발송될 수 없음)
// - 공개 키(publishable key)는 JWT 가 아니라서 verify_jwt=false 로 배포하고, 대신 아래에서 입력 검증을 직접 함.
//   Supabase 기본 signUp 엔드포인트도 공개 키만 있으면 누구나 호출 가능하므로 보안 수준은 동일.
// - 닉네임 규칙은 js/auth-utils.js 와 반드시 같아야 함.
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://osh925.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];
const EMAIL_DOMAIN = "ox-quiz.invalid";
const NICKNAME_MIN = 2, NICKNAME_MAX = 10, NICKNAME_MAX_BYTES = 30;

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const displayNickname = (raw: unknown) => String(raw ?? "").normalize("NFC").trim();
const normalizeNickname = (raw: unknown) => String(raw ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
function validateNickname(raw: unknown): string | null {
  const n = normalizeNickname(raw);
  const len = [...n].length;
  if (len < NICKNAME_MIN) return `닉네임은 ${NICKNAME_MIN}자 이상이어야 합니다.`;
  if (len > NICKNAME_MAX) return `닉네임은 ${NICKNAME_MAX}자 이하로 해 주세요.`;
  if (!/^[\p{L}\p{N}_.-]+$/u.test(n)) return "닉네임에는 한글·영문·숫자와 _ . - 만 쓸 수 있습니다.";
  if (new TextEncoder().encode(n).length > NICKNAME_MAX_BYTES) return "닉네임이 너무 깁니다.";
  return null;
}
function nicknameToEmail(raw: unknown) {
  const hex = [...new TextEncoder().encode(normalizeNickname(raw))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `u${hex}@${EMAIL_DOMAIN}`;
}

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!req.headers.get("apikey")) return reply(401, { error: "missing_apikey" });

  let body: { nickname?: unknown; pin?: unknown };
  try { body = await req.json(); } catch { return reply(400, { error: "bad_json" }); }

  const nickErr = validateNickname(body.nickname);
  if (nickErr) return reply(400, { error: "invalid_nickname", message: nickErr });
  const pin = String(body.pin ?? "");
  if (!/^[0-9]{6}$/.test(pin)) return reply(400, { error: "invalid_pin", message: "PIN은 숫자 6자리입니다." });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.auth.admin.createUser({
    email: nicknameToEmail(body.nickname),
    password: pin,
    email_confirm: true,
    user_metadata: { nickname: displayNickname(body.nickname), nickname_norm: normalizeNickname(body.nickname) },
  });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "email_exists" || code === "user_already_exists" || /already/i.test(error.message)) {
      return reply(409, { error: "nickname_taken", message: "이미 사용 중인 닉네임입니다." });
    }
    console.error("createUser failed", code, error.message);
    return reply(500, { error: "signup_failed", message: "가입 중 오류가 발생했습니다." });
  }
  return reply(200, { ok: true, user_id: data.user?.id });
});
