// Supabase 연결 정보. publishable key 는 공개되어도 되는 키(브라우저용)이며, 데이터 보호는 RLS 가 담당.
export const SUPABASE_URL = 'https://pmplhnxhxdbuqoflgthb.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_xVRMYy7uKdngyyFJHQZGIA_n3ogsAv2';
// supabase-js v2 ESM (빌드 없이 CDN). 버전을 고정해 갑작스러운 변경을 막음.
export const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
export const RECENT_ROUNDS = 10;
