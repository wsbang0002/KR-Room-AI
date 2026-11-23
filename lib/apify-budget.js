export const MAX_ACCOUNT_LIMIT_USD = 10;
const ACCOUNT_SPEND_FRACTION = 0.9;
const MAX_SOFT_STOP_USD = MAX_ACCOUNT_LIMIT_USD * ACCOUNT_SPEND_FRACTION;
// Free tier, 1 GB: $0.01 to start plus $0.025 for each of 20 detail results.
const MAX_ESTIMATED_RUN_USD = 0.51;

export function apifyRunBudgetUsd(env) {
  const limit = Number(env.APIFY_MAX_COST_USD ?? MAX_ESTIMATED_RUN_USD);
  return Number.isFinite(limit) && limit > 0 && limit <= MAX_ESTIMATED_RUN_USD ? limit : null;
}

export function apifyBudgetSettings(env) {
  const monthlyBudgetUsd = Number(env.APIFY_MONTHLY_BUDGET_USD ?? MAX_ACCOUNT_LIMIT_USD);
  const softStopUsd = Number(env.APIFY_SOFT_STOP_USD ?? monthlyBudgetUsd * ACCOUNT_SPEND_FRACTION);
  if (!Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd <= 0 || monthlyBudgetUsd > MAX_ACCOUNT_LIMIT_USD ||
      !Number.isFinite(softStopUsd) || softStopUsd <= 0 || softStopUsd > MAX_SOFT_STOP_USD || softStopUsd > monthlyBudgetUsd) {
    return null;
  }
  return {monthlyBudgetUsd, softStopUsd};
}

export function validApifyAccountLimit(limit) {
  return Number.isFinite(limit) && limit > 0 && limit <= MAX_ACCOUNT_LIMIT_USD;
}

// Keep the margin when Apify lowers the account cap after a promotion.
export function effectiveApifyStop(settings, accountLimit) {
  return Math.min(settings.softStopUsd, accountLimit * ACCOUNT_SPEND_FRACTION);
}

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
    if (!validApifyAccountLimit(hardLimit))
      return refuse(`Apify 계정의 월 한도를 $0 초과 $${MAX_ACCOUNT_LIMIT_USD} 이하로 설정해 주세요.`, 'HARD_LIMIT_NOT_SET');
    const settings = apifyBudgetSettings(env);
    if (!settings) return refuse('안전 예산 설정이 유효하지 않습니다.', 'INVALID_ESTIMATE');
    const stop = effectiveApifyStop(settings, hardLimit);
    if (spent + estimatedRunUsd > stop)
      return refuse(`이번 수집을 포함하면 안전 예산 $${stop.toFixed(2)}를 초과할 수 있습니다.`, 'BUDGET_EXHAUSTED');
    return {allowed: true, code: 'OK', spentUsd: spent, hardLimitUsd: hardLimit,
      estimatedRunUsd, appStopUsd: stop,cycle:data.monthlyUsageCycle||null,checkedAt:new Date().toISOString()};
  } catch {
    return refuse('Apify 사용량을 확인할 수 없어 신규 수집을 차단합니다.', 'LIMIT_LOOKUP_FAILED');
  } finally {
    clearTimeout(timer);
  }
}
