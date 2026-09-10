let ACTIVE_TIME_ALLOCATION = null;
let timeAllocationPromise = null;

function getTimeAllocationRatios(sales, part){
  if(!ACTIVE_TIME_ALLOCATION) throw new Error('Time Allocation V1.0이 로드되지 않았습니다.');
  const x=Number(sales)||0;
  const row=ACTIVE_TIME_ALLOCATION.find(r=>r.part===part && x>=r.min && (r.max===null || x<r.max));
  if(!row) throw new Error(`Time Allocation 구간을 찾을 수 없습니다: ${part}, ${x}`);
  return {...row.ratios};
}
async function ensureTimeAllocationLoaded(){
  if(ACTIVE_TIME_ALLOCATION) return {source:'supabase',version:'1.0',rowCount:ACTIVE_TIME_ALLOCATION.length};
  if(timeAllocationPromise) return timeAllocationPromise;
  timeAllocationPromise=fetch('/api/time-allocation',{cache:'no-store'}).then(async r=>{
    if(!r.ok) throw new Error('Time Allocation API 조회 실패: HTTP '+r.status);
    const d=await r.json();
    if(!d.ok || d.source!=='supabase' || d.version!=='1.0' || !Array.isArray(d.rows) || d.rows.length!==32) throw new Error('Time Allocation V1.0 검증 실패 (32행 필요)');
    ACTIVE_TIME_ALLOCATION=d.rows.map(r=>({part:r.part,min:Number(r.sales_min_won),max:r.sales_max_won===null?null:Number(r.sales_max_won),ratios:{
      '오픈':Number(r.open_ratio),'런치피크':Number(r.lunch_ratio),'스윙':Number(r.swing_ratio),'디너':Number(r.dinner_ratio),'마감':Number(r.close_ratio)
    }}));
    ACTIVE_TIME_ALLOCATION.forEach(r=>{ const s=Object.values(r.ratios).reduce((a,b)=>a+b,0); if(Math.abs(s-1)>0.00001) throw new Error('Time Allocation 비율합계 오류: '+r.part); });
    return {source:'supabase',version:'1.0',rowCount:ACTIVE_TIME_ALLOCATION.length};
  }).finally(()=>timeAllocationPromise=null);
  return timeAllocationPromise;
}
ensureTimeAllocationLoaded().catch(e=>console.warn('[Time Allocation] 사전 로드 실패:',e));
