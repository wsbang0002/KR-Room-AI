import fs from 'node:fs';
import {redis} from '../lib/store.js';
import {restoreListings} from '../lib/listing-store.js';
const file=process.argv[2];
if(!file){console.error('사용법: npm run redis:restore -- backup.json');process.exitCode=1;}
else try{const result=await restoreListings(redis(),JSON.parse(fs.readFileSync(file,'utf8')));console.log(JSON.stringify(result));}catch{console.error('KNU Room AI 백업 복원 실패. 기존 키는 삭제하지 않았습니다.');process.exitCode=1;}
