// Ashley Schedule Tool - V1.0 calculation config source selector
// Step 11-4: Supabase 우선 / diagnosis-engine.js 로컬 V1.0 자동 fallback

let ACTIVE_DIAGNOSIS_CONFIG = buildLocalDiagnosisConfig();
let DIAGNOSIS_CONFIG_SOURCE_INFO = {
  source: 'local',
  version: '1.0',
  valueCount: 14,
  fallback: true,
  reason: '초기 로컬 V1.0 설정',
};
let diagnosisConfigLoadPromise = null;

function buildLocalDiagnosisConfig() {
  return {
    GUEST_UNIT_PRICE_WEEKDAY,
    GUEST_UNIT_PRICE_WEEKEND,
    CURVE: {
      FLOOR: CURVE.FLOOR,
      KNOT: CURVE.KNOT,
      SLOPE: CURVE.SLOPE,
      TIERS: {
        '최소허들': { ...CURVE.TIERS['최소허들'] },
        '1차목표': { ...CURVE.TIERS['1차목표'] },
        '2차목표': { ...CURVE.TIERS['2차목표'] },
      },
    },
  };
}

function getActiveDiagnosisConfig() {
  return ACTIVE_DIAGNOSIS_CONFIG;
}

function getDiagnosisConfigSourceInfo() {
  return { ...DIAGNOSIS_CONFIG_SOURCE_INFO };
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function isValidDiagnosisConfigPayload(data) {
  if (!data || data.ok !== true || data.source !== 'supabase') return false;
  if (data.version !== '1.0' || data.rowCount !== 6 || data.matchesExpected !== true) return false;
  const c = data.config;
  if (!c || !c.guestUnitPrice || !c.curve || !c.curve.tiers) return false;

  const values = [
    c.guestUnitPrice.weekday,
    c.guestUnitPrice.weekend,
    c.curve.floor,
    c.curve.knot,
    c.curve.slope,
    c.curve.tiers.minimum && c.curve.tiers.minimum.a,
    c.curve.tiers.minimum && c.curve.tiers.minimum.b,
    c.curve.tiers.minimum && c.curve.tiers.minimum.c,
    c.curve.tiers.target1 && c.curve.tiers.target1.a,
    c.curve.tiers.target1 && c.curve.tiers.target1.b,
    c.curve.tiers.target1 && c.curve.tiers.target1.c,
    c.curve.tiers.target2 && c.curve.tiers.target2.a,
    c.curve.tiers.target2 && c.curve.tiers.target2.b,
    c.curve.tiers.target2 && c.curve.tiers.target2.c,
  ];
  return values.length === 14 && values.every(isFiniteNumber);
}

function mapApiConfigToEngineConfig(config) {
  return {
    GUEST_UNIT_PRICE_WEEKDAY: Number(config.guestUnitPrice.weekday),
    GUEST_UNIT_PRICE_WEEKEND: Number(config.guestUnitPrice.weekend),
    CURVE: {
      FLOOR: Number(config.curve.floor),
      KNOT: Number(config.curve.knot),
      SLOPE: Number(config.curve.slope),
      TIERS: {
        '최소허들': {
          a: Number(config.curve.tiers.minimum.a),
          b: Number(config.curve.tiers.minimum.b),
          c: Number(config.curve.tiers.minimum.c),
        },
        '1차목표': {
          a: Number(config.curve.tiers.target1.a),
          b: Number(config.curve.tiers.target1.b),
          c: Number(config.curve.tiers.target1.c),
        },
        '2차목표': {
          a: Number(config.curve.tiers.target2.a),
          b: Number(config.curve.tiers.target2.b),
          c: Number(config.curve.tiers.target2.c),
        },
      },
    },
  };
}

async function loadDiagnosisConfigFromSupabase() {
  const response = await fetch('/api/model-config', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error('V1.0 설정 API 조회 실패: HTTP ' + response.status);
  }

  const data = await response.json();
  if (!isValidDiagnosisConfigPayload(data)) {
    throw new Error('Supabase V1.0 설정 검증 실패 (6 rows / 14 values 조건 불일치)');
  }

  ACTIVE_DIAGNOSIS_CONFIG = mapApiConfigToEngineConfig(data.config);
  DIAGNOSIS_CONFIG_SOURCE_INFO = {
    source: 'supabase',
    version: data.version,
    valueCount: 14,
    fallback: false,
    reason: null,
  };

  console.log('[V1.0 Config] Supabase loaded: 6 rows / 14 values');
  return getDiagnosisConfigSourceInfo();
}

async function ensureDiagnosisConfigLoaded() {
  if (DIAGNOSIS_CONFIG_SOURCE_INFO.source === 'supabase') {
    return getDiagnosisConfigSourceInfo();
  }

  if (diagnosisConfigLoadPromise) return diagnosisConfigLoadPromise;

  diagnosisConfigLoadPromise = loadDiagnosisConfigFromSupabase()
    .catch(error => {
      ACTIVE_DIAGNOSIS_CONFIG = buildLocalDiagnosisConfig();
      DIAGNOSIS_CONFIG_SOURCE_INFO = {
        source: 'local',
        version: '1.0',
        valueCount: 14,
        fallback: true,
        reason: error && error.message ? error.message : String(error),
      };
      console.warn('[V1.0 Config] Supabase 조회 실패 → 로컬 fallback 사용:', error);
      return getDiagnosisConfigSourceInfo();
    })
    .finally(() => {
      diagnosisConfigLoadPromise = null;
    });

  return diagnosisConfigLoadPromise;
}

// 페이지 진입 시 미리 DB 설정을 받아둔다. 업로드 시점에도 ensure를 다시 호출한다.
ensureDiagnosisConfigLoaded();
