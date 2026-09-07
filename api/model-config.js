export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET 요청만 허용됩니다.' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    res.status(500).json({
      ok: false,
      error: 'Supabase 환경변수가 설정되지 않았습니다.',
      missing: {
        SUPABASE_URL: !supabaseUrl,
        SUPABASE_SECRET_KEY: !supabaseSecretKey,
      },
    });
    return;
  }

  const headers = {
    apikey: supabaseSecretKey,
    Authorization: `Bearer ${supabaseSecretKey}`,
    'Content-Type': 'application/json',
  };

  try {
    const url = new URL('/rest/v1/model_config', supabaseUrl);
    url.searchParams.set(
      'select',
      'config_group,config_key,config_value,model_version,description,is_active'
    );
    url.searchParams.set('model_version', 'eq.1.0');
    url.searchParams.set('is_active', 'eq.true');
    url.searchParams.set('order', 'config_group.asc,config_key.asc');

    const response = await fetch(url, { headers });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`model_config 조회 실패 (${response.status}): ${detail}`);
    }

    const rows = await response.json();

    const byKey = new Map(
      rows.map((row) => [`${row.config_group}.${row.config_key}`, row.config_value])
    );

    const weekday = Number(byKey.get('guest_unit_price.weekday'));
    const weekend = Number(byKey.get('guest_unit_price.weekend'));
    const common = byKey.get('curve.common') || {};
    const minimum = byKey.get('curve.minimum') || {};
    const target1 = byKey.get('curve.target1') || {};
    const target2 = byKey.get('curve.target2') || {};

    const config = {
      guestUnitPrice: {
        weekday,
        weekend,
      },
      curve: {
        floor: Number(common.floor),
        knot: Number(common.knot),
        slope: Number(common.slope),
        tiers: {
          minimum: {
            a: Number(minimum.a),
            b: Number(minimum.b),
            c: Number(minimum.c),
          },
          target1: {
            a: Number(target1.a),
            b: Number(target1.b),
            c: Number(target1.c),
          },
          target2: {
            a: Number(target2.a),
            b: Number(target2.b),
            c: Number(target2.c),
          },
        },
      },
    };

    const expected = {
      rowCount: 6,
      guestUnitPrice: {
        weekday: 21138,
        weekend: 24889,
      },
      curve: {
        floor: 90,
        knot: 1200,
        slope: 0.164532,
        tiers: {
          minimum: { a: 47.6487, b: 0.5936, c: 0.8431 },
          target1: { a: 61.9593, b: 0.1823, c: 0.9948 },
          target2: { a: 60.09, b: 0.1403, c: 1.023 },
        },
      },
    };

    const matchesExpected =
      rows.length === expected.rowCount &&
      config.guestUnitPrice.weekday === expected.guestUnitPrice.weekday &&
      config.guestUnitPrice.weekend === expected.guestUnitPrice.weekend &&
      config.curve.floor === expected.curve.floor &&
      config.curve.knot === expected.curve.knot &&
      config.curve.slope === expected.curve.slope &&
      config.curve.tiers.minimum.a === expected.curve.tiers.minimum.a &&
      config.curve.tiers.minimum.b === expected.curve.tiers.minimum.b &&
      config.curve.tiers.minimum.c === expected.curve.tiers.minimum.c &&
      config.curve.tiers.target1.a === expected.curve.tiers.target1.a &&
      config.curve.tiers.target1.b === expected.curve.tiers.target1.b &&
      config.curve.tiers.target1.c === expected.curve.tiers.target1.c &&
      config.curve.tiers.target2.a === expected.curve.tiers.target2.a &&
      config.curve.tiers.target2.b === expected.curve.tiers.target2.b &&
      config.curve.tiers.target2.c === expected.curve.tiers.target2.c;

    res.status(200).json({
      ok: true,
      source: 'supabase',
      version: '1.0',
      rowCount: rows.length,
      matchesExpected,
      config,
      rows,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
