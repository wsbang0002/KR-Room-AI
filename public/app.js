const byId = id => document.getElementById(id);
const form = byId('searchForm');
const input = byId('query');
const conversation = byId('conversation');
const choices = byId('regionChoices');
const resultStatus = byId('status');
const reset = byId('resetSearch');
const initialPlaceholder = input.placeholder;
const initialSubmitLabel = byId('submitLabel').textContent;
const number = new Intl.NumberFormat('ko-KR');
const roomTypes = {ONE_ROOM:'원룸', TWO_ROOM:'투룸', THREE_ROOM:'쓰리룸', FOUR_ROOM:'포룸', OFFICETEL:'오피스텔', APT:'아파트'};
const modes = {walk:'도보', transit:'대중교통', car:'자동차'};
const prelaunch = '매물 공개 준비 중입니다. 검색 조건은 미리 정해 둘 수 있어요.';

let confirmed = null;
let pending = null;
let pendingBase = null;
let queryBeforeClarification = '';
let selectedPlace = null;
let revision = 0;
let active = null;
let placeLookup = null;
let inventoryPublic = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(text, className, click) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', click);
  return node;
}

async function request(path, body, signal) {
  const response = await fetch(path, body === undefined ? {signal} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || '요청을 완료하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function clearCards() {
  byId('cards').replaceChildren();
  byId('unknownCards').replaceChildren();
  byId('unknownTitle').hidden = true;
}

function showIdleStatus() {
  byId('results').dataset.state = inventoryPublic === null ? 'error' : inventoryPublic ? 'ready' : 'private';
  resultStatus.textContent = inventoryPublic === false ? prelaunch :
    inventoryPublic === true ? '검색 조건을 입력하면 매물을 확인할 수 있어요.' : '지금은 매물 공개 상태를 확인할 수 없어요.';
}

async function readPublicationState() {
  try {
    const data = await request('/api/status');
    inventoryPublic = typeof data.privateData === 'boolean' ? !data.privateData : null;
  } catch {
    inventoryPublic = null;
  }
}

const initialStatus = readPublicationState().then(() => {
  if (!confirmed && !pending && !active) showIdleStatus();
});

function showBusy(busy) {
  form.setAttribute('aria-busy', String(busy));
  byId('submit').disabled = busy;
  byId('submitLabel').textContent = busy ? '확인 중' : initialSubmitLabel;
}

function money(value) {
  return Number.isFinite(value) ? number.format(value) + '만 원' : '미확인';
}

function showConditions(c) {
  const items = [c.location, c.destination ? '목적지 ' + c.destination : null];
  for (const [key, label] of [['maxDeposit','보증금'], ['maxRent','월세'], ['maxMonthlyTotal','관리비 포함 월']]) {
    if (Number.isFinite(c[key])) items.push(`${label} ${money(c[key])} 이하`);
  }
  if (Number.isFinite(c.maxCommuteMinutes)) items.push(`${modes[c.transportMode] || '이동'} ${c.maxCommuteMinutes}분 이내`);
  else if (c.transportMode && c.transportMode !== 'walk') items.push(modes[c.transportMode]);
  items.push(...(c.roomTypes || []).map(key => roomTypes[key] || key));
  items.push(...(c.requiredOptions || []).map(option => option + ' 필수'));
  items.push(...(c.preferredOptions || []).filter(option => !c.requiredOptions?.includes(option)).map(option => option + ' 선호'));
  if (Number.isFinite(c.weights?.cost) && Math.abs(c.weights.cost - .5) > .001) items.push(`비용 비중 ${Math.round(c.weights.cost * 100)}%`);
  byId('conditions').replaceChildren(...items.filter(Boolean).map(label => element('span', 'condition-chip', label)));
}

function offerRegions(response) {
  conversation.textContent = response.question;
  choices.replaceChildren();
  const candidates = response.candidates || [];
  // A confirmed city can span several districts. Highlight candidates within the
  // confirmed jurisdiction, while requiring the visitor to choose the actual 동.
  const area = (pendingBase?.location || '').split(' ');
  if (/[읍면동가]$/.test(area.at(-1))) area.pop();
  const option = address => {
    const sameArea = area.length >= 2 && address.startsWith(area.join(' ') + ' ');
    const label = sameArea ? address + ' · 현재 검색 지역' : address;
    return button(label, 'choice-button', () => submitTurn(address));
  };
  const visible = 4;
  choices.append(...candidates.slice(0, visible).map(option));
  if (candidates.length > visible) {
    const more = button('다른 지역 보기', 'choice-button more-choices', () => {
      more.replaceWith(...candidates.slice(visible).map(option));
    });
    choices.append(more);
  }
  input.placeholder = '예: 원주시요';
}

function safeLink(label, href, className) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:') return null;
    const link = element('a', className, label);
    link.href = url.href;
    link.rel = 'noopener noreferrer';
    link.target = '_blank';
    return link;
  } catch { return null; }
}

