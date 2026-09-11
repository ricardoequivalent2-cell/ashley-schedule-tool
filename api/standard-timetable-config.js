export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET 요청만 허용됩니다.' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !key) {
    return res.status(500).json({ ok:false, error:'Supabase 환경변수가 설정되지 않았습니다.' });
  }

  const headers = { apikey:key, Authorization:`Bearer ${key}`, 'Content-Type':'application/json' };

  try {
    const url = new URL('/rest/v1/standard_timetable_config_v2', supabaseUrl);
    url.searchParams.set('select','version,is_active,mixed_guest_unit_price,sales_min_won,sales_max_won,sales_step_won,slot_minutes,hc_step,monotonic_enabled,operating_start_time,operating_end_time');
    url.searchParams.set('version','eq.2.0');
    url.searchParams.set('is_active','eq.true');
    url.searchParams.set('limit','1');

    const r = await fetch(url,{headers});
    if(!r.ok) throw new Error(`standard_timetable_config_v2 조회 실패 (${r.status}): ${await r.text()}`);
    const rows = await r.json();
    if(!Array.isArray(rows) || rows.length !== 1) throw new Error('정석 시간표 V2 설정은 활성 1행이어야 합니다.');

    const row = rows[0];
    const config = {
      version: String(row.version),
      mixedGuestUnitPrice: Number(row.mixed_guest_unit_price),
      salesMinWon: Number(row.sales_min_won),
      salesMaxWon: Number(row.sales_max_won),
      salesStepWon: Number(row.sales_step_won),
      slotMinutes: Number(row.slot_minutes),
      hcStep: Number(row.hc_step),
      monotonicEnabled: row.monotonic_enabled === true,
      operatingStartTime: String(row.operating_start_time || ''),
      operatingEndTime: String(row.operating_end_time || ''),
    };

    const valid =
      config.version === '2.0' &&
      Number.isFinite(config.mixedGuestUnitPrice) && config.mixedGuestUnitPrice > 0 &&
      Number.isFinite(config.salesMinWon) && config.salesMinWon > 0 &&
      Number.isFinite(config.salesMaxWon) && config.salesMaxWon >= config.salesMinWon &&
      Number.isFinite(config.salesStepWon) && config.salesStepWon > 0 &&
      Number.isFinite(config.slotMinutes) && config.slotMinutes > 0 &&
      Number.isFinite(config.hcStep) && config.hcStep > 0 &&
      /^\d{2}:\d{2}/.test(config.operatingStartTime) &&
      /^\d{2}:\d{2}/.test(config.operatingEndTime);

    if(!valid) throw new Error('정석 시간표 V2 설정값 검증 실패');

    return res.status(200).json({ok:true, source:'supabase', config});
  } catch(e) {
    return res.status(500).json({ok:false, error:e.message});
  }
}
