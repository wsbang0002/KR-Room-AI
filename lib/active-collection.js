const activeKey='knuroom:apify:active';
const jobPrefix='knuroom:collect:';
const runPrefix='knuroom:apify:run:';
const jobIdPattern=/^[a-f0-9]{64}$/;
const opaqueIdPattern=/^[\w-]{1,128}$/;

function record(raw){
 try{return JSON.parse(raw);}catch{return null;}
}

function ownedJob(raw,id,requestId,user){
 const job=record(raw);
 return job?.id===id&&job.requestId===requestId&&job.user===user;
}

async function findRecordId(db,prefix,idPattern,matches,{unique=false}={}){
 const cursors=new Set();
 let cursor='0',readCount=0,found=null;
 for(let page=0;page<64;page++){
  if(cursors.has(cursor))break;
  cursors.add(cursor);
  const result=await db.command(['SCAN',cursor,'MATCH',prefix+'*','COUNT',256]);
  if(!Array.isArray(result)||!Array.isArray(result[1]))break;
  const keys=result[1].filter(key=>typeof key==='string'&&key.startsWith(prefix)&&idPattern.test(key.slice(prefix.length)));
  for(let i=0;i<keys.length;i+=16){
   const batch=keys.slice(i,i+16);
   readCount+=batch.length;
   if(readCount>1024)return null;
   const values=await db.command(['MGET',...batch]);
   if(!Array.isArray(values)||values.length!==batch.length)return null;
   for(const [index,key] of batch.entries()){
    const id=key.slice(prefix.length);
    if(!matches(values[index],id))continue;
    if(!unique)return id;
    if(found&&found!==id)return null;
    found=id;
   }
  }
  // Redis cursors are unsigned 64-bit values and must not be rounded in JS.
  if(typeof result[0]==='number'&&!Number.isSafeInteger(result[0]))break;
  cursor=String(result[0]);
  if(cursor==='0')return found;
  if(!/^\d+$/.test(cursor))break;
 }
 return null;
}

// Some starts saved the run index before their job update completed. Only a
// unique reverse mapping for this exact request can identify its upstream run.
export async function findRecordedRunId(db,job){
 if(job?.runId||typeof job?.id!=='string'||!jobIdPattern.test(job.id)||
    typeof job.requestId!=='string'||!opaqueIdPattern.test(job.requestId))return null;
 const matches=(raw,id)=>{
  const saved=record(raw);
  return saved?.jobId===job.id&&saved.requestId===job.requestId&&(saved.runId===undefined||saved.runId===id);
 };
 const id=await findRecordId(db,runPrefix,opaqueIdPattern,matches,{unique:true});
 return id&&matches(await db.command(['GET',runPrefix+id]),id)?id:null;
}

export async function findActiveCollection(db,user){
 const requestId=await db.command(['GET',activeKey]);
 if(requestId===null)return {state:'IDLE'};
 const unknown={state:'UNIDENTIFIED'};
 if(typeof user!=='string'||!user||typeof requestId!=='string'||!opaqueIdPattern.test(requestId))return unknown;
 const raw=await db.command(['GET','knuroom:budget:reservation:'+requestId]);
 const reservation=record(raw);
 if(raw!==null&&(reservation?.requestId!==requestId||reservation.settled===true))return unknown;
 let id=reservation?.jobId;
 if(id===undefined){
  // Older reservations contain the request UUID but no index to their collection key.
  id=await findRecordId(db,jobPrefix,jobIdPattern,(raw,id)=>ownedJob(raw,id,requestId,user));
 }else if(typeof id!=='string'||!jobIdPattern.test(id)){
  return unknown;
 }
 if(!id)return unknown;
 // The lock or job could have been replaced while traversing older entries.
 const pair=await db.command(['MGET',activeKey,jobPrefix+id]);
 if(!Array.isArray(pair)||pair.length!==2)return unknown;
 if(pair[0]===null)return {state:'IDLE'};
 return pair[0]===requestId&&ownedJob(pair[1],id,requestId,user)?{jobId:id,requestId}:unknown;
}
