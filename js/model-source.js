// Ashley Schedule Tool - standard model source selector
// Step 10: Supabase 우선 / 로컬 standard-models.js 자동 fallback

let ACTIVE_STANDARD_MODELS = EMBEDDED_STANDARD_MODELS;
let STANDARD_MODEL_SOURCE_INFO = {
  source: 'local',
  modelCount: EMBEDDED_STANDARD_MODELS.length,
  slotCount: EMBEDDED_STANDARD_MODELS.reduce((sum, m) => sum + Object.keys(m.table || {}).length, 0),
  fallback: true,
  reason: '초기 로컬 모델',
};
let standardModelLoadPromise = null;

function getStandardModels() {
  return ACTIVE_STANDARD_MODELS;
}

function getStandardModelSourceInfo() {
  return { ...STANDARD_MODEL_SOURCE_INFO };
}

function isValidSupabaseModelPayload(data) {
  if (!data || data.ok !== true || !Array.isArray(data.models)) return false;
  if (data.modelCount !== 16 || data.slotCount !== 432) return false;
  if (data.matchesExpected !== true) return false;

  return data.models.every(model => {
    if (!model || typeof model.title !== 'string' || !Number.isFinite(Number(model.sales))) return false;
    const slots = model.table && typeof model.table === 'object' ? Object.keys(model.table) : [];
    return slots.length === 27;
  });
}

async function loadStandardModelsFromSupabase() {
  const response = await fetch('/api/standard-models', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error('기준모델 API 조회 실패: HTTP ' + response.status);
  }

  const data = await response.json();
  if (!isValidSupabaseModelPayload(data)) {
    throw new Error('Supabase 기준모델 검증 실패 (16개 모델 / 432개 슬롯 조건 불일치)');
  }

  // API는 기존 EMBEDDED_STANDARD_MODELS와 동일한 title/sales/table 형태를 반환한다.
  ACTIVE_STANDARD_MODELS = data.models.map(model => ({
    title: model.title,
    sales: Number(model.sales),
    table: model.table,
  }));

  STANDARD_MODEL_SOURCE_INFO = {
    source: 'supabase',
    modelCount: data.modelCount,
    slotCount: data.slotCount,
    fallback: false,
    reason: null,
  };

  return getStandardModelSourceInfo();
}

async function ensureStandardModelsLoaded() {
  if (STANDARD_MODEL_SOURCE_INFO.source === 'supabase') {
    return getStandardModelSourceInfo();
  }

  if (standardModelLoadPromise) return standardModelLoadPromise;

  standardModelLoadPromise = loadStandardModelsFromSupabase()
    .catch(error => {
      // DB/API 장애가 진단 기능 전체 장애로 이어지지 않도록 기존 기준모델을 유지한다.
      ACTIVE_STANDARD_MODELS = EMBEDDED_STANDARD_MODELS;
      STANDARD_MODEL_SOURCE_INFO = {
        source: 'local',
        modelCount: EMBEDDED_STANDARD_MODELS.length,
        slotCount: EMBEDDED_STANDARD_MODELS.reduce((sum, m) => sum + Object.keys(m.table || {}).length, 0),
        fallback: true,
        reason: error && error.message ? error.message : String(error),
      };
      console.warn('[Standard Models] Supabase 조회 실패 → 로컬 fallback 사용:', error);
      return getStandardModelSourceInfo();
    })
    .finally(() => {
      standardModelLoadPromise = null;
    });

  return standardModelLoadPromise;
}

// 페이지 진입 시 미리 DB 모델을 받아둔다. 업로드 시점에도 ensure를 다시 호출하므로
// 느린 네트워크에서도 계산 전에는 source가 확정된다.
ensureStandardModelsLoaded().then(() => {
  try {
    if (typeof renderBackdataModelsTable === 'function') renderBackdataModelsTable();
  } catch (e) {
    console.warn('[Standard Models] 백데이터 표 갱신 생략:', e);
  }
});
