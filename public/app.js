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
const signInPrompt = '오른쪽 위의 로그인 버튼을 눌러 조건에 맞는 매물을 확인하세요.';

let confirmed = null;
let pending = null;
let pendingBase = null;
let queryBeforeClarification = '';
let selectedPlace = null;
let revision = 0;
let active = null;
let placeLookup = null;
let cardLifetime = new AbortController();
let inventoryPublic = null;
let signedIn = false;
let waitingSearch = null;
let coverageRequest = null;
let walkingEnabled = null;
let routeInitialized = false;

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
  cardLifetime.abort();
  cardLifetime = new AbortController();
  byId('cards').replaceChildren();
  byId('unknownCards').replaceChildren();
  byId('unknownTitle').hidden = true;
}

function canSearch() {
  return signedIn || inventoryPublic === true;
}

function showIdleStatus() {
  byId('results').dataset.state = canSearch() ? 'ready' : inventoryPublic === false ? 'private' : 'error';
  resultStatus.textContent = canSearch() ? '검색 조건을 입력하면 매물을 확인할 수 있어요.' :
    inventoryPublic === false ? signInPrompt : '지금은 매물 공개 상태를 확인할 수 없어요.';
}

function showAccess() {
  byId('publicationState').textContent = signedIn ? '로그인됨 · 수집된 매물을 검색할 수 있어요.' :
    inventoryPublic === true ? '수집된 지역의 매물을 검색할 수 있어요.' :
    inventoryPublic === false ? '로그인하면 수집된 매물을 검색할 수 있어요.' : '매물 공개 상태 미확인';
  if (canSearch()) {
    if (!coverageRequest) showInventory();
  } else {
    coverageRequest?.abort();
    coverageRequest = null;
    byId('coverageSummary').replaceChildren();
    byId('coverageSummary').hidden = true;
  }
}

async function readPublicationState() {
  try {
    const data = await request('/api/status');
    inventoryPublic = typeof data.privateData === 'boolean' ? !data.privateData : null;
    walkingEnabled = data.walking?.enabled === true && data.walking?.keyConfigured === true;
    byId('walkingState').textContent = walkingEnabled ? 'TMAP 도보 경로 사용 가능' : '도보 시간 계산 비활성';
    if (walkingEnabled && !routeInitialized) {
      routeInitialized = true;
      setupPublicRoute();
    }
  } catch {
    inventoryPublic = null;
    byId('walkingState').textContent = '도보 경로 상태 미확인';
  }
  showAccess();
}

async function showInventory() {
  const node = byId('coverageSummary');
  const current = new AbortController();
  coverageRequest = current;
  node.hidden = false;
  node.textContent = '수집한 지역을 확인하고 있어요.';
  try {
    const data = await request('/api/status?scope=coverage', undefined, current.signal);
    if (current.signal.aborted) return;
    if (data.state === 'private') {
      inventoryPublic = false;
      if (signedIn) login.expire();
      else { showAccess(); showIdleStatus(); }
      return;
    }
    node.textContent = searchInfo.inventorySummary(data);
  } catch { if (!current.signal.aborted) node.textContent = '보유 지역과 매물 수를 확인할 수 없어요.'; }
}