function validPoint(point) {
  return Number.isFinite(point?.lat) && point.lat >= 32 && point.lat <= 39 &&
    Number.isFinite(point?.lng) && point.lng >= 124 && point.lng <= 132;
}

function mapFigure(point, caption) {
  const figure = element('figure');
  const frame = element('iframe');
  const {lat,lng} = point;
  const params = new URLSearchParams({bbox:[lng-.012, lat-.009, lng+.012, lat+.009].join(','), layer:'mapnik', marker:[lat,lng].join(',')});
  frame.title = caption;
  frame.loading = 'lazy';
  frame.referrerPolicy = 'no-referrer';
  frame.src = 'https://www.openstreetmap.org/export/embed.html?' + params;
  const label = element('figcaption', '', caption);
  const source = safeLink(point.source, point.sourceUrl, 'listing-link');
  if (source) label.append(' · ', source);
  figure.append(label, frame);
  return figure;
}

function listingMaps(room, destination) {
  const details = element('details', 'listing-detail');
  details.append(element('summary', '', '위치 지도 보기'));
  details.addEventListener('toggle', () => {
    if (!details.open || details.querySelector('iframe')) return;
    const maps = element('div', 'listing-maps');
    maps.append(mapFigure(room, room.approximate !== false ? '출발 · 대략적 매물 위치' : '출발 · 매물 위치'));
    if (destination?.verified && validPoint(destination)) maps.append(mapFigure(destination, '도착 · ' + destination.name));
    details.append(maps, element('small','muted','지도 © OpenStreetMap 기여자'));
  });
  return details;
}

function dateLabel(value, includeTime=false) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const options = {timeZone:'Asia/Seoul', year:'numeric', month:'numeric', day:'numeric'};
  if (includeTime) Object.assign(options, {hour:'2-digit', minute:'2-digit'});
  return date.toLocaleString('ko-KR', options);
}

function listingCard(room, conditions, unknown) {
  const card = element('article', 'listing-card');
  const destination = conditions.destinationPlace;
  const roomType = roomTypes[room.roomType] || room.roomType;
  const top = element('div', 'listing-summary');
  top.append(element('p', 'listing-place', [room.address || room.dong, roomType, Number.isFinite(room.areaM2) ? `${room.areaM2}㎡` : null].filter(Boolean).join(' · ') || '위치 미확인'));
  top.append(element('h3', 'listing-title', room.title || '매물 상세'));
  card.append(top, element('p', 'listing-price', Number.isFinite(room.total) ? `월 ${money(room.total)}` : '월 총액 미확인'));
  card.append(element('p', 'listing-breakdown', `보증금 ${money(room.deposit)} · 월세 ${money(room.rent)} · 관리비 ${money(room.fee)}`));
  const route = room.walkingRoute;
  const walked = route?.status === 'success' && route.provider === 'tmap' && Number.isFinite(route.durationMinutes) && Number.isFinite(route.distanceMeters);
  if (walked) {
    card.append(element('p', 'listing-commute', `도보 예상 ${route.durationMinutes}분 · ${number.format(route.distanceMeters)}m`));
    card.append(element('p', 'listing-meta', ['TMAP 보행 경로', destination?.name, route.originApproximate ? '대략적 매물 위치 기준' : null, dateLabel(route.calculatedAt, true)].filter(Boolean).join(' · ')));
  } else {
    const mode = modes[conditions.transportMode] || '이동';
    const time = Number.isFinite(room.commuteMinutes) ? `${mode} 예상 ${room.commuteMinutes}분` : `${mode} 시간 미확인`;
    card.append(element('p', 'listing-commute', time));
    if (room.approximate !== false) card.append(element('p', 'listing-meta', '대략적 매물 위치'));
  }
  if (unknown && room.missingConditions?.length) card.append(element('p', 'listing-meta', '확인할 조건 · ' + room.missingConditions.join(', ')));
  if (room.options?.length) card.append(element('p', 'listing-meta', room.options.join(' · ')));
  const checked = dateLabel(room.lastSeenAt || room.collectedAt);
  if (checked) card.append(element('p', 'listing-meta', `최근 확인 ${checked}${room.syncStatus === 'stale' ? ' · 오래된 정보' : ''}`));
  if (validPoint(room)) card.append(listingMaps(room, destination));
  const source = safeLink('원본 매물 확인 ↗', room.url, 'listing-link');
  if (source) card.append(source);
  return card;
}

