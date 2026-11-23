function measuredRoute(route) {
  return route?.status === 'success' && route.provider === 'tmap' &&
    Number.isFinite(route.durationMinutes) && Number.isFinite(route.distanceMeters);
}

function walkingIssue(reason) {
  const reasons = {
    disabled:'지금은 도보 경로 계산이 꺼져 있어요.',
    'missing-key':'지금은 TMAP 도보 경로를 사용할 수 없어요.',
    authentication:'TMAP 인증을 확인할 수 없어요.',
    unauthorized:'로그인 후 다시 확인해 주세요.',
    'invalid-origin':'매물의 위치 좌표가 없어 도보 시간을 계산할 수 없어요.',
    'unverified-destination':'도착지의 위치를 확인해 주세요.',
    'daily-limit':'오늘의 도보 경로 조회 한도에 도달했어요.',
    'user-rate-limit':'요청이 많아요. 잠시 후 다시 시도해 주세요.',
    'upstream-rate-limit':'TMAP의 경로 조회 한도에 도달했어요.',
    'concurrent-limit':'다른 경로를 조회 중이에요. 잠시 후 다시 시도해 주세요.',
    pending:'같은 경로를 조회 중이에요. 잠시 후 다시 확인해 주세요.',
    cooldown:'방금 조회한 경로예요. 잠시 후 다시 확인해 주세요.',
    'route-not-found':'TMAP에서 두 지점을 잇는 보행 경로를 찾지 못했어요.',
    timeout:'TMAP 경로 응답이 지연되고 있어요.',
    network:'TMAP에 연결할 수 없어요.',
    'redis-unavailable':'도보 조회 잔여 한도를 확인할 수 없어 요청을 멈췄어요.'
  };
  return reasons[reason] || '지금은 이 보행 경로를 확인할 수 없어요.';
}

// Both the search-condition picker and a single listing use the same verified places.
function placeFinder({labelText, submitText, initialName = '', signal, onSelect, onError}) {
  const form = element('form', 'destination-form');
  const label = element('label', '', labelText);
  const field = element('input');
  field.type = 'search';
  field.minLength = 2;
  field.maxLength = 100;
  field.required = true;
  field.value = initialName;
  const find = element('button', 'choice-button', submitText);
  find.type = 'submit';
  const message = element('p', 'muted');
  message.setAttribute('aria-live', 'polite');
  const matches = element('div', 'destination-choices');
  label.append(field);
  form.append(label, find, message, matches);
  let lookup;
  signal.addEventListener('abort', () => lookup?.abort(), {once:true});
  field.addEventListener('input', () => {
    lookup?.abort();
    matches.replaceChildren();
    message.textContent = '';
    find.disabled = false;
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (find.disabled || signal.aborted) return;
    lookup?.abort();
    const current = new AbortController();
    lookup = current;
    find.disabled = true;
    matches.replaceChildren();
    message.textContent = '목적지를 찾고 있어요.';
    try {
      const data = await request('/api/destinations', {query:field.value.trim()}, current.signal);
      if (current.signal.aborted) return;
      const places = (data.destinations || []).filter(place => place.id && place.verified && validPoint(place));
      message.textContent = [places.length ? '주소를 보고 도착할 곳을 선택해 주세요.' : '좌표를 확인한 장소가 없어요. 지역과 기관명을 함께 입력해 주세요.', data.notice, data.attribution].filter(Boolean).join(' ');
      for (const place of places) {
        matches.append(button([place.name, place.address].filter(Boolean).join(' · '), 'choice-button', () => {
          if (!signal.aborted) onSelect(place);
        }));
      }
    } catch (error) {
      if (!current.signal.aborted) {
        message.textContent = error.message;
        onError?.(error);
      }
    } finally {
      if (!current.signal.aborted) find.disabled = false;
    }
  });
  return form;
}

const listingModeNames = {walking:'도보', bus:'버스', car:'자동차'};

function listingRouteIssue(mode, reason) {
  if (mode === 'walking') return walkingIssue(reason);
  const name = listingModeNames[mode];
  switch (reason) {
    case 'disabled':
    case 'missing-key':
    case 'authentication': return name + ' 경로를 현재 조회할 수 없어요.';
    case 'operating-hours':
    case 'no-service': return '현재 운행하는 버스 경로가 없어요.';
    case 'unverified-destination': return '도착지 위치를 확인할 수 없어요.';
    case 'route-not-found':
    case 'no-bus-route': return name + ' 경로를 찾지 못했어요.';
    case 'daily-limit': return '오늘의 조회 한도에 도달했어요.';
    case 'redis-unavailable': return '조회 가능 횟수를 확인할 수 없어요.';
    case 'timeout': return name + ' 경로 응답이 늦어지고 있어요.';
    case 'upstream-rate-limit':
    case 'user-rate-limit':
    case 'concurrent-limit':
    case 'pending':
    case 'cooldown': return '잠시 후 다시 조회해 주세요.';
    default: return name + ' 시간을 확인하지 못했어요.';
  }
}

