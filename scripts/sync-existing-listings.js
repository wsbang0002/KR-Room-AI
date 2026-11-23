import {syncInventory} from '../lib/inventory-sync.js';
import {defaultLocation} from '../lib/regions.js';

const deployment=process.argv.includes('--production-backfill');
if(deployment&&(process.env.VERCEL_ENV!=='production'||process.env.VERCEL_PROJECT_PRODUCTION_URL!=='kr-room-ai.vercel.app')){
 console.log('운영 배포 전용 기존 매물 동기화를 건너뜁니다.');
}else{
 try{
  const req={headers:{authorization:'Bearer '+(process.env.ADMIN_API_KEY||'')}};
  const report=await syncInventory({req,location:defaultLocation});
  console.log(JSON.stringify(report));
  if(!report.dataset?.verified||!report.database)process.exitCode=1;
 }catch{
  console.error('기존 매물을 동기화할 수 없습니다. 운영 연결 설정을 확인하세요.');
  process.exitCode=1;
 }
}
