'use strict';
const $=id=>document.getElementById(id);
const query=$('query'),btn=$('submit'),status=$('status'),cards=$('cards'),chips=$('conditions');
const fmt=n=>n==null?'미확인':`${Number(n).toLocaleString('ko-KR')}만 원`;
let credential='',controller=null,liveCollection=false;
let confirmed=null,pending=null,lastPayload=null,walkingEnabled=null,coverageRequest=null;
function make(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;}
function chip(text){chips.append(make('span','chip',text));}
async function request(path,options={},key=credential){
 const response=await fetch(path,{...options,signal:options.signal??controller?.signal,
  redirect:'error',cache:'no-store',credentials:'omit',
  headers:{'Content-Type':'application/json',Authorization:'Bearer '+key}});
 const data=await response.json();
 if(!response.ok)throw Error(data.error||'요청을 완료하지 못했습니다.');
 return data;
}
function post(path,body){return request(path,{method:'POST',body:JSON.stringify(body)});}
function clearSession(){
 controller?.abort();
 placeLookup?.abort();
 coverageRequest?.abort();
 walkingEnabled=null;
 credential='';liveCollection=false;confirmed=null;pending=null;lastPayload=null;
 $('adminKey').value='';query.value='';destinationInput.value='';
 clearPlaces();
 for(const id of ['status','cards','unknownCards','conditions','integrationResult','comparisonResult','regionChoices','loginMessage','inventorySummary','interpretationNote'])$(id).replaceChildren();
 for(const id of ['map','endMap'])$(id).removeAttribute('src');
 for(const id of ['workspace','signOut','unknownTitle','mapPanel'])$(id).hidden=true;
 $('comparisonResult').hidden=true;
 $('loginPanel').hidden=false;
 busy(false);
}
window.addEventListener('pagehide',clearSession);
$('signOut').onclick=()=>{clearSession();$('adminKey').focus();};
$('loginForm').onsubmit=async e=>{
 e.preventDefault();
 const input=$('adminKey'),key=input.value;
 if(!/^[\x21-\x7e]{24,512}$/.test(key)){
  $('loginMessage').textContent='공백 없이 영문·숫자·기호로 된 로그인 키를 입력하세요.';return;
 }
 controller?.abort();
 const login=new AbortController();controller=login;
 const button=$('loginForm').querySelector('button');
 button.disabled=true;$('loginMessage').textContent='인증 확인 중…';
 try{
  const config=await request('/api/status?scope=admin',{signal:login.signal},key);
  if(login.signal.aborted)return;
  if(config.adminAuthenticated!==true)throw Error('로그인을 확인할 수 없습니다.');
  credential=key;input.value='';liveCollection=config.liveCollectionEnabled===true;
  $('loginMessage').textContent='';$('loginPanel').hidden=true;$('workspace').hidden=false;$('signOut').hidden=false;
  $('compareGemini').hidden=config.analysisProvider!=='gemini'||!config.geminiConfigured;
  walkingEnabled=config.walking?.enabled===true&&config.walking?.keyConfigured===true;
  $('inventorySummary').textContent='보유 지역을 확인하고 있습니다…';
  coverageRequest?.abort();
  coverageRequest=new AbortController();
  const scope=coverageRequest;
  request('/api/status?scope=coverage',{signal:scope.signal}).then(data=>{
   if(!scope.signal.aborted&&credential===key)$('inventorySummary').textContent=searchInfo.inventorySummary(data);
  }).catch(()=>{
   if(!scope.signal.aborted&&credential===key)$('inventorySummary').textContent='보유 지역과 매물 수를 확인할 수 없습니다.';
  });
  busy(false);query.focus();
 }catch(error){
  if(!login.signal.aborted){$('loginMessage').textContent=error.message;input.select();}
 }finally{button.disabled=false;}
};
let selectedDestination=null,placeLookup=null;
const destinationInput=$('destination');

function showPlaceSource(container,place){
 if(!place?.sourceUrl?.startsWith('https://'))return;
 const link=make('a','',place.source||'목적지 좌표 출처');
 link.href=place.sourceUrl;link.target='_blank';link.rel='noopener noreferrer';
 container.append(' · ',link);
}

function clearPlaces(){
 placeLookup?.abort();
 placeLookup=null;
 selectedDestination=null;
 $('destinationChoices').replaceChildren();
 $('destinationChoices').hidden=true;
 $('destinationMessage').textContent='';
}

