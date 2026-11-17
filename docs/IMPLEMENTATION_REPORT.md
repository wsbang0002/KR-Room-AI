# KNU Room AI v0.5 구현·검증 보고

작성일: 2026-11-17 (대한민국 시간 기준). 사용자 요청에 따라 v0.4 원본을 분석한 뒤 개발하고, 후속 Redis 운영 정책이 첨부 문서의 LabFix 관련 요구보다 우선하도록 반영했습니다.

## 상태

| 항목 | 상태 | 검증 근거 / 한계 |
| --- | --- | --- |
| 기존 소스 분석·기준 테스트 | 완료 | v0.4 의존성 없는 Node 구조, public/api/lib/data/scripts/test 검토. 최초 9/9 통과 |
| 전국 검색·동명이인 선택 | 완료 | 17개 시도·3,830개 행정구역 명칭. 2026-04-01 인덱스 고정, 최신 개편·법정동 전수는 미검증 |
| Gemini 연동·검증·기본 파서 | 부분 완료 | 관리자·Redis 호출 제한, JSON 검증, fallback, 사용 여부 진단. 실제 키 미설정으로 실호출 미검증 |
| Apify 비동기·Dataset | 부분 완료 | 시작/상태/실패/완료/0건 Mock 검증. 공식 공개 Actor schema GET 확인. 인증 Dataset GET·유료 Actor POST 미실행 |
| Redis 영속 매물·지역 캐시·갱신일 | 부분 완료 | TTL 없는 upsert·ID 중복 갱신·stale·독립 TTL 캐시 Mock 통과. 실제 Upstash 미연결 |
| Redis 운영 전환 | 부분 완료 | 기존 KNU_Room_AI DB만 환경변수로 연결. PING/SCAN 조회 명령·관리자 API 구현. 새 DB·LabFix 작업·기존 키 삭제 없음 |
| JSON 백업·복원 | 완료 | KNU 매물 전용, 원본 날짜 유지, 전체 검증 후 upsert, 외부 키 제외. Mock 검증 |
| Apify 계정 $5 / $4.50 차단 | 부분 완료 | 공식 Limits 응답 필드 검토. 신규 실행 전 fail closed. Lua 전역 잠금·월간/일일 원자 예약·확인된 비용만 차액 정산. 실계정·실Redis Lua 실행 미검증 |
| 추천 | 완료 | 필수 조건 분리, 50/35/15 가중치, 미확인 후보·정보 근거 비율·수집일·슬라이더. 실제 경로 없는 매물은 시간 미확인 |
| 지도 | 부분 완료 | OSM 좌표 iframe 구현. 실제 지도 서비스 응답·데이터 위치 정확도는 미검증 |
| 실제 이동시간 | 부분 완료 | TMAP 도보/자동차 어댑터 Mock 통과, 유료 검색 연결 안 함. 대중교통·목적지 좌표/요금/권한 미구현·미검증 |
| 전체 자동 테스트 | 완료 | 로컬 Node 20/24: 각각 74/74. GitHub Windows/Linux × Node 20/22: 4개 작업 모두 74/74. 외부 서비스는 Mock, 로컬 HTTP 통합 포함 |
| 브라우저 검증 | 완료 | Chromium: 390px 모바일/1440px 데스크톱, 지역 선택·데모·인증·수집 잠금. 가로 넘침·JS 오류 없음 |
| GitHub main | 완료 | 구현 커밋 `90b2abf1d604bfc2bfd96f4652f509729dc584db`, 45개 파일 반영. GitHub Actions #1의 Windows/Linux × Node 20/22 4개 작업 모두 success |
| Vercel 실제 배포 | 완료 | https://kr-room-ai.vercel.app/ 실제 화면·데모 검색·API 검증. 최초 FUNCTION_INVOCATION_FAILED는 framework=null 및 빈 buildCommand 지정 후 해결. Gemini/Apify/Redis 운영 연동은 별도 미검증 |
| 과제의 실제 2-API 사용 | 미검증 | Gemini+Apify 인증 실호출 증거 없음. Apify 인정 여부·외부 사용자 시험도 별도 확인 필요 |

## 수정·추가 파일

수정: `package.json`, `.env.example`, `.gitignore`, `README.md`, `server.js`, `vercel.json`, `api/search.js`, `api/status.js`, `lib/core.js`, `lib/apify.js`, `public/index.html`, `public/app.js`, `public/style.css`.

추가 API: `api/collect.js`, `api/collect-status.js`, `api/listings.js`, `api/redis-inspect.js`.

추가 모듈: `lib/regions.js`, `lib/conditions.js`, `lib/gemini.js`, `lib/recommend.js`, `lib/security.js`, `lib/store.js`, `lib/collection.js`, `lib/apify-budget.js`, `lib/monthly-budget.js`, `lib/listing-store.js`, `lib/routes.js`.

추가 데이터/문서: `data/regions.json`, `docs/apify-input-schema.json`, `docs/LICENSE-regions.txt`, `docs/EXTERNAL_SERVICES.md`, 이 보고서.

추가 운영/테스트: `scripts/redis-inspect.js`, `scripts/redis-backup.js`, `scripts/redis-restore.js`, `test/budget.test.js`(신규 첨부의 6개 유지), `test/v05.test.js`, `test/redis-budget.test.js`, `test/http.test.js`, `test-support/fake-redis.js`, `.github/workflows/test.yml`.

