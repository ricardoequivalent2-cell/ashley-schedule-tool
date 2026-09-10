import { kv } from '@vercel/kv';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 설정되지 않았습니다.`);
  return value;
}

async function upsertWeeklySummary(summary) {
  if (!summary) throw new Error('adminWeeklySummary가 필요합니다.');

  const supabaseUrl = requireEnv('SUPABASE_URL');
  const supabaseSecretKey = requireEnv('SUPABASE_SECRET_KEY');

  const row = {
    store_name: String(summary.storeName || '').trim(),
    week_start: summary.weekStart,
    week_end: summary.weekEnd,
    week_label: summary.weekLabel || null,
    model_version: summary.modelVersion || null,
    config_version: summary.configVersion || null,
    expected_sales: Math.round(Number(summary.expectedSales || 0)),
    guest_count: Math.round(Number(summary.guestCount || 0)),
    actual_hours: Number(summary.actualHours || 0),
    standard_hours: Number(summary.standardHours || 0),
    gap_hours: Number(summary.gapHours || 0),
    gap_pct: summary.gapPct == null ? null : Number(summary.gapPct),
    kitchen_actual_hours: Number(summary.kitchenActualHours || 0),
    kitchen_standard_hours: Number(summary.kitchenStandardHours || 0),
    kitchen_gap_hours: Number(summary.kitchenGapHours || 0),
    kitchen_gap_pct: summary.kitchenGapPct == null ? null : Number(summary.kitchenGapPct),
    hall_actual_hours: Number(summary.hallActualHours || 0),
    hall_standard_hours: Number(summary.hallStandardHours || 0),
    hall_gap_hours: Number(summary.hallGapHours || 0),
    hall_gap_pct: summary.hallGapPct == null ? null : Number(summary.hallGapPct),
    labor_productivity: summary.laborProductivity == null ? null : Number(summary.laborProductivity),
    saved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (!row.store_name || !row.week_start || !row.week_end) {
    throw new Error('관리자 요약의 매장명/주차 정보가 올바르지 않습니다.');
  }

  const url = new URL('/rest/v1/weekly_store_summary', supabaseUrl);
  url.searchParams.set('on_conflict', 'store_name,week_start');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: supabaseSecretKey,
      Authorization: `Bearer ${supabaseSecretKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`weekly_store_summary 저장 실패 (${response.status}): ${detail}`);
  }

  const savedRows = await response.json();
  return savedRows[0] || row;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST 요청만 허용됩니다.' });
    return;
  }

  try {
    const { storeName, headline, weeklySummary, result, adminWeeklySummary } = req.body || {};
    if (!storeName) {
      res.status(400).json({ error: 'storeName이 필요합니다.' });
      return;
    }

    const savedWeeklySummary = await upsertWeeklySummary({
      ...adminWeeklySummary,
      storeName
    });

    const record = {
      storeName,
      headline: headline || null,
      weeklySummary: weeklySummary || null,
      result: result || null,
      adminWeeklySummary: adminWeeklySummary || null,
      savedAt: new Date().toISOString(),
    };

    await kv.set('store:' + storeName, record);
    await kv.sadd('store-index', storeName);

    const weekStart = String(adminWeeklySummary?.weekStart || '').trim();
    if (weekStart) {
      const weekKey = `store-week:${storeName}:${weekStart}`;
      await kv.set(weekKey, record);
      await kv.sadd('store-week-index', weekKey);
    }

    res.status(200).json({ ok: true, weeklyStoreSummary: savedWeeklySummary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
