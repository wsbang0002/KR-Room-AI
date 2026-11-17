import fs from 'node:fs';
import {redis} from '../lib/store.js';
import {backupListings} from '../lib/listing-store.js';
const file=process.argv[2];
if(!file){console.error('사용법: npm run redis:backup -- backup.json (민감 파일, Git에 올리지 마세요)');process.exitCode=1;}
else try{fs.writeFileSync(file,JSON.stringify(await backupListings(redis()),null,2)+'\n',{flag:'wx',mode:0o600});console.log('KNU Room AI 매물 JSON 백업 완료');}catch{console.error('백업 실패. 기존 파일은 덮어쓰지 않습니다.');process.exitCode=1;}
