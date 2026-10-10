# OX 퀴즈 (법학 객관식 대비) — PoC

정지문(옳은 지문)과 오지문(틀린 지문)을 무작위로 내서 O/X로 푸는 **모바일 우선 정적 웹앱**입니다.
빌드 도구나 프레임워크 없이 `index.html + CSS + JS 모듈`로 되어 있고, 문항은 `data/questions.json` 하나에서 읽습니다.

- 현재 데이터: 민사소송법1 중간 — 정지문 682개, 오지문 780개 (`data/build_report.txt` 참고)
- **계정**: 닉네임 + 숫자 6자리 PIN. 기록과 오답노트는 **서버(Supabase)**에 저장되므로 기기를 바꿔도 이어서 풀 수 있습니다.
- **오답노트**: 틀린 문항이 자동으로 모이고, 오답노트에 있는 문항만 골라 푸는 모드가 있습니다.

---

## 1. 빠른 실행

```bash
cd ox-quiz
python3 tools/build_dataset.py      # docx → data/questions.json (+ 검증 리포트)
node --test tests/                  # 출제 확률·채점 단위 테스트
python3 -m http.server 8080         # http://localhost:8080 접속
```

> `index.html`을 파일로 바로 열면(file://) 브라우저가 JSON 로딩을 막습니다. 꼭 웹서버로 여세요.

---

## 2. 출제·채점 규칙

| 단계 | 동작 |
|---|---|
| 1 | 출제 범위 안의 **정지문 하나를 균등 확률**로 고름 |
| 2 | 50% 확률로 **정지문을 그대로** 냄 → 정답 **O** |
| 3 | 나머지 50%는 그 정지문의 **오지문 중 하나를 균등 확률로** 냄 → 정답 **X** |
| 3-예외 | **오지문이 없는 정지문**이면 50% 쪽에서도 정지문을 그대로 냄(정답 O). 그래서 그 정지문은 항상 O 문제로 나옵니다. 문항 선택 확률(1단계)을 바꾸지 않으려고 이렇게 정했습니다. 지금 데이터에는 이런 정지문이 0개입니다. |
| 4 | 맞히면 **'정답입니다'**, 다음 문제는 **[다음] 버튼**으로 넘어감(지문을 읽을 시간을 주려고 자동으로 넘기지 않음) |
| 5 | 정지문에 X라고 답해서 틀리면 **'오답입니다'**만 보여 줌 |
| 6 | 오지문에 O라고 답해서 틀리면 **'오답입니다' + 원래 정지문**을 보여 주고, 오지문과 **다른 부분을 노란색으로 강조**. 문서의 '변형 포인트'는 접힌 상태로 붙음(오지문이 단어를 '추가'만 해서 정지문에 강조할 부분이 없으면 펼쳐서 보여 줌) |
| 7 | 한 라운드(N문항, 기본 15, 시작 화면에서 10~20)가 끝나면 **맞은 문항 수 / 시도 문항 수** 창이 뜨고 [다시 하기]를 누를 수 있음 |
| 8 | 문제 위에 섹션 경로(예: `Ⅰ. 소제기 › 2. 소제기의 절차 › …`)를 작게 표시 |

- 피드백 문구 앞에는 O/X 기호를 붙이지 않습니다(`quiz-core.js`의 `feedbackText`).
- 시작 화면에서 **범위**(대단원·중단원)를 고를 수 있습니다. 과목이 2개 이상이면 과목 선택도 나타납니다.
### 문항당 제한 시간 (타이머)

- 시작 화면에서 **무제한(기본) / 10초 / 30초** 중에서 고릅니다. 마지막으로 고른 값은 localStorage(`prefs.timerId`)에 저장됩니다.
- 옵션 목록은 `js/quiz-core.js`의 `TIMER_OPTIONS` 한 곳에만 있습니다. `{ id, label, seconds }`를 추가하면 버튼이 자동으로 생깁니다. `seconds: 0`은 무제한입니다. 이미 저장된 값이 있으니 기존 `id`는 바꾸지 마세요.
- **무제한**: 타이머 UI가 없고, 동작은 타이머가 없던 이전 버전과 똑같습니다.
- **10초·30초**: 문제 위에 막대와 남은 초가 보이고, 3초 이하가 되면 빨간색으로 바뀝니다.
  - 시간이 다 되면 **오답**으로 처리됩니다(시도 수와 오답 수에 포함). 화면에는 작은 `시간 초과` 라벨과 함께 **'오답입니다'**가 나오고, 오답 규칙은 그대로 적용됩니다(오지문이었으면 정지문과 강조 표시, 정지문이었으면 '오답입니다'만).
  - 타이머는 **답하는 순간 또는 시간이 다 되는 순간 멈추고**, 피드백 화면에서는 돌지 않습니다. 다음 문제의 타이머는 **[다음]을 눌러 문제가 화면에 나타날 때** 새로 시작합니다.
  - 시간이 다 된 뒤의 탭이나 연타는 무시합니다. [다시 하기]나 [그만하기]를 누르면 타이머가 정리되고, interval이 남지 않습니다.
  - 남은 시간은 `시작 시각 + 제한 시간 − 현재 시각`으로 계산합니다(`js/timer.js`). 그래서 브라우저가 백그라운드 탭의 interval을 늦추거나 멈춰도 시간이 정확합니다. **탭이 숨겨져 있는 동안에도 시간은 흐릅니다(일시정지하지 않음).** 탭으로 돌아오면(`visibilitychange`) 즉시 다시 계산하고, 이미 시간이 지났으면 바로 시간 초과로 처리합니다.
  - 기록: 문항별 `stats[id].timeout`(wrong에도 포함), 라운드별 `timeouts`와 `timerId`. 결과 창에 `시간 초과 n`을 표시합니다.

### 계정 · 오답노트

- 처음 접속하면 **로그인 / 처음이에요(가입)** 화면이 나옵니다. 닉네임은 2~10자(한글·영문·숫자·`_ . -`)이고, 대소문자와 공백은 구분하지 않습니다(`Test 용A` = `test용a`). PIN은 숫자 6자리입니다.
- 로그인 폼은 일반 `<form>`이고, `autocomplete="username"`, `current-password`/`new-password` 속성이 붙어 있습니다. 로그인에 성공하면 폼을 숨기고 `history.pushState('#home')`을 호출하므로, Chrome·Safari 비밀번호 관리자가 닉네임과 PIN 저장을 제안합니다.
- 로그인 세션은 브라우저에 유지됩니다(supabase-js `persistSession`). 오른쪽 위 **로그아웃** 버튼으로 끝낼 수 있습니다.
- **오답노트 규칙**(`quiz-core.js`의 `applyWrongNote`와 DB 함수 `record_attempt`가 같은 규칙을 따름):
  - 묶음 단위는 **정지문**입니다. 정지문을 X라고 답하거나 그 정지문의 오지문을 O라고 답하면(시간 초과 포함) 해당 정지문이 오답노트에 들어가고, 틀린 횟수와 마지막으로 틀린 지문(오지문 ID)이 기록됩니다.
  - **오답노트 모드에서 2번 연속 맞히면**(`WRONG_NOTE_CLEAR_STREAK = 2`) 오답노트에서 빠집니다. 일반 모드에서 맞힌 것은 횟수에 들어가지 않습니다.
  - 어느 모드에서든 다시 틀리면 연속 정답 수가 0이 되고, 빠졌던 문항도 다시 들어옵니다.
- **오답노트 화면**: 섹션 경로, 정지문, 틀린 횟수, 마지막으로 틀린 날짜, 연속 정답 수를 보여 줍니다. '틀렸던 지문 보기'를 펼치면 틀렸던 오지문이 바뀐 부분 강조와 함께 나옵니다.
- **오답노트로 풀기**: 출제 규칙(50/50, 오지문 균등)과 제한 시간 옵션은 일반 모드와 같고, 활성 오답노트 항목에서만 출제합니다. 라운드 길이는 `min(설정한 문항 수, 오답노트 항목 수)`이고(복원 추출), 항목이 0개면 버튼이 비활성화됩니다. 라운드 도중에 빠진 항목도 그 라운드가 끝날 때까지는 계속 나올 수 있습니다.
- **저장 실패**: 모든 저장은 큐(`js/sync-queue.js`, localStorage)를 거칩니다. 네트워크가 끊기면 쌓아 두고, 다시 연결되거나(online 이벤트) 30초마다 순서대로 다시 보냅니다. 3초 넘게 남아 있으면 화면 아래에 작은 '저장 대기 n건' 알림이 뜹니다. 같은 응답이 두 번 저장되지 않도록 응답마다 `client_id`를 붙입니다. 오프라인에서도 오답노트와 기록은 로컬 캐시로 바로 갱신됩니다.
### 앱 설치(홈 화면에 추가)

- **앱 안에는 설치 버튼이나 안내가 없습니다.** Chrome(안드로이드·데스크톱)에서는 **⋮ 메뉴 → '앱 설치' 또는 '홈 화면에 추가'**로 설치합니다. iOS Safari에서는 공유 → '홈 화면에 추가'를 씁니다.
- 설치 조건은 `manifest.webmanifest`(이름, 아이콘 192/512·maskable, `start_url`/`scope` `./`, `display: standalone`), `sw.js` 서비스 워커, `index.html`의 meta 태그로 맞췄습니다.
- `beforeinstallprompt`는 가로채지 않습니다(`preventDefault`를 호출하지 않음). 그래서 Chrome의 기본 설치 UI가 그대로 동작합니다.
- 서비스 워커 동작:
  - 같은 출처 파일은 **네트워크 우선, 실패하면 캐시**를 씁니다. 배포하면 바로 새 버전이 보이고, 오프라인이면 마지막으로 받은 버전으로 열립니다.
  - supabase-js CDN(버전 고정 URL)은 캐시를 우선합니다.
  - Supabase API 요청에는 관여하지 않습니다.
  - 캐시를 강제로 비워야 하면 `sw.js`의 `VERSION` 값을 올리세요.

- 이전 버전에서 localStorage에만 저장하던 기록은 **서버로 옮기지 않습니다**(가져오기 기능 없음). 이전 데이터는 기기에 그대로 남아 있지만 화면에 표시하지 않습니다.

- 문제 번호(예: `13-1`)는 정답을 알려 주는 셈이라 화면에 표시하지 않습니다.
- 데스크톱 단축키: `O`/`←` = O, `X`/`→` = X, `Enter` = 다음.

---

## 3. 데이터 업데이트 방법

1. 원본 docx를 고칩니다(아래 4번 서식 규칙을 지켜 주세요).
2. 고친 파일을 `data/src/`에 넣습니다. 현재 파일 이름은 `jeongjimun.docx`(정지문)와 `ojimun.docx`(오지문)입니다.
   - **원본 docx는 저장소에 올리지 않습니다**(`.gitignore`에서 `*.docx` 제외). 관리자 PC나 작업 박스에만 두고, 빌드 결과인 `data/questions.json`만 커밋합니다. 저장소를 새로 받은 경우에는 docx를 직접 `data/src/`에 넣어야 빌드할 수 있습니다.
3. `python3 tools/build_dataset.py`를 실행하고, 출력된 리포트에서 **경고 0건**인지와 각 개수를 확인합니다.
   - CI처럼 경고가 있을 때 실패시키려면 `--strict` 옵션을 붙입니다.
4. `node --test tests/` → 커밋 → 배포(정적 파일 복사)합니다.

**과목 추가**: `data/subjects.config.json`의 `subjects` 배열에 `{id, name, trueDocx, falseDocx}`를 추가하고 다시 빌드합니다.
`id`(예: `civpro1-mid`)는 한 번 정하면 **바꾸지 마세요**. 문항 ID의 접두어로 쓰입니다.

---

## 4. 파서가 기대하는 docx 서식 규칙

파서는 `tools/build_dataset.py`이고, 외부 라이브러리 없이 `zipfile`과 XML로 `word/document.xml`의 **문단 텍스트**만 읽습니다(서식·표·각주는 무시).

공통
- **한 문단에 한 지문.** 줄바꿈(Shift+Enter)은 공백으로 바뀝니다.
- 맨 앞 **2문단(제목·부제)**은 건너뜁니다(`PREAMBLE_LINES`).
- `※`로 시작하는 문단은 안내문으로 보고 제외합니다.
- **제목(섹션) 문단**: 아래 형식으로 시작하고, **마침표로 끝나지 않는 짧은 문단(80자 이하)**이어야 합니다.

  | 레벨 | 형식 | 예 |
  |---|---|---|
  | 1 | 로마 숫자 + `.` | `Ⅰ. 소제기` |
  | 2 | 아라비아 숫자 + `.` | `1. 주요 개념` |
  | 3 | 한글 한 글자 + `.` | `가. 소장의 제출` |
  | 4 | 숫자 + `)` 또는 `⚫` 박스 제목 | `1) 소장의 기재사항`, `⚫ 민사소송절차에 관한 …` |
  | 5·6 | `(1)`, `가)` | (예비) |

정지문 파일
- 항목 형식: `번호. 문장` (예: `8. 소를 제기하려는 자는 …`)
- **번호는 문서 전체에서 1부터 이어지는 전역 번호**여야 합니다(섹션이 바뀌어도 다시 1부터 시작하지 않음).
- `1. 주요 개념` 같은 제목과 구분하는 기준: **① 번호가 직전 항목 번호보다 크고 +5 이내 ② 문장이 마침표로 끝남**을 둘 다 만족하면 항목이고, 아니면 제목으로 봅니다. 번호가 건너뛰거나 순서가 어긋나면 리포트에 경고가 나옵니다.

오지문 파일
- 항목 형식: `N-k. 문장` (N = 정지문 번호, k = 1부터 매기는 가지번호. 예: `13-1.`, `13-2.`)
- 섹션 제목은 정지문 파일과 같게 둡니다. 다만 앱의 섹션 경로는 **정지문 파일을 기준**으로 하고, 두 문서가 다르면 리포트에 '섹션 경로 불일치'로 나옵니다.
- 맨 뒤의 **`정답·변형 포인트`** 문단 다음부터는 변형 포인트 목록으로 읽습니다. 형식: `N-k〔유형〕 원래 표현 → 바뀐 표현`. 한 줄에 여러 개가 있으면 `｜`로 구분합니다.

검증 리포트(`data/build_report.txt`) 항목: 정지문 수, 오지문 수, 오지문이 0개인 정지문, 고아 오지문(N번 정지문이 없음), 번호 중복, 정지문과 글자가 똑같은 오지문, 섹션 불일치, 변형 포인트 누락/고아, 분류하지 못한 문단.

---

## 5. 데이터 스키마 (`data/questions.json`)

```jsonc
{
  "schemaVersion": 1,
  "version": "7c8efbda",            // 문항 내용 해시. 내용이 바뀌면 값도 바뀜
  "generatedAt": "2026-10-10T17:05:53+09:00",
  "sources": [{ "subject": "civpro1-mid", "kind": "true", "file": "data/src/jeongjimun.docx", "sha1": "…" }],
  "subjects": [{
    "id": "civpro1-mid", "name": "민사소송법1 중간", "title": "…docx 제목…",
    "itemCount": 682, "wrongCount": 780,
    "items": [{
      "id": "civpro1-mid-0013",     // 고정 ID = 과목ID-정지문번호(4자리)
      "no": 13,
      "section": ["Ⅰ. 소제기", "2. 소제기의 절차", "가. 소장의 제출", "1) 소장의 기재사항"],
      "answer": "피고의 주소는 …",   // 정지문 문장(번호 제외)
      "hash": "9f4841c7",           // 문장 해시(같은 ID의 문장이 바뀌었는지 확인용)
      "wrongs": [{
        "id": "civpro1-mid-0013-1", // 고정 ID = 정지문ID-가지번호
        "no": "13-1",
        "text": "피고의 주소는 …",
        "hash": "1ee87df5",
        "point": { "type": "기타", "change": "필수적 기재사항은 아니지만 → 필수적 기재사항이고" }
      }]
    }]
  }]
}
```

**ID 안정성 규칙**: ID는 **문서의 번호**로 만듭니다. 그래서 문장을 고쳐도 ID는 그대로이고 사용자 기록도 유지됩니다(바뀐 문장은 `hash`로 알 수 있음).
반대로 **번호를 다시 매기면(중간에 끼워 넣고 뒤 번호를 밀면) 기록이 엉뚱한 문항에 붙습니다.** 새 문항은 **맨 뒤 번호**로 추가하고, 지운 번호는 다시 쓰지 않는 것을 권장합니다(번호가 빠져도 경고만 나오고 빌드는 됩니다).

---

## 6. 구조

```
ox-quiz/
├─ index.html              화면 마크업(시작 / 문제 / 결과 모달)
├─ manifest.webmanifest    홈 화면 추가(PWA 기본 정보)
├─ sw.js                   서비스 워커(설치 가능 조건 + 오프라인 앱 화면)
├─ css/style.css           모바일 우선, safe-area, 다크모드
├─ js/
│  ├─ quiz-core.js         ★ 순수 로직: 출제(pickQuestion)·채점(grade)·라운드·섹션 필터·diff. DOM 의존 없음
│  ├─ timer.js             문항당 카운트다운(타임스탬프 기반, 시계/스케줄러 주입 → 테스트 가능)
│  ├─ auth-utils.js        닉네임 정규화·검증, 닉네임 → 내부 이메일 변환 (순수 함수)
│  ├─ sync-queue.js        저장 재시도 큐 (localStorage 영속, 순서 보장, 순수 로직)
│  ├─ supabase-store.js    서버 저장소: 인증, 라운드·응답 저장, 오답노트 조회, 오프라인 캐시
│  ├─ config.js            Supabase URL / publishable key / supabase-js CDN 주소
│  ├─ storage.js           기기별 설정(문항 수·범위·타이머) 저장 (LocalProgressStore.prefs)
│  └─ app.js               UI 계층(로그인, 홈, 오답노트, 퀴즈, 결과)
├─ data/
│  ├─ subjects.config.json 과목 목록과 원본 docx 경로
│  ├─ src/*.docx           원본 문서 (로컬 전용, git 제외)
│  ├─ questions.json       빌드 결과(앱이 읽는 파일)
│  └─ build_report.txt     검증 리포트
├─ tools/
│  ├─ build_dataset.py     docx → JSON 파서·검증
│  ├─ make_icons.py        아이콘 생성(Pillow)
│  ├─ screenshots.cjs      헤드리스 크롬 퀴즈/타이머 E2E + 스크린샷 (OX_NICK/OX_PIN 필요)
│  └─ e2e-supabase.cjs     실제 Supabase 대상 E2E: 가입·로그인·RLS·오답노트·오프라인 큐·지속성
├─ supabase/
│  ├─ migrations/*.sql     DB 스키마·RLS·record_attempt 함수 (적용된 마이그레이션 원본)
│  └─ functions/signup/    가입 Edge Function (닉네임+PIN → Auth 사용자 생성)
├─ tests/quiz-core.test.js node --test: 확률 분포 시뮬레이션, 채점 분기, 시간 초과 채점, 타이머(가짜 시계), 라운드, 저장소, 전체 데이터 diff
└─ screenshots/            모바일 화면 캡처
```

### 서버 구조 (Supabase)

- 프로젝트: `ox-quiz` (ref `pmplhnxhxdbuqoflgthb`, 서울 `ap-northeast-2`, Free 플랜, 조직 LawTF)
- 클라이언트는 supabase-js v2를 CDN ESM으로 불러옵니다(빌드 없음). 커밋된 publishable key는 공개되어도 괜찮은 키이고, 데이터는 **RLS**로 보호합니다(모든 테이블에서 `auth.uid() = user_id`인 행만 읽고 쓸 수 있음. anon 역할은 테이블 접근 권한 없음).

**인증 방식**: Supabase Auth의 이메일+비밀번호 방식을 그대로 씁니다.
- 닉네임을 정규화(NFKC, 공백 제거, 소문자)한 뒤 UTF-8 hex로 바꿔 **내부 이메일** `u<hex>@ox-quiz.invalid`로 만듭니다. 예: `test용a` → `u74657374ec9aa961@ox-quiz.invalid`. `.invalid`는 예약 도메인이라 메일이 실제로 발송되지 않습니다.
- PIN이 곧 비밀번호입니다(6자리, Supabase 최소 길이 6자).
- **가입**은 Edge Function `signup`이 처리합니다(Admin API, `email_confirm: true`). 그래서 대시보드에서 'Confirm email'을 끄지 않아도 바로 로그인할 수 있습니다. 닉네임 중복은 이메일 고유성으로 막고, 이미 있으면 409를 돌려줍니다.
- publishable key는 JWT가 아니므로 이 함수는 `verify_jwt=false`로 배포했습니다. 대신 함수 안에서 입력을 직접 검증합니다. 공개 키만 있으면 누구나 부를 수 있다는 점에서 Supabase 기본 signUp과 같은 수준입니다.
- 로그인은 클라이언트가 `signInWithPassword`를 직접 호출합니다.

**테이블** (`supabase/migrations/20261010090000_init_schema.sql`)

| 테이블 | 주요 컬럼 | 비고 |
|---|---|---|
| `profiles` | user_id(PK), nickname(표시용), nickname_norm(unique) | auth.users에 사용자가 생기면 트리거(`private.handle_new_user`)가 자동 생성 |
| `rounds` | id(클라이언트 UUID), mode(normal/wrongnote), timer_sec, total, attempted, correct, timeouts, started_at, finished_at | 시작할 때 행을 만들고 끝날 때 갱신. 중간에 그만둔 라운드는 finished_at이 null |
| `attempts` | client_id(중복 방지), item_id(정지문 ID), variant_id(오지문 ID 또는 null), shown_type(O/X), user_answer(O/X, 시간 초과면 null), correct, timed_out, mode, round_id, created_at | `unique(user_id, client_id)` |
| `wrong_notes` | (user_id, item_id) PK, wrong_count, last_wrong_at, correct_streak, cleared, cleared_at, last_variant_id | 오답노트 |

**RPC** `record_attempt(...)`: `SECURITY INVOKER` 함수라 RLS가 그대로 적용됩니다. 응답 저장과 오답노트 갱신을 **한 트랜잭션에서 원자적으로** 처리하고, 같은 `client_id`로 다시 호출되면 아무것도 바꾸지 않습니다.

**스키마를 바꿀 때**: `supabase/migrations/`에 새 SQL 파일을 추가하고, Supabase SQL Editor(또는 CLI `supabase db push`)로 적용합니다.

**기기별 localStorage 키**
- `oxquiz.auth`: 로그인 세션
- `oxquiz.v1`: 설정(prefs)
- `oxquiz.queue.<userId>`: 저장 대기 큐
- `oxquiz.cache.<userId>`: 최근 기록·오답노트 캐시

### 관리자 작업 (Supabase 대시보드)

- **PIN 초기화**:
  1. 대시보드 → Table Editor → `profiles`에서 닉네임을 찾아 `user_id`를 확인합니다.
  2. Authentication → Users에서 그 사용자(내부 이메일 `u…@ox-quiz.invalid`)를 찾습니다. 사용자 메타데이터에도 닉네임이 들어 있습니다.
  3. **⋯ → Reset password는 메일을 보내는 기능이라 쓸 수 없습니다.** 대신 SQL Editor에서 실행하세요:
     ```sql
     update auth.users set encrypted_password = crypt('새PIN6자리', gen_salt('bf'))
     where id = (select user_id from public.profiles where nickname_norm = '정규화된닉네임');
     ```
     (정규화된 닉네임 = 소문자·공백 제거. 예: `Test 용A` → `test용a`)
- **사용자 삭제**: Authentication → Users에서 삭제하면 프로필·기록·오답노트가 함께 지워집니다(`on delete cascade`).
- **닉네임 변경**: 내부 이메일이 닉네임에서 만들어지므로 간단하지 않습니다. 현재는 지원하지 않습니다(필요하면 auth.users.email과 profiles를 함께 바꿔야 함).

### 한계 · 보안 메모

- **PIN 6자리는 약한 비밀번호입니다.** 경우의 수가 100만 가지라, 닉네임을 아는 사람이 오래 무차별 대입하면 뚫릴 수 있습니다. Supabase Auth의 IP별 요청 제한이 어느 정도 막아 주지만, 시험 대비 기록 정도의 낮은 민감도에만 맞는 설계입니다. 민감한 정보는 저장하지 마세요.
- 보안 어드바이저의 'Leaked Password Protection Disabled' 경고는 **일부러 무시했습니다.** 이 기능을 켜면 대부분의 6자리 숫자 PIN이 유출 목록에 걸려 가입할 수 없습니다(게다가 유료 플랜 기능).
- PIN을 잊으면 본인이 재설정할 수 없고 관리자가 초기화해야 합니다(위 SQL 참고).
- Supabase Free 플랜 프로젝트는 **1주일 동안 활동이 없으면 일시 중지**됩니다. 대시보드에서 Restore를 누르면 다시 켜집니다.
- 가입 Edge Function의 CORS 허용 목록은 `https://osh925.github.io`와 `localhost:8080`입니다. 도메인을 바꾸면 `supabase/functions/signup/index.ts`의 `ALLOWED_ORIGINS`를 고치고 다시 배포하세요.

---

## 7. 배포

**현재 배포: GitHub Pages** (`main` 브랜치 루트, `.nojekyll` 포함) → https://osh925.github.io/ox-quiz/

- `main`에 push하면 1~2분 뒤 자동으로 반영됩니다. 데이터 갱신 절차: docx 수정 → `python3 tools/build_dataset.py --strict` → `node --test tests/` → `data/questions.json` 커밋 → push.
- 사이트가 `/ox-quiz/` 하위 경로에서 서비스되므로, HTML·JS·manifest 안의 경로는 모두 **상대 경로**(`data/questions.json`, `icons/…`, `start_url: "./"`)로 유지해야 합니다. `/`로 시작하는 절대 경로를 쓰면 깨집니다.
- 브라우저 캐시 때문에 갱신이 늦게 보이면 새로고침하세요(데이터는 `cache: 'no-cache'`로 불러옵니다).
- 다른 정적 호스팅(Netlify, Vercel, Cloudflare Pages)으로 옮겨도 그대로 동작합니다.
- 원본 docx는 공개 저장소에 없습니다(저작권·공개 범위 때문). `data/questions.json`에는 문장 텍스트가 들어 있으므로 사이트 자체는 공개 상태라는 점에 유의하세요.

---

## 8. 로드맵

1. ~~공유 백엔드~~ · ~~계정~~ · ~~오답노트 모드~~ → 완료(Supabase, 닉네임+PIN)
2. 더 강한 인증(카카오/구글 OAuth, 또는 PIN 시도 횟수 제한 Edge Function), 사용자가 직접 PIN 변경
3. 이전 localStorage 기록을 서버로 가져오기, 문항별 정답률 통계 화면(attempts 집계)
4. **간격 반복(SRS)**: 문항별 다음 복습일(SM-2/Leitner)을 두고, 그날 볼 문항을 우선 출제합니다. 이때 `pickQuestion`에 가중치 전략을 주입합니다(지금의 균등 규칙은 기본 전략으로 남김).
5. **여러 과목**: config에 과목을 추가합니다. 과목이 많아지면 `questions.json`을 과목별 파일로 나누고 필요할 때 불러옵니다.
6. **관리자 편집**: 웹에서 지문을 고치거나 신고받기(오탈자·정답 오류). 백엔드 도입 후 docx 대신 DB를 원본으로 삼을지 결정합니다.
7. 오프라인 지원(Service Worker), 문항별 통계 대시보드, 라운드 기록 내보내기.
