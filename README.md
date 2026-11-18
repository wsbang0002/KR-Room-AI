# KNU Room AI v0.6

지역과 예산을 대화로 조정하고 월세·관리비·통학시간을 비교할 수 있는 전국 자취방 검색 서비스입니다. 화면 우측 상단에서 라이트·다크 테마를 바꿀 수 있습니다.

## 실행

Node.js **20.19 이상**. 외부 npm 런타임 의존성이 없습니다. 프로젝트 루트는 이 파일과 `package.json`이 있는 `knu-room-ai/`입니다.

```powershell
Copy-Item .env.example .env
npm.cmd test
npm.cmd run dev
```

http://localhost:3000 에서 환경변수 없이 검색 조건을 입력하고 수정할 수 있습니다. 예를 들어 ‘원주시 무실동, 관리비 포함 월 50만 원 이하’ 뒤에 ‘중앙동으로 바꿔줘’라고 하면 같은 이름의 동을 조회해 시·군·구를 묻습니다. ‘원주시요’라고 답하거나 주소를 선택하면 예산을 유지합니다. 기본 운영 설정에서 로그인 전에는 검색 조건을 정리할 수 있습니다.

비공개 실매물을 보려면 홈 상단 **로그인**을 누르고 Vercel에 설정한 32자리 `ADMIN_API_KEY`를 입력하세요. 같은 화면에서 지역과 예산으로 저장된 매물을 검색할 수 있습니다. 서버는 검색용 쿠키(`HttpOnly`, `SameSite=Strict`)를 발급합니다. 브라우저는 새로고침 후에도 로그인을 유지하며, 1시간이 지나거나 **로그아웃**을 누르면 다시 키가 필요합니다.

연결 검사와 신규 수집은 운영 콘솔 `/admin`에서 관리합니다. 운영 콘솔은 키를 페이지 메모리에서만 사용하며 별도의 Bearer 인증을 요구합니다. 같은 키로 운영 기능에도 접근할 수 있으므로 운영 권한이 있는 사람만 보관하세요.

`data/listings.json`은 단계동·무실동 스냅샷이며 흥업면/캠퍼스 주변으로 치환하지 않습니다. 기본 지역 검색에서는 필수 지역을 확인할 수 없는 후보로 분리되거나 제외됩니다. `강원 원주시`를 명시하면 원주 스냅샷을 검색할 수 있습니다. 관리비는 만원, Apify 원본 `maintenance_cost`만 원→만원 변환합니다. 옵션 빈 배열·미확인 시간은 충족으로 간주하지 않습니다. 원본 사진을 재게시하지 않습니다.

## 기능과 API

