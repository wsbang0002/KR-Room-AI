import {createHash} from 'node:crypto';
import {resolveLocation} from './regions.js';
import {inventoryReader,HttpError,jsonFetch} from './security.js';
import {redis} from './store.js';

export const DEFAULT_DESTINATION_ID='knu-wonju';
const placePrefix='knuroom:destination:';
const day=86400;
const geocoder='https://photon.komoot.io/api/';
const attribution='© OpenStreetMap contributors (ODbL) · Photon · 캠퍼스 대표점 자료: 한국어 위키백과 기여자';
const osmTypes={N:'node',W:'way',R:'relation'};
const aliases=new Map([['강원대학교','강원대'],['서울대학교','서울대'],['연세대학교','연세대'],['부산대학교','부산대']]);

function campus(id,university,area,qualifiers,address,region,lat,lng,wikiTitle){
 return {
  id,name:university+' '+area,address,region,lat,lng,verified:true,precision:'campus-reference',
  source:'한국어 위키백과 · 캠퍼스 대표점',
  sourceUrl:'https://ko.wikipedia.org/wiki/'+encodeURIComponent(wikiTitle.replaceAll(' ','_')),
  qualifiers,university
 };
}

// Coordinates identify campus reference points, not a building or a pedestrian entrance.
const campuses=[
 campus(DEFAULT_DESTINATION_ID,'강원대학교','원주캠퍼스',['원주'],'강원특별자치도 원주시 흥업면 남원로 150','강원특별자치도 원주시 흥업면',37.3052056,127.9228972,'강원대학교 원주캠퍼스'),
 campus('knu-chuncheon','강원대학교','춘천캠퍼스',['춘천'],'강원특별자치도 춘천시 강원대학길 1','강원특별자치도 춘천시',37.869972,127.743389,'강원대학교'),
 campus('snu-gwanak','서울대학교','관악캠퍼스',['관악'],'서울특별시 관악구 관악로 1','서울특별시 관악구',37.459333,126.953111,'서울대학교'),
 campus('yonsei-sinchon','연세대학교','신촌캠퍼스',['신촌'],'서울특별시 서대문구 연세로 50','서울특별시 서대문구',37.565778,126.938528,'연세대학교'),
 campus('yonsei-mirae','연세대학교','미래캠퍼스 매지',['미래캠퍼스 매지','매지','미래캠퍼스','미래'],'강원특별자치도 원주시 흥업면 연세대길 1','강원특별자치도 원주시 흥업면',37.279417,127.9015,'연세대학교 미래캠퍼스'),
 campus('pnu-jangjeon','부산대학교','부산캠퍼스',['부산캠퍼스','장전'],'부산광역시 금정구 부산대학로63번길 2','부산광역시 금정구',35.233944,129.079306,'부산대학교')
];

function publicCampus({qualifiers,university,...place}){return place;}

function namesFor(place){return [place.university,aliases.get(place.university)];}
const wordEnd='(?=$|[\\s,.?!·]|에서|까지|으로|근처|주변|도보|앞|에(?:서|\\s|$))';
function specificPattern(place){
 const names=namesFor(place).join('|');
 const qualifiers=place.qualifiers.map(q=>q.replaceAll(' ','\\s*')).join('|');
 return new RegExp('(?:'+names+')\\s*(?:'+qualifiers+')(?:캠퍼스|캠)?'+wordEnd);
}

function campusCandidates(query){
 return campuses.filter(place=>specificPattern(place).test(query)||
  namesFor(place).some(name=>new RegExp(name+wordEnd).test(query)));
}

export function identifyDestination(text){
 const query=typeof text==='string'?text.trim():'';
 const candidates=campusCandidates(query);
 const universities=new Set(candidates.map(p=>p.university));
 const exact=candidates.filter(place=>specificPattern(place).test(query));
 if(universities.size===1&&exact.length===1)return {status:'resolved',destination:publicCampus(exact[0])};
 if(candidates.length)return {status:'ambiguous',destination:null};
 const placeMention=/(대학교|초등학교|중학교|고등학교|학교|병원|회사|직장|캠퍼스|[가-힣]+역(?:까지|에서|으로|\s|$))/.test(query);
 return {status:placeMention?'unresolved':'missing',destination:null};
}

export const matchDestination=text=>identifyDestination(text).destination;

function knownOsmId(id){return typeof id==='string'&&/^osm-[NWR]-[1-9]\d{0,16}$/.test(id);}
function validPair(lat,lng){
 return Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=32.9&&lat<=38.7&&lng>=124.5&&lng<=132;
}