async function findPlaces(){
 clearPlaces();
 const text=destinationInput.value.trim();
 if(!text){$('destinationMessage').textContent='목적지 이름 또는 주소를 입력하세요.';destinationInput.focus();return;}
 const lookup=new AbortController();
 placeLookup=lookup;
 const message=$('destinationMessage'),choices=$('destinationChoices');
 message.textContent='목적지 조회 중…';
 try{
  const response=await request('/api/destinations',{method:'POST',body:JSON.stringify({query:text}),signal:lookup.signal});
  if(placeLookup!==lookup)return;
  const places=response.destinations.filter(place=>place.verified&&place.id);
  const prompt=places.length?'주소를 확인하고 도착할 장소를 선택하세요.':'해당 이름으로 좌표를 확인한 장소가 없습니다.';
  message.textContent=[prompt,response.notice,response.attribution].filter(Boolean).join(' ');
  for(const place of places){
   const li=make('li'),button=make('button','','');
   button.type='button';
   button.append(make('strong','',place.name),make('small','',place.address||'주소 미확인'));
   button.onclick=()=>{
    selectedDestination=place;
    destinationInput.value=place.name;
    choices.replaceChildren();
    choices.hidden=true;
    message.textContent=['선택한 목적지',place.name,place.address,response.attribution].filter(Boolean).join(' · ');
    showPlaceSource(message,place);
    if(pending?.kind==='destination')loadSelectedPlace(place);
    else destinationInput.focus();
   };
   li.append(button);choices.append(li);
  }
  choices.hidden=!places.length;
 }catch(e){if(placeLookup===lookup)message.textContent=e.message;}
}
destinationInput.addEventListener('input',clearPlaces);
destinationInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();findPlaces();}});
$('findDestinations').onclick=findPlaces;

async function loadSelectedPlace(place){
 const next={...pending.conditions,destination:place.name};
 const body={query:pending.query,confirmedConditions:next,destinationId:place.id};
 controller?.abort();const operation=new AbortController();controller=operation;
 busy(true);
 try{
  const result=await post('/api/search',body);
  if(operation.signal.aborted)return;
  pending=null;confirmed=next;lastPayload=body;
  render(result);query.value='';
 }catch(error){if(!operation.signal.aborted)status.textContent=error.message;}
 finally{if(controller===operation)busy(false);}
}

function validMapPoint(place){
 return Number.isFinite(place?.lat)&&place.lat>=32&&place.lat<=39&&Number.isFinite(place?.lng)&&place.lng>=124&&place.lng<=132;
}

function mapSource({lat,lng}){
 const params=new URLSearchParams({bbox:[lng-.012,lat-.009,lng+.012,lat+.009].join(','),layer:'mapnik',marker:[lat,lng].join(',')});
 return 'https://www.openstreetmap.org/export/embed.html?'+params;
}

function showMap(room,destination){
 $('mapNotice').textContent=room.approximate?'출발 · 대략적 매물 위치':'출발 · 매물 위치';
 $('map').src=mapSource(room);
 const showEnd=destination?.verified&&validMapPoint(destination);
 $('endMapPanel').hidden=!showEnd;
 if(showEnd){
  $('endMapLabel').textContent=['도착',destination.name,destination.address].filter(Boolean).join(' · ');
  showPlaceSource($('endMapLabel'),destination);
  $('endMap').src=mapSource(destination);
 }else $('endMap').removeAttribute('src');
 const panel=$('mapPanel');panel.hidden=false;panel.open=true;panel.scrollIntoView({block:'nearest'});
}

function routeSummary(route){
 if(route?.status!=='success'||route.provider!=='tmap'||!Number.isFinite(route.durationMinutes)||!Number.isFinite(route.distanceMeters))return null;
 const origin=route.originApproximate?'대략적 매물 위치 기준 ':'';
 return origin+'도보 예상 '+route.durationMinutes+'분 · '+route.distanceMeters.toLocaleString('ko-KR')+'m';
}

