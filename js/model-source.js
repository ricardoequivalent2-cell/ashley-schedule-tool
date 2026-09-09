// Ashley Schedule Tool - standard model source selector
// DB CLEAN-1: Supabase 기준모델 단일 소스
// 로컬 standard-models.js fallback은 사용하지 않는다.

let ACTIVE_STANDARD_MODELS = [];
let STANDARD_MODEL_SOURCE_INFO = {
  source: 'unloaded',
  modelCount: 0,
  slotCount: 0,
  fallback: false,
  reason: null,
};
let standardModelLoadPromise = null;

function getStandardModels() {
  if (!Array.isArray(ACTIVE_STANDARD_MODELS) || ACTIVE_STANDARD_MODELS.length === 0) {
    throw new Error('기준모델이 아직 로드되지 않았습니다. Supabase 기준모델을 먼저 불러와주세요.');
  }
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
      // 로컬 fallback 금지:
      // 기준모델을 못 읽으면 잘못된 구버전 계산 대신 진단을 중단한다.
      ACTIVE_STANDARD_MODELS = [];
      STANDARD_MODEL_SOURCE_INFO = {
        source: 'error',
        modelCount: 0,
        slotCount: 0,
        fallback: false,
        reason: error && error.message ? error.message : String(error),
      };
      console.error('[Standard Models] Supabase 기준모델 로드 실패:', error);
      throw new Error(
        '기준모델 데이터를 불러오지 못했습니다. 진단을 실행할 수 없습니다. ' +
        (error && error.message ? error.message : '')
      );
    })
    .finally(() => {
      standardModelLoadPromise = null;
    });

  return standardModelLoadPromise;
}

// 페이지 진입 시 미리 DB 모델을 받아둔다.
// 실패해도 로컬 모델로 대체하지 않으며, 실제 업로드 시 ensure에서 다시 시도한다.
ensureStandardModelsLoaded()
  .then(() => {
    try {
      if (typeof renderBackdataModelsTable === 'function') renderBackdataModelsTable();
    } catch (e) {
      console.warn('[Standard Models] 백데이터 표 갱신 생략:', e);
    }
  })
  .catch(error => {
    console.warn('[Standard Models] 사전 로드 실패. 업로드 시 다시 시도합니다:', error);
  });
