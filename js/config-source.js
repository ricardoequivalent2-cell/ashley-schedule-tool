// Ashley Schedule Tool - V1.0 calculation config source selector
// DB CLEAN-3: Supabase model_config 단일 소스
// 로컬 V1.0 / CAP fallback은 사용하지 않는다.

let ACTIVE_DIAGNOSIS_CONFIG = null;
let DIAGNOSIS_CONFIG_SOURCE_INFO = {
  source: 'unloaded',
  version: null,
  valueCount: 0,
  fallback: false,
  reason: null,
};
let diagnosisConfigLoadPromise = null;

function getActiveDiagnosisConfig() {
  if (!ACTIVE_DIAGNOSIS_CONFIG || DIAGNOSIS_CONFIG_SOURCE_INFO.source !== 'supabase') {
    throw new Error('계산기준이 아직 로드되지 않았습니다. Supabase model_config를 먼저 불러와주세요.');
  }
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
  if (
    data.version !== '1.0' ||
    data.rowCount !== 6 ||
    data.totalRowCount !== 9 ||
    data.partCapRowCount !== 3 ||
    data.matchesExpected !== true
  ) return false;

  const c = data.config;
  if (!c || !c.guestUnitPrice || !c.curve || !c.curve.tiers || !c.partCaps) return false;

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

  const capParts = ['DMO', '데코이', '폴리싱'];
  const capsValid = capParts.every(part => {
    const rules = c.partCaps[part];
    return Array.isArray(rules) && rules.length > 0 && rules.every(r =>
      isFiniteNumber(r.maxSales) && isFiniteNumber(r.cap)
    );
  });

  return values.length === 14 && values.every(isFiniteNumber) && capsValid;
}

function mapApiConfigToEngineConfig(config) {
  return {
    GUEST_UNIT_PRICE_WEEKDAY: Number(config.guestUnitPrice.weekday),
    GUEST_UNIT_PRICE_WEEKEND: Number(config.guestUnitPrice.weekend),
    PART_CAP_RULES: {
      DMO: config.partCaps.DMO.map(r => ({
        maxSales: Number(r.maxSales),
        cap: Number(r.cap),
      })),
      '데코이': config.partCaps['데코이'].map(r => ({
        maxSales: Number(r.maxSales),
        cap: Number(r.cap),
      })),
      '폴리싱': config.partCaps['폴리싱'].map(r => ({
        maxSales: Number(r.maxSales),
        cap: Number(r.cap),
      })),
    },
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
    throw new Error('Supabase V1.0 설정 검증 실패 (6 base rows / 3 CAP rows 조건 불일치)');
  }

  ACTIVE_DIAGNOSIS_CONFIG = mapApiConfigToEngineConfig(data.config);
  DIAGNOSIS_CONFIG_SOURCE_INFO = {
    source: 'supabase',
    version: data.version,
    valueCount: 14,
    fallback: false,
    reason: null,
  };

  console.log('[V1.0 Config] Supabase loaded: 6 base rows / 14 values + 3 CAP rules');
  return getDiagnosisConfigSourceInfo();
}

async function ensureDiagnosisConfigLoaded() {
  if (DIAGNOSIS_CONFIG_SOURCE_INFO.source === 'supabase') {
    return getDiagnosisConfigSourceInfo();
  }

  if (diagnosisConfigLoadPromise) return diagnosisConfigLoadPromise;

  diagnosisConfigLoadPromise = loadDiagnosisConfigFromSupabase()
    .catch(error => {
      // DB CLEAN-3:
      // Supabase config를 못 읽으면 구버전 로컬값으로 계산하지 않고 진단을 중단한다.
      ACTIVE_DIAGNOSIS_CONFIG = null;
      DIAGNOSIS_CONFIG_SOURCE_INFO = {
        source: 'error',
        version: null,
        valueCount: 0,
        fallback: false,
        reason: error && error.message ? error.message : String(error),
      };

      console.error('[V1.0 Config] Supabase load failed:', error);
      throw new Error(
        '계산기준 데이터를 불러오지 못했습니다. 진단을 실행할 수 없습니다. ' +
        (error && error.message ? error.message : '')
      );
    })
    .finally(() => {
      diagnosisConfigLoadPromise = null;
    });

  return diagnosisConfigLoadPromise;
}

// 페이지 진입 시 미리 DB config를 받아둔다.
// 실패해도 로컬값으로 대체하지 않으며, 실제 UP 업로드 시 ensure에서 다시 시도한다.
ensureDiagnosisConfigLoaded().catch(error => {
  console.warn('[V1.0 Config] 사전 로드 실패. UP 업로드 시 다시 시도합니다:', error);
});