function routeReason(code){
 const labels={
  'disabled':'경로 계산이 꺼져 있습니다.', 'unauthorized':'관리자 인증이 필요합니다.',
  'unverified-destination':'목적지 좌표 미확인', 'invalid-origin':'매물 좌표 미확인',
  'authentication':'TMAP 인증 실패', 'missing-key':'TMAP 키 미설정',
  'daily-limit':'오늘의 경로 호출 한도 도달', 'diagnostic-limit':'오늘의 관리자 검사 한도 도달',
  'user-rate-limit':'사용자 요청 한도 도달', 'upstream-rate-limit':'TMAP 요청 한도 도달',
  'concurrent-limit':'다른 경로 계산 중', 'pending':'같은 경로 계산 중', 'cooldown':'최근 조회한 경로',
  'timeout':'TMAP 응답 지연', 'network':'TMAP 연결 실패', 'upstream-server':'TMAP 서버 오류',
  'route-not-found':'보행 경로 없음', 'invalid-response':'거리·시간 응답 미확인',
  'redis-unavailable':'사용량 저장소 연결 실패'
 };
 return labels[code]||code;
}

function checkedAt(value){
 const date=new Date(value);
 return value&&Number.isFinite(date.getTime())?date.toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+' (한국시간)':'미확인';
}

function walkDetails(el,room,destination,mode){
 const route=room.walkingRoute;
 const summary=routeSummary(route);
 if(summary){
  el.append(make('p','walk-summary',summary));
  el.append(make('p','metadata',['TMAP 보행 경로',destination?.name,'계산 '+checkedAt(route.calculatedAt)].filter(Boolean).join(' · ')));
  return;
 }
 const modeLabel={transit:'대중교통',car:'자동차'}[mode];
 const time=modeLabel?modeLabel+' 시간 계산 미지원':room.commuteMinutes==null?'도보 시간 미확인':`도보 예상 ${room.commuteMinutes}분`;
 const reason=route?.reason?routeReason(route.reason):'';
 el.append(make('p','metadata',[time,reason,room.approximate?'대략적 매물 위치':'위치 정확도 확인 필요'].filter(Boolean).join(' · ')));
}

function addRoomActions(el,room,destination){
 if(!validMapPoint(room))return;
 const actions=make('div','room-actions');
 const map=make('button','room-action','위치 지도 보기');
 map.type='button';map.onclick=()=>showMap(room,destination);
 actions.append(map);el.append(actions);
 if(!room.id||!destination?.id||!destination.verified||!credential)return;
 const test=make('button','room-action route-diagnose','관리자 도보 경로 검사');
 test.type='button';
 const feedback=make('p','hint');
 feedback.setAttribute('aria-live','polite');
 actions.append(test);el.append(feedback);
 test.onclick=async()=>{
  controller?.abort();controller=new AbortController();busy(true);
  feedback.textContent='도보 경로 검사 중…';
  try{
   const {walking}=await request('/api/status');
   if(!walking?.keyConfigured){feedback.textContent='TMAP 키 설정을 확인하세요.';return;}
   const payload={listingId:room.id,destinationId:destination.id,diagnostic:true};
   if(!walking.enabled&&!walking.diagnosticEnabled){
    if(walking.oneShotAllowed!==true){feedback.textContent='서버에서 관리자 도보 경로 검사가 잠겨 있습니다.';return;}
    const approved=window.confirm(
     'SK Open API 대시보드에서 이 앱의 TMAP Free 보행 경로 권한, 오늘의 잔여 무료 한도와 한도 초과 차단을 확인하셨나요?'+
     '\n확인을 누르면 선택한 경로 1건을 검사합니다. 실제 호출은 오늘의 사용량에 포함됩니다.'
    );
    if(!approved){feedback.textContent='도보 경로 검사를 취소했습니다.';return;}
    payload.confirmFreePlan=true;
   }
   const route=await request('/api/routes/walking',{method:'POST',body:JSON.stringify(payload)});
   const summary=routeSummary(route);
   feedback.textContent=summary
    ? [summary,'TMAP',route.cacheHit?'캐시 적중':'새 계산',checkedAt(route.calculatedAt)].join(' · ')
    : '이동시간 미확인'+(route.reason?' · '+routeReason(route.reason):'');
  }catch(e){feedback.textContent=e.name==='AbortError'?'도보 경로 조회를 취소했습니다.':e.message;}
  finally{busy(false);}
 };
}