async function setupPublicRoute() {
  const section = byId('publicRoute');
  const origin = byId('routeOrigin'), destination = byId('routeDestination');
  const submit = byId('routeSubmit'), feedback = byId('routeFeedback');
  const selectOption = (value, label) => new Option(label, value);
  const placeOption = place => selectOption(place.id, [place.name, place.address].filter(Boolean).join(' · '));
  section.hidden = false;
  origin.disabled = true;
  destination.disabled = true;
  submit.disabled = true;
  let locations;
  try {
    locations = await request('/api/routes/walking?places=public');
    if (!locations.origins?.length || !locations.destinations?.length) throw Error();
  } catch {
    feedback.textContent = '공개 출발지와 목적지 목록을 불러오지 못했어요.';
    return;
  }
  origin.replaceChildren(selectOption('', '출발지 선택'), ...locations.origins.map(placeOption));
  destination.replaceChildren(selectOption('', '먼저 출발지를 선택하세요'));
  origin.disabled = false;
  function pickOrigin() {
    const from = locations.origins.find(place => place.id === origin.value);
    const places = locations.destinations.filter(place => from?.destinationIds?.includes(place.id));
    destination.replaceChildren(selectOption('', '도착지 선택'), ...places.map(placeOption));
    destination.disabled = !places.length;
    submit.disabled = true;
    feedback.textContent = '';
  }
  origin.addEventListener('change', pickOrigin);
  destination.addEventListener('change', () => { submit.disabled = !destination.value; feedback.textContent = ''; });
  byId('publicRouteForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || !origin.value || !destination.value) return;
    const from = origin.selectedOptions[0], to = destination.selectedOptions[0];
    submit.disabled = true;
    origin.disabled = true;
    destination.disabled = true;
    feedback.textContent = 'TMAP에서 보행 경로를 확인하고 있어요.';
    try {
      const route = await request('/api/routes/walking', {publicOriginId:from.value, destinationId:to.value});
      if (measuredWalk(route)) {
        const updated = dateLabel(route.calculatedAt, true);
        feedback.textContent = `${from.text.split(' · ')[0]} → ${to.text.split(' · ')[0]} · 도보 예상 ${route.durationMinutes}분 · ${number.format(route.distanceMeters)}m · TMAP · ${updated ? updated + ' 계산 (한국시간)' : '계산 시각 미확인'}${route.cacheHit ? ' · 저장된 경로' : ''}`;
      } else {
        feedback.textContent = walkingIssue(route.reason);
      }
    } catch (error) { feedback.textContent = '도보 시간 미확인. ' + error.message; }
    finally { origin.disabled = false; destination.disabled = false; submit.disabled = false; }
  });
}

