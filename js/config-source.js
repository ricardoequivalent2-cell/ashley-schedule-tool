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
    PART_CAP_RULES: {
      DMO: PART_CAP_RULES.DMO.map(r => ({ ...r })),
      '데코이': PART_CAP_RULES['데코이'].map(r => ({ ...r })),
      '폴리싱': PART_CAP_RULES['폴리싱'].map(r => ({ ...r })),
    },
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
  if (data.version !== '1.0' || data.rowCount !== 6 || data.totalRowCount !== 9 || data.partCapRowCount !== 3 || data.matchesExpected !== true) return false;
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
      DMO: config.partCaps.DMO.map(r => ({ maxSales: Number(r.maxSales), cap: Number(r.cap) })),
      '데코이': config.partCaps['데코이'].map(r => ({ maxSales: Number(r.maxSales), cap: Number(r.cap) })),
      '폴리싱': config.partCaps['폴리싱'].map(r => ({ maxSales: Number(r.maxSales), cap: Number(r.cap) })),
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
