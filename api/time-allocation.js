export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET 요청만 허용됩니다.' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !key) return res.status(500).json({ ok:false, error:'Supabase 환경변수가 설정되지 않았습니다.' });
  const headers = { apikey:key, Authorization:`Bearer ${key}`, 'Content-Type':'application/json' };
  try {
    const url = new URL('/rest/v1/time_allocation_v1', supabaseUrl);
    url.searchParams.set('select','band_code,band_label,sales_min_won,sales_max_won,part,open_ratio,lunch_ratio,swing_ratio,dinner_ratio,close_ratio,source_model_count,version');
    url.searchParams.set('version','eq.1.0');
    url.searchParams.set('order','sales_min_won.asc,part.asc');
    const r = await fetch(url,{headers});
    if(!r.ok) throw new Error(`time_allocation_v1 조회 실패 (${r.status}): ${await r.text()}`);
    const rows = await r.json();
    res.status(200).json({ok:true,source:'supabase',version:'1.0',rowCount:rows.length,rows});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
}
