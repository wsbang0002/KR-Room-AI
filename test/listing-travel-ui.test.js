import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const cardSource = readFileSync(new URL('../public/listing-walk.js', import.meta.url), 'utf8');
const campus = {id:'knu-wonju', name:'강원대학교 원주캠퍼스', verified:true, lat:37.3, lng:127.9};
const listing = {id:'listing-1', lat:37.31, lng:127.92, approximate:true};

// The public card is a plain DOM script. Capture visible labels, controls, and
// requests without requiring a browser binary on each Node CI runner.
function element(tag, className, textContent = '') {
  const attrs = {};
  const node = {
    tag, className, textContent, children:[], hidden:false, disabled:false,
    classList:{add() {}},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { attrs[key] = value; },
    getAttribute(key) { return attrs[key]; }
  };
  return node;
}

function visibleNodes(node) {
  return node.hidden ? [] : [node, ...node.children.flatMap(visibleNodes)];
}

function visibleText(panel) {
  return visibleNodes(panel).map(node => node.textContent).join(' ');
}

function action(panel, label) {
  const selected = visibleNodes(panel).find(node => node.tag === 'button' && label.test(node.getAttribute('aria-label') || node.textContent));
  assert.ok(selected, 'missing ' + label + ' in ' + visibleText(panel));
  assert.equal(selected.disabled, false);
  return selected.click();
}

function makeCard({room = listing, conditions = {}, respond, globals = {}} = {}) {
  const requests = [];
  const destinations = [];
  const context = vm.createContext({
    element, AbortController,
    listingRoutes:{car:{enabled:true,keyConfigured:true},bus:{enabled:true,keyConfigured:true}},
    button:(label, cls, click) => Object.assign(element('button',cls,label),{click}),
    validPoint:point => Number.isFinite(point?.lat) && Number.isFinite(point?.lng),
    walkingEnabled:true,
    modes:{walk:'도보',car:'자동차',transit:'대중교통'},
    number:new Intl.NumberFormat('ko-KR'),
    dateLabel:()=>'',
    request:async(path, body) => {
      requests.push({path, body:{...body}});
      return respond(path,body);
    },
    ...globals
  });
  vm.runInContext(cardSource,context);
  // Destination search is covered separately. Exercise its selection callback.
  let destinationSelection;
  context.placeFinder = options => {
    destinationSelection = options.onSelect;
    return Object.assign(element('form','picker'), {querySelector:()=>({focus() {}})});
  };
  const panel = context.listingWalk(room, conditions, new AbortController().signal, place => destinations.push(place.id));
  return {panel,requests,destinations,selectPlace:place => destinationSelection(place)};
}

function result(mode, minutes, destinationId = campus.id) {
  return {status:'success', mode, provider:'tmap', durationMinutes:minutes, distanceMeters:540,
    listingId:listing.id, destinationId};
}

test('listing comparison requests only the selected mode and preserves each measured time', async () => {
  const durations = {walking:15, bus:21, car:7};
  const {panel, requests} = makeCard({
    room:{...listing,walkingRoute:result('walking',15)},conditions:{destinationPlace:campus},
    respond:(_,body)=>result(body.mode,durations[body.mode])
  });
  assert.equal(requests.length,0);
  assert.match(visibleText(panel),/예상 15분/);
  await action(panel,/버스 시간 확인/);
  assert.match(visibleText(panel),/예상 15분/);
  assert.match(visibleText(panel),/예상 21분/);
  await action(panel,/자동차 시간 확인/);
  const text = visibleText(panel);
  for (const minutes of Object.values(durations)) assert.ok(text.includes('예상 ' + minutes + '분'));
  assert.deepEqual(requests,['bus','car'].map(mode=>({
    path:'/api/routes/walking',body:{listingId:listing.id,destinationId:campus.id,mode}
  })));
});

test('changing destination clears old measurements and ignores a previous request finishing late', async () => {
  let finish;
  const oldResult = new Promise(resolve => {finish=resolve;});
  const {panel, requests, selectPlace} = makeCard({
    room:{...listing,walkingRoute:result('walking',12)},conditions:{destinationPlace:campus},
    respond:(_,body)=>body.mode==='bus'?oldResult:result(body.mode,6,body.destinationId)
  });
  const pending = action(panel,/버스 시간 확인/);
  action(panel,/다른 목적지 찾기/);
  selectPlace({...campus,id:'station',name:'원주역'});
  assert.equal(requests.length,1);
  finish(result('bus',18));
  await pending;
  assert.match(visibleText(panel),/원주역까지/);
  assert.doesNotMatch(visibleText(panel),/예상 (?:12|18)분/);
  await action(panel,/자동차 시간 확인/);
  assert.equal(requests[1].body.destinationId,'station');
  assert.match(visibleText(panel),/예상 6분/);
});

