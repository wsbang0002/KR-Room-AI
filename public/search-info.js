// Shared copy for the public search and authenticated inventory views.
const searchInfo = (() => {
  const sources = {
    redis:'저장 매물', 'apify-api':'Apify Dataset', 'apify-cache':'최근 조회한 Apify Dataset',
    'apify-run':'신규 수집 Dataset', 'apify-stale':'이전 Apify 자료', snapshot:'저장본', 'snapshot-fallback':'이전 저장본'
  };
  const modes = {walk:'도보', transit:'대중교통', car:'자동차'};
  function date(value) {
    if (!value) return '미확인';
    const day = new Date(value);
    return Number.isFinite(day.getTime()) ? day.toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul'}) : '미확인';
  }
  function source(names) {
    return [...new Set((names || []).map(name => sources[name] || name).filter(Boolean))].join(', ') || '미확인';
  }
  function interpretation(info) {
    if (!info) return '';
    const mode = {ai:'AI로 조건을 해석했어요.', fallback:'AI 분석을 사용할 수 없어 기본 해석을 적용했어요.', local:'기본 해석으로 조건을 확인했어요.'};
    const unsupported = info.unsupported?.length ? '필터에 반영되지 않은 조건 · ' + info.unsupported.join(', ') : '';
    return [mode[info.mode],unsupported].filter(Boolean).join(' ');
  }
  function mobility(c,walkingEnabled) {
    if (c?.maxCommuteMinutes == null) return '';
    if (c.transportMode === 'car' || c.transportMode === 'transit') return `${modes[c.transportMode]} 이동시간 계산은 아직 지원하지 않아요. 이 시간 조건을 충족한 것으로 표시하지 않아요.`;
    return walkingEnabled === false ? '현재 도보 시간 계산이 꺼져 있어요.' : '';
  }
  function inventoryRow(row) {
    return `${row.location} · ${row.count}건 · 자료 ${source(row.sources)} · 최근 수집 ${date(row.lastCollectedAt)} · 원본 마지막 관측 ${date(row.lastSeenAt)}`;
  }
  function inventorySummary(data) {
    if (data.state === 'private') return '';
    if (data.state === 'unavailable') return '보유 지역과 매물 수를 확인할 수 없어요.';
    const rows = (data.regions || []).map(inventoryRow);
    if (data.unlocatedCount > 0) rows.push('지역 미확인 자료 ' + data.unlocatedCount + '건');
    if (data.state === 'partial') rows.push('일부 자료의 조회가 지연되고 있어요.');
    return rows.join('\n') || (data.state === 'empty' ? '현재 보유한 수집 매물이 없어요.' : '보유 자료의 지역을 확인할 수 없어요.');
  }
  function resultStatus(data) {
    const coverage = data.coverage;
    const matched = data.results?.length || 0;
    const pending = data.unverified?.length || 0;
    const message = [];
    if (coverage?.state === 'unavailable' || (data.dataSource === 'snapshot-fallback' && data.count === 0 && !coverage))
      return {state:'error',text:'매물 정보를 불러오지 못했어요. 잠시 후 다시 검색해 주세요.'};
    const state = matched || pending ? 'results' : 'empty';
    if (matched) message.push(`조건에 맞는 매물 ${matched}개.`);
    if (pending) message.push(`확인할 조건이 있는 매물 ${pending}개.`);
    if (!matched && !pending) {
      if (coverage?.state === 'partial') message.push('이 지역 자료의 일부를 조회하지 못해 검색 결과를 확정할 수 없어요.');
      else if (coverage?.state === 'unknown-region') message.push('보유 자료의 지역이 미확인이어서 이 지역의 매물 수를 확정할 수 없어요.');
      else if (coverage?.state === 'empty') message.push('이 지역에서 수집이 확인된 매물이 없어요.');
      else if (coverage?.count > 0) message.push(`이 지역의 보유 매물 ${coverage.count}건 중 현재 조건에 맞는 매물이 없어요. 지역이나 예산을 바꿔 보세요.`);
      else message.push('현재 이 조건에 맞는 매물이 없어요.');
    }
    if (coverage?.count > 0) message.push(inventoryRow(coverage));
    else if (coverage?.state === 'unknown-region' && pending) message.push('자료의 지역을 확인할 수 없어 조건 충족 여부가 미확인이에요.');
    if (coverage?.stale) message.push('이전에 수집한 자료를 사용했어요.');
    if (coverage?.state === 'partial' && (matched || pending)) message.push('일부 자료만 조회했어요.');
    return {state,text:message.join(' ')};
  }
  function listingRecord(room) {
    const origin = room.source;
    const stored = room.inventorySource;
    const provenance = origin || stored ? ['자료 ' + (origin || source([stored])), origin && stored ? source([stored]) : null].filter(Boolean).join(' · ') : '자료 출처 미확인';
    const availability = room.availabilityCheckedAt && room.availability === 'verified'
      ? '공실 확인일 ' + date(room.availabilityCheckedAt) : '공실 미확인';
    return `${provenance} · 수집일 ${date(room.collectedAt)} · 원본 마지막 관측 ${date(room.lastSeenAt)} · ${availability}${room.syncStatus === 'stale' ? ' · 오래된 정보' : ''}`;
  }
  return {interpretation,mobility,inventorySummary,resultStatus,listingRecord};
})();
