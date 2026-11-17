/**
 * Apify 신규 Actor 실행 전 안전 확인 (fail closed).
 * 이 모듈은 호출 전 검사일 뿐이며 실제 결제액을 보증하지 않습니다.
 * 계정 Hard limit을 Apify Console에서 별도로 $5로 설정해야 합니다.
 * 전국 수집 기능을 구현할 때 서버에서 Actor 실행 직전에 호출하세요.
 */
const HARD_CAP_USD = 5;
const APP_STOP_USD = 4.5;
const MAX_ESTIMATED_RUN_USD = 0.5;

export async function checkApifyBudget({
  fetcher = fetch,
  env = process.env,
  estimatedRunUsd = MAX_ESTIMATED_RUN_USD,
} = {}) {
  const refuse = (reason, code = 'BUDGET_BLOCKED') => ({allowed: false, code, reason});
  if (env.ENABLE_LIVE_COLLECTION !== 'true') return refuse('실시간 수집이 비활성화되어 있습니다.', 'COLLECTION_DISABLED');
  if (!env.APIFY_TOKEN) return refuse('Apify 인증 토큰이 없습니다.', 'CONFIG_MISSING');
  if (!Number.isFinite(estimatedRunUsd) || estimatedRunUsd <= 0 || estimatedRunUsd > MAX_ESTIMATED_RUN_USD)
    return refuse('예상 실행 비용이 허용 범위를 벗어났습니다.', 'INVALID_ESTIMATE');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetcher('https://api.apify.com/v2/users/me/limits', {
      headers: { Authorization: `Bearer ${env.APIFY_TOKEN}` }, signal: controller.signal,
    });
    if (!response.ok) return refuse(`계정 한도 조회 실패 (HTTP ${response.status})`, 'LIMIT_LOOKUP_FAILED');
    const body = await response.json();
    const data = body?.data;
    const hardLimit = data?.limits?.maxMonthlyUsageUsd;
    const spent = data?.current?.monthlyUsageUsd;
    if (!Number.isFinite(hardLimit) || !Number.isFinite(spent) || spent < 0)
      return refuse('사용량 또는 계정 한도 값이 유효하지 않습니다.', 'INVALID_LIMIT_DATA');
    if (hardLimit <= 0 || hardLimit > HARD_CAP_USD)
      return refuse('Apify 계정의 Hard limit을 $5 이하로 먼저 설정해야 합니다.', 'HARD_LIMIT_NOT_SET');
    const monthlyBudget=Number(env.APIFY_MONTHLY_BUDGET_USD||5);
    const stop=Number(env.APIFY_SOFT_STOP_USD||4.5);
    if(!Number.isFinite(monthlyBudget)||monthlyBudget<=0||monthlyBudget>5||!Number.isFinite(stop)||stop<=0||stop>4.5||stop>monthlyBudget)return refuse('안전 예산 설정이 유효하지 않습니다.','INVALID_ESTIMATE');
    if (spent >= stop || spent + estimatedRunUsd > Math.min(stop,hardLimit,monthlyBudget))
      return refuse('안전 예산 $4.50에 도달했거나 이번 실행으로 초과할 수 있습니다.', 'BUDGET_EXHAUSTED');
    return {allowed: true, code: 'OK', spentUsd: spent, hardLimitUsd: hardLimit,
      estimatedRunUsd, appStopUsd: Math.min(stop,hardLimit,monthlyBudget),cycle:data.monthlyUsageCycle||null,checkedAt:new Date().toISOString()};
  } catch {
    return refuse('Apify 사용량을 확인할 수 없어 신규 수집을 차단합니다.', 'LIMIT_LOOKUP_FAILED');
  } finally {
    clearTimeout(timer);
  }
}
