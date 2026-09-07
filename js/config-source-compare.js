(function () {
  const TOLERANCE = 1e-9;

  function localConfig() {
    if (typeof GUEST_UNIT_PRICE_WEEKDAY === 'undefined' || typeof GUEST_UNIT_PRICE_WEEKEND === 'undefined' || typeof CURVE === 'undefined') {
      throw new Error('diagnosis-engine.js의 V1.0 설정을 읽지 못했습니다.');
    }
    return {
      guestUnitPrice: { weekday: GUEST_UNIT_PRICE_WEEKDAY, weekend: GUEST_UNIT_PRICE_WEEKEND },
      curve: {
        floor: CURVE.FLOOR,
        knot: CURVE.KNOT,
        slope: CURVE.SLOPE,
        tiers: {
          minimum: CURVE.TIERS['최소허들'],
          target1: CURVE.TIERS['1차목표'],
          target2: CURVE.TIERS['2차목표']
        }
      }
    };
  }

  const PATHS = [
    ['guestUnitPrice.weekday', c => c.guestUnitPrice.weekday],
    ['guestUnitPrice.weekend', c => c.guestUnitPrice.weekend],
    ['curve.floor', c => c.curve.floor],
    ['curve.knot', c => c.curve.knot],
    ['curve.slope', c => c.curve.slope],
    ['curve.tiers.minimum.a', c => c.curve.tiers.minimum.a],
    ['curve.tiers.minimum.b', c => c.curve.tiers.minimum.b],
    ['curve.tiers.minimum.c', c => c.curve.tiers.minimum.c],
    ['curve.tiers.target1.a', c => c.curve.tiers.target1.a],
    ['curve.tiers.target1.b', c => c.curve.tiers.target1.b],
    ['curve.tiers.target1.c', c => c.curve.tiers.target1.c],
    ['curve.tiers.target2.a', c => c.curve.tiers.target2.a],
    ['curve.tiers.target2.b', c => c.curve.tiers.target2.b],
    ['curve.tiers.target2.c', c => c.curve.tiers.target2.c]
  ];

  function sameNumber(a, b) {
    return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= TOLERANCE;
  }

  async function runCompare() {
    const status = document.getElementById('status');
    const details = document.getElementById('details');
    status.className = 'status pending';
    status.textContent = '비교 중...';
    details.textContent = 'Supabase V1.0 설정을 불러오는 중입니다.';

    try {
      const local = localConfig();
      const response = await fetch('/api/model-config', { cache: 'no-store' });
      if (!response.ok) throw new Error(`API 응답 오류: ${response.status}`);
      const payload = await response.json();
      if (!payload.ok || !payload.config) throw new Error(payload.error || 'DB 설정 응답이 올바르지 않습니다.');

      const mismatches = [];
      PATHS.forEach(([path, getter]) => {
        const localValue = getter(local);
        const dbValue = getter(payload.config);
        if (!sameNumber(localValue, dbValue)) mismatches.push({ path, local: localValue, db: dbValue });
      });

      document.getElementById('localCount').textContent = PATHS.length;
      document.getElementById('dbCount').textContent = PATHS.length;
      document.getElementById('valueCount').textContent = PATHS.length;
      document.getElementById('mismatchCount').textContent = mismatches.length;

      if (mismatches.length === 0 && payload.rowCount === 6) {
        status.className = 'status success';
        status.textContent = '100% 일치 · 로컬 V1.0과 Supabase V1.0 설정이 동일합니다.';
        details.textContent = [
          `API source: ${payload.source}`,
          `model version: ${payload.version}`,
          `DB rows: ${payload.rowCount}`,
          `비교 값: ${PATHS.length}`,
          '불일치: 0',
          '',
          ...PATHS.map(([path, getter]) => `${path}: ${getter(local)}`)
        ].join('\n');
      } else {
        status.className = 'status fail';
        status.textContent = `불일치 발견 · ${mismatches.length}개 값을 확인하세요.`;
        details.textContent = JSON.stringify({ rowCount: payload.rowCount, mismatches }, null, 2);
      }
    } catch (error) {
      status.className = 'status fail';
      status.textContent = '비교 실패 · API 또는 설정을 확인하세요.';
      details.textContent = error.stack || error.message;
    }
  }

  document.getElementById('runBtn').addEventListener('click', runCompare);
  runCompare();
})();
