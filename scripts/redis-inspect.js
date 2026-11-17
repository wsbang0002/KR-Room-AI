import {redis} from '../lib/store.js';
import {inspectRedis} from '../lib/listing-store.js';
try{console.log(JSON.stringify(await inspectRedis(redis()),null,2));}catch{console.error('Redis 연결/PING/SCAN 실패. 환경변수와 접근 권한을 확인하세요. 기존 키는 변경하지 않았습니다.');process.exitCode=1;}
