const $=id=>document.getElementById(id),query=$('query'),btn=$('submit'),status=$('status'),cards=$('cards'),chips=$('conditions');
const fmt=n=>n==null?'미확인':`${Number(n).toLocaleString('ko-KR')}만 원`;
let controller=null,lastPayload=null,jobId=null;
function make(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;}
function chip(t){chips.append(make('span','chip',t));}
function headers(){return {'Content-Type':'application/json',...($('adminKey').value?{Authorization:`Bearer ${$('adminKey').value}`}:{})};}
async function request(url,options={}){const r=await fetch(url,{...options,headers:headers(),signal:controller?.signal});const j=await r.json();if(!r.ok){if(j.region?.candidates){$('regionChoices').replaceChildren();j.region.candidates.forEach(x=>{const b=make('button','',x);b.onclick=()=>{$('location').value=x;submit();};$('regionChoices').append(b);});}throw Error(j.error||'요청 실패');}return j;}
function payload(){const edits={};for(const key of ['location','destination','maxDeposit','maxRent','maxMonthlyTotal','maxCommuteMinutes','transportMode'])if($(key).value!=='')edits[key]=$(key).value;const cost=Number($('costWeight').value)/100;edits.weights={cost,commute:.85-cost,options:.15};return {query:query.value.trim(),demo:$('demo').checked,edits};}
function render(data){chips.replaceChildren();cards.replaceChildren();$('unknownCards').replaceChildren();$('regionChoices').replaceChildren();const c=data.conditions;
 chip(c.location);if(c.destination)chip(`목적지: ${c.destination}`);
 for(const [key,label] of [['maxDeposit','보증금'],['maxMonthlyTotal','월 총비용'],['maxRent','월세']])if(c[key]!=null)chip(`${label} ≤ ${fmt(c[key])}`);
 if(c.maxCommuteMinutes!=null)chip(`${c.transportMode} ≤ ${c.maxCommuteMinutes}분`);
 c.preferredOptions.forEach(x=>chip(`선호: ${x}`));c.requiredOptions.forEach(x=>chip(`필수: ${x}`));chip(`비용 비중 ${Math.round(c.weights.cost*100)}%`);
 status.textContent=`${data.mode==='demo'?'가상 데모':data.dataSource} · 조건 충족 ${data.results.length}건 / 확인 필요 ${data.unverified.length}건 · 분석 ${data.parser} · ${data.notice} ${(c.warnings||[]).join(' ')}`;
 if(!data.results.length)cards.append(make('div','status','조건이 확인된 매물이 없습니다. 지역·예산을 수정하거나 확인 필요 후보를 살펴보세요.'));
 function card(r,i,unknown){const el=make('article',unknown?'room unknown':'room');const top=make('div','room-top');top.append(make('h3','',r.title));top.append(make('span','pill',unknown?'확인 필요':`추천 ${i+1}순위`));el.append(top);
 el.append(make('div','price',r.total==null?'월 총액 미확인':`월 ${fmt(r.total)}`));el.append(make('p','metadata',`보증금 ${fmt(r.deposit)} · 월세 ${fmt(r.rent)} · 관리비 ${fmt(r.fee)}`));
 el.append(make('p','metadata',`이동시간 ${r.commuteMinutes==null?'미확인':`${r.commuteMinutes}분${data.mode==='demo'?' (가상)':''}`} · ${r.approximate?'대략적 위치':'정확도 확인 필요'}`));
 el.append(make('p','metadata',`${r.address||'주소 미확인'} · ${r.roomType||'방 유형 미확인'} · ${r.areaM2==null?'면적 미확인':r.areaM2+'㎡'}`));
 el.append(make('p','metadata',`수집일 ${r.collectedAt||'미확인'} · 마지막 확인 ${r.lastSeenAt||'미확인'}${r.syncStatus==='stale'?' (오래된 정보)':''} · 점수 근거 정보 ${Math.round(r.scoreCoverage*100)}%`));
 el.append(make('p','metadata',r.reasons.join(' · ')));if(unknown)el.append(make('p','caution',`필수 정보 미확인: ${r.missingConditions.join(', ')}`));
 const opts=make('div','room-tags');(r.options||[]).forEach(o=>opts.append(make('span','',o)));if(!r.options?.length)opts.append(make('span','','옵션 정보 미확인'));el.append(opts);
 if(r.lat!=null&&r.lng!=null&&data.mode!=='demo'){const map=make('button','','지도에서 대략적 위치 확인');map.onclick=()=>{const delta=.012;$('map').src=`https://www.openstreetmap.org/export/embed.html?bbox=${r.lng-delta},${r.lat-delta},${r.lng+delta},${r.lat+delta}&layer=mapnik&marker=${r.lat},${r.lng}`;$('mapPanel').hidden=false;$('mapPanel').open=true;$('mapNotice').textContent=r.approximate?'대략적인 좌표이며 실제 주소·이동시간을 확인할 수 없습니다.':'수집된 좌표입니다. 정확도와 이동시간은 별도 확인이 필요합니다.';};el.append(map);}
 if(r.url){const a=make('a','link','원본 매물 확인 ↗');a.href=r.url;a.target='_blank';a.rel='noopener noreferrer';el.append(a);}el.append(make('div','caution',data.mode==='demo'?'가상 데모 · 실제 계약 불가':'계약 가능 여부·가격·위치 미검증'));return el;}
 data.results.forEach((r,i)=>cards.append(card(r,i,false)));data.unverified.forEach((r,i)=>$('unknownCards').append(card(r,i,true)));$('unknownTitle').hidden=!data.unverified.length;
}
function busy(value){btn.disabled=value;$('cancel').disabled=!value;btn.textContent=value?'검색 중…':'방 찾아보기 ↗';$('collect').disabled=value||$('demo').checked||!$('adminKey').value;}
async function submit(){if(!query.value.trim()){status.textContent='검색 조건을 입력해 주세요.';return;}controller?.abort();controller=new AbortController();jobId=null;lastPayload=payload();busy(true);status.textContent='조건 분석 및 지역별 매물 검색 중…';try{render(await request('/api/search',{method:'POST',body:JSON.stringify(lastPayload)}));}catch(e){status.textContent=e.name==='AbortError'?'검색 조회를 취소했습니다.':e.message;}finally{busy(false);}}
async function collect(){controller?.abort();controller=new AbortController();lastPayload=payload();if(lastPayload.demo)return;busy(true);try{
 const cfg=await request('/api/status');if(!cfg.liveCollectionEnabled)throw Error('신규 유료 수집이 잠겨 있습니다. 서버의 비용 보호·인증 설정이 필요합니다.');
 const job=await request('/api/collect',{method:'POST',body:JSON.stringify(lastPayload)});jobId=job.jobId;
 for(let i=0;i<90;i++){
 const current=await request(`/api/collect-status?jobId=${encodeURIComponent(jobId)}`);status.textContent=`수집 상태: ${current.state} · 최대 10건 · 취소해도 Actor 비용은 발생할 수 있습니다.`;
 if(current.state==='SUCCEEDED'){render(await request('/api/search',{method:'POST',body:JSON.stringify({...lastPayload,jobId})}));return;}
 if(['FAILED','ABORTED','TIMED-OUT','START_UNCONFIRMED'].includes(current.state))throw Error(`수집 종료: ${current.state}. 자동 재실행하지 않습니다.`);
 if(current.state==='RESERVED')throw Error('수집 시작 처리 중이거나 결과가 미확인입니다. 잠시 뒤 같은 조건으로 상태를 확인하세요.');
 await new Promise((resolve,reject)=>{const signal=controller.signal;const abort=()=>{clearTimeout(timer);reject(new DOMException('취소','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},3000);signal.addEventListener('abort',abort,{once:true});});
 }throw Error('조회 대기 종료. 같은 조건으로 수집을 누르면 기존 실행을 확인합니다.');
 }catch(e){status.textContent=e.name==='AbortError'?'화면 조회 취소. 이미 시작된 Actor는 Apify Console에서 확인하세요.':e.message;}finally{busy(false);}}
btn.onclick=submit;$('collect').onclick=collect;$('cancel').onclick=()=>controller?.abort();$('demo').onchange=()=>busy(false);$('adminKey').oninput=()=>busy(false);$('costWeight').oninput=()=>$('costValue').textContent=`${$('costWeight').value}%`;
query.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')submit();});document.querySelectorAll('[data-example]').forEach(b=>b.onclick=()=>{query.value=b.dataset.example;submit();});
