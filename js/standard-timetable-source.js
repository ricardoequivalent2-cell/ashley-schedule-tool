// Ashley Schedule Tool - Standard Timetable V2
// Data source policy:
// - Target2 curve/config: Supabase model_config
// - Part Allocation: Supabase part_allocation_v1
// - 30-min BP source: Supabase standard_models + standard_model_slots
// - Timetable operating config: Supabase standard_timetable_config_v2
// Calculation logic only lives in code. No local data fallback.

(function (global) {
  let ACTIVE_TIMETABLE_CONFIG = null;
  let timetableConfigPromise = null;
  let masterCache = null;

  async function ensureTimetableConfigLoaded() {
    if (ACTIVE_TIMETABLE_CONFIG) return ACTIVE_TIMETABLE_CONFIG;
    if (timetableConfigPromise) return timetableConfigPromise;

    timetableConfigPromise = fetch('/api/standard-timetable-config', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }).then(async response => {
      if (!response.ok) throw new Error('정석 시간표 V2 설정 API 조회 실패: HTTP ' + response.status);
      const data = await response.json();
      if (!data || data.ok !== true || data.source !== 'supabase' || !data.config) {
        throw new Error('Supabase 정석 시간표 V2 설정 검증 실패');
      }
      ACTIVE_TIMETABLE_CONFIG = data.config;
      masterCache = null;
      return ACTIVE_TIMETABLE_CONFIG;
    }).finally(() => {
      timetableConfigPromise = null;
    });

    return timetableConfigPromise;
  }

  function getParts() {
    if (typeof getStandardModelParts !== 'function') throw new Error('DB 파트 목록 로더를 찾을 수 없습니다.');
    return getStandardModelParts();
  }

  function getSlotLabels() {
    if (typeof getStandardModelSlotLabels !== 'function') throw new Error('DB 30분 슬롯 라벨 로더를 찾을 수 없습니다.');
    return getStandardModelSlotLabels().map(label => String(label).slice(0, 5));
  }

  function sortedModelSlots(model) {
    return Object.keys((model && model.table) || {}).sort((a, b) => Number(a) - Number(b));
  }

  function normalizeModelByPart(model, parts) {
    const slotKeys = sortedModelSlots(model);
    if (slotKeys.length !== 27) {
      throw new Error('30분 BP 모델 슬롯 수가 27개가 아닙니다: ' + (model && model.title ? model.title : '알 수 없음'));
    }

    const allocation = {};
    parts.forEach(part => {
      const values = slotKeys.map(key => Number(((model.table || {})[key] || {})[part] || 0));
      const total = values.reduce((sum, value) => sum + value, 0);
      allocation[part] = total > 0 ? values.map(value => value / total) : values.map(() => 0);
    });

    return { title: model.title, sales: Number(model.sales), allocation };
  }

  function getNormalizedAnchors(parts) {
    if (typeof getStandardModels !== 'function') throw new Error('30분 BP 모델 로더를 찾을 수 없습니다.');
    return getStandardModels().map(model => normalizeModelByPart(model, parts)).sort((a, b) => a.sales - b.sales);
  }

  function interpolateAllocation(salesWon, parts) {
    const anchors = getNormalizedAnchors(parts);
    const sales = Number(salesWon) || 0;
    if (!anchors.length) throw new Error('30분 BP 모델이 없습니다.');

    let lower = anchors[0];
    let upper = anchors[0];
    let weight = 0;
    let method = '하한고정';

    if (sales <= anchors[0].sales) {
      lower = upper = anchors[0];
    } else if (sales >= anchors[anchors.length - 1].sales) {
      lower = upper = anchors[anchors.length - 1];
      method = '상한고정';
    } else {
      for (let i = 0; i < anchors.length - 1; i += 1) {
        const a = anchors[i];
        const b = anchors[i + 1];
        if (sales >= a.sales && sales <= b.sales) {
          lower = a;
          upper = b;
          if (sales === a.sales) {
            upper = a;
            method = '원본앵커';
          } else if (sales === b.sales) {
            lower = b;
            upper = b;
            method = '원본앵커';
          } else {
            weight = (sales - a.sales) / (b.sales - a.sales);
            method = '선형보간';
          }
          break;
        }
      }
    }

    const byPart = {};
    parts.forEach(part => {
      const a = lower.allocation[part];
      const b = upper.allocation[part];
      byPart[part] = a.map((value, index) => value + (b[index] - value) * weight);
      const sum = byPart[part].reduce((s, v) => s + v, 0);
      if (sum > 0) byPart[part] = byPart[part].map(v => v / sum);
    });

    return { byPart, lower, upper, weight, method };
  }

  // Core V2 rule:
  // For the same part × same 30-min slot, higher sales can never have lower HC.
  // We work in integer HC-step units so 0.5 HC is exact and no floating-step drift occurs.
  function monotonicBalance(rawValues, previousValues, targetPartHours, hcStep, slotHours) {
    const unitHours = hcStep * slotHours;
    const desiredUnits = rawValues.map(v => Math.max(0, Number(v) || 0) / hcStep);
    const units = previousValues.map(v => Math.max(0, Math.round((Number(v) || 0) / hcStep)));
    const minimumUnits = units.reduce((s, v) => s + v, 0);
    const targetUnits = Math.max(minimumUnits, Math.round((Number(targetPartHours) || 0) / unitHours));

    let remaining = targetUnits - minimumUnits;
    while (remaining > 0) {
      let bestIndex = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < units.length; i += 1) {
        // Priority 1: fill the biggest gap versus BP-derived raw demand.
        // Priority 2: when every slot is already above raw demand, preserve BP peak shape.
        const deficit = desiredUnits[i] - units[i];
        const shape = desiredUnits[i] * 1e-6;
        const score = deficit + shape - i * 1e-10;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }
      units[bestIndex] += 1;
      remaining -= 1;
    }

    const values = units.map(u => u * hcStep);
    const roundedHours = units.reduce((s, u) => s + u * unitHours, 0);
    return {
      values,
      roundedHours,
      forcedCarryHours: Math.max(0, minimumUnits * unitHours - (Number(targetPartHours) || 0)),
    };
  }

  function rawTimetableForSales(sales, parts, slots, cfg) {
    if (typeof getPartAllocationRatios !== 'function') throw new Error('Part Allocation V1.0 로더를 찾을 수 없습니다.');
    if (typeof getActiveDiagnosisConfig !== 'function' || typeof tierHoursDaily !== 'function') {
      throw new Error('표준인시 V1.0 계산기준을 찾을 수 없습니다.');
    }

    const diagnosisConfig = getActiveDiagnosisConfig();
    const guestCount = sales / Number(cfg.mixedGuestUnitPrice);
    const target2 = tierHoursDaily(diagnosisConfig.CURVE.TIERS['2차목표'], guestCount, diagnosisConfig.CURVE);
    const partRatios = getPartAllocationRatios(sales);
    const allocation = interpolateAllocation(sales, parts);
    const slotHours = Number(cfg.slotMinutes) / 60;

    const rawByPart = {};
    const partHours = {};
    parts.forEach(part => {
      partHours[part] = target2 * Number(partRatios[part] || 0);
      rawByPart[part] = allocation.byPart[part].map(ratio => partHours[part] * ratio / slotHours);
    });

    return { sales, guestCount, target2, partRatios, partHours, rawByPart, allocation, slots };
  }

  function buildMaster() {
    if (!ACTIVE_TIMETABLE_CONFIG) throw new Error('정석 시간표 V2 DB 설정이 아직 로드되지 않았습니다.');

    const cfg = ACTIVE_TIMETABLE_CONFIG;
    const parts = getParts();
    const slots = getSlotLabels();
    const hcStep = Number(cfg.hcStep);
    const slotHours = Number(cfg.slotMinutes) / 60;
    const master = new Map();
    const previousByPart = {};
    parts.forEach(part => { previousByPart[part] = slots.map(() => 0); });

    for (let sales = Number(cfg.salesMinWon); sales <= Number(cfg.salesMaxWon); sales += Number(cfg.salesStepWon)) {
      const raw = rawTimetableForSales(sales, parts, slots, cfg);
      const hcByPart = {};
      const roundedPartHours = {};
      const forcedCarryHoursByPart = {};

      parts.forEach(part => {
        const result = cfg.monotonicEnabled
          ? monotonicBalance(raw.rawByPart[part], previousByPart[part], raw.partHours[part], hcStep, slotHours)
          : monotonicBalance(raw.rawByPart[part], slots.map(() => 0), raw.partHours[part], hcStep, slotHours);
        hcByPart[part] = result.values;
        roundedPartHours[part] = result.roundedHours;
        forcedCarryHoursByPart[part] = result.forcedCarryHours;
        previousByPart[part] = result.values.slice();
      });

      const slotTotals = slots.map((_, i) => parts.reduce((sum, part) => sum + hcByPart[part][i], 0));
      const roundedTotalHours = slotTotals.reduce((sum, hc) => sum + hc * slotHours, 0);

      master.set(sales, {
        sales,
        guestCount: raw.guestCount,
        guestUnitPrice: Number(cfg.mixedGuestUnitPrice),
        target2: raw.target2,
        roundedTotalHours,
        totalHourDiff: roundedTotalHours - raw.target2,
        parts: parts.slice(),
        slots: slots.slice(),
        partRatios: raw.partRatios,
        partHours: raw.partHours,
        roundedPartHours,
        rawByPart: raw.rawByPart,
        hcByPart,
        slotTotals,
        forcedCarryHoursByPart,
        source: {
          method: raw.allocation.method,
          lowerSales: raw.allocation.lower.sales,
          lowerTitle: raw.allocation.lower.title,
          upperSales: raw.allocation.upper.sales,
          upperTitle: raw.allocation.upper.title,
          weight: raw.allocation.weight,
        },
      });
    }

    return master;
  }

  function getMaster() {
    if (!masterCache) masterCache = buildMaster();
    return masterCache;
  }

  function buildStandardTimetable(salesWon) {
    if (!ACTIVE_TIMETABLE_CONFIG) throw new Error('정석 시간표 V2 DB 설정이 아직 로드되지 않았습니다.');
    const cfg = ACTIVE_TIMETABLE_CONFIG;
    const step = Number(cfg.salesStepWon);
    const min = Number(cfg.salesMinWon);
    const max = Number(cfg.salesMaxWon);
    const rounded = Math.round((Number(salesWon) || min) / step) * step;
    const sales = Math.max(min, Math.min(max, rounded));
    const result = getMaster().get(sales);
    if (!result) throw new Error('선택 매출의 정석 시간표를 찾을 수 없습니다: ' + sales);
    return result;
  }

  async function ensureLoaded() {
    await ensureTimetableConfigLoaded();
    return { source:'supabase', version:ACTIVE_TIMETABLE_CONFIG.version };
  }

  function invalidate() {
    ACTIVE_TIMETABLE_CONFIG = null;
    masterCache = null;
  }

  global.AshleyStandardTimetable = {
    ensureLoaded,
    build: buildStandardTimetable,
    invalidate,
    getConfig: () => ACTIVE_TIMETABLE_CONFIG ? { ...ACTIVE_TIMETABLE_CONFIG } : null,
  };
})(window);
