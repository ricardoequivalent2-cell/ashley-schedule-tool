export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET 요청만 허용됩니다.' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    res.status(500).json({
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
    const modelsUrl = new URL('/rest/v1/standard_models', supabaseUrl);
    modelsUrl.searchParams.set('select', 'id,model_name,reference_sales,day_type,model_version');
    modelsUrl.searchParams.set('model_version', 'eq.1.0');
    modelsUrl.searchParams.set('is_active', 'eq.true');
    modelsUrl.searchParams.set('order', 'reference_sales.asc');

    const modelsResponse = await fetch(modelsUrl, { headers });
    if (!modelsResponse.ok) {
      const detail = await modelsResponse.text();
      throw new Error(`standard_models 조회 실패 (${modelsResponse.status}): ${detail}`);
    }

    const modelRows = await modelsResponse.json();

    if (!Array.isArray(modelRows) || modelRows.length === 0) {
      res.status(200).json({
        ok: true,
        source: 'supabase',
        modelCount: 0,
        slotCount: 0,
        models: [],
      });
      return;
    }

    const modelIds = modelRows.map((m) => m.id);
    const slotsUrl = new URL('/rest/v1/standard_model_slots', supabaseUrl);
    slotsUrl.searchParams.set(
      'select',
      'model_id,slot_time,sushi,cold,bakery,hot,grill,pipa,dmo,hall'
    );
    slotsUrl.searchParams.set('model_id', `in.(${modelIds.join(',')})`);
    slotsUrl.searchParams.set('order', 'model_id.asc,slot_time.asc');

    const slotsResponse = await fetch(slotsUrl, { headers });
    if (!slotsResponse.ok) {
      const detail = await slotsResponse.text();
      throw new Error(`standard_model_slots 조회 실패 (${slotsResponse.status}): ${detail}`);
    }

    const slotRows = await slotsResponse.json();
    const slotsByModelId = new Map();

    for (const slot of slotRows) {
      if (!slotsByModelId.has(slot.model_id)) {
        slotsByModelId.set(slot.model_id, []);
      }
      slotsByModelId.get(slot.model_id).push(slot);
    }

    const models = modelRows.map((model) => {
      const slots = slotsByModelId.get(model.id) || [];
      const table = {};

      slots.forEach((slot, index) => {
        table[String(index)] = {
          '데코이': 0,
          '폴리싱': 0,
          '스시': Number(slot.sushi) || 0,
          '콜드': Number(slot.cold) || 0,
          '베이커리': Number(slot.bakery) || 0,
          '핫': Number(slot.hot) || 0,
          '그릴': Number(slot.grill) || 0,
          '피파': Number(slot.pipa) || 0,
          'DMO': Number(slot.dmo) || 0,
          '홀': Number(slot.hall) || 0,
        };
      });

      return {
        id: model.id,
        title: model.model_name,
        sales: Number(model.reference_sales),
        dayType: model.day_type,
        version: model.model_version,
        slotCount: slots.length,
        table,
      };
    });

    const slotCount = models.reduce((sum, model) => sum + model.slotCount, 0);

    res.status(200).json({
      ok: true,
      source: 'supabase',
      modelCount: models.length,
      slotCount,
      expected: {
        modelCount: 16,
        slotCount: 432,
      },
      matchesExpected: models.length === 16 && slotCount === 432,
      models,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
