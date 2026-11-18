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
GEMINI_MODEL=gemini-2.5-flash
APIFY_TOKEN=확인한_Apify_토큰
APIFY_DATASET_ID=기존_Dataset_ID
UPSTASH_REDIS_REST_URL=기존_Upstash_REST_URL
UPSTASH_REDIS_REST_TOKEN=기존_Upstash_REST_토큰
ADMIN_API_KEY=직접_생성한_32자_이상_난수
ENABLE_LIVE_COLLECTION=false
APIFY_MONTHLY_BUDGET_USD=5.00
APIFY_SOFT_STOP_USD=4.50
APIFY_MAX_COST_USD=0.50
DATA_RIGHTS_REVIEWED=false
```

Production 환경에 적용하고 저장한 다음 **Deployments → Redeploy**합니다. 키를 등록해도 이전 배포에는 자동 반영되지 않을 수 있습니다. 다른 프로젝트나 Preview에만 등록하지 않도록 확인하세요.

## 3. 버튼 하나로 연결 검사

https://kr-room-ai.vercel.app/ 에서 **지역·조건 수정 / 관리자 설정**을 펼칩니다. 설정한 ADMIN_API_KEY를 관리자 인증키 입력란에 넣고 **API 연결 검사**를 누릅니다.

- Redis: PING과 SCAN만 수행합니다. 기존 키의 값과 이름은 결과 화면에 노출하지 않고 개수만 표시합니다. 기존 키를 삭제하지 않습니다.
- Apify 계정: Limits API로 토큰·현재 사용량·계정 $5 이하 한도·과금 주기를 확인합니다. 한도 안전 여부와 인증 성공을 구분합니다.
- Apify Dataset: 기존 Dataset에서 최대 1건을 읽어 접근 가능 여부를 확인합니다. 빈 Dataset도 연결 성공일 수 있습니다. 신규 Actor는 실행하지 않습니다.
- Gemini: 고정된 짧은 검색 문장으로 실제 요청을 최대 1회 합니다. 기존 10분 캐시와 일일 20회 Redis 제한을 적용합니다. 응답 JSON 검증 성공·캐시·실패를 구분합니다. 토큰 사용료가 발생할 수 있습니다.

검사는 서버리스 시간 제한에 맞춰 storage 검사와 Gemini 검사를 별도 HTTP 요청으로 순서대로 실행합니다. 공개 `GET /api/status`는 설정 존재 여부일 뿐 연결 성공 증거가 아닙니다. 새 검사 API인 `POST /api/integrations`는 관리자 Bearer 인증을 요구합니다.

최종 수집 활성화는 Apify 계정 한도·영속 예약을 실제로 검증한 뒤 별도로 진행하세요. 이번 일괄 연결에서 `ENABLE_LIVE_COLLECTION=false`는 유지합니다.

## 4. 지도·경로의 범위

OSM 지도는 별도 키 없이 표시합니다. TMAP 도보/자동차는 어댑터만 구현되어 있어 TMAP_API_KEY를 입력하는 것만으로 실제 통학시간 검색이 완성되지는 않습니다. 대중교통 공급사, 실제 목적지 좌표, 요금·권한과 경로 호출 비용 제한을 확정해야 합니다. 이번 세 서비스 연결 성공과 실경로 구현 완료를 혼동하지 마세요.

## Gemini 오류 검사 보강

연결 검사에서 `geminiModel`은 서버에 등록한 키로 모델 메타데이터를 읽어 `generateContent` 지원 여부를 먼저 확인합니다(생성 요청 없음, 5분 캐시·별도 일일 제한). 이 검사를 통과할 때만 Gemini 생성 검사를 실행합니다. 일반 검색은 Gemini 생성 응답을 최대 5초 기다린 후 기본 파서로 조건을 해석합니다. 관리자 생성 검사의 기본 대기 시간은 35초입니다. 기존 `GEMINI_TIMEOUT_MS`로 각 대기 시간을 1초까지 단축할 수 있습니다. Redis와 매물 조회 시간은 별도로 소요되며 Vercel 함수 제한은 60초입니다. Google의 503·요청 시간초과는 앱 설정 변경만으로 해결된다고 보장할 수 없습니다.

관리자 요청 `POST /api/integrations`에 `{"service":"gemini-interactions"}`를 보내면 같은 키와 모델로 Google Interactions API의 구조화 출력을 검사합니다. 고정 문구에서 서울 관악구와 월세 40만원을 모두 추출해야 성공입니다. 두 생성 경로는 일일 20회 한도를 공유하며 한 요청에서 호출하는 경로는 하나입니다. 검색에 이 경로를 선택하려면 Vercel Production에 `GEMINI_API_METHOD=interactions`를 적용하고 재배포합니다. Google 요청에는 `store:false`가 적용됩니다. [Google Interactions API](https://aistudio.google.com/docs/interactions-overview)

## OpenRouter 무료 모델로 검색 조건 해석하기

1. [OpenRouter 키 관리](https://openrouter.ai/settings/keys)에서 무료 계정의 API 키를 발급합니다. 결제 수단, 크레딧 충전, 외부 모델 제공자의 유료 키 연결은 필요하지 않습니다.
2. Vercel 프로젝트의 **Settings → Environment Variables → Production**에 `AI_PROVIDER=openrouter-free`와 `OPENROUTER_API_KEY`를 등록합니다. 키는 Sensitive로 저장하고 재배포합니다.
3. 사이트의 관리자 설정에서 **API 연결 검사**를 실행합니다. 고정 예문에서 서울 관악구와 월세 40만원을 모두 확인하면 검증 성공을 표시합니다. 재검사에서 캐시를 사용했는지도 표시합니다. 실제 검색은 가상 매물 데모를 해제하고 진행합니다.

검색 문장은 서버에서 OpenRouter와 선택된 무료 모델 제공자에게 전송됩니다. 앱은 생성 전 OpenRouter 키 정보의 `is_free_tier`가 `true`인지 확인합니다. 무료 등급을 확인할 수 없으면 기본 파서를 사용합니다. 앱은 OpenRouter의 `inclusionai/ling-3.2-flash:free` 모델로만 텍스트 분석을 요청하고 가격 상한을 0으로 지정합니다. Redis로 앱의 OpenRouter 생성을 하루 20회로 제한합니다. 무료 모델 가용량, 공급자 한도, 5초 검색 대기 시간을 초과하면 로컬 파서가 조건을 해석합니다. [무료 모델 정책](https://openrouter.ai/docs/guides/routing/model-variants/free) · [호출 한도](https://openrouter.ai/docs/api/reference/limits)
