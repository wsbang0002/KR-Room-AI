# Gemini · Apify · 기존 Upstash 한 번에 연결하기

대상 Vercel 프로젝트는 **kr-room-ai**입니다. 같은 저장소에 연결된 다른 프로젝트가 있더라도 `https://kr-room-ai.vercel.app/`를 제공하는 프로젝트에 등록하세요.

## 1. 키와 연결 정보 확인

| 서비스 | 공식 콘솔 | Vercel 변수 |
| --- | --- | --- |
| Gemini | https://aistudio.google.com/apikey | GEMINI_API_KEY |
| Apify | https://console.apify.com/settings/integrations | APIFY_TOKEN |
| 기존 Apify Dataset | Apify Console → Storage → Datasets → 기존 수집 Dataset → ID | APIFY_DATASET_ID |
| 기존 Upstash | https://console.upstash.com/ → KNU_Room_AI → Connect → REST | UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN |

Apify 토큰 값이 다시 표시되지 않으면 기존 연결에 미치는 영향을 확인하고 새 토큰을 생성하세요. Dataset ID는 Actor ID가 아닙니다. Upstash는 기존 DB를 재사용하고 새 DB를 만들지 않습니다. Redis REST Token은 비용 예약과 매물 저장을 위해 읽기·쓰기 권한이 필요합니다.

