# Gemini 응답 지연 코드 검토

## 확인한 코드상의 개선점

1. `api/search.js`가 Gemini 분석을 끝까지 기다린 다음 Redis/Dataset 조회를 시작했습니다. 기본 파서로 지역을 해석할 수 있는 경우 매물 조회와 AI 분석을 병행하도록 변경했습니다. AI가 다른 지역을 확정하면 해당 지역으로 다시 읽어 잘못된 지역 자료를 쓰지 않습니다.
2. `lib/gemini.js`가 Gemini 3.x에도 temperature=0을 전송했습니다. 공식 Gemini 3 가이드에 따라 3.x에는 1을 적용했습니다. JSON 서버 검증·필수 조건 검증은 그대로 유지합니다. 이 설정이 이번 시간초과의 유일한 원인이라고 단정하지 않습니다.
3. 타이머만으로는 Google 응답 헤더 대기와 본문 수신/JSON 파싱 지연을 구분할 수 없었습니다. `jsonFetch`에 선택적 시간 측정을 추가했습니다. 관리자 Gemini 진단의 timings에 redisReserveMs, google.headersMs/bodyMs/totalMs/phase를 반환합니다. 요청 URL·헤더·키·사용자 질의를 시간 측정에 저장하지 않습니다.

## 요청 경로

검색: 관리자 인증 → 기본 지역 해석 → (저장 매물 읽기와 Gemini 분석 병행) → 확정 조건 검증 → 필요 시 지역 재조회 → 추천.

최소 Gemini 검사: 관리자 인증 → Redis 원자 호출 제한 → 고정 '안녕' 생성 요청 → 응답 확인 → 검사 결과 캐시.

Gemini 요청에는 자동 재시도·백그라운드 반복 호출·Actor 호출이 없습니다. Redis는 실행 전 1회 원자 예약과 결과 저장에 사용됩니다. 실매물 검색의 SCAN은 Gemini 응답 후에만 실행되던 직렬 작업이었지만, 최소 '안녕' 검사에는 매물 검색·추천·지역 카탈로그 탐색이 없습니다.

`response-headers` 단계에서 시간이 초과되고 headersMs가 없으면 HTTP 응답 헤더를 받기 전에 중단된 것입니다. 이 경우 JSON.parse/추천 연산이 35초를 소비한 것은 아닙니다. 다만 DNS/TLS/네트워크·Google 큐/생성 처리 중 어디서 지연되는지는 이 지표만으로 구분하지 못합니다.

공식 근거: https://ai.google.dev/gemini-api/docs/gemini-3?hl=en
