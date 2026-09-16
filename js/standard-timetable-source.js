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
      // 운영시간 밖 슬롯(예: 08:30)은 먼저 제외하고, 남은 운영시간만 다시 100%로 정규화한다.
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
  '09:00': {
    '스시': 1,
    '콜드': 1,
    '베이커리': 0,
    '핫': 0.5,
    '그릴': 0.5,
    '피파': 0,
    'DMO': 0,
    '홀': 1
  },
  '09:30': {
    '스시': 1,
    '콜드': 1,
    '베이커리': 0,
    '핫': 0.5,
    '그릴': 0.5,
    '피파': 1,
    'DMO': 0,
    '홀': 1
  },
  '10:00': {
    '스시': 2,
    '콜드': 1,
    '베이커리': 0,
    '핫': 1,
    '그릴': 1,
    '피파': 1,
    'DMO': 0,
    '홀': 2
  },
  '10:30': {
    '스시': 2,
    '콜드': 1,
    '베이커리': 0,
    '핫': 1,
    '그릴': 1,
    '피파': 1,
    'DMO': 0,
    '홀': 2
  }
};
// 오픈 고정화로 발생한 증감시간을 재배분할 피크 구간
const OPEN_REALLOCATION_PEAKS = {
  lunch: {
    start: '11:00',
    end: '14:00'
  },
  dinner: {
    start: '17:00',
    end: '20:00'
  }
};
function applyOpenFixedRule(hcByPart, slots, slotHours) {
  // 원본을 직접 변경하지 않고 복사본에서 작업
  const adjusted = {};
  Object.keys(hcByPart).forEach(part => {
    adjusted[part] = hcByPart[part].slice();
  });

  // 파트별 오픈 고정화에 따른 시간 증감
  // + : 오픈에서 시간이 더 필요함
  // - : 오픈에서 시간이 남음
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

  return {
    adjusted,
    deltaHoursByPart
  };
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

    if (minute >= lunchStart && minute < lunchEnd) {
      lunch.push(index);
    }

    if (minute >= dinnerStart && minute < dinnerEnd) {
      dinner.push(index);
    }
  });

  return {
    lunch,
    dinner,
    all: [...lunch, ...dinner]
  };
}
function redistributeOpenSurplus(adjusted, deltaHoursByPart, slots, slotHours) {
  const peakIndexes = getPeakSlotIndexes(slots);
  const addHoursPerStep = 0.5 * slotHours; // 0.5HC × 30분 = 0.25h

  // 특정 피크 구간 안에서 기존 HC가 높은 슬롯부터 배분
  function addHoursToPeak(part, indexes, hoursToAdd) {
    let remaining = hoursToAdd;

    const candidates = indexes
      .map(index => ({
        index,
        hc: Number(adjusted[part][index] || 0)
      }))
      .sort((a, b) => {
        if (b.hc !== a.hc) return b.hc - a.hc;
        return a.index - b.index;
      });

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

    // delta < 0 = 오픈 고정 후 남은 시간
    if (deltaHours >= 0) return;

    const surplusHours = -deltaHours;

    // 현재 BP 배치에서 런치/디너가 차지하는 인시 계산
    const lunchHours = peakIndexes.lunch.reduce(
      (sum, index) => sum + Number(adjusted[part][index] || 0) * slotHours,
      0
    );

    const dinnerHours = peakIndexes.dinner.reduce(
      (sum, index) => sum + Number(adjusted[part][index] || 0) * slotHours,
      0
    );

    const peakTotalHours = lunchHours + dinnerHours;

    // 기존 BP의 런치 : 디너 비율
    // 둘 다 0인 예외 상황에서는 50:50
    const lunchRatio =
      peakTotalHours > 0 ? lunchHours / peakTotalHours : 0.5;

    // 0.25h 단위로 런치 배분량 결정
    const totalSteps = Math.round(surplusHours / addHoursPerStep);
    const lunchSteps = Math.round(totalSteps * lunchRatio);
    const dinnerSteps = totalSteps - lunchSteps;

    const lunchTargetHours = lunchSteps * addHoursPerStep;
    const dinnerTargetHours = dinnerSteps * addHoursPerStep;

    addHoursToPeak(
      part,
      peakIndexes.lunch,
      lunchTargetHours
    );

    addHoursToPeak(
      part,
      peakIndexes.dinner,
      dinnerTargetHours
    );
  });

  return adjusted;
}
function recoverOpenDeficit(adjusted, deltaHoursByPart, slots, slotHours) {
  const peakIndexes = getPeakSlotIndexes(slots);
  const removeHoursPerStep = 0.5 * slotHours; // 0.25h

  Object.keys(adjusted).forEach(part => {
    const deltaHours = Number(deltaHoursByPart[part] || 0);

    // delta > 0 = 오픈 고정으로 기존보다 시간을 더 사용함
    if (deltaHours <= 0) return;

    let remainingHours = deltaHours;

    // 런치 + 디너 피크 안에서만 회수
    // HC가 높은 슬롯부터 회수하여 피크의 모양을 최대한 유지
    const candidates = peakIndexes.all
      .map(index => ({
        index,
        hc: Number(adjusted[part][index] || 0)
      }))
      .filter(item => item.hc >= 0.5)
      .sort((a, b) => {
        if (b.hc !== a.hc) return b.hc - a.hc;
        return a.index - b.index;
      });

    while (remainingHours >= removeHoursPerStep - 1e-9) {
      let removedInThisRound = false;

      for (const candidate of candidates) {
        if (remainingHours < removeHoursPerStep - 1e-9) break;

        const currentHC = Number(adjusted[part][candidate.index] || 0);

        // 0 아래로 내려가지 않도록 보호
        if (currentHC < 0.5) continue;

        adjusted[part][candidate.index] = currentHC - 0.5;
        remainingHours -= removeHoursPerStep;
        removedInThisRound = true;
      }

      // 더 이상 피크에서 뺄 시간이 없으면 무한루프 방지
      if (!removedInThisRound) break;
    }
  });

  return adjusted;
}
// ============================================================
// REAL SHIFT LIBRARY V1 - FINAL
// 실제 매장에서 사용하는 현실 근무조
// start/end = 체류 시간대
// workHours = 휴게시간을 제외한 실제 인정 근로시간
// breakMinutes = 휴게시간(분)
// recommendedBreakStart/End = 표준시간표 기본 휴게 배치시간
// ============================================================
const REAL_SHIFT_LIBRARY = [
  {
    id: 'OPEN_HALF_1',
    name: '오픈하프①',
    start: '09:00',
    end: '15:30',
    workHours: 6,
    breakMinutes: 30,
    recommendedBreakStart: '11:00',
    recommendedBreakEnd: '11:30'
  },
  {
    id: 'OPEN_HALF_2',
    name: '오픈하프②',
    start: '10:00',
    end: '16:00',
    workHours: 6,
    breakMinutes: 30,
    recommendedBreakStart: '11:30',
    recommendedBreakEnd: '12:00'
  },
  {
    id: 'FULL_1',
    name: '풀타임①',
    start: '11:00',
    end: '20:00',
    workHours: 8,
    breakMinutes: 60,
    recommendedBreakStart: '15:00',
    recommendedBreakEnd: '16:00'
  },
  {
    id: 'FULL_2',
    name: '풀타임②',
    start: '12:00',
    end: '21:00',
    workHours: 8,
    breakMinutes: 60,
    recommendedBreakStart: '15:00',
    recommendedBreakEnd: '16:00'
  },
  {
    id: 'FULL_3',
    name: '풀타임③',
    start: '12:30',
    end: '21:30',
    workHours: 8,
    breakMinutes: 60,
    recommendedBreakStart: '15:00',
    recommendedBreakEnd: '16:00'
  },
  {
    id: 'FULL_4',
    name: '풀타임④',
    start: '13:00',
    end: '22:00',
    workHours: 8,
    breakMinutes: 60,
    recommendedBreakStart: '15:30',
    recommendedBreakEnd: '16:30'
  },
  {
    id: 'CLOSE_HALF_1',
    name: '마감하프①',
    start: '15:00',
    end: '21:30',
    workHours: 6,
    breakMinutes: 30,
    recommendedBreakStart: '17:00',
    recommendedBreakEnd: '17:30'
  },
  {
    id: 'CLOSE_HALF_2',
    name: '마감하프②',
    start: '15:30',
    end: '22:00',
    workHours: 6,
    breakMinutes: 30,
    recommendedBreakStart: '17:00',
    recommendedBreakEnd: '17:30'
  },
  {
    id: 'PEAK_SHORT_1',
    name: '피크초단기①',
    start: '11:00',
    end: '15:30',
    workHours: 4,
    breakMinutes: 30,
    recommendedBreakStart: '13:00',
    recommendedBreakEnd: '13:30'
  },
  {
    id: 'PEAK_SHORT_2',
    name: '피크초단기②',
    start: '10:00',
    end: '14:30',
    workHours: 4,
    breakMinutes: 30,
    recommendedBreakStart: '13:00',
    recommendedBreakEnd: '13:30'
  }
];
function shiftToHcArray(shift, slots) {
  const startMinute = timeToMinutes(shift.start);
  const endMinute = timeToMinutes(shift.end);

  const breakStartMinute =
    shift.recommendedBreakStart != null
      ? timeToMinutes(shift.recommendedBreakStart)
      : null;

  const breakEndMinute =
    shift.recommendedBreakEnd != null
      ? timeToMinutes(shift.recommendedBreakEnd)
      : null;

  return slots.map(time => {
    const minute = timeToMinutes(time);

    // 근무 시작 전 / 종료 후
    if (minute < startMinute || minute >= endMinute) {
      return 0;
    }

    // 추천 휴게시간
    if (
      breakStartMinute != null &&
      breakEndMinute != null &&
      minute >= breakStartMinute &&
      minute < breakEndMinute
    ) {
      return 0;
    }

    // 실제 근무 중
    return 1;
  });
}
function validateRealShiftLibrary(slots, slotHours) {
  REAL_SHIFT_LIBRARY.forEach(shift => {
    const hcArray = shiftToHcArray(shift, slots);

    const calculatedHours = hcArray.reduce(
      (sum, hc) => sum + Number(hc || 0) * slotHours,
      0
    );

    const expectedHours = Number(shift.workHours);
    const diff = calculatedHours - expectedHours;

    if (Math.abs(diff) > 1e-9) {
      console.warn(
        `[SHIFT 검증 실패] ${shift.name} | ` +
        `기준=${expectedHours.toFixed(1)}h | ` +
        `계산=${calculatedHours.toFixed(1)}h | ` +
        `차이=${diff.toFixed(1)}h`
      );
    }
  });
}
  function buildMaster(guestUnitPriceOverride) {
    if (!ACTIVE_TIMETABLE_CONFIG) throw new Error('정석 시간표 V2 DB 설정이 아직 로드되지 않았습니다.');

    const cfg = ACTIVE_TIMETABLE_CONFIG;
    const parts = getParts();
    const slots = getSlotLabels(cfg);
    const hcStep = Number(cfg.hcStep);
    const slotHours = Number(cfg.slotMinutes) / 60;
    const master = new Map();
    validateRealShiftLibrary(slots, slotHours);
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
  const beforeHours = hcByPart[part].reduce(
    (sum, hc) => sum + Number(hc || 0) * slotHours,
    0
  );

  const afterHours = openResult.adjusted[part].reduce(
    (sum, hc) => sum + Number(hc || 0) * slotHours,
    0
  );

  const diff = afterHours - beforeHours;

  if (Math.abs(diff) > 1e-9) {
    console.warn(
      `[OPEN RULE 총량 불일치] 매출=${sales}, 파트=${part}, ` +
      `적용전=${beforeHours.toFixed(2)}h, ` +
      `적용후=${afterHours.toFixed(2)}h, ` +
      `차이=${diff.toFixed(2)}h`
    );
  }
});
// 검증이 끝난 OPEN RULE 결과를 실제 표준시간표에 적용
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

  // 일간/주간 진단은 평일·주말 객단가가 이미 DB model_config에 있으므로
  // 동일한 V2 알고리즘을 쓰되 해당 일자의 객단가 기준으로 별도 master를 계산한다.
  function buildForDiagnosis(salesWon, guestUnitPrice) {
    return buildStandardTimetable(salesWon, guestUnitPrice);
  }

  async function ensureLoaded() {
  await Promise.all([
    ensureTimetableConfigLoaded(),
    window.AshleyActionStandard.ensureLoaded()
  ]);

  return { source:'supabase', version:ACTIVE_TIMETABLE_CONFIG.version };
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
