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
export function resolveLocation(input){
 const value=canonical(input);if(!value)return {status:'missing',candidates:[]};
 const parts=value.split(' ');let candidates=regions.filter(x=>parts.every(p=>x.split(' ').includes(p)));
 const exact=candidates.find(x=>x===value);if(exact)return {status:'resolved',location:exact};
 // A locality may omit its province. Keep only shortest matching administrative level.
 if(candidates.length){const depth=Math.min(...candidates.map(x=>x.split(' ').length));candidates=candidates.filter(x=>x.split(' ').length===depth);}
 return candidates.length===1?{status:'resolved',location:candidates[0]}:{status:candidates.length?'ambiguous':'unsupported',candidates:candidates.slice(0,30)};
}
export function extractRegion(text,override){
 if(override)return resolveLocation(override);
 const tokens=String(text).match(/[가-힣0-9·.]+/g)||[];
 const allNames=new Set(regions.flatMap(x=>x.split(' ')));
 const found=tokens.map(t=>t.replace(/(?:에서|으로|까지|근처|주변|인근|의|에)$/,'')).filter(t=>allNames.has(aliases[t]||t)||/(?:시|군|구|읍|면|동)$/.test(t));
 if(found.length)return resolveLocation(found.join(' '));
 for(const d of Object.values(destinations))if(d.aliases.some(a=>text.includes(a)))return resolveLocation(d.location);
 // Explicit unknown place/destination must not silently select Wonju.
 if(/(?:대학교|대학|역|회사|직장|캠퍼스)\s*(?:근처|주변|까지|에서)|[가-힣]+(?:구|동)에서/.test(text))return {status:'unsupported',candidates:[]};
 return {...resolveLocation(defaultLocation),isDefault:true};
}
export function locationMatch(room,location,{snapshot=false}={}){
 const target=resolveLocation(location);if(target.status!=='resolved')return 'unknown';
 const evidence=canonical([room.address,room.dong].filter(Boolean).join(' '));
 const parts=target.location.split(' ');
 // Snapshot provenance is fixed to Wonju; it never establishes campus proximity.
 const scope=snapshot?'강원특별자치도 원주시':canonical(room.region||'');
 const context=`${scope} ${evidence}`;
 if(parts.every(p=>context.split(/\s+/).includes(p)))return 'match';
 if(scope&&parts.some((p,i)=>i<2&&!scope.includes(p)))return 'mismatch';
 return 'unknown';
}
