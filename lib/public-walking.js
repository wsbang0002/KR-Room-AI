import {getDestination} from './destinations.js';
import {HttpError} from './security.js';
import {walkingRoute} from './walking.js';

// Station coordinates are the reference points in the linked Korean Wikipedia
// articles. A station/campus reference point does not identify a particular gate.
const stations=[
 {id:'station-wonju',name:'원주역',address:'강원특별자치도 원주시 북원로 1860',lat:37.31611,lng:127.92167,destinationIds:['knu-wonju','yonsei-mirae']},
 {id:'station-gwanaksan',name:'관악산역',address:'서울특별시 관악구 신림로 23',lat:37.46861,lng:126.94528,destinationIds:['snu-gwanak']},
 {id:'station-sinchon',name:'신촌역 (2호선)',article:'신촌역_(지하)',address:'서울특별시 마포구 신촌로 지하90',lat:37.55528,lng:126.93694,destinationIds:['yonsei-sinchon']},
 {id:'station-namchuncheon',name:'남춘천역',address:'강원특별자치도 춘천시 영서로 2260',lat:37.86111,lng:127.72917,destinationIds:['knu-chuncheon']},
 {id:'station-pusan-univ',name:'부산대역',address:'부산광역시 금정구 장전온천천로 48',lat:35.229927,lng:129.089364,destinationIds:['pnu-jangjeon']},
];

export async function publicWalkingPlaces(){
 const origins=stations.map(({id,name,address,article,destinationIds})=>({
  id,name,address,destinationIds,source:'한국어 위키백과 · 역 대표점',
  sourceUrl:'https://ko.wikipedia.org/wiki/'+encodeURIComponent(article||name)
 }));
 const ids=[...new Set(stations.flatMap(station=>station.destinationIds))];
 const destinations=await Promise.all(ids.map(id=>getDestination(id)));
 return {origins,destinations:destinations.map(({id,name,address,source,sourceUrl})=>({id,name,address,source,sourceUrl}))};
}

export async function publicWalking(body,options){
 if(Object.keys(body).some(field=>!['publicOriginId','destinationId'].includes(field))){
  throw new HttpError(400,'출발역과 도착지를 선택해 주세요.');
 }
 const station=stations.find(item=>item.id===body.publicOriginId);
 if(!station||!station.destinationIds.includes(body.destinationId)){
  throw new HttpError(400,'출발역과 가까운 캠퍼스 중 도착지를 선택해 주세요.');
 }
 const campus=await getDestination(body.destinationId);
 // Both points come from these fixed public records. No private inventory lookup.
 return walkingRoute({...station,approximate:true},campus,{...options,publicLandmark:true});
}
