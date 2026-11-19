function measuredWalk(route) {
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

function listingWalk(room, conditions, signal, onDestination) {
  const panel = element('div', 'listing-walk');
  const summary = element('p', 'listing-commute');
  const meta = element('p', 'listing-meta');
  summary.setAttribute('aria-live', 'polite');
  const origin = room.approximate !== false ? '대략적 매물 위치 기준' : '매물 위치 기준';
  meta.textContent = origin;
  const actions = element('div', 'listing-walk-actions');
  panel.append(summary, meta, actions);

  if (conditions.transportMode && conditions.transportMode !== 'walk') {
    summary.textContent = modes[conditions.transportMode] + ' 시간 계산 미지원';
    return panel;
  }
  const searchPlace = conditions.destinationPlace?.verified ? conditions.destinationPlace : null;
  let place = searchPlace;
  let route = room.walkingRoute;
  let busy = false;
  let picker;
  function render() {
    actions.replaceChildren();
    meta.textContent = [place?.name, origin].filter(Boolean).join(' · ');
    const measured = place && measuredWalk(route);
    if (measured) {
      summary.textContent = '도보 예상 ' + route.durationMinutes + '분 · ' + number.format(route.distanceMeters) + 'm';
      const limit = conditions.maxCommuteMinutes;
      const timeCondition = place.id === searchPlace?.id && Number.isFinite(limit)
        ? '검색 조건 ' + limit + '분 ' + (route.durationMinutes > limit ? '초과' : '이내') : null;
      meta.textContent = [place.name, 'TMAP 보행 경로', origin, timeCondition, dateLabel(route.calculatedAt, true)].filter(Boolean).join(' · ');
    } else if (!room.id || !validPoint(room)) {
      summary.textContent = walkingIssue('invalid-origin');
      return;
    } else if (walkingEnabled === false) {
      summary.textContent = walkingIssue('disabled');
      return;
    } else if (route?.reason) {
      summary.textContent = walkingIssue(route.reason);
    } else {
      summary.textContent = place ? '이 매물에서 목적지까지 도보 시간을 확인하세요.' : '목적지를 선택하면 도보 시간을 확인할 수 있어요.';
    }
    if (!measured && place) {
      actions.append(button(place.name + '까지 도보', 'choice-button', () => calculate(place)));
    }
    if (searchPlace || walkingEnabled === false) return;
    if (!place && /원주시(?:\s|$)/.test([room.observedRegion, room.region, conditions.location].filter(Boolean).join(' '))) {
      actions.append(button('강원대 원주캠퍼스까지 도보', 'choice-button', () => calculate(null)));
    }
    const choose = button(place ? '다른 목적지 찾기' : '목적지 찾기', 'choice-button', () => {
      if (!picker) {
        picker = placeFinder({labelText:'도착할 장소', submitText:'장소 검색', signal, onSelect:calculate, onError:authFailure});
        picker.classList.add('listing-walk-picker');
        panel.append(picker);
      }
      picker.hidden = false;
      choose.setAttribute('aria-expanded', 'true');
      picker.querySelector('input').focus();
    });
    choose.setAttribute('aria-expanded', String(Boolean(picker && !picker.hidden)));
    actions.append(choose);
  }

  function authFailure(error) {
    if (error.status === 401 && !signal.aborted) handleFailure(error, revision);
  }

  async function calculate(target) {
    if (busy || signal.aborted) return;
    if (target && target.id === place?.id && measuredWalk(route)) {
      if (picker) picker.hidden = true;
      render();
      return;
    }
    busy = true;
    for (const item of actions.children) item.disabled = true;
    if (picker) picker.hidden = true;
    summary.textContent = 'TMAP 도보 경로를 확인하고 있어요.';
    try {
      if (!target) {
        const data = await request('/api/destinations', {query:'강원대학교 원주캠퍼스'}, signal);
        if (signal.aborted) return;
        target = data.destinations?.find(item => item.id === 'knu-wonju' && item.verified && validPoint(item));
        if (!target) throw Error('원주캠퍼스의 위치를 확인할 수 없어요.');
      }
      place = target;
      route = null;
      onDestination(place);
      route = await request('/api/routes/walking', {listingId:room.id, destinationId:place.id}, signal);
      if (signal.aborted) return;
      if (route.reason === 'unauthorized') authFailure({status:401});
      if (!signal.aborted) render();
    } catch (error) {
      if (!signal.aborted) {
        render();
        summary.textContent = error.message;
        authFailure(error);
      }
    } finally { busy = false; }
  }
  render();
  return panel;
}
