export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET 요청만 허용됩니다.' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    res.status(500).json({
      error: 'Supabase 환경변수가 설정되지 않았습니다.'
    });
    return;
  }

  try {
    const url = new URL('/rest/v1/weekly_store_summary', supabaseUrl);
    url.searchParams.set(
      'select',
      'id,store_name,week_start,week_end,week_label,model_version,config_version,expected_sales,guest_count,actual_hours,standard_hours,gap_hours,gap_pct,kitchen_actual_hours,kitchen_standard_hours,kitchen_gap_hours,kitchen_gap_pct,hall_actual_hours,hall_standard_hours,hall_gap_hours,hall_gap_pct,labor_productivity,saved_at,updated_at'
    );
    url.searchParams.set('order', 'week_start.desc,store_name.asc');

    const response = await fetch(url, {
      headers: {
        apikey: supabaseSecretKey,
        Authorization: `Bearer ${supabaseSecretKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`weekly_store_summary 조회 실패 (${response.status}): ${detail}`);
    }

    const rows = await response.json();

    const weeks = [...new Map(
      rows.map(row => [
        row.week_start,
        {
          weekStart: row.week_start,
          weekEnd: row.week_end,
          weekLabel: row.week_label || `${row.week_start} ~ ${row.week_end}`
        }
      ])
    ).values()];

    res.status(200).json({
      ok: true,
      weeks,
      rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