export async function getDestination(id,{store,env=process.env,fetcher=fetch}={}){
 const local=campuses.find(place=>place.id===id);
 if(local)return publicCampus(local);
 if(!knownOsmId(id))return null;
 try{
  const record=await (store||redis(env,fetcher)).get(placePrefix+id);
  return record?.id===id&&record.verified===true&&validPair(record.lat,record.lng)?record:null;
 }catch{return null;}
}

const poiKeys=new Set(['amenity','office','shop','craft','healthcare','industrial','tourism','leisure','railway','public_transport','aeroway','building']);
function photonPlace(feature){
 const p=feature?.properties;
 const coords=feature?.geometry?.coordinates;
 if(feature?.geometry?.type!=='Point'||!Array.isArray(coords)||!validPair(coords[1],coords[0]))return null;
 if(p?.countrycode?.toUpperCase()!=='KR'||!poiKeys.has(p.osm_key)||!osmTypes[p.osm_type])return null;
 if(typeof p.name!=='string'||!p.name.trim()||!Number.isSafeInteger(p.osm_id)||p.osm_id<1)return null;
 const locality=[p.state,p.county,p.city,p.district].filter(v=>typeof v==='string'&&v.trim());
 if(!locality.length)return null;
 const address=[...new Set([...locality,p.street,p.housenumber].filter(Boolean))].join(' ');
 const regions=[[p.state,p.city],[p.state,p.county],[p.city],[p.county]];
 const region=regions.filter(parts=>parts.every(Boolean)).map(parts=>resolveLocation(parts.join(' '))).find(r=>r.status==='resolved');
 return {
  id:'osm-'+p.osm_type+'-'+p.osm_id,name:p.name,address,region:region?.location||null,
  lat:coords[1],lng:coords[0],verified:true,precision:'poi-reference',
  source:'OpenStreetMap · 장소 대표점',sourceUrl:'https://www.openstreetmap.org/'+osmTypes[p.osm_type]+'/'+p.osm_id
 };
}

function expanded(query){
 for(const [full,short] of aliases){
  if(query===short||query.startsWith(short+' '))return full+query.slice(short.length);
 }
 return query;
}

export async function searchDestinations(body,{req,env=process.env,store,fetcher=fetch}={}){
 const user=inventoryReader(req,env);
 const query=typeof body?.query==='string'?body.query.trim().replace(/\s+/g,' '):'';
 if(query.length<2||query.length>100)throw new HttpError(400,'목적지 이름을 2~100자로 입력하세요.');
 const local=campusCandidates(query).map(publicCampus);
 const response=(destinations,notice)=>({destinations,attribution,...(notice?{notice}:{})});
 const identified=identifyDestination(query);
 if(identified.status==='resolved')return response([identified.destination]);

 const text=expanded(query);
 const cacheKey=placePrefix+'search:v1:'+createHash('sha256').update(text).digest('hex');
 try{
  const db=store||redis(env,fetcher);
  const cached=await db.get(cacheKey);
  if(Array.isArray(cached))return response([...local,...cached]);
  // Only a submitted search may reach Photon. This lock covers all instances.
  const acquired=await db.command(['SET',placePrefix+'lookup-rate','1','NX','EX',1]);
  if(acquired!=='OK')throw new HttpError(429,'잠시 후 목적지 검색을 다시 시도하세요.');
  const prior=await db.reserve({key:cacheKey+':pending',kind:'place-lookup',user,
   limit:60,cost:1,budget:200,ttl:6,value:{pending:true}});
  if(prior)throw new HttpError(429,'같은 목적지를 확인하고 있습니다. 잠시 후 다시 시도하세요.');
  const url=new URL(geocoder);
  url.search=new URLSearchParams({q:text,countrycode:'kr',bbox:'124.5,32.9,132,38.7',limit:'12'}).toString();
  const payload=await jsonFetch(url.toString(),{fetcher,timeoutMs:4000,redirect:'error',headers:{
   Accept:'application/json','Accept-Language':'ko','User-Agent':'KNU-Room-AI/0.6 (https://github.com/wsbang0002/KR-Room-AI)'
  }});
  if(!Array.isArray(payload?.features))throw new Error('invalid-place-response');
  const places=new Map();
  for(const feature of payload.features){
   const place=photonPlace(feature);
   if(place)places.set(place.id,place);
  }
  const remote=[...places.values()];
  await Promise.all(remote.map(place=>db.set(placePrefix+place.id,place,30*day)));
  await db.set(cacheKey,remote,remote.length?7*day:3600);
  return response([...local,...remote]);
 }catch(e){
  if(local.length)return response(local,'전국 장소 검색을 사용할 수 없어 등록된 캠퍼스를 표시합니다.');
  if(e instanceof HttpError&&e.status===429)throw e;
  throw new HttpError(503,'목적지 검색을 잠시 사용할 수 없습니다. 지역과 기관 이름을 확인한 뒤 다시 시도하세요.');
 }
}