const login = startSearchLogin(value => {
  signedIn = value;
  if (!value) clearSearch();
  showAccess();
  if (value && waitingSearch && !active) {
    const {query, destinationId, lookupQuery} = waitingSearch;
    waitingSearch = null;
    if (lookupQuery && pending) destinationPicker(pending.conditions, query, revision, lookupQuery);
    else if (confirmed && !pending) {
      const turn = startRequest();
      loadListings(query, turn, confirmed, destinationId).catch(error => handleFailure(error, turn)).finally(() => finishRequest(turn));
    }
  } else if (!active) showIdleStatus();
}, message => { conversation.textContent = message; });
const initialStatus = Promise.all([readPublicationState(), login.initial]).then(() => {
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
  if (Number.isFinite(c.weights?.cost) && Math.abs(c.weights.cost - .5) > .001) {
    items.push(`비용 ${Math.round(c.weights.cost * 100)}% · 이동 ${Math.round(c.weights.commute * 100)}%`);
  }
  byId('conditions').replaceChildren(...items.filter(Boolean).map(label => element('span', 'condition-chip', label)));
}

function offerClarification(response) {
  conversation.textContent = response.question;
  choices.replaceChildren();
  const candidates = response.candidates || [];
  // A confirmed city can span several districts. Highlight candidates within the
  // confirmed jurisdiction, while requiring the visitor to choose the actual 동.
  const area = (pendingBase?.location || '').split(' ');
  if (/[읍면동가]$/.test(area.at(-1))) area.pop();
  const option = address => {
    if (response.kind === 'destination') {
      const place = response.places?.find(item => item.name === address);
      return button([address,place?.address].filter(Boolean).join(' · '), 'choice-button', () => submitTurn(address));
    }
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
  input.placeholder = response.kind === 'destination' ? '예: 강원대학교 원주캠퍼스' : '예: 원주시요';
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
  let mappedDestinationId = destination?.id;
  let maps = validPoint(room) ? listingMaps(room, destination) : null;
  card.append(listingWalk(room, conditions, cardLifetime.signal, place => {
    if (!maps || place.id === mappedDestinationId) return;
    mappedDestinationId = place.id;
    const replacement = listingMaps(room, place);
    replacement.open = maps.open;
    maps.replaceWith(replacement);
    maps = replacement;
  }));
  if (unknown && room.missingConditions?.length) card.append(element('p', 'listing-meta', '검색 당시 미확인 · ' + room.missingConditions.join(', ')));
  if (room.options?.length) card.append(element('p', 'listing-meta', room.options.join(' · ')));
  card.append(element('p', 'listing-meta', searchInfo.listingRecord(room)));
  if (maps) card.append(maps);
  const source = safeLink('원본 매물 확인 ↗', room.url, 'listing-link');
  if (source) card.append(source);
  return card;
}

function destinationPicker(c, query, turn, lookupQuery) {
  placeLookup?.abort();
  placeLookup = new AbortController();
  const picker = placeFinder({
    labelText:'도착할 학교나 직장의 이름', submitText:'목적지 찾기',
    initialName:lookupQuery || c.destination || '', signal:placeLookup.signal,
    onError:error => { if (error.status === 401) handleFailure(error, turn); },
    onSelect:place => {
      const next = startRequest();
      selectedPlace = place;
      const draft = pending?.conditions || confirmed;
      confirmed = {...draft, destination:place.name};
      pending = null;
      pendingBase = null;
      queryBeforeClarification = '';
      choices.replaceChildren();
      showConditions(confirmed);
      conversation.textContent = '목적지를 ' + place.name + '로 정했어요.';
      loadListings(query, next, confirmed, place.id).catch(error => handleFailure(error, next)).finally(() => finishRequest(next));
    }
  });
  choices.append(picker);
  if (lookupQuery) picker.requestSubmit();
}

async function loadListings(query, turn, conditions, destinationId) {
  clearCards();
  await initialStatus;
  if (turn !== revision) return;
  if (!signedIn && inventoryPublic === null) await readPublicationState();
  if (turn !== revision) return;
  if (!canSearch()) {
    waitingSearch = {query, destinationId};
    showIdleStatus();
    return;
  }
  waitingSearch = null;
  byId('results').dataset.state = 'loading';
  resultStatus.textContent = '조건에 맞는 매물을 찾고 있어요.';
  const data = await request('/api/search', {query, confirmedConditions:conditions, ...(destinationId ? {destinationId} : {})}, active.signal);
  if (turn !== revision) return;
  const c = data.conditions;
  const unverified = data.unverified.length;
  const summary = searchInfo.resultStatus(data);
  byId('results').dataset.state = summary.state;
  const mobility = searchInfo.mobility(c, walkingEnabled);
  resultStatus.textContent = [summary.text, mobility].filter(Boolean).join(' ');
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
    if (signedIn) { login.expire(); return; }
    clearCards();
    showAccess();
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
  waitingSearch = null;
  const draftAtSubmit = input.value;
  const wasPending = !fresh && pending;
  const previous = wasPending ? pendingBase : fresh ? null : confirmed;
  const originalQuery = wasPending ? queryBeforeClarification : query;
  conversation.textContent = '검색 조건을 확인하고 있어요.';
  try {
    const data = await request('/api/conditions', {query, ...(previous ? {previous} : {}), ...(wasPending ? {pending} : {}), ...(!fresh && selectedPlace?.id ? {destinationId:selectedPlace.id} : {})}, active.signal);
    if (turn !== revision) return;
    if (input.value === draftAtSubmit) input.value = '';
    choices.replaceChildren();
    const info = searchInfo.interpretation(data.interpretation);
    const mobility = searchInfo.mobility(data.conditions || data.pending?.conditions, walkingEnabled);
    byId('interpretationNote').textContent = [info,mobility].filter(Boolean).join(' ');
    if (data.state === 'clarify') {
      pending = data.pending;
      pendingBase = previous;
      queryBeforeClarification = originalQuery;
      offerClarification(data);
      if (data.kind === 'destination' && data.lookupQuery && !data.candidates?.length) {
        if (canSearch()) destinationPicker(data.pending.conditions, originalQuery, turn, data.lookupQuery);
        else waitingSearch = {query:originalQuery, lookupQuery:data.lookupQuery};
      }
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
function clearSearch() {
  revision++;
  active?.abort();
  placeLookup?.abort();
  active = null;
  confirmed = null;
  pending = null;
  pendingBase = null;
  selectedPlace = null;
  waitingSearch = null;
  queryBeforeClarification = '';
  input.value = '';
  input.placeholder = initialPlaceholder;
  conversation.textContent = '';
  byId('interpretationNote').textContent = '';
  choices.replaceChildren();
  byId('conditions').replaceChildren();
  clearCards();
  showIdleStatus();
  showBusy(false);
  reset.hidden = true;
}
reset.addEventListener('click', () => {
  clearSearch();
  input.focus();
});