- 전국 지역: 17개 시도, 시군구·읍면동 명칭 검색과 중복 지명 선택. `data/regions.json`은 SGIS / vuski/admdongkor 행정구역 인덱스의 **2026-04-01** 명칭을 추출한 3,830개 항목입니다. 요청 명세의 광주·전남 별도 구성을 지원하기 위해 이 시점을 고정했습니다. 최신 행정개편 및 법정동과 행정동의 차이는 별도 검증 대상입니다. 미등록 명칭을 실존 지역으로 추정하지 않습니다. 출처·라이선스는 `docs/LICENSE-regions.txt` 참조.
- 자연어 검색은 지역 명칭과 이전 조건을 서버에서 확인합니다. 로그인 후 새 검색을 시작하면 설정된 AI가 추가 조건을 해석할 수 있습니다. 매물 공개 후에는 비로그인 검색에도 무료 OpenRouter를 사용할 수 있습니다. 비공개 운영 중 로그인 전의 조건 정리와 지역 확인 응답은 자체 파서를 사용합니다. 무료 모델의 단가 제한과 Redis 일일 예산을 적용합니다.
- Apify: 고정 Dataset 조회·수동 import 유지. 지역별 신규 Actor는 비동기 시작→상태 조회→Dataset 조회. Actor와 빌드 `1.0.12`는 서버 고정이며 임의 Actor/URL/건수/비용을 받지 않습니다. 공개 스키마는 `docs/apify-input-schema.json`에 저장했습니다.
- 추천: 필수 지역·예산·방 유형·필수 옵션·이동시간을 먼저 검증. 정보 부족 후보를 `unverified`로 분리. 비용 50%, 이동시간 35%, 옵션 15% 기본값과 자연어 우선순위 변경(예: ‘비용 우선’)을 지원합니다. 누락된 항목의 점수를 다른 항목으로 재분배하지 않으며 점수 근거 비율과 수집일을 표시합니다.
- 지도: 선택 매물 좌표를 OpenStreetMap iframe으로 표시. 대략적 좌표 표시이며 실제 경로 계산과 다릅니다. 최초 지도 선택 시 OSM 외부 요청이 발생합니다.
- 승인된 운영 사이트에서는 원주역·관악산역 등 공개된 역에서 인근 캠퍼스까지 TMAP 도보 경로를 계산할 수 있습니다. 선택한 지점은 대표 좌표입니다. 매물 공개 전에도 이 기능을 이용할 수 있습니다. 매물 조회 권한은 별도로 확인합니다.
- 매물 검색에서는 이동시간을 요청했을 때 목적지를 먼저 확인합니다. 지역·가격 등으로 후보를 좁힌 뒤 최대 5건을 조회합니다. 자동차·대중교통의 실경로 계산은 미지원입니다. 일일 예산과 활성화·중지 방법은 [TMAP 운영 기준](docs/TMAP.md)을 참고하세요.

| Endpoint | 동작 |
| --- | --- |
| POST `/api/session` | 로그인 키를 Bearer로 검증하고 매물 검색용 쿠키 발급 |
| GET / DELETE `/api/session` | 검색 로그인 상태 확인 / 현재 브라우저에서 로그아웃 |
| POST `/api/conditions` | `{query,previous?,pending?}` → 확정 조건 또는 구분이 필요한 지역 질문·선택지 |
| POST `/api/destinations` | `{query}` → 학교·직장 목적지 ID, 주소, 좌표 출처 |
| GET `/api/routes/walking?places=public` | 공개 출발역과 인근 캠퍼스 목록 |
| POST `/api/routes/walking` | `{publicOriginId,destinationId}` → 공개 장소 간 보행 경로 |
| POST `/api/routes/walking` | `{listingId,destinationId,diagnostic?,confirmFreePlan?}` → 검증된 시간·거리 또는 미확인 사유 |
| POST `/api/search` | `{query,confirmedConditions?,edits?,jobId?,destinationId?}` → 지역·조건·추천·미확인 후보 |
| POST `/api/collect` | `{query,confirmedConditions?,edits?}` → 202, jobId/runId/state; 인증 필수 |
| GET `/api/collect-status?jobId=...` | READY/RUNNING/SUCCEEDED/FAILED/ABORTED/TIMED-OUT 등 |
| GET `/api/listings?jobId=...` | 성공 Dataset 정규화·중복 제거·원래 조건 추천 |
| GET `/api/status?scope=coverage` | 제공 지역·건수·출처·갱신일 집계. 비공개 운영 중 로그인 전에는 공개 상태만 반환 |
| GET `/api/status` | 설정 여부만; 실호출 성공 증명이 아님 |

`edits`는 location, destination, maxDeposit, maxRent, maxMonthlyTotal, maxCommuteMinutes, transportMode, weights를 지원합니다. 금액 단위는 만원입니다. `DATA_RIGHTS_REVIEWED=false`이면 홈에서 로그인한 뒤 실매물을 조회할 수 있습니다. 재게시 권리를 검토한 뒤에만 공개 설정을 변경하세요. 검색용 세션은 운영 진단과 신규 수집 권한을 부여하지 않습니다.

## 신규 유료 수집 보호

