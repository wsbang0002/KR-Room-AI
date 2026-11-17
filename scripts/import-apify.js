import fs from 'node:fs';
import {normalize} from '../lib/core.js';
const file=process.argv[2];
if(!file){console.error('사용법: npm.cmd run import -- "C:\\경로\\dataset.json"');process.exit(1);}
let input;
try{input=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){console.error('파일을 읽지 못했습니다:',e.message);process.exit(1);}
if(!Array.isArray(input)){console.error('최상위 JSON 배열이 필요합니다.');process.exit(1);}
const unique=new Map();
for(const raw of input){const room=normalize(raw);if(room.rent!==null&&room.id)unique.set(room.id,room);}
const rooms=[...unique.values()];
fs.writeFileSync(new URL('../data/listings.json',import.meta.url),JSON.stringify(rooms,null,2)+'\n');
const dongs=rooms.reduce((acc,x)=>(acc[x.dong||'미확인']=(acc[x.dong||'미확인']||0)+1,acc),{});
console.log(`수집 ${input.length}건 / 저장 ${rooms.length}건 / 관리비 확인 ${rooms.filter(x=>x.fee!==null).length}건`);
console.log('지역별:',JSON.stringify(dongs));
console.log('학교 주변 확인된 매물:',rooms.filter(x=>x.nearCampusVerified).length,'건 (검증 전에는 0건)');
console.log('원본 데이터의 상세 주소/정확한 도보 시간이 없는 경우는 미확인으로 표시됩니다.');
