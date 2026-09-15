// Ashley FINAL Action Standard Engine
// 숫자 원천은 Supabase만 사용한다. 이 파일은 계산 순서/공식만 가진다.

let ACTIVE_ACTION_CONFIG = null;
let actionConfigLoadPromise = null;

function isActionConfigLoaded() {
  return !!ACTIVE_ACTION_CONFIG;
}

async function ensureActionConfigLoaded() {
  if (ACTIVE_ACTION_CONFIG) return { source: 'supabase', version: ACTIVE_ACTION_CONFIG.version };
  if (actionConfigLoadPromise) return actionConfigLoadPromise;

  actionConfigLoadPromise = fetch('/api/action-config', { cache: 'no-store' })
    .then(async r => {
      if (!r.ok) throw new Error('Action 기준 API 조회 실패: HTTP ' + r.status);
      const d = await r.json();
      if (!d.ok || d.source !== 'supabase' || d.version !== 'FINAL_2026-09-15') {
        throw new Error('FINAL Action 기준 검증 실패');
      }
      if (!Array.isArray(d.sushiRows) || d.sushiRows.length !== 7) {
        throw new Error('스시 Action 기준 7행이 필요합니다.');
      }
      if (!Array.isArray(d.bakeryRows) || d.bakeryRows.length !== 15000) {
        throw new Error('베이커리 Action 기준 15,000행이 필요합니다.');
      }

      const sushi = {};
      d.sushiRows.forEach(r => { sushi[r.action_key] = Number(r.action_value); });
      const bakery = new Map();
      d.bakeryRows.forEach(r => bakery.set(Number(r.weekly_guests), {
        challengeHoursWeek: Number(r.challenge_hours_week),
        appliedHoursWeek: Number(r.applied_hours_week),
      }));

      ACTIVE_ACTION_CONFIG = { version: d.version, sushi, bakery };
      return { source: 'supabase', version: d.version };
    })
    .finally(() => { actionConfigLoadPromise = null; });

  return actionConfigLoadPromise;
}

function getFinalGuestUnitPrice() {
  const c = getActiveDiagnosisConfig();
  const weekday = Number(c.GUEST_UNIT_PRICE_WEEKDAY);
  const weekend = Number(c.GUEST_UNIT_PRICE_WEEKEND);
  if (!Number.isFinite(weekday) || !Number.isFinite(weekend) || weekday !== weekend) {
    throw new Error('FINAL 객단가는 평일/주말 동일값이어야 합니다. model_config를 확인해주세요.');
  }
  return weekday;
}

function calculateSushiActionSaving(guests) {
  if (!ACTIVE_ACTION_CONFIG) throw new Error('Action 기준이 로드되지 않았습니다.');
  const n = Number(guests) || 0;
  const p = ACTIVE_ACTION_CONFIG.sushi;

  const frozenRollTheoretical = p.frozen_roll_fixed_hours + p.frozen_roll_guest_coef * n;
  const frozenRollRealized = frozenRollTheoretical * p.frozen_roll_realization_rate;
  const diyNoodle = p.diy_noodle_fixed_hours + p.diy_noodle_guest_coef * n;
  const sorterPlates = Math.round(n * p.sorter_plate_coef);
  const sorterHours = sorterPlates * p.sorter_seconds_per_plate / 3600;
  const total = frozenRollRealized + diyNoodle + sorterHours;

  return { frozenRollTheoretical, frozenRollRealized, diyNoodle, sorterPlates, sorterHours, total };
}

function getBakeryActionBasis(guests) {
  if (!ACTIVE_ACTION_CONFIG) throw new Error('Action 기준이 로드되지 않았습니다.');
  // FINAL: 주간객수 = ROUND(일객수 × 7), DB 유효범위 1~15,000.
  const weeklyGuestsRaw = Math.round((Number(guests) || 0) * 7);
  const weeklyGuests = Math.min(15000, Math.max(1, weeklyGuestsRaw));
  const row = ACTIVE_ACTION_CONFIG.bakery.get(weeklyGuests);
  if (!row) throw new Error(`베이커리 기준을 찾을 수 없습니다: 주간객수 ${weeklyGuests}`);
  return {
    weeklyGuests,
    challengeHoursWeek: row.challengeHoursWeek,
    appliedHoursWeek: row.appliedHoursWeek,
    appliedHoursDay: row.appliedHoursWeek / 7,
  };
}

function calculateFinalActionStandard(salesWon) {
  if (typeof tierHoursDaily !== 'function' || typeof getPartAllocationRatios !== 'function') {
    throw new Error('V1 표준인시/Part Allocation 엔진이 준비되지 않았습니다.');
  }
  if (!ACTIVE_ACTION_CONFIG) throw new Error('Action 기준이 로드되지 않았습니다.');

  const sales = Number(salesWon) || 0;
  const unitPrice = getFinalGuestUnitPrice();
  const guests = sales / unitPrice;
  const diagnosisConfig = getActiveDiagnosisConfig();
  const ratios = getPartAllocationRatios(sales);

  const v1 = {
    minimum: tierHoursDaily(diagnosisConfig.CURVE.TIERS['최소허들'], guests, diagnosisConfig.CURVE),
    target1: tierHoursDaily(diagnosisConfig.CURVE.TIERS['1차목표'], guests, diagnosisConfig.CURVE),
    guideline: tierHoursDaily(diagnosisConfig.CURVE.TIERS['2차목표'], guests, diagnosisConfig.CURVE),
  };

  const sushi = calculateSushiActionSaving(guests);
  const bakery = getBakeryActionBasis(guests);
  const bakeryRatio = Number(ratios['베이커리']) || 0;

  const bakerySaving = {
    minimum: Math.max(0, v1.minimum * bakeryRatio - bakery.appliedHoursDay),
    target1: Math.max(0, v1.target1 * bakeryRatio - bakery.appliedHoursDay),
    guideline: Math.max(0, v1.guideline * bakeryRatio - bakery.appliedHoursDay),
  };

  const action = {
    minimum: v1.minimum - sushi.total - bakerySaving.minimum,
    target1: v1.target1 - sushi.total - bakerySaving.target1,
    guideline: v1.guideline - sushi.total - bakerySaving.guideline,
  };

  const partTargets = {};
  ['minimum', 'target1', 'guideline'].forEach(tier => {
    const row = {};
    Object.entries(ratios).forEach(([part, ratio]) => { row[part] = v1[tier] * Number(ratio); });
    row['스시'] = Math.max(0, row['스시'] - sushi.total);
    row['베이커리'] = Math.min(row['베이커리'], bakery.appliedHoursDay);
    partTargets[tier] = row;
  });

  return {
    sourceVersion: ACTIVE_ACTION_CONFIG.version,
    salesWon: sales,
    guestUnitPrice: unitPrice,
    guests,
    weeklyGuests: bakery.weeklyGuests,
    v1,
    partAllocation: ratios,
    sushi,
    bakery,
    bakerySaving,
    action,
    partTargets,
  };
}

async function calculateFinalActionStandardReady(salesWon) {
  await Promise.all([
    ensureDiagnosisConfigLoaded(),
    ensurePartAllocationLoaded(),
    ensureActionConfigLoaded(),
  ]);
  return calculateFinalActionStandard(salesWon);
}