기본 `ENABLE_LIVE_COLLECTION=false`. 인증·Redis가 없으면 활성화할 수 없습니다. 준비된 환경에서만 아래 항목을 설정합니다.

- `ADMIN_API_KEY`: 24자 이상 난수 비밀키. 계정별 인증 대신 단일 관리자 권한을 제공합니다.
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`: HTTPS Redis REST. EVAL 가능 권한 필요.
- `APIFY_TOKEN`, `ENABLE_LIVE_COLLECTION=true`.
- `APIFY_MAX_COST_USD=0.50`: 1회 최대 $0.50, 더 큰 값 거부. Apify `maxTotalChargeUsd` 전달.
- `APIFY_DAILY_BUDGET_USD=1.00`: UTC 일별 최대 비용 예약 합계. 서버 상한 $5.
- `COLLECTION_DAILY_LIMIT=2`: 관리자별 UTC 하루 실행 상한. 서버 상한 10.
- `CACHE_TTL_SECONDS=3600`: 동일 수집 조건 캐시/잠금. 600~86400초.

Redis Lua 한 번으로 중복 잠금·전역 실행 잠금·호출 횟수·월간/일일 예산 예약을 처리합니다. Vercel 여러 인스턴스에서도 같은 저장소를 사용해야 합니다. 실패 또는 비용 미확인 시 예약은 유지하고, 종료 Run의 비용이 확인되면 미사용 차액만 해제합니다. timeout으로 Actor 시작 여부가 불명확하면 `START_UNCONFIRMED`로 잠그며 자동 재실행하지 않습니다. Redis 저장 실패나 시작 여부·비용 미확인 상태에서는 Apify Console을 확인해야 합니다. 예약 이후 POST를 재시도하면 이중 과금될 수 있으므로 운영자가 이력을 검토해야 합니다.

초기 건수는 항상 최대 10건, 1페이지, 실행 timeout 180초입니다. 브라우저 취소는 조회만 중단하며 Actor는 계속 실행될 수 있습니다. Apify Console에서 중단하세요. 캐시를 무시하는 요청 옵션은 없습니다. 런타임 메모리 캐시는 기존 Dataset 읽기 최적화에만 사용합니다. 신규 수집 상태·예산·중복 잠금은 Redis와 Apify에 저장합니다. Redis 장애 시 수집을 거부합니다.

## GitHub main → Vercel

배포 대상은 https://github.com/wsbang0002/KR-Room-AI 입니다. **이 폴더 안의 내용**이 저장소 루트가 됩니다. Vercel에서 이 저장소를 Import하면 이후 main push를 자동 배포할 수 있습니다.

```powershell
# 기존 저장소에서 변경 파일을 검토한 뒤
npm.cmd test
git add .
git commit -m "Implement KNU Room AI v0.5 nationwide search"
git push origin main
```

Vercel에서 기존 GitHub 저장소 연결을 유지하고 Framework `Other`, Root Directory `package.json` 위치, Output Directory `public`, 별도 Build Command 없음, Node.js 22.x 또는 지원되는 20.19+를 사용하세요. `api/*.js`는 Node Functions이며 `vercel.json`은 각 함수 최대 30초와 데이터 파일 포함을 선언합니다. Actor 완료까지 기다리지 않습니다. 플랜별 함수 제한과 실제 빌드 동작은 Vercel 배포 후 확인해야 합니다.

`.env.example`의 서버 환경변수를 Vercel 프로젝트 Settings에 입력하고 다시 배포하세요. **실제 키를 Git에 넣지 마세요.** `.github/workflows/test.yml`에 Linux/Windows × Node 20/22 CI를 추가했습니다. GitHub branch protection 및 Vercel의 검사 결과 대기 설정을 적용해야 실패한 CI가 자동 배포를 막습니다. 워크플로가 추가된 것만으로 배포 차단을 보장하지 않습니다.

배포 후 `/`에서 지역 확인과 조건 유지, `/admin`의 인증, `/api/status`의 공개 여부와 비용 잠금 상태를 확인하세요.

## 수동 자료 갱신

```powershell
npm.cmd run import -- "C:\경로\dataset.json"
```

원본 ID로 중복 제거하고 기존 데이터 파일을 갱신합니다. 원본을 별도 보관한 뒤 실행하세요. Vercel 함수는 로컬 JSON을 영속 DB로 수정하지 않습니다. 원본 제공 자료 10건은 이번 개발에서 변경하지 않았습니다. 공개 GitHub에는 재게시 권리가 검증되지 않은 `data/listings.json`을 올리지 않습니다(`.gitignore`). 원본 10건은 사용자 첨부 ZIP과 개발 작업본에 그대로 보존합니다. GitHub 기반 배포에서는 서버의 `APIFY_DATASET_ID`로 원본 Dataset을 조회하세요. 로컬 import 결과도 기본적으로 Git에서 제외되므로 재게시 권리 검토 없이 강제 추가하지 마세요.

## 검증과 남은 과제

`npm test`는 외부 서비스를 호출하지 않는 자동 테스트입니다. 테스트 통과는 Gemini/Apify/Redis/TMAP 실계정 검증과 구분합니다. 상세 결과와 변경 파일은 `docs/IMPLEMENTATION_REPORT.md`를 확인하세요.

실제 Gemini+Apify 성공 응답, 공개 API 과제 인정 여부, 경로 공급사 요금/권한, 스크래핑·재게시 권리, GitHub/Vercel 연동 및 외부 사용자 시험이 남아 있습니다. Apify가 과제의 공개 API로 인정되지 않으면 공공데이터포털 주택 관련 API 또는 GAS를 별도 키·쿼터와 함께 추가하는 것이 다음 대안이며 아직 구현하지 않았습니다.

## Upstash Redis 운영 정책 (사용자 변경 요청 반영)

기존 **KNU_Room_AI / Upstash / GCP ASIA-NORTHEAST1 / Free Tier** 데이터베이스만 사용합니다. 새 DB 생성·LabFix 분석·이전·삭제는 구현하지 않습니다. 대시보드의 0 commands / 0 B 표시는 사용자가 제공한 정보이며 연결 검증 결과로 간주하지 않습니다.

Vercel Settings → Environment Variables에 기존 DB의 `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`을 등록하세요. 채팅이나 GitHub에 토큰을 붙여 넣지 마세요. 로컬은 `.env`에서 같은 이름을 사용합니다.

```powershell
npm.cmd run redis:inspect
# PING + 페이지 SCAN만 실행. 기존 키는 보고하며 값 읽기/삭제 안 함.
# 서버에서는 관리자 Bearer 인증으로 GET /api/redis-inspect 사용 가능.

New-Item -ItemType Directory -Force backups
npm.cmd run redis:backup -- backups/knuroom-backup.json
npm.cmd run redis:restore -- backups/knuroom-backup.json
```

백업은 KNU Room AI **매물만** JSON으로 저장합니다. 임의 Redis 키를 복원하지 않으며 TTL 없는 매물·지역 인덱스를 재구성합니다. 기존 매물 ID는 갱신하고 기존 최초 수집일은 유지합니다. 전체 삭제 명령이나 정리 스크립트는 없습니다. 백업 파일은 `.gitignore`로 제외합니다.

| 키 | 보관 정책 |
| --- | --- |
| `knuroom:listing:{encodedId}` | JSON 매물. TTL 없음, ID별 upsert, firstCollectedAt/lastSeenAt/monthlyTotal/availability |
| `knuroom:region:{encodedName}:listings` | 매물 키 Set. TTL 없음, 미발견 매물도 유지 |
| `knuroom:cache:region:{encodedName}` | 최신 수집 ID·갱신일. 기본 24시간, SEARCH_CACHE_TTL_SECONDS로 설정 |
| `knuroom:metadata:last-sync` | 최근 저장 시각. TTL 없음 |
| `knuroom:collect:{queryHash}` | 작업 상태. 진행·시작 미확인은 과금 주기 종료+7일까지; 정산 후 1시간 캐시 |
| `knuroom:apify:run:{runId}` | Run 상태·requestId·jobId, 24시간 |
| `knuroom:apify:active` | 전체 수집 단일 실행 잠금. 확인된 종료·정산 시 본인 잠금만 해제 |
| `knuroom:budget:{billingCycle}:reserved/observed` | 월간 예약·관측 상한, 과금 주기 종료+7일까지 |
| `knuroom:budget:reservation:{requestId}` | 실행별 예약/정산. Run ID는 작업·실행 인덱스에서 연결 |
| `knuroom:collect:count:*`, `knuroom:collect:budget:*` | 관리자별 일일 횟수 / 일일 비용 예약, 48시간 |
| `knuroom:gemini:*` | 검증된 분석 캐시, 10분. Gemini 카운터도 모두 knuroom 접두사 |

저장 데이터는 7일 초과 시 조회 응답에서 `stale`로 표시하고 자동 삭제하지 않습니다. 저장 매물 검색은 수집 비용 한도 도달·신규 수집 비활성 상태에서도 유지합니다. Redis 장애 시 신규 유료 Actor는 거절하고 검색은 기존 Dataset/스냅샷 경로로 대체합니다.

### 계정 $5 / $4.50 사전 차단

`APIFY_MONTHLY_BUDGET_USD=5.00`, `APIFY_SOFT_STOP_USD=4.50`, `ENABLE_LIVE_COLLECTION=false`가 기본입니다. 더 큰 환경변수 값은 거부합니다. 매 신규 수집 직전 공식 `GET /v2/users/me/limits`의 `limits.maxMonthlyUsageUsd`, `current.monthlyUsageUsd`, `monthlyUsageCycle.startAt/endAt`을 검증합니다. 계정 한도가 미확인·0 이하·$5 초과, 과금 주기 미확인, 사용량 오류, 401/429/timeout이면 거절합니다. 계정 한도를 변경하는 PUT 요청은 구현하지 않습니다.

Lua 예약에서 **관측 사용량 상한 + 이 앱의 월간 예약 비용 + 신규 실행 최대 비용**이 $4.50(또는 더 작은 계정/앱 한도)을 넘으면 차단합니다. 전역 활성 잠금이 있으면 다른 지역도 실행하지 않습니다. 동일 요청은 기존 작업을 반환합니다. 추가로 일일 횟수/비용 상한을 검사합니다.

종료 Run의 공식 `usageTotalUsd`가 유효하면 예약 상한에서 미사용 차액만 해제합니다. 실제 비용 부분은 이번 과금 주기에 보수적으로 계속 적립하므로 Apify 사용량에도 반영되면 이중 계산되어 **더 일찍 차단될 수 있습니다**. 집계 지연으로 예산을 낮게 계산하는 것을 피하기 위한 선택입니다. 확인되지 않은 최종 비용·응답 유실·실제 비용의 예약액 초과는 잠금을 유지합니다. 운영자가 Run/계정 이력을 확인한 뒤 조치해야 합니다. 앱 검사만으로 외부 프로젝트의 사용이나 실제 청구액을 보장하지 않습니다.

상태 조회와 완료 결과 조회 시 Dataset을 저장합니다. 사용자가 모든 조회를 중단한 실행은 다음 상태 조회 전까지 영속 매물 반영이 지연될 수 있습니다. 무인 동기화용 webhook/스케줄러는 추후 운영 기능입니다.

## API 일괄 연결

키를 확인하는 공식 링크, Vercel 일괄 등록 변수와 운영 콘솔의 **연결 검사** 사용법은 [docs/API_SETUP.md](docs/API_SETUP.md)를 확인하세요. 통합 검사는 신규 유료 Actor를 실행하지 않으며 Redis·Apify 읽기와 명시적인 AI 테스트를 수행합니다.
