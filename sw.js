// 서비스 워커: Chrome ⋮ 메뉴의 "앱 설치"(홈 화면에 추가)가 가능하도록 하고, 오프라인에서도 앱 화면이 열리게 함.
// 앱 안에 설치 버튼은 두지 않음. beforeinstallprompt 도 가로채지 않아서 브라우저 기본 설치 UI가 그대로 동작함.
//
// 전략
//  - 같은 출처 GET: 네트워크 우선 → 실패하면 캐시. 배포하면 다음 로드부터 바로 새 버전이 보이고, 오프라인이면 마지막 버전을 씀
//  - supabase-js CDN(버전 고정 URL): 캐시 우선
//  - Supabase API(인증/DB/함수) 및 GET 이 아닌 요청: 관여하지 않음 (오프라인 저장은 앱의 SyncQueue 가 담당)
const PREFIX = 'oxquiz-v'; // 이 앱의 캐시 이름 접두사 (다른 앱/미리보기 캐시는 건드리지 않음)
const VERSION = `${PREFIX}3`;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/app.js', 'js/quiz-core.js', 'js/timer.js', 'js/storage.js', 'js/supabase-store.js',
  'js/sync-queue.js', 'js/auth-utils.js', 'js/config.js',
  'data/questions.json', 'data/cloze.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const CDN_HOST = 'cdn.jsdelivr.net';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.host === CDN_HOST) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (url.origin !== self.location.origin) return; // Supabase 등은 그대로 통과

  event.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
      throw err;
    }
  })());
});
