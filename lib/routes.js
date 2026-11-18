import {jsonFetch} from './security.js';
// Compatibility adapter for injected transports. Production walking uses lib/walking.js.
export async function routeTime(room,destination,mode,{env={},fetcher}={}){
 if(typeof fetcher!=='function'||env.ENABLE_ROUTE_API!=='true'||!env.TMAP_API_KEY||room.approximate!==false||!destination?.verified||!['walk','car'].includes(mode)||![room.lat,room.lng,destination.lat,destination.lng].every(Number.isFinite))return null;
 const pedestrian=mode==='walk';
 const result=await jsonFetch(`https://apis.openapi.sk.com/tmap/routes${pedestrian?'/pedestrian':''}?version=1`,{fetcher,method:'POST',headers:{appKey:env.TMAP_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({startX:room.lng,startY:room.lat,endX:destination.lng,endY:destination.lat,reqCoordType:'WGS84GEO',resCoordType:'WGS84GEO',...(pedestrian?{startName:'출발',endName:'도착'}:{})})});
 const seconds=result.features?.[0]?.properties?.totalTime;
 return typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0?{minutes:Math.ceil(seconds/60),destination:destination.name,mode,verified:true,provider:'TMAP',checkedAt:new Date().toISOString()}:null;
}
