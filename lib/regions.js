import fs from 'node:fs';
const catalog=JSON.parse(fs.readFileSync(new URL('../data/regions.json',import.meta.url),'utf8'));
export const regions=catalog.names;
const aliases={'서울':'서울특별시','부산':'부산광역시','대구':'대구광역시','인천':'인천광역시','광주':'광주광역시','대전':'대전광역시','울산':'울산광역시','세종':'세종특별자치시','경기':'경기도','강원':'강원특별자치도','강원도':'강원특별자치도','충북':'충청북도','충남':'충청남도','전북':'전북특별자치도','전라북도':'전북특별자치도','전남':'전라남도','경북':'경상북도','경남':'경상남도','제주':'제주특별자치도'};
export const defaultLocation='강원특별자치도 원주시 흥업면';
export const destinations={
 '강원대학교 원주캠퍼스':{location:defaultLocation,aliases:['강원대 원주캠퍼스','강원대학교 원주캠퍼스'],verified:false},
 '서울대학교':{location:'서울특별시 관악구',aliases:['서울대학교','서울대'],verified:true},
 '부산대학교':{location:'부산광역시 금정구',aliases:['부산대학교','부산대'],verified:true}
};
export function canonical(value){return String(value||'').trim().split(/\s+/).map(x=>aliases[x]||x).join(' ');}
// Several SGIS names combine a city and its district, e.g. 성남시중원구.
function addressWords(address){
 const words=address.split(' ');
 const district=words[1]?.match(/^(.+시)(.+구)$/);
 return district?[...words,district[1],district[2]]:words;
}
const regionWords=new Map(regions.map(address=>[address,addressWords(address)]));
const names=new Set([...regionWords.values()].flat());
const shortCities=new Map();
for(const name of names){
 if(!/^.{2,}(시|군)$/.test(name))continue;
 const short=name.slice(0,-1);
 if(!shortCities.has(short))shortCities.set(short,new Set());
 shortCities.get(short).add(name);
}
export function addressContains(address,parts){
 const words=regionWords.get(address);
 return Boolean(words)&&parts.every(part=>words.includes(part));
}
export function regionTerms(text){
 const raw=String(text).match(/[가-힣0-9·.]+/g)||[];
 const found=[];
 for(const token of raw){
  // Check the original first: 광주, 구리시, 서귀포시 and 시흥시 are whole names.
  const stripped=token.replace(/(?:에서요?|에서|으로요?|으로|까지|근처|주변|인근|이에요|이요|입니다|에요|예요|이랑|만요|로요|은요|는요|이야|이죠|요|로|의|에|은|는|만|를|을)$/,'');
  const word=[token,stripped].map(t=>aliases[t]||t).find(t=>names.has(t));
  if(word){found.push(word);continue;}
  const short=shortCities.get(stripped);
  if(short?.size===1){found.push([...short][0]);continue;}
  // Preserve an unknown, explicitly named location so it can be corrected.
  if(stripped.length>1&&/(?:시|군|구|읍|면|동)$/.test(stripped)&&!/(?:[으하되라다]면|하려면|이라면|있으면|없으면|이동|변동|활동|운동|친구|출구|입구|가구|가면|라구|말구)$/.test(stripped))found.push(stripped);
 }
 return [...new Set(found)];
}
export function resolveLocation(input,{limit=30}={}){
 const value=canonical(input);
 if(!value)return {status:'missing',candidates:[]};
 if(regionWords.has(value))return {status:'resolved',location:value};
 const parts=value.split(' ');
 let candidates=regions.filter(address=>addressContains(address,parts));
 if(candidates.length){
  const depth=Math.min(...candidates.map(x=>x.split(' ').length));
  candidates=candidates.filter(x=>x.split(' ').length===depth);
 }
 return candidates.length===1?{status:'resolved',location:candidates[0]}:{status:candidates.length?'ambiguous':'unsupported',candidates:candidates.slice(0,limit)};
}
export function extractRegion(text,override){
 if(override)return resolveLocation(override);
 const found=regionTerms(text);
 if(found.length)return resolveLocation(found.join(' '));
 for(const d of Object.values(destinations))if(d.aliases.some(a=>text.includes(a)))return resolveLocation(d.location);
 // Explicit unknown place/destination must not silently select Wonju.
 if(/(?:대학교|대학|역|회사|직장|캠퍼스)\s*(?:근처|주변|까지|에서)|[가-힣]+(?:구|동)에서/.test(text))return {status:'unsupported',candidates:[]};
 return {...resolveLocation(defaultLocation),isDefault:true};
}
const provinces=new Set(regions.filter(address=>!address.includes(' ')));
const municipalities=new Set(regions.filter(address=>address.split(' ').length===2).map(address=>address.split(' ')[1]));
const cityWords=new Set([...municipalities].flatMap(area=>addressWords('도 '+area).slice(1)));

export function locationMatch(room,location,{snapshot=false}={}){
 const target=resolveLocation(location);
 if(target.status!=='resolved')return 'unknown';
 const [province,area,neighborhood]=target.location.split(' ');
 const scope=snapshot?'강원특별자치도 원주시':room.region;
 const observed=new Set(regionTerms([scope,room.address,room.dong].filter(Boolean).join(' ')));
 for(const name of [...observed]){
  if(municipalities.has(name))for(const word of addressWords('도 '+name).slice(2))observed.add(word);
 }
 const district=area?.match(/^(.+시)(.+구)$/);
 const needed=[province,...(district?district.slice(1):[area]),neighborhood].filter(Boolean);
 if(needed.every(name=>observed.has(name)))return 'match';
 for(const name of observed){
  if(provinces.has(name)&&name!==province)return 'mismatch';
  if(area&&cityWords.has(name)&&!addressContains(target.location,[name]))return 'mismatch';
  // Only compare administrative neighborhoods known in the requested city/district.
  // A street address or a 법정동 absent from that administrative catalog stays unknown.
  if(neighborhood&&name!==neighborhood&&regionWords.has([province,area,name].join(' ')))return 'mismatch';
 }
 return 'unknown';
}
