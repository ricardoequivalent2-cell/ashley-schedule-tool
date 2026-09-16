// Ashley Schedule Tool - Standard Timetable V2
// Data source policy:
// - Target2 curve/config: Supabase model_config
// - Part Allocation: Supabase part_allocation_v1
// - 30-min BP source: Supabase standard_models + standard_model_slots
// - Timetable operating config: Supabase standard_timetable_config_v2
// Calculation logic only lives in code. No local data fallback.
//
// NOTE: "REAL SHIFT LIBRARY" 근무조 조합 탐색 블록은 제거됨.
// 그 블록은 sales===13000000일 때 console.log로 근무조 조합을 진단 출력만 하던 코드로,
// hcByPart/master 등 실제 계산 결과에는 전혀 반영되지 않았음 (제거해도 산출값 동일).

(function (global) {
  let ACTIVE_TIMETABLE_CONFIG = null;
  let timetableConfigPromise = null;
  let masterCache = new Map();

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
      masterCache = new Map();
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

  function timeToMinutes(value) {
    const text = String(value || '').slice(0, 5);
    const [h, m] = text.split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
  }

  function getAllSlotLabels() {
    if (typeof getStandardModelSlotLabels !== 'function') throw new Error('DB 30분 슬롯 라벨 로더를 찾을 수 없습니다.');
    return getStandardModelSlotLabels().map(label => String(label).slice(0, 5));
  }

  function getActiveSlotIndexes(cfg) {
    const all = getAllSlotLabels();
    const start = timeToMinutes(cfg.operatingStartTime);
    const end = timeToMinutes(cfg.operatingEndTime);
    return all.map((label, index) => ({ label, index, minute: timeToMinutes(label) }))
      .filter(x => Number.isFinite(x.minute) && x.minute >= start && x.minute < end);
  }

  function getSlotLabels(cfg) {
    return getActiveSlotIndexes(cfg).map(x => x.label);
  }

  function sortedModelSlots(model) {
    return Object.keys((model && model.table) || {}).sort((a, b) => Number(a) - Number(b));
  }

  function normalizeModelByPart(model, parts, cfg) {
    const slotKeys = sortedModelSlots(model);
    const allLabels = getAllSlotLabels();
    if (slotKeys.length !== allLabels.length) {
      throw new Error('30분 BP 모델 슬롯 수와 DB 슬롯 라벨 수가 일치하지 않습니다: ' + (model && model.title ? model.title : '알 수 없음'));
    }

    const active = getActiveSlotIndexes(cfg);
    if (!active.length) throw new Error('DB 운영시간에 포함되는 30분 슬롯이 없습니다.');

    const allocation = {};
    parts.forEach(part => {
      const values = active.map(x => Number(((model.table || {})[slotKeys[x.index]] || {})[part] || 0));
      const total = values.reduce((sum, value) => sum + value, 0);
      allocation[part] = total > 0 ? values.map(value => value / total) : values.map(() => 0);
    });

    return { title: model.title, sales: Number(model.sales), allocation };
  }

  function getNormalizedAnchors(parts, cfg) {
    if (typeof getStandardModels !== 'function') throw new Error('30분 BP 모델 로더를 찾을 수 없습니다.');
    return getStandardModels().map(model => normalizeModelByPart(model, parts, cfg)).sort((a, b) => a.sales - b.sales);
  }

  function interpolateAllocation(salesWon, parts, cfg) {
    const anchors = getNormalizedAnchors(parts, cfg);
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
  // For the same part x same 30-min slot, higher sales can never have lower HC.
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

  function rawTimetableForSales(sales, parts, slots, cfg, guestUnitPriceOverride) {
    if (typeof getPartAllocationRatios !== 'function') throw new Error('Part Allocation V1.0 로더를 찾을 수 없습니다.');
    if (typeof getActiveDiagnosisConfig !== 'function' || typeof tierHoursDaily !== 'function') {
      throw new Error('표준인시 V1.0 계산기준을 찾을 수 없습니다.');
    }

    const finalAction = window.AshleyActionStandard.calculate(sales);

    const guestUnitPrice = Number(finalAction.guestUnitPrice);
    const guestCount = Number(finalAction.guests);
    const target2 = Number(finalAction.action.guideline);
    const partRatios = finalAction.partAllocation;
    const allocation = interpolateAllocation(sales, parts, cfg);
    const slotHours = Number(cfg.slotMinutes) / 60;

    const rawByPart = {};
    const partHours = {};

    parts.forEach(part => {
      partHours[part] = Number(finalAction.partTargets.guideline[part] || 0);
      rawByPart[part] = allocation.byPart[part].map(
        ratio => partHours[part] * ratio / slotHours
      );
    });

    return { sales, guestCount, guestUnitPrice, target2, partRatios, partHours, rawByPart, allocation, slots };
  }

  // ============================================================
  // OPEN FIXED RULE V1
  // 09:00~11:00 오픈 운영 고정 기준
  // FINAL 엔진의 파트별 필요시간 총량은 변경하지 않는다.
  // 핫/그릴/피파 통합 4.5h는 내부적으로 1:1:1 귀속한다.
  // ============================================================
  const OPEN_FIXED_RULE = {
    '09:00': { '스시': 1, '콜드': 1, '베이커리': 0, '핫': 0.5, '그릴': 0.5, '피파': 0, 'DMO': 0, '홀': 1 },
    '09:30': { '스시': 1, '콜드': 1, '베이커리': 0, '핫': 0.5, '그릴': 0.5, '피파': 1, 'DMO': 0, '홀': 1 },
    '10:00': { '스시': 2, '콜드': 1, '베이커리': 0, '핫': 1, '그릴': 1, '피파': 1, 'DMO': 0, '홀': 2 },
    '10:30': { '스시': 2, '콜드': 1, '베이커리': 0, '핫': 1, '그릴': 1, '피파': 1, 'DMO': 0, '홀': 2 },
  };

  // 오픈 고정화로 발생한 증감시간을 재배분할 피크 구간
  const OPEN_REALLOCATION_PEAKS = {
    lunch: { start: '11:00', end: '14:00' },
    dinner: { start: '17:00', end: '20:00' },
  };

  function applyOpenFixedRule(hcByPart, slots, slotHours) {
    const adjusted = {};
    Object.keys(hcByPart).forEach(part => {
      adjusted[part] = hcByPart[part].slice();
    });

    const deltaHoursByPart = {};

    Object.keys(adjusted).forEach(part => {
      let beforeHours = 0;
      let afterHours = 0;

      Object.entries(OPEN_FIXED_RULE).forEach(([time, rule]) => {
        const slotIndex = slots.indexOf(time);
        if (slotIndex < 0) return;
        if (!(part in rule)) return;

        const beforeHC = Number(adjusted[part][slotIndex] || 0);
        const fixedHC = Number(rule[part] || 0);

        beforeHours += beforeHC * slotHours;
        afterHours += fixedHC * slotHours;

        adjusted[part][slotIndex] = fixedHC;
      });

      deltaHoursByPart[part] = afterHours - beforeHours;
    });

    return { adjusted, deltaHoursByPart };
  }

  function getPeakSlotIndexes(slots) {
    const lunchStart = timeToMinutes(OPEN_REALLOCATION_PEAKS.lunch.start);
    const lunchEnd = timeToMinutes(OPEN_REALLOCATION_PEAKS.lunch.end);
    const dinnerStart = timeToMinutes(OPEN_REALLOCATION_PEAKS.dinner.start);
    const dinnerEnd = timeToMinutes(OPEN_REALLOCATION_PEAKS.dinner.end);

    const lunch = [];
    const dinner = [];

    slots.forEach((time, index) => {
      const minute = timeToMinutes(time);
      if (minute >= lunchStart && minute < lunchEnd) lunch.push(index);
      if (minute >= dinnerStart && minute < dinnerEnd) dinner.push(index);
    });

    return { lunch, dinner, all: [...lunch, ...dinner] };
  }

  function redistributeOpenSurplus(adjusted, deltaHoursByPart, slots, slotHours) {
    const peakIndexes = getPeakSlotIndexes(slots);
    const addHoursPerStep = 0.5 * slotHours;

    function addHoursToPeak(part, indexes, hoursToAdd) {
      let remaining = hoursToAdd;

      const candidates = indexes
        .map(index => ({ index, hc: Number(adjusted[part][index] || 0) }))
        .sort((a, b) => (b.hc !== a.hc ? b.hc - a.hc : a.index - b.index));

      while (remaining >= addHoursPerStep - 1e-9) {
        for (const candidate of candidates) {
          if (remaining < addHoursPerStep - 1e-9) break;
          adjusted[part][candidate.index] += 0.5;
          remaining -= addHoursPerStep;
        }
      }

      return remaining;
    }

    Object.keys(adjusted).forEach(part => {
      const deltaHours = Number(deltaHoursByPart[part] || 0);
      if (deltaHours >= 0) return;

      const surplusHours = -deltaHours;

      const lunchHours = peakIndexes.lunch.reduce(
        (sum, index) => sum + Number(adjusted[part][index] || 0) * slotHours, 0
      );
      const dinnerHours = peakIndexes.dinner.reduce(
        (sum, index) => sum + Number(adjusted[part][index] || 0) * slotHours, 0
      );

      const peakTotalHours = lunchHours + dinnerHours;
      const lunchRatio = peakTotalHours > 0 ? lunchHours / peakTotalHours : 0.5;

      const totalSteps = Math.round(surplusHours / addHoursPerStep);
      const lunchSteps = Math.round(totalSteps * lunchRatio);
      const dinnerSteps = totalSteps - lunchSteps;

      addHoursToPeak(part, peakIndexes.lunch, lunchSteps * addHoursPerStep);
      addHoursToPeak(part, peakIndexes.dinner, dinnerSteps * addHoursPerStep);
    });

    return adjusted;
  }

  function recoverOpenDeficit(adjusted, deltaHoursByPart, slots, slotHours) {
    const peakIndexes = getPeakSlotIndexes(slots);
    const removeHoursPerStep = 0.5 * slotHours;

    Object.keys(adjusted).forEach(part => {
      const deltaHours = Number(deltaHoursByPart[part] || 0);
      if (deltaHours <= 0) return;

      let remainingHours = deltaHours;

      const candidates = peakIndexes.all
        .map(index => ({ index, hc: Number(adjusted[part][index] || 0) }))
        .filter(item => item.hc >= 0.5)
        .sort((a, b) => (b.hc !== a.hc ? b.hc - a.hc : a.index - b.index));

      while (remainingHours >= removeHoursPerStep - 1e-9) {
        let removedInThisRound = false;

        for (const candidate of candidates) {
          if (remainingHours < removeHoursPerStep - 1e-9) break;

          const currentHC = Number(adjusted[part][candidate.index] || 0);
          if (currentHC < 0.5) continue;

          adjusted[part][candidate.index] = currentHC - 0.5;
          remainingHours -= removeHoursPerStep;
          removedInThisRound = true;
        }

        if (!removedInThisRound) break;
      }
    });

    return adjusted;
  }

  function buildMaster(guestUnitPriceOverride) {
    if (!ACTIVE_TIMETABLE_CONFIG) throw new Error('정석 시간표 V2 DB 설정이 아직 로드되지 않았습니다.');

    const cfg = ACTIVE_TIMETABLE_CONFIG;
    const parts = getParts();
    const slots = getSlotLabels(cfg);
    const hcStep = Number(cfg.hcStep);
    const slotHours = Number(cfg.slotMinutes) / 60;
    const master = new Map();
    const previousByPart = {};
    parts.forEach(part => { previousByPart[part] = slots.map(() => 0); });

    for (let sales = Number(cfg.salesMinWon); sales <= Number(cfg.salesMaxWon); sales += Number(cfg.salesStepWon)) {
      const raw = rawTimetableForSales(sales, parts, slots, cfg, guestUnitPriceOverride);
      let hcByPart = {};
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

      const openResult = applyOpenFixedRule(hcByPart, slots, slotHours);

      redistributeOpenSurplus(openResult.adjusted, openResult.deltaHoursByPart, slots, slotHours);
      recoverOpenDeficit(openResult.adjusted, openResult.deltaHoursByPart, slots, slotHours);

      // OPEN RULE 적용 전/후 파트별 총량 보존 검증
      parts.forEach(part => {
        const beforeHours = hcByPart[part].reduce((sum, hc) => sum + Number(hc || 0) * slotHours, 0);
        const afterHours = openResult.adjusted[part].reduce((sum, hc) => sum + Number(hc || 0) * slotHours, 0);
        const diff = afterHours - beforeHours;

        if (Math.abs(diff) > 1e-9) {
          console.warn(
            `[OPEN RULE 총량 불일치] 매출=${sales}, 파트=${part}, ` +
            `적용전=${beforeHours.toFixed(2)}h, 적용후=${afterHours.toFixed(2)}h, 차이=${diff.toFixed(2)}h`
          );
        }
      });

      hcByPart = openResult.adjusted;

      const slotTotals = slots.map((_, i) => parts.reduce((sum, part) => sum + hcByPart[part][i], 0));
      const roundedTotalHours = slotTotals.reduce((sum, hc) => sum + hc * slotHours, 0);

      master.set(sales, {
        sales,
        guestCount: raw.guestCount,
        guestUnitPrice: Number(raw.guestUnitPrice),
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

  function getMaster(guestUnitPriceOverride) {
    if (!ACTIVE_TIMETABLE_CONFIG) throw new Error('정석 시간표 V2 DB 설정이 아직 로드되지 않았습니다.');
    const price = Number(guestUnitPriceOverride || ACTIVE_TIMETABLE_CONFIG.mixedGuestUnitPrice);
    const key = String(price);
    if (!masterCache.has(key)) masterCache.set(key, buildMaster(price));
    return masterCache.get(key);
  }

  function buildStandardTimetable(salesWon, guestUnitPriceOverride) {
    if (!ACTIVE_TIMETABLE_CONFIG) throw new Error('정석 시간표 V2 DB 설정이 아직 로드되지 않았습니다.');
    const cfg = ACTIVE_TIMETABLE_CONFIG;
    const step = Number(cfg.salesStepWon);
    const min = Number(cfg.salesMinWon);
    const max = Number(cfg.salesMaxWon);
    const rounded = Math.round((Number(salesWon) || min) / step) * step;
    const sales = Math.max(min, Math.min(max, rounded));
    const result = getMaster(guestUnitPriceOverride).get(sales);
    if (!result) throw new Error('선택 매출의 정석 시간표를 찾을 수 없습니다: ' + sales);
    return result;
  }

  function buildForDiagnosis(salesWon, guestUnitPrice) {
    return buildStandardTimetable(salesWon, guestUnitPrice);
  }

  async function ensureLoaded() {
    await Promise.all([
      ensureTimetableConfigLoaded(),
      window.AshleyActionStandard.ensureLoaded()
    ]);

    return { source: 'supabase', version: ACTIVE_TIMETABLE_CONFIG.version };
  }

  function invalidate() {
    ACTIVE_TIMETABLE_CONFIG = null;
    masterCache = new Map();
  }

  global.AshleyStandardTimetable = {
    ensureLoaded,
    build: buildStandardTimetable,
    buildForDiagnosis,
    invalidate,
    getConfig: () => ACTIVE_TIMETABLE_CONFIG ? { ...ACTIVE_TIMETABLE_CONFIG } : null,
  };
})(window);