function listingWalk(room, conditions, signal, onDestination) {
  const panel = element('div', 'listing-walk');
  const title = element('p', 'listing-commute');
  const origin = room.approximate === false ? '매물 위치 기준' : '대략적 매물 위치 기준';
  const details = element('div', 'listing-travel-times');
  details.setAttribute('aria-live', 'polite');
  const actions = element('div', 'listing-walk-actions');
  panel.append(title, element('p', 'listing-meta', origin), details, actions);
  if (!room.id || !validPoint(room)) {
    title.textContent = '매물 좌표가 없어 이동 시간을 확인할 수 없어요.';
    return panel;
  }

  const searchPlace = conditions.destinationPlace?.verified ? conditions.destinationPlace : null;
  const inWonju = /원주시(?:\s|$)/.test(room.observedRegion || room.region || conditions.location || '');
  let place = searchPlace;
  let routes = searchPlace ? {walking:room.walkingRoute} : {};
  let current;
  let busyMode;
  let picker;
  signal.addEventListener('abort', () => current?.abort(), {once:true});

  function enabled(mode) {
    if (mode === 'walking') return walkingEnabled === true;
    const config = listingRoutes[mode];
    return config?.enabled === true && config.keyConfigured === true;
  }

  function authFailure(error) {
    if (error.status === 401 && !signal.aborted) handleFailure(error, revision);
  }

  function choosePlace(target) {
    if (target.id !== place?.id) routes = {};
    place = target;
    onDestination(place);
    if (picker) picker.hidden = true;
    render();
  }

  function render() {
    const name = place?.name || (inWonju ? '강원대학교 원주캠퍼스' : null);
    title.textContent = name ? name + '까지' : '목적지까지 이동 시간';
    details.replaceChildren();
    for (const [mode,label] of Object.entries(listingModeNames)) {
      const row = element('div', 'listing-travel-row');
      row.append(element('strong', '', label));
      const route = routes[mode];
      const measured = place && route?.mode === mode && route.listingId === room.id &&
        route.destinationId === place.id && measuredRoute(route);
      if (measured) {
        const result = element('div', 'listing-travel-result');
        result.append(element('span', '', '예상 ' + route.durationMinutes + '분 · ' + number.format(route.distanceMeters) + 'm'));
        const limit = conditions.maxCommuteMinutes;
        const filter = mode === 'walking' && conditions.transportMode === 'walk' &&
          place.id === searchPlace?.id && Number.isFinite(limit)
          ? '검색 조건 ' + limit + '분 ' + (route.durationMinutes > limit ? '초과' : '이내') : null;
        result.append(element('small', 'listing-meta', [mode === 'walking' ? 'TMAP 보행 경로' : mode === 'bus' ? 'TMAP · 도보 포함' : 'TMAP', dateLabel(route.calculatedAt,true), filter].filter(Boolean).join(' · ')));
        row.append(result);
      } else if (!enabled(mode)) {
        row.append(element('span','listing-meta',route?.reason ? listingRouteIssue(mode,route.reason) : '현재 조회 불가'));
      } else if (!name) {
        row.append(element('span','listing-meta','목적지를 선택해 주세요.'));
      } else {
        const control = element('div', 'listing-travel-control');
        if (route) control.append(element('span','listing-meta',listingRouteIssue(mode,route.reason || 'invalid-response')));
        const query = button(busyMode === mode ? '조회 중…' : '시간 확인','choice-button',() => calculate(mode));
        query.setAttribute('aria-label',name + '까지 ' + label + ' 시간 확인');
        query.disabled = Boolean(current);
        control.append(query);
        row.append(control);
      }
      if (mode === 'bus' && !measured && (!enabled(mode) || route?.reason)) {
        if (place?.verified && validPoint(place)) {
          const link = element('a','listing-link listing-transit-link','카카오맵 대중교통 ↗');
          link.href = 'https://map.kakao.com/link/by/traffic/' +
            encodeURIComponent('매물') + ',' + room.lat + ',' + room.lng + '/' +
            encodeURIComponent('목적지') + ',' + place.lat + ',' + place.lng;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          row.append(link);
        } else if (inWonju && !place) {
          const select = button(busyMode === 'destination' ? '확인 중…' : '원주캠퍼스 선택','choice-button listing-transit-link',() => calculate());
          select.disabled = Boolean(current);
          row.append(select);
        }
      }
      details.append(row);
    }
    actions.replaceChildren();
    const choose = button(name ? '다른 목적지 찾기' : '목적지 찾기', 'choice-button', () => {
      if (!picker) {
        picker = placeFinder({labelText:'도착할 장소',submitText:'장소 검색',signal,onError:authFailure,onSelect:target => {
          current?.abort();
          current = null;
          busyMode = null;
          choosePlace(target);
        }});
        picker.classList.add('listing-walk-picker');
        panel.append(picker);
      }
      picker.hidden = false;
      choose.setAttribute('aria-expanded','true');
      picker.querySelector('input').focus();
    });
    choose.setAttribute('aria-expanded', String(Boolean(picker && !picker.hidden)));
    actions.append(choose);
  }

  async function calculate(mode) {
    if (current || signal.aborted || (mode && !enabled(mode))) return;
    const operation = new AbortController();
    current = operation;
    busyMode = mode || 'destination';
    render();
    try {
      if (!place) {
        const data = await request('/api/destinations', {query:'강원대학교 원주캠퍼스'}, operation.signal);
        if (operation.signal.aborted) return;
        const campus = data.destinations?.find(item => item.id === 'knu-wonju' && item.verified && validPoint(item));
        if (!campus) {
          routes[mode || 'bus'] = {reason:'unverified-destination'};
          return;
        }
        choosePlace(campus);
      }
      if (!mode) return;
      const payload = {listingId:room.id, destinationId:place.id};
      if (mode !== 'walking') payload.mode = mode;
      const route = await request('/api/routes/walking',payload,operation.signal);
      if (operation.signal.aborted) return;
      routes[mode] = route;
      if (route.reason === 'unauthorized') authFailure({status:401});
    } catch (error) {
      if (!operation.signal.aborted) {
        routes[mode || 'bus'] = {reason:'network'};
        authFailure(error);
      }
    } finally {
      if (current === operation) {
        current = null;
        busyMode = null;
        if (!signal.aborted) render();
      }
    }
  }
  render();
  return panel;
}