function destinationPicker(c, query, turn) {
  const picker = element('form', 'destination-form');
  const label = element('label', '', '도착할 학교나 직장의 이름');
  const field = element('input');
  field.maxLength = 100;
  field.minLength = 2;
  field.required = true;
  field.value = c.destination || '';
  const find = element('button', 'choice-button', '목적지 찾기');
  find.type = 'submit';
  const message = element('p', 'muted');
  message.setAttribute('aria-live', 'polite');
  const matches = element('div','destination-choices');
  label.append(field);
  picker.append(label, find, message, matches);
  choices.append(picker);
  field.addEventListener('input', () => {
    placeLookup?.abort();
    matches.replaceChildren();
    message.textContent = '';
    find.disabled = false;
  });
  picker.addEventListener('submit', async event => {
    event.preventDefault();
    placeLookup?.abort();
    const lookup = new AbortController();
    placeLookup = lookup;
    find.disabled = true;
    matches.replaceChildren();
    message.textContent = '목적지를 찾고 있어요.';
    try {
      const data = await request('/api/destinations', {query:field.value.trim()}, lookup.signal);
      if (turn !== revision || lookup.signal.aborted) return;
      const places = (data.destinations || []).filter(p => p.verified && p.id);
      message.textContent = [places.length ? '주소를 보고 도착할 곳을 선택해 주세요.' : '좌표를 확인한 장소가 없어요. 지역과 기관명을 함께 입력해 주세요.', data.notice, data.attribution].filter(Boolean).join(' ');
      for (const place of places) {
        matches.append(button([place.name, place.address].filter(Boolean).join(' · '), 'choice-button', () => {
          const next = startRequest();
          selectedPlace = place;
          confirmed = {...confirmed, destination:place.name};
          choices.replaceChildren();
          showConditions(confirmed);
          conversation.textContent = '목적지를 ' + place.name + '로 정했어요.';
          loadListings(query, next, confirmed, place.id).catch(error => handleFailure(error, next)).finally(() => finishRequest(next));
        }));
      }
    } catch (error) {
      if (turn === revision && !lookup.signal.aborted) message.textContent = error.message;
    } finally {
      if (turn === revision && !lookup.signal.aborted) find.disabled = false;
    }
  });
}

async function loadListings(query, turn, conditions, destinationId) {
  clearCards();
  await initialStatus;
  if (turn !== revision) return;
  if (inventoryPublic === null) await readPublicationState();
  if (turn !== revision) return;
  if (inventoryPublic !== true) { showIdleStatus(); return; }
  byId('results').dataset.state = 'loading';
  resultStatus.textContent = '조건에 맞는 매물을 찾고 있어요.';
  const data = await request('/api/search', {query, confirmedConditions:conditions, ...(destinationId ? {destinationId} : {})}, active.signal);
  if (turn !== revision) return;
  const c = data.conditions;
  const matches = data.results.length;
  const unverified = data.unverified.length;
  if (data.dataSource === 'snapshot-fallback' && data.count === 0) {
    byId('results').dataset.state = 'error';
    resultStatus.textContent = '매물 정보를 불러오지 못했어요. 잠시 후 다시 검색해 주세요.';
    return;
  }
  byId('results').dataset.state = matches || unverified ? 'results' : 'empty';
  const info = [];
  if (matches) info.push(`조건에 맞는 매물 ${matches}개`);
  else if (unverified) info.push('모든 조건이 확인된 매물은 아직 없어요.');
  else info.push('현재 이 조건에 맞는 매물이 없어요. 지역이나 예산을 바꿔 보세요.');
  if (unverified) info.push(`확인할 조건이 있는 매물 ${unverified}개`);
  if (c.maxCommuteMinutes != null && data.walking?.status === 'disabled') info.push('현재 도보 시간을 확인할 수 없어요.');
  if (data.parserReason === 'upstream-timeout') info.push('AI 응답이 지연되어 입력에서 확인한 조건을 적용했어요.');
  if (data.dataSource === 'snapshot-fallback') info.push('매물 조회가 지연되어 기존 저장 자료를 확인했어요.');
  resultStatus.textContent = info.join(' ');
  showConditions(c);
  byId('cards').replaceChildren(...data.results.map(room => listingCard(room, c, false)));
  byId('unknownCards').replaceChildren(...data.unverified.map(room => listingCard(room, c, true)));
  byId('unknownTitle').hidden = !unverified;
  if (['ambiguous','unresolved'].includes(c.destinationStatus) || ['destination-ambiguous','destination-unverified'].includes(data.walking?.status)) {
    conversation.textContent = '도착할 곳을 주소로 확인해 주세요.';
    destinationPicker(c, query, turn);
  }
}