보존: 기존 `test/core.test.js`, `test/remote.test.js`, `scripts/import-apify.js`, 원본 `data/listings.json`. 원본 매물 파일은 바이트 동일하며 SHA256 `1c8bad282a7370cc02dbf6c1c79b7196ca39c3b9547d71b366a1d48798064f71`입니다. 실제 매물의 공개 재게시 권리 미확인으로 이 파일은 공개 GitHub에서 제외합니다. 사용자 첨부 ZIP과 로컬 작업본에는 그대로 있습니다. 공개 배포에서는 서버 환경변수의 Apify Dataset을 사용합니다.

## Redis 검증의 범위

사용자가 제공한 DB 이름·GCP 리전·Free Tier·0 commands / 0 B 표시를 기록했지만 실제 연결 검증으로 간주하지 않았습니다. 이 환경에는 `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`이 없으므로 실제 Redis 명령은 실행하지 않았습니다. 모든 비용/영속성/동시성 검사는 FakeRedis 모델 또는 REST Mock입니다. Lua 문자열은 구현했지만 실제 Upstash의 EVAL·KEEPTTL·SCAN 호환성과 동시성은 배포 환경에서 추가 검증해야 합니다.

모든 키는 `knuroom:`이며 매물·지역 인덱스는 TTL 없이 저장합니다. 기존 키는 PING/SCAN 검사에서 보고만 합니다. 전체 삭제·LabFix 삭제/이전 기능은 없습니다. 비용 종료 정산 시에만 이 앱이 소유한 활성 잠금을 requestId 확인 후 해제합니다.

월간 비용은 관측 사용량과 앱 예약액을 보수적으로 합산하므로 실제 비용보다 일찍 차단할 수 있습니다. 응답 유실·미확정 비용은 과금 주기 종료+7일까지 잠금을 유지합니다. 외부 Actor/프로젝트의 사용과 실청구액을 앱만으로 절대 보장할 수 없습니다.

## 운영 전 다음 작업

1. 지정 GitHub main 소스를 Vercel에 Import하고 서버 환경변수 설정. 먼저 `ENABLE_LIVE_COLLECTION=false` 유지.
2. 기존 Upstash 연결 후 관리자 `GET /api/redis-inspect` 또는 `npm run redis:inspect`로 PING/SCAN 실제 성공·기존 키 확인. 발견 키는 삭제하지 않기.
3. Apify Limits GET의 실제 $5 이하 계정 한도·월간 사용량·과금 주기 확인, Redis Lua 원자 잠금/예약 검증.
4. 승인된 테스트 환경에서 Gemini 호출과 최대 10건·$0.50 상한 Actor 1회 실검증. 이번 작업에서는 수행하지 않음.
5. 목적지 명칭·좌표 확인, 경로 API 현행 요금/무료량·인증·권리 검토 및 비용 제한을 추가한 뒤 TMAP/대중교통 실연결.
6. GitHub CI 통과 확인과 Vercel 배포 후 실제 URL에서 사용자 흐름 확인. 미완성 연결을 완료로 표기하지 않기.

## 원격 검증 링크

- 소스: https://github.com/wsbang0002/KR-Room-AI
- 구현 커밋: https://github.com/wsbang0002/KR-Room-AI/commit/90b2abf1d604bfc2bfd96f4652f509729dc584db
- 통과한 4개 CI 작업: https://github.com/wsbang0002/KR-Room-AI/actions/runs/44028431354

코드 구현과 실제 운영 계정 연결은 구분했습니다. Redis PING/SCAN, Gemini API, Apify 계정 Limits/유료 Run/Dataset, TMAP 실제 호출은 아직 하지 않았습니다. 공개 Actor 메타데이터·공식 문서 조회만 실외부 GET으로 수행했습니다.

## 실제 Vercel 배포 후 검증

사용자가 연결한 https://kr-room-ai.vercel.app/ 의 최초 배포에서 홈페이지·모든 API에 500 FUNCTION_INVOCATION_FAILED가 발생했습니다. `vercel.json`의 `framework: null`, `buildCommand: ""`를 명시해 자동 프레임워크 감지를 끄고 정적 public + api 함수 구성을 적용한 커밋 `1256ed991c66bead64b099c676a70176ca6a14d5`로 자동 재배포 후 해결했습니다.

- 홈페이지, app.js, style.css: 200.
- /api/status: 200, v0.5.0. Gemini/Apify/Redis 설정 false, 신규 수집 false, 실매물 관리자 전용 true.
- 데모 POST /api/search: 200, 서울 관악구 해석·월세 40만원 조건·가상 매물 3건. 실제 Chromium 화면에서도 확인.
- 중구 동명이인 데모 검색: 422.
- 미인증 실매물 검색/신규 수집/Redis 검사: 각각 401.
- GET /api/search: 405.
- 수정 후 로컬 테스트 74/74, Windows/Linux × Node 20/22 CI 4개 작업 모두 success.

외부 유료 호출은 하지 않았습니다. 실제 Redis PING/SCAN과 Gemini/Apify 인증 연동은 환경변수를 등록한 후 검증해야 합니다.