공식 안내: [Gemini 키](https://ai.google.dev/gemini-api/docs/api-key), [Apify 토큰](https://docs.apify.com/integrations/api), [Upstash REST](https://upstash.com/docs/redis/features/restapi).

## 2. Vercel 환경변수 일괄 입력

Vercel → **kr-room-ai → Settings → Environment Variables**에서 아래 이름을 등록합니다. `확인한 값`은 실제 값으로 바꾸고, `ADMIN_API_KEY`는 비밀번호 관리자 등으로 생성한 32자 이상 난수를 사용하세요. 키를 채팅·GitHub에 붙여넣지 마세요. Vercel에서 Import .env 기능이 있으면 로컬에서 작성한 비밀 파일을 직접 가져올 수 있습니다. 프로젝트에는 비밀값이 없는 `.env.example`만 있습니다.

```dotenv
GEMINI_API_KEY=확인한_Gemini_키
AI_PROVIDER=gemini
APIFY_TOKEN=확인한_Apify_토큰
APIFY_DATASET_ID=기존_Dataset_ID
UPSTASH_REDIS_REST_URL=기존_Upstash_REST_URL
UPSTASH_REDIS_REST_TOKEN=기존_Upstash_REST_토큰
ADMIN_API_KEY=직접_생성한_32자_이상_난수
ENABLE_LIVE_COLLECTION=false
APIFY_MONTHLY_BUDGET_USD=10.00
APIFY_SOFT_STOP_USD=9.00
APIFY_MAX_COST_USD=0.51
DATA_RIGHTS_REVIEWED=false
PUBLIC_SAVED_LISTINGS=true
```

Production 환경에 적용하고 저장한 다음 **Deployments → Redeploy**합니다. 키를 등록해도 이전 배포에는 자동 반영되지 않을 수 있습니다. 다른 프로젝트나 Preview에만 등록하지 않도록 확인하세요.

일반 검색은 Gemini 3.6 Flash를 사용합니다. Vercel 배포에 사용할 모델은 저장소의 `vercel.json`에서 `env.GEMINI_PRIMARY_MODEL`로 지정합니다. 이 설정이 기존 `GEMINI_MODEL`보다 우선합니다. 운영 도메인의 `GET /api/status`에서 `analysisProvider`와 `geminiModel`을 확인할 수 있습니다.

## 3. 버튼 하나로 연결 검사

운영 사이트는 `PUBLIC_SAVED_LISTINGS=true`로 Redis와 기존 Apify Dataset의 매물을 로그인 전에도 검색할 수 있습니다. 저장소의 Vercel 설정은 `PUBLIC_SAVED_LISTINGS_PRODUCTION_HOST`로 이 공개 범위를 `kr-room-ai.vercel.app` 프로젝트의 Production 배포에 적용합니다. 다른 설치의 기본값은 비공개입니다. 재게시 권리 검토 설정인 `DATA_RIGHTS_REVIEWED`는 별도로 관리합니다. 홈 상단에서 기존 키로 **로그인**하면 수집할 조건을 확인하고 신규 매물 수집을 직접 요청할 수 있습니다. **로그아웃**을 누르거나 1시간이 지나면 검색 세션이 끝납니다. [KNU Room AI 홈](https://kr-room-ai.vercel.app/)

외부 서비스 연결을 검사하려면 운영 콘솔에서 같은 키로 별도 로그인한 뒤 **서비스 연결 → 연결 검사**를 누릅니다. [운영 콘솔](https://kr-room-ai.vercel.app/admin)

**Gemini 3.5 Flash-Lite 비교 검사**를 누르면 경량 모델에 같은 예문을 보냅니다. 두 모델은 일일 생성 한도 20회를 공유하고 응답은 모델별로 캐시합니다. 일반 검색에서 3.6이 시간 초과나 503을 반환하면 기본 파서로 검색을 이어갑니다. Lite 모델 호출은 운영자가 비교 검사를 선택했을 때만 발생합니다.

- Redis: PING과 SCAN만 수행합니다. 기존 키의 값과 이름은 결과 화면에 노출하지 않고 개수만 표시합니다. 기존 키를 삭제하지 않습니다.
- Apify 계정 검사에서는 Limits API로 계정 한도, 사용량과 과금 주기를 조회합니다. 앱은 양수이면서 $10 이하인 계정 한도를 지원합니다. 조회 결과에서 인증 성공과 신규 수집 허용 여부를 각각 확인하세요.
- Apify Dataset: 기존 Dataset에서 최대 1건을 읽어 접근 가능 여부를 확인합니다. 빈 Dataset도 연결 성공일 수 있습니다. 신규 Actor는 실행하지 않습니다.
- Gemini: 고정된 짧은 검색 문장으로 실제 요청을 최대 1회 합니다. 기존 10분 캐시와 일일 20회 Redis 제한을 적용합니다. 응답 JSON 검증 성공·캐시·실패를 구분합니다. 토큰 사용료가 발생할 수 있습니다.

검사는 서버리스 시간 제한에 맞춰 storage 검사와 Gemini 검사를 별도 HTTP 요청으로 순서대로 실행합니다. 공개 `GET /api/status`는 설정 존재 여부일 뿐 연결 성공 증거가 아닙니다. 새 검사 API인 `POST /api/integrations`는 관리자 Bearer 인증을 요구합니다.

배포 기준은 월 $10, 신규 수집 중단 $9입니다. 다른 환경에서는 월 예산을 $10 이하, 중단 기준을 $9 이하로 낮출 수 있습니다. 중단 기준은 월 예산 이하로 설정하세요. 앱은 계정 한도의 90%도 적용하므로 계정 한도가 $5인 경우 $4.50에서 신규 수집을 차단합니다. 한도 검사는 크레딧 잔액과 만료일을 제공하지 않습니다. 필요하면 Apify Console의 결제 내역에서 확인하세요.

신규 Actor는 상세 매물을 최대 20건 요청하며, 1회 기본 예약액과 설정 상한은 $0.51입니다. Apify의 일일 수집 횟수와 비용 제한은 적용하지 않습니다. 이전 일일 설정값이 있어도 다음 실행 가능 여부는 월 예산·계정 한도·예약·잠금으로 결정됩니다.

`ENABLE_LIVE_COLLECTION=false`로 연결을 검사하세요. 새 Actor를 시작하려면 별도로 계정 한도와 Redis 예약을 검증하고 수집을 활성화해야 합니다.

## 4. 지도·경로의 범위

OSM 지도는 별도 키 없이 매물 위치를 표시합니다. 도보 시간과 거리는 서버의 `TMAP_APP_KEY`로 TMAP 보행자 경로를 조회합니다. 매물 카드에서 목적지를 선택하거나 검색 문장에 도보 목적지를 입력하세요. 운영 설정과 호출 한도는 [TMAP 운영 기준](TMAP.md)에서 확인할 수 있습니다.

## Gemini 오류 검사 보강

연결 검사에서 `geminiModel`은 서버에 등록한 키로 모델 메타데이터를 읽어 `generateContent` 지원 여부를 먼저 확인합니다(생성 요청 없음, 5분 캐시·별도 일일 제한). 이 검사를 통과할 때만 Gemini 생성 검사를 실행합니다. 일반 검색은 Gemini 생성 응답을 최대 15초 기다린 후 기본 파서로 조건을 해석합니다. 관리자 생성 검사의 기본 대기 시간은 35초입니다. 기존 `GEMINI_TIMEOUT_MS`로 각 대기 시간을 1초까지 단축할 수 있습니다. Redis와 매물 조회 시간은 별도로 소요되며 Vercel 함수 제한은 60초입니다. Google의 503·요청 시간초과는 앱 설정 변경만으로 해결된다고 보장할 수 없습니다.

관리자 요청 `POST /api/integrations`에 `{"service":"gemini-interactions"}`를 보내면 같은 키와 모델로 Google Interactions API의 구조화 출력을 검사합니다. 고정 문구에서 서울 관악구와 월세 40만원을 모두 추출해야 성공입니다. 두 생성 경로는 일일 20회 한도를 공유하며 한 요청에서 호출하는 경로는 하나입니다. 검색에 이 경로를 선택하려면 Vercel Production에 `GEMINI_API_METHOD=interactions`를 적용하고 재배포합니다. Google 요청에는 `store:false`가 적용됩니다. [Google Interactions API](https://aistudio.google.com/docs/interactions-overview)

## OpenRouter 무료 모델로 검색 조건 해석하기

1. [OpenRouter 키 관리](https://openrouter.ai/settings/keys)에서 무료 계정의 API 키를 발급합니다. 결제 수단, 크레딧 충전, 외부 모델 제공자의 유료 키 연결은 필요하지 않습니다.
2. Vercel 프로젝트의 **Settings → Environment Variables → Production**에 `AI_PROVIDER=openrouter-free`와 `OPENROUTER_API_KEY`를 등록합니다. 키는 Sensitive로 저장하고 재배포합니다.
3. 운영 콘솔에서 **연결 검사**를 실행합니다. 고정 예문에서 서울 관악구와 월세 40만원을 모두 확인하면 검증 성공을 표시합니다. 재검사에서 캐시를 사용했는지도 표시합니다. 저장된 실매물은 홈에서 검색하고, 외부 AI를 이용한 조건 해석은 로그인 후 사용하세요.

로그인 후 OpenRouter 분석을 사용하는 검색 문장은 서버에서 OpenRouter와 선택된 무료 모델 제공자에게 전송됩니다. 앱은 생성 전 OpenRouter 키 정보의 `is_free_tier`가 `true`인지 확인합니다. 무료 등급을 확인할 수 없으면 기본 파서를 사용합니다. 앱은 OpenRouter의 `inclusionai/ling-3.2-flash:free` 모델로만 텍스트 분석을 요청하고 가격 상한을 0으로 지정합니다. Redis로 앱의 OpenRouter 생성을 하루 20회로 제한합니다. 무료 모델 가용량, 공급자 한도, 5초 검색 대기 시간을 초과하면 로컬 파서가 조건을 해석합니다. [무료 모델 정책](https://openrouter.ai/docs/guides/routing/model-variants/free) · [호출 한도](https://openrouter.ai/docs/api/reference/limits)
