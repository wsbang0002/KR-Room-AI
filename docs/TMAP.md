# TMAP 이동 경로 운영 기준

## 매물별 자가용·버스 조회

방 찾기에서 매물과 목적지를 선택한 뒤 원하는 이동수단을 눌러 예상 시간을 조회한다. 자동차와 버스는 각 버튼을 눌렀을 때만 조회하며, 같은 매물과 목적지의 도보 시간과 함께 표시한다. 자동차와 버스 요약은 Redis에 저장하지 않는다. 해당 조회로 검색 순위와 결과 목록을 다시 계산하지 않는다.

- **자가용**은 기존 `TMAP_APP_KEY`로 자동차 경로안내를 조회한다. 앱의 `TMAP_DAILY_APP_LIMIT`(최대 200회)은 도보·자동차의 합산 한도다. TMAP Free 상품의 경로안내 한도는 하루 1,000건이며 초과 시 차단된다. [SK 요금표](https://openapi.sk.com/products/calc?menuSeq=5&svcSeq=4)
- **버스**는 TMAP 대중교통 **Free** 상품의 요약정보를 사용한다. SK Open API에서 해당 상품을 이용할 앱을 확인하고 그 앱 키를 Vercel 프로젝트의 Production 환경변수 `TMAP_TRANSIT_APP_KEY`에 Sensitive로 등록한 뒤 재배포한다. 요약정보 Free 한도는 하루 10회이며 초과 시 차단된다. 앱은 Redis에서 호출마다 1회를 예약하며 `TMAP_TRANSIT_DAILY_APP_LIMIT`으로 한도를 0~10회로 낮출 수 있다. 반환된 버스 경로(`pathType=2`) 중 총 소요 시간이 가장 짧은 값을 사용한다. [상품 등록](https://openapi.sk.com/products/detail?svcSeq=59) · [요금과 한도](https://transit.tmapmobility.com/) · [요약 API](https://transit.tmapmobility.com/docs/routes/sub)
- 공개 `GET /api/status`의 `listingRoutes.car`, `listingRoutes.bus`에서 활성화 여부, 키 등록 여부와 앱 한도를 확인할 수 있다. 버스 키가 없거나 경로를 받지 못한 경우에는 카카오맵에서 같은 두 지점을 조회할 수 있다. [카카오맵 길찾기 URL](https://apis.map.kakao.com/web/guide/#routeurl)

2026년 11월 19일(KST) 공개 상품 설명과 약관 확인 기준. 계정 소유자는 `KNU-Room-AI` 앱에 `TMAP(Free)`를 등록했다고 보고했다. 계정별 계약·잔여량과 운영 경로 응답은 별도 검증 항목이다.

## 요청과 결과

Vercel 서버가 `POST https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1`에 JSON을 보낸다. 헤더에 `appKey`, `Accept: application/json`, `Content-Type: application/json`을 넣는다. 인증 값은 Vercel의 `TMAP_APP_KEY`에서 읽는다. 숫자형 `startX/endX`는 경도, `startY/endY`는 위도다. 요청·응답 좌표계를 `WGS84GEO`로 지정하고, `startName/endName`에는 UTF-8 URL 인코딩을 적용한다. 고정 ASCII 이름도 사용할 수 있다. `searchOption`의 문자열 `"0"`은 추천 경로다. [SK 보행자 경로 명세 및 예제](https://openapi.sk.com/products/detail?menuSeq=45&svcSeq=4)

출발점(`pointType=SP`)의 경로 요약에 있는 `totalDistance`(m)와 `totalTime`(초)을 사용한다. 원주시는 공식 서비스 지역에 포함된다. 전국 검색 중에는 보행 경로 지원 범위 밖의 매물도 생긴다. 지원하지 않는 구간의 오류 코드는 `3002`다. 대략적 매물 좌표에서 출발한 값에는 해당 정확도를 표시한다. [응답 예제](https://openapi.sk.com/products/detail?menuSeq=45&svcSeq=4) · [SK 오류 코드](https://openapi.sk.com/products/detail?menuSeq=58&svcSeq=4)

## 무료 한도

공개 표에서 보행자는 자동차·타임머신 등과 같은 ‘경로안내’ 그룹에 속하며 Free의 표기 한도는 하루 1,000건이다. 요금 정책에는 Free 한도 초과 시 자동 차단, 한도 확대 시 별도 상품 변경 구매라고 명시되어 있다. 계정에 등록된 상품 및 앱의 남은 경로 그룹 사용량을 SK 대시보드에서 확인한다. 앱 내부 Redis 카운터는 이 서비스가 예약한 시도 횟수이며, 동일 앱 키의 다른 사용처까지 집계한 공급자 잔여량은 계정에서 확인해야 한다. [상품별 요금표와 초과 정책](https://openapi.sk.com/products/calc?menuSeq=5&svcSeq=4) · [SK 대시보드](https://openapi.sk.com/mypage/dashboard)

## 저장과 화면 표시

TMAP Open API 약관은 저장 후 24시간이 지난 데이터의 사용을 금지한다. 이 서비스의 선택적 Redis 캐시는 성공한 경로의 거리·시간 및 검증에 필요한 메타데이터에 최대 23시간 TTL을 적용한다. 캐시를 읽어도 만료 시각을 연장하지 않는다. 영구 매물 레코드와 JSON 매물 백업에는 TMAP 경로 요약을 포함하지 않는다. [TMAP API 약관의 준수사항](https://tmapapi.tmapmobility.com/terms.html)

공식 보행자 API는 거리와 소요 시간을 출력 항목으로 제공한다. 결과 카드에는 이를 ‘TMAP 경로 기준’으로 표시한다. 확인한 공개 자료에는 타사 지도 위에 경로선이나 TMAP 유래 좌표를 겹치거나 요약을 지도 위 라벨로 올리는 이용 허락이 명시되어 있지 않다. v0.6은 OSM 지도와 별도인 카드에서만 경로 요약을 제공하며, 지도에는 독립 출처의 출발·목적지 좌표를 사용한다. 경로 형상 원문은 캐시에 저장하지 않는다. 지도 위 중첩이 필요해지면 해당 사용 방식을 SK에 확인한다. [보행자 API 상품 안내](https://openapi.sk.com/products/detail?menuSeq=45&svcSeq=4) · [TMAP API 약관](https://tmapapi.tmapmobility.com/terms.html)

## 운영 활성화 순서

1. **무료 상품 확인.** SK 대시보드의 앱과 적용 상품에서 `KNU-Room-AI`, 활성 `TMAP(Free)`, 보행자 경로 사용 권한, 당일 경로안내 사용량과 차단 조건을 확인한다. 확인 내용을 기록할 때 앱 키는 제외한다. 공개 문서에서 계정별 잔여량 조회용 공개 API는 확인되지 않았다. [SK 대시보드](https://openapi.sk.com/mypage/dashboard) · [무료 정책](https://openapi.sk.com/products/calc?menuSeq=5&svcSeq=4)
2. **일반 검색을 끈 상태에서 준비.** Vercel Production에서 기존 `TMAP_APP_KEY`를 유지하고 `ENABLE_WALKING_ROUTES=false`, `TMAP_DAILY_APP_LIMIT=200`, `TMAP_MAX_ROUTES_PER_SEARCH=5`를 사용한다. 관리자 상태 화면에서 설정 여부, Redis 연결 및 앱 사용량을 확인한다. 약관과 해당 상품의 저장 조건을 확인한 경우에만 `TMAP_ROUTE_CACHE_ALLOWED=true`를 설정한다.
3. **관리자 경로 1건 확인.** 일반 검색용 `ENABLE_WALKING_ROUTES=false`를 유지한다. `ENABLE_TMAP_DIAGNOSTICS`가 미설정이면 환경변수 변경이나 재배포 없이 검사할 수 있다. 인증된 관리자가 매물과 목적지를 선택하고 무료 상품·잔여량·차단 조건을 확인한 뒤 화면에서 1건 검사를 승인한다. 이때 `POST /api/routes/walking`은 `listingId`, `destinationId`, `diagnostic: true`, `confirmFreePlan: true`를 받는다. 승인은 해당 요청에만 적용되며 일반 검색을 활성화하지 않는다. 진단 플래그를 명시적으로 `false`로 설정하면 이 일회성 승인도 차단한다. 성공 응답의 거리·시간·조회 시각을 확인하고, `cacheHit: false`와 당일 사용량 변화로 실제 신규 조회를 판별한다.
4. **승인된 운영 배포.** `vercel.json`의 `WALKING_ROUTES_PRODUCTION_HOST`는 `kr-room-ai.vercel.app`으로 지정한다. Vercel이 주입한 프로젝트 운영 도메인과 일치하는 Production 배포에만 이 설정을 적용한다. 환경변수 `ENABLE_WALKING_ROUTES`를 직접 설정하면 이 값이 우선한다. 미리보기와 로컬 배포에서는 기본적으로 꺼져 있다.
5. **서비스 종료 또는 일시 중지.** 해당 프로젝트의 Production에서 `ENABLE_WALKING_ROUTES=false`, `ENABLE_TMAP_DIAGNOSTICS=false`를 설정하고 재배포한 뒤 `/api/status`의 `walking.enabled`를 확인한다. 매물 공개 및 Apify 유료 수집은 도보 설정과 독립적으로 관리한다.

## 비로그인 도보 경로

`GET /api/routes/walking?places=public`은 원주역 · 남춘천역 · 관악산역 · 신촌역(2호선) · 부산대역과 인근 대학을 반환한다. 역 좌표는 해당 지점의 한국어 위키백과 문서에서 확인한 대표 좌표며 각 항목에 출처 URL이 포함된다. 일반 방문자가 출발역과 캠퍼스를 선택하고 조회하면 서버는 두 ID를 검증한 뒤 TMAP에 좌표를 보낸다. 매물 ID·임의 좌표·다른 도시 조합은 이 경로에서 사용할 수 없다. 매물 추천과 같은 Redis 일일 카운터, 사용자별 제한, 동시 실행 제한을 적용한다.