function render(data){chips.replaceChildren();cards.replaceChildren();$('unknownCards').replaceChildren();$('regionChoices').replaceChildren();const c=data.conditions;
 $('mapPanel').hidden=true;$('map').removeAttribute('src');$('endMap').removeAttribute('src');
 chip(c.location);if(c.destination)chip('목적지 · '+(c.destinationPlace?.name||c.destination));
 for(const [key,label] of [['maxDeposit','보증금'],['maxMonthlyTotal','월 총비용'],['maxRent','월세']])if(c[key]!=null)chip(`${label} ≤ ${fmt(c[key])}`);
 if(c.maxCommuteMinutes!=null)chip(`${{walk:'도보',transit:'대중교통',car:'자동차'}[c.transportMode]} ${c.maxCommuteMinutes}분 이내`);
 c.preferredOptions.forEach(x=>chip(`선호: ${x}`));c.requiredOptions.forEach(x=>chip(`필수: ${x}`));chip(`비용 비중 ${Math.round(c.weights.cost*100)}%`);
 const summary=searchInfo.resultStatus(data);
 status.textContent=[summary.text,searchInfo.mobility(c,walkingEnabled)].filter(Boolean).join(' ');
 const walking=data.walking;
 if(walking&&walking.status!=='not-requested'){
  const notes={
   'destination-ambiguous':'같은 이름의 목적지가 있습니다. 주소를 보고 선택하세요.',
   'destination-unverified':'목적지 좌표를 확인해야 도보 시간을 계산할 수 있습니다.',
   disabled:'도보 경로 계산이 꺼져 있어 이동시간을 확인할 수 없습니다.',
   'no-eligible-listings':'예산·방 조건과 출발 좌표를 모두 확인한 매물이 없어 경로를 조회하지 않았습니다.',
   calculated:`도보 경로 확인 ${walking.successCount} / ${walking.selectedCount}건`,
   unconfirmed:'후보 매물의 보행 경로를 확인할 수 없습니다.'
  };
  if(notes[walking.status])status.textContent+=' '+notes[walking.status];
  if(['destination-ambiguous','destination-unverified'].includes(walking.status)){
   const choose=make('button','room-action','목적지 주소 선택');
   choose.type='button';
   choose.onclick=()=>{
    if(!destinationInput.value&&c.destination)destinationInput.value=c.destination;
    destinationInput.closest('details').open=true;
    destinationInput.focus();
   };
   $('regionChoices').append(choose);
  }
 }

 function card(r,i,unknown){const el=make('article',unknown?'room unknown':'room');const top=make('div','room-top');top.append(make('h3','',r.title));top.append(make('span','pill',unknown?'확인 필요':`추천 ${i+1}순위`));el.append(top);
 el.append(make('div','price',r.total==null?'월 총액 미확인':`월 ${fmt(r.total)}`));el.append(make('p','metadata',`보증금 ${fmt(r.deposit)} · 월세 ${fmt(r.rent)} · 관리비 ${fmt(r.fee)}`));
 walkDetails(el,r,c.destinationPlace,c.transportMode);
 el.append(make('p','metadata',`${r.address||'주소 미확인'} · ${r.roomType||'방 유형 미확인'} · ${r.areaM2==null?'면적 미확인':r.areaM2+'㎡'}`));
 el.append(make('p','metadata',searchInfo.listingRecord(r)));
 el.append(make('p','metadata',r.reasons.join(' · ')));if(unknown)el.append(make('p','caution',`필수 정보 미확인: ${r.missingConditions.join(', ')}`));
 const opts=make('div','room-tags');(r.options||[]).forEach(o=>opts.append(make('span','',o)));if(!r.options?.length)opts.append(make('span','','옵션 정보 미확인'));el.append(opts);
 addRoomActions(el,r,c.destinationPlace);
 if(typeof r.url==='string'&&r.url.startsWith('https://')){const a=make('a','link','원본 매물 확인 ↗');a.href=r.url;a.target='_blank';a.rel='noopener noreferrer';el.append(a);}el.append(make('div','caution','계약 가능 여부·가격·위치 미검증'));return el;}
 data.results.forEach((r,i)=>cards.append(card(r,i,false)));data.unverified.forEach((r,i)=>$('unknownCards').append(card(r,i,true)));$('unknownTitle').hidden=!data.unverified.length;
}
function busy(active){
 document.querySelectorAll('.route-diagnose').forEach(b=>{b.disabled=active||!credential;});
 $('checkConnections').disabled=active||!credential;
 $('compareGemini').disabled=active||!credential;
 $('findDestinations').disabled=active||!credential;
 btn.disabled=active||!credential;$('cancel').disabled=!active;
 $('collect').disabled=active||!liveCollection||!credential||!lastPayload||Boolean(pending);
}
async function submit(text=query.value.trim()){
 if(!credential||!text)return;
 controller?.abort();placeLookup?.abort();const operation=new AbortController();controller=operation;
 busy(true);status.textContent='검색 조건을 확인하고 있습니다…';
 try{
  const turn=await post('/api/conditions',{query:text,previous:confirmed||undefined,pending:pending||undefined,destinationId:selectedDestination?.id});
  if(operation.signal.aborted)return;
  $('interpretationNote').textContent=[searchInfo.interpretation(turn.interpretation),searchInfo.mobility(turn.conditions||turn.pending?.conditions,walkingEnabled)].filter(Boolean).join(' ');
  if(turn.state==='clarify'){
   pending=turn.pending;status.textContent=turn.question;
   const choices=$('regionChoices');choices.replaceChildren();
   for(const address of turn.candidates||[]){
    const campus=turn.kind==='destination'?turn.places?.find(p=>p.name===address):null;
    const button=make('button','',[address,campus?.address].filter(Boolean).join(' · '));button.type='button';button.onclick=()=>submit(address);choices.append(button);
   }
   query.placeholder=turn.kind==='destination'?'예: 강원대학교 원주캠퍼스':'예: 원주시요';
   if(turn.kind==='destination'&&turn.lookupQuery&&!turn.candidates?.length){
    destinationInput.closest('details').open=true;
    destinationInput.value=turn.lookupQuery;
    findPlaces();
   }
   query.value='';query.focus();return;
  }
  const original=pending?.query||text;
  const requested=turn.conditions.destination;
  const changedDestination=requested!==(confirmed?.destination??null);
  const place=changedDestination&&requested!==selectedDestination?.name?null:selectedDestination;
  const nextConditions=place?{...turn.conditions,destination:place.name}:turn.conditions;
  const body={query:original,confirmedConditions:nextConditions};
  if(place||turn.destinationId)body.destinationId=place?.id||turn.destinationId;
  const result=await post('/api/search',body);
  if(operation.signal.aborted)return;
  if(selectedDestination&&!place){clearPlaces();destinationInput.value='';}
  pending=null;confirmed=nextConditions;lastPayload=body;
  render(result);query.value='';
 }catch(error){if(controller===operation)status.textContent=error.name==='AbortError'?'검색을 취소했습니다.':error.message;}
 finally{if(controller===operation)busy(false);}
}
async function collect(){
 if(!lastPayload||!credential||pending)return;
 if(!window.confirm(confirmed.location+' 지역의 신규 매물 수집을 시작할까요? Actor 실행 시 비용이 발생할 수 있습니다.'))return;
 controller?.abort();controller=new AbortController();busy(true);try{
 const cfg=await request('/api/status');if(!cfg.liveCollectionEnabled)throw Error('신규 유료 수집이 잠겨 있습니다. 서버의 비용 보호·인증 설정이 필요합니다.');
 const job=await request('/api/collect',{method:'POST',body:JSON.stringify({query:lastPayload.query,confirmedConditions:confirmed})});const jobId=job.jobId;
 for(let i=0;i<90;i++){
 const current=await request(`/api/collect-status?jobId=${encodeURIComponent(jobId)}`);status.textContent=`수집 상태: ${current.state} · 최대 10건 · 취소해도 Actor 비용은 발생할 수 있습니다.`;
 if(current.state==='SUCCEEDED'){render(await request('/api/search',{method:'POST',body:JSON.stringify({...lastPayload,jobId})}));return;}
 if(['FAILED','ABORTED','TIMED-OUT','START_UNCONFIRMED'].includes(current.state))throw Error(`수집 종료: ${current.state}. 자동 재실행하지 않습니다.`);
 if(current.state==='RESERVED')throw Error('수집 시작 처리 중이거나 결과가 미확인입니다. 잠시 뒤 같은 조건으로 상태를 확인하세요.');
 await new Promise((resolve,reject)=>{const signal=controller.signal;const abort=()=>{clearTimeout(timer);reject(new DOMException('취소','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},3000);signal.addEventListener('abort',abort,{once:true});});
 }throw Error('조회 대기 종료. 같은 조건으로 수집을 누르면 기존 실행을 확인합니다.');
 }catch(e){status.textContent=e.name==='AbortError'?'화면 조회 취소. 이미 시작된 Actor는 Apify Console에서 확인하세요.':e.message;}finally{busy(false);}}
$('searchForm').onsubmit=e=>{e.preventDefault();submit();};
$('collect').onclick=collect;
$('cancel').onclick=()=>controller?.abort();
query.addEventListener('keydown',e=>{
 if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();$('searchForm').requestSubmit();}
});

$('checkConnections').onclick=async()=>{
 if(!credential)return;
 controller?.abort();controller=new AbortController();busy(true);const output=$('integrationResult');output.textContent='Redis·Apify 연결 검사 중…';
 const statuses={verified:'검증 성공',missing:'환경변수 미설정',blocked:'선행 설정 필요',failed:'검증 실패',partial:'부분 구현'};
 const routeState=v=>[
  'TMAP 도보 경로',
  v.keyConfigured?'키 등록':'키 미등록',v.enabled?'계산 활성':'계산 비활성',
  `오늘 ${v.usedToday??'미확인'} / ${v.dailyLimit}회`,`검색당 최대 ${v.maxPerSearch}건`,
  v.cacheAllowed?'캐시 허용':'캐시 비활성',v.diagnosticEnabled?'관리자 경로 검사 활성':v.keyConfigured&&v.oneShotAllowed===true?'관리자 확인 후 경로 1건 검사 가능':'관리자 경로 검사 잠금',v.message
 ].filter(Boolean).join(' · ');
 const renderChecks=data=>Object.entries(data).filter(([,v])=>v&&typeof v==='object'&&v.status).map(([name,v])=>name==='route'&&v.dailyLimit!=null?routeState(v):`${name}: ${statuses[v.status]||v.status}${v.variables?' — '+v.variables.join(', '):''}${v.message?' — '+v.message:''}${v.model?' / 모델 '+v.model:''}${v.reason?' / '+v.reason:''}${v.spentUsd!=null?' (사용 $'+v.spentUsd+' / 한도 $'+v.hardLimitUsd+')':''}`).join('\n');
 try{
  const check=service=>request('/api/integrations',{method:'POST',body:JSON.stringify({service})});
  const storage=await check('storage');
  const results={...storage};
  if(storage.analysisProvider==='openrouter-free'){
   output.textContent=renderChecks(storage)+'\nOpenRouter 무료 모델 검사 중…';
   Object.assign(results,await check('openrouter'));
  }else if(storage.analysisProvider==='gemini'){
   output.textContent=renderChecks(storage)+'\nGemini 연결 검사 중…';
   const model=await check('gemini-model');
   Object.assign(results,model);
   if(model.geminiModel?.status==='verified'){
    output.textContent=renderChecks(results)+'\nGemini 생성 검사 중…';
    Object.assign(results,await check('gemini'));
   }else{
    results.gemini={status:'blocked',message:'먼저 모델 접근 검사를 통과해야 생성 요청을 실행합니다.'};
   }
  }else{
   output.textContent=renderChecks(storage)+'\n검색 조건은 기본 파서로 해석합니다.';
   return;
  }
  output.textContent=renderChecks(results)+'\n신규 유료 Actor 실행: 없음';
 }catch(e){output.textContent+='\n'+(e.name==='AbortError'?'조회 취소':e.message);}finally{busy(false);}
};

$('compareGemini').onclick=async()=>{
 if(!credential)return;
 controller?.abort();
 const operation=new AbortController();
 controller=operation;
 const output=$('comparisonResult');
 output.hidden=false;
 busy(true);output.textContent='Gemini 3.5 Flash-Lite로 같은 예문을 확인하고 있어요.';
 try{
  const {gemini}=await post('/api/integrations',{service:'gemini',model:'gemini-3.5-flash-lite'});
  if(operation.signal.aborted)return;
  output.textContent=['Gemini 3.5 Flash-Lite',gemini.message,gemini.reason,gemini.timings?.google?.providerReason].filter(Boolean).join(' · ');
 }catch(error){
  if(!operation.signal.aborted)output.textContent=error.message;
 }finally{
  if(controller===operation){
   if(operation.signal.aborted&&credential)output.textContent='비교 검사를 취소했습니다.';
   busy(false);
  }
 }
};