test('bus failure and mismatched IDs never appear as a measured route', async () => {
  const {panel} = makeCard({
    room:{...listing,walkingRoute:result('walking',19,'different')},conditions:{destinationPlace:campus},
    respond:(_,body)=>body.mode==='bus'?{status:'unconfirmed',reason:'no-bus-route'}:
      {...result('car',3),listingId:'other-listing'}
  });
  await action(panel,/버스 시간 확인/);
  await action(panel,/자동차 시간 확인/);
  assert.match(visibleText(panel),/버스 경로를 찾지 못했어요/);
  assert.ok(visibleNodes(panel).some(node => node.tag === 'a' && /카카오맵/.test(node.textContent)));
  assert.doesNotMatch(visibleText(panel),/예상 \d+분/);
});

test('unconfigured transit or missing coordinates do not start external queries', () => {
  const {panel, requests} = makeCard({conditions:{destinationPlace:campus},
    globals:{listingRoutes:{car:{enabled:true,keyConfigured:true},bus:{enabled:false,keyConfigured:false}}}});
  const buttons = visibleNodes(panel).filter(node=>node.tag==='button').map(node=>node.getAttribute('aria-label'));
  assert.ok(buttons.includes(campus.name+'까지 자동차 시간 확인'));
  assert.ok(!buttons.includes(campus.name+'까지 버스 시간 확인'));
  assert.equal(requests.length,0);
  const invalid = makeCard({room:{...listing,lat:null}});
  assert.equal(visibleNodes(invalid.panel).some(node=>node.tag==='button'),false);
  assert.equal(invalid.requests.length,0);
});

test('unavailable bus directions open externally with only the current origin and destination points', () => {
  const {panel, requests, selectPlace} = makeCard({
    room:{...listing,title:'PRIVATE-LISTING-NAME'},conditions:{destinationPlace:campus},
    globals:{listingRoutes:{car:{enabled:true,keyConfigured:true},bus:{enabled:false,keyConfigured:false}}}
  });
  function checkExternal(place) {
    const link = visibleNodes(panel).find(node => node.tag === 'a' && /카카오맵/.test(node.textContent));
    assert.ok(link);
    const url = new URL(link.href);
    assert.equal(url.origin,'https://map.kakao.com');
    const [,prefix,direction,mode,start,end] = decodeURIComponent(url.pathname).split('/');
    assert.deepEqual([prefix,direction,mode],['link','by','traffic']);
    assert.deepEqual(start.split(',').slice(1),[String(listing.lat),String(listing.lng)]);
    assert.deepEqual(end.split(',').slice(1),[String(place.lat),String(place.lng)]);
    assert.ok(!decodeURIComponent(link.href).includes(place.name));
    assert.ok(!decodeURIComponent(link.href).includes('PRIVATE-LISTING-NAME'));
    assert.equal(link.target,'_blank');
    assert.match(link.rel,/noreferrer/);
  }
  checkExternal(campus);
  action(panel,/다른 목적지 찾기/);
  const station = {...campus,id:'station',name:'PRIVATE-STATION',lat:37.32,lng:127.96};
  selectPlace(station);
  checkExternal(station);
  assert.equal(requests.length,0);
});

test('a Wonju listing without a destination resolves the curated campus without starting a transit request', async () => {
  const {panel,requests,destinations} = makeCard({
    conditions:{location:'원주시 무실동'},globals:{listingRoutes:{}},
    respond:() => ({destinations:[campus]})
  });
  assert.equal(requests.length,0);
  await action(panel,/원주캠퍼스 선택/);
  assert.deepEqual(requests,[{path:'/api/destinations',body:{query:'강원대학교 원주캠퍼스'}}]);
  assert.deepEqual(destinations,[campus.id]);
  assert.ok(visibleNodes(panel).some(node => node.tag === 'a' && /카카오맵/.test(node.textContent)));
});
