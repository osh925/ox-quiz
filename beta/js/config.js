// Supabase 연결 정보. publishable key 는 공개되어도 되는 키(브라우저용)이며, 데이터 보호는 RLS 가 담당.
export const SUPABASE_URL = 'https://pmplhnxhxdbuqoflgthb.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_xVRMYy7uKdngyyFJHQZGIA_n3ogsAv2';
// supabase-js v2 ESM (빌드 없이 CDN). 버전을 고정해 갑작스러운 변경을 막음.
export const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
export const RECENT_ROUNDS = 10;
// 앱 버전 (화면 아래 표시, CHANGELOG.md 와 맞춤)
export const APP_VERSION = '2.0.0';
// 기기 저장소(localStorage) 키 접두어. 미리보기(beta/) 배포 때는 별도 값으로 바꿔 본 앱과 로그인·저장 대기열이 섞이지 않게 함.
export const STORAGE_NS = 'oxquizbeta';
