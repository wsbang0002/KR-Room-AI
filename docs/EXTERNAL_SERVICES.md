# 외부 서비스 검토 기록 — 2026-11-17

실제 인증 API 호출과 공개 문서 GET 조회를 구분합니다. 이번 환경에는 Gemini/Apify/Redis/TMAP 운영 키가 없습니다.

## Apify — 공개 메타데이터와 스키마 확인 완료

- https://api.apify.com/v2/acts/sian.agency~dabang-property-scraper
- https://api.apify.com/v2/actor-builds/cADv3xxuPGlwduvRH
- https://docs.apify.com/api/v2/act-runs-post

빌드 1.0.12의 inputSchema를 `apify-input-schema.json`에 저장했습니다. 실제 지원 필드인 place, scrapeMode, category, sellingTypes, roomTypes, depositMax, rentMax, maxResults, maxPages만 전달합니다. 공식 Run 문서에서 waitForFinish=0과 maxTotalChargeUsd(전체 가격 모델 비용 상한), timeout, memory를 확인했습니다. Actor 메타데이터의 현행 PAY_PER_EVENT 가격은 계정 등급에 따라 달라집니다. 설명에 있는 무료 티어를 무료 실행 보장으로 해석하지 않습니다.

유료 Run POST, 인증된 Dataset/Run GET은 실행하지 않았습니다. 공개 Actor 개발자의 수집 합법성 주장은 다방 데이터·사진의 재게시 허가 증명이 아닙니다. 권리 검토 전 실매물 API는 관리자 전용이며 사용자 제공 실제 데이터 파일은 공개 GitHub에서 제외합니다.

## 지도·경로 — 부분 검토, 실계약 전 사용 중지

| 공급사 | 검토 근거와 구현 범위 | 인증·가격 상태 |
| --- | --- | --- |
| OpenStreetMap | 매물 선택 시 공식 export iframe으로 지도 표시. 경로 계산 아님. 기여자 표시 포함. | 지도 키 없음. 외부 요청 발생. 타일 대량 다운로드는 구현하지 않음. |
| TMAP / SK open API | https://openapi.sk.com/products/detail?linkMenuSeq=4 에 보행자 경로 안내 제공 확인. 도보·자동차 POST 어댑터 작성, Mock 검증. | appKey 필요. 현행 무료량·가격과 앱별 서비스 권한은 확인되지 않아 검색에 연결하지 않음. |
| Naver Directions 5 | https://api.ncloud-docs.com/docs/ai-naver-mapsdirections-driving 문서 응답 확인. 자동차 Directions이며 도보·대중교통 제공으로 간주하지 않음. | Ncloud 프로젝트 인증·요금 검토 미완료. 미구현. |
| Kakao Mobility | 검토한 directions 문서 URL이 404라 최신 문서 확인 필요. 지도 SDK를 모든 이동수단 경로 API로 간주하지 않음. | 가격·권한 검토 미완료. 미구현. |

이 비교는 가격·계약 완료를 의미하지 않습니다. 운영 공급사 최종 선정 및 대중교통 API는 남은 작업입니다. TMAP 어댑터를 실검색에 연결하기 전 목적지 좌표 검증, Redis 호출/비용 제한, 사용량 대시보드, 무료량·초과요금 확인이 필요합니다.

## 행정구역

원자료: 통계청 SGIS(공공누리 제1유형). 가공자료: https://github.com/vuski/admdongkor (CC BY 4.0).
`dist/data/_index_v3.parquet`에서 요청의 17개 시도 구성을 지원하는 2026-04-01 명칭 3,830개를 추출·공백 구분 경로로 재구성했습니다. 최신 시점·법정동 전수 검증을 보증하지 않습니다. `LICENSE-regions.txt`에 출처와 이용 조건을 보존했습니다. 이 파일은 앱 런타임에서 외부 다운로드하지 않습니다.

## BudgetGuard 추가 확인

- https://docs.apify.com/api/v2/users-me-limits-get
- https://docs.apify.com/api/v2/users-me-usage-monthly-get
- https://docs.apify.com/api/v2/actor-run-get

공식 Limits 응답의 `monthlyUsageCycle.startAt/endAt`, `limits.maxMonthlyUsageUsd`, `current.monthlyUsageUsd`와 Run 응답의 `usageTotalUsd`를 문서에서 확인했습니다. 신규 실행에는 Limits GET을 필수 적용합니다. 월 상세 API의 경로·필드도 검토했지만 추가 청구 집계 조회는 구현하지 않았습니다. 계정 설정을 바꾸는 PUT 요청은 없습니다. 계정별 한도·사용량·과금 주기는 해당 시점의 인증된 Limits 응답으로 확인합니다.

### 현재 운영 예산

배포 설정의 월 예산은 $10.00, 수집 중단 설정은 $9.00입니다. 앱은 실행 전에 확인한 계정 한도의 90%와 두 설정값 중 가장 작은 금액을 적용합니다. 계정 한도 $5에는 최대 $4.50이 적용됩니다. 계정 한도·월 예산은 사용 가능한 프로모션 크레딧이나 그 만료 시점을 나타내지 않습니다. 계정 한도 검사는 읽기 요청만 사용합니다. [Apify 계정 한도 조회](https://docs.apify.com/api/v2/users-me-limits-get)

신규 Actor는 `scrapeMode=detail`로 상세 매물을 최대 20건 요청합니다. 1회 비용의 기본값과 상한은 $0.51입니다. 일일 예산 $1.00에서는 기본 예약 1건이 정산된 후에도 같은 UTC 날짜의 추가 $0.51 예약은 차단됩니다. [Dabang Scraper](https://apify.com/sian.agency/dabang-property-scraper) · [Actor 실행 API](https://docs.apify.com/api/v2/act-runs-post)
