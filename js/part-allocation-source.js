let ACTIVE_PART_ALLOCATION = null;
let partAllocationPromise = null;

function getPartAllocationRatios(sales) {
  if (!ACTIVE_PART_ALLOCATION) throw new Error('Part Allocation V1.0이 로드되지 않았습니다.');
  const x = Number(sales) || 0;
  const rows = ACTIVE_PART_ALLOCATION;
  let a, b;
  if (x <= rows[0].sales) a = b = rows[0];
  else if (x >= rows[rows.length-1].sales) a = b = rows[rows.length-1];
  else {
    for (let i=0;i<rows.length-1;i++) if (x >= rows[i].sales && x <= rows[i+1].sales) { a=rows[i]; b=rows[i+1]; break; }
  }
  const w = a===b ? 0 : (x-a.sales)/(b.sales-a.sales);
  const out = {};
  Object.keys(a.ratios).forEach(p => out[p] = a.ratios[p] + (b.ratios[p]-a.ratios[p])*w);
  const sum = Object.values(out).reduce((s,v)=>s+v,0);
  Object.keys(out).forEach(p => out[p] = sum ? out[p]/sum : 0);
  return out;
}

async function ensurePartAllocationLoaded(){
  if(ACTIVE_PART_ALLOCATION) return {source:'supabase',version:'1.0',rowCount:ACTIVE_PART_ALLOCATION.length};
  if(partAllocationPromise) return partAllocationPromise;
  partAllocationPromise = fetch('/api/part-allocation',{cache:'no-store'}).then(async r=>{
    if(!r.ok) throw new Error('Part Allocation API 조회 실패: HTTP '+r.status);
    const d=await r.json();
    if(!d.ok || d.source!=='supabase' || d.version!=='1.0' || !Array.isArray(d.rows) || d.rows.length!==34) throw new Error('Part Allocation V1.0 검증 실패 (34행 필요)');
    ACTIVE_PART_ALLOCATION=d.rows.map(r=>({sales:Number(r.sales_won),ratios:{
      '스시':Number(r.sushi_ratio),'콜드':Number(r.cold_ratio),'베이커리':Number(r.bakery_ratio),'핫':Number(r.hot_ratio),
      '그릴':Number(r.grill_ratio),'피파':Number(r.pipa_ratio),'DMO':Number(r.dmo_ratio),'홀':Number(r.hall_ratio)
    }}));
    return {source:'supabase',version:'1.0',rowCount:ACTIVE_PART_ALLOCATION.length};
  }).finally(()=>partAllocationPromise=null);
  return partAllocationPromise;
}
ensurePartAllocationLoaded().catch(e=>console.warn('[Part Allocation] 사전 로드 실패:',e));
