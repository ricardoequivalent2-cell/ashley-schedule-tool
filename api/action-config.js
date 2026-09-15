export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET 요청만 허용됩니다.' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !key) {
    res.status(500).json({ ok: false, error: 'Supabase 환경변수가 설정되지 않았습니다.' });
    return;
  }

  const version = 'FINAL_2026-09-15';
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };

  async function fetchJson(url, extraHeaders = {}) {
    const r = await fetch(url, { headers: { ...headers, ...extraHeaders } });
    if (!r.ok) throw new Error(`Supabase 조회 실패 (${r.status}): ${await r.text()}`);
    return r.json();
  }

  try {
    const sushiUrl = new URL('/rest/v1/action_sushi_v1', supabaseUrl);
    sushiUrl.searchParams.set('select', 'action_key,action_value,unit,description,version,is_active');
    sushiUrl.searchParams.set('version', `eq.${version}`);
    sushiUrl.searchParams.set('is_active', 'eq.true');
    sushiUrl.searchParams.set('order', 'id.asc');
    const sushiRows = await fetchJson(sushiUrl);

    // Supabase REST 기본 반환 제한(보통 1,000행)을 피하기 위해 1,000행씩 읽는다.
    const bakeryRows = [];
    const pageSize = 1000;
    for (let from = 0; from < 15000; from += pageSize) {
      const to = from + pageSize - 1;
      const bakeryUrl = new URL('/rest/v1/action_bakery_v1', supabaseUrl);
      bakeryUrl.searchParams.set('select', 'weekly_guests,challenge_hours_week,applied_hours_week,version,is_active');
      bakeryUrl.searchParams.set('version', `eq.${version}`);
      bakeryUrl.searchParams.set('is_active', 'eq.true');
      bakeryUrl.searchParams.set('order', 'weekly_guests.asc');
      const page = await fetchJson(bakeryUrl, { Range: `${from}-${to}` });
      bakeryRows.push(...page);
      if (page.length < pageSize) break;
    }

    const expectedSushiKeys = [
      'frozen_roll_fixed_hours',
      'frozen_roll_guest_coef',
      'frozen_roll_realization_rate',
      'diy_noodle_fixed_hours',
      'diy_noodle_guest_coef',
      'sorter_plate_coef',
      'sorter_seconds_per_plate',
    ];
    const sushiKeys = new Set(sushiRows.map(r => r.action_key));
    const sushiValid = sushiRows.length === 7 && expectedSushiKeys.every(k => sushiKeys.has(k));
    const bakeryValid =
      bakeryRows.length === 15000 &&
      Number(bakeryRows[0]?.weekly_guests) === 1 &&
      Number(bakeryRows[bakeryRows.length - 1]?.weekly_guests) === 15000;

    res.status(200).json({
      ok: sushiValid && bakeryValid,
      source: 'supabase',
      version,
      sushiRowCount: sushiRows.length,
      bakeryRowCount: bakeryRows.length,
      sushiRows,
      bakeryRows,
      validation: { sushiValid, bakeryValid },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
