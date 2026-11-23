// Public search responses carry only these categories, never upstream messages or timings.
export function fallbackReason(result,provider){
 const detail=result.timings?.[provider==='gemini'?'google':'openrouter']?.providerReason;
 switch(result.parserReason){
  case 'not-configured':
  case 'free-tier-unverified': return 'configuration';
  case 'daily-rate-limit': return 'daily-limit';
  case 'reservation-unavailable': return 'usage-check';
  case 'pending-or-limited': return 'pending';
  case 'upstream-http-504':
  case 'upstream-timeout': return 'timeout';
  case 'upstream-http-429': return 'provider-limit';
  case 'access-unavailable': return 'session';
  case 'response-blocked': return 'response-blocked';
  case 'upstream-http-401':
  case 'upstream-http-403': return 'access';
  case 'upstream-http-400': return 'request-rejected';
  case 'upstream-http-404': return 'provider-resource';
  case 'upstream-http-500':
  case 'upstream-http-502': return 'service-unavailable';
  case 'upstream-http-503': return detail==='model-capacity'?'capacity':'service-unavailable';
  case 'invalid-schema':
  case 'empty-conditions':
  case 'invalid-json':
  case 'empty-response':
  case 'incomplete-response':
  case 'interaction-incomplete':
  case 'output-token-limit': return 'response-format';
  default: return 'unavailable';
 }
}