function startRequest() {
  active?.abort();
  placeLookup?.abort();
  active = new AbortController();
  reset.hidden = false;
  showBusy(true);
  return ++revision;
}

function finishRequest(turn) {
  if (turn !== revision) return;
  active = null;
  showBusy(false);
}

function handleFailure(error, turn) {
  if (turn !== revision || error.name === 'AbortError') return;
  if (error.status === 401 || error.status === 403) {
    inventoryPublic = false;
    clearCards();
    showIdleStatus();
  } else {
    conversation.textContent = error.message || '검색을 마치지 못했어요. 다시 시도해 주세요.';
    if (byId('results').dataset.state === 'loading') {
      byId('results').dataset.state = 'error';
      resultStatus.textContent = '매물 조회를 마치지 못했어요.';
    }
  }
}

async function submitTurn(query, fresh=false) {
  query = query.trim();
  if (!query) { input.focus(); return; }
  const turn = startRequest();
  const draftAtSubmit = input.value;
  const wasPending = !fresh && pending;
  const previous = wasPending ? pendingBase : fresh ? null : confirmed;
  const originalQuery = wasPending ? queryBeforeClarification : query;
  conversation.textContent = '검색 조건을 확인하고 있어요.';
  try {
    const data = await request('/api/conditions', {query, ...(previous ? {previous} : {}), ...(wasPending ? {pending} : {})}, active.signal);
    if (turn !== revision) return;
    if (input.value === draftAtSubmit) input.value = '';
    choices.replaceChildren();
    if (data.state === 'clarify') {
      pending = data.pending;
      pendingBase = previous;
      queryBeforeClarification = originalQuery;
      offerRegions(data);
      input.focus({preventScroll:true});
      return;
    }
    if (data.state !== 'ready' || !data.conditions) throw Error('조건을 확인하지 못했어요. 다시 입력해 주세요.');
    pending = null;
    pendingBase = null;
    queryBeforeClarification = '';
    if (fresh || data.conditions.destination !== previous?.destination) selectedPlace = null;
    confirmed = data.conditions;
    showConditions(confirmed);
    conversation.textContent = confirmed.location ? `${confirmed.location} 조건을 적용했어요.` : '검색 조건을 적용했어요.';
    input.placeholder = '예: 관리비 포함 월 45만 원으로 바꿔줘';
    await loadListings(originalQuery, turn, confirmed, data.destinationId || selectedPlace?.id);
  } catch (error) {
    handleFailure(error, turn);
  } finally { finishRequest(turn); }
}

form.addEventListener('submit', event => { event.preventDefault(); submitTurn(input.value); });
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!byId('submit').disabled) form.requestSubmit();
  }
});
for (const example of document.querySelectorAll('[data-query]')) {
  example.addEventListener('click', () => {
    input.value = example.dataset.query;
    submitTurn(input.value, true);
  });
}
reset.addEventListener('click', () => {
  revision++;
  active?.abort();
  placeLookup?.abort();
  active = null;
  confirmed = null;
  pending = null;
  pendingBase = null;
  selectedPlace = null;
  queryBeforeClarification = '';
  input.value = '';
  input.placeholder = initialPlaceholder;
  conversation.textContent = '';
  choices.replaceChildren();
  byId('conditions').replaceChildren();
  clearCards();
  showIdleStatus();
  showBusy(false);
  reset.hidden = true;
  input.focus();
});
