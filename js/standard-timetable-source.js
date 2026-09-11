// Ashley Schedule Tool - Standard Timetable V2 candidate
// Purpose: build a sales-band standard timetable from the 16 raw 30-minute BP models.
// This does NOT change diagnosis calculations. It is used only by the "정석 시간표" view.

(function (global) {
  const PARTS = ['스시','콜드','베이커리','핫','그릴','피파','DMO','홀'];
  const SLOT_LABELS = [
    '08:30','09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30',
    '13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00',
    '17:30','18:00','18:30','19:00','19:30','20:00','20:30','21:00','21:30'
  ];
  const HALF_HOUR = 0.5;
  const MIXED_GUEST_UNIT_PRICE = 22400;

  function sortedModelSlots(model) {
    return Object.keys((model && model.table) || {})
      .sort((a, b) => Number(a) - Number(b));
  }

  function normalizeModelByPart(model) {
    const slotKeys = sortedModelSlots(model);
    if (slotKeys.length !== 27) {
      throw new Error('30분 BP 모델 슬롯 수가 27개가 아닙니다: ' + (model && model.title ? model.title : '알 수 없음'));
    }

    const allocation = {};
    PARTS.forEach(part => {
      const values = slotKeys.map(key => Number(((model.table || {})[key] || {})[part] || 0));
      const total = values.reduce((sum, value) => sum + value, 0);
      allocation[part] = total > 0 ? values.map(value => value / total) : values.map(() => 0);
    });

    return {
      title: model.title,
      sales: Number(model.sales),
      allocation,
    };
  }

  function getNormalizedAnchors() {
    if (typeof getStandardModels !== 'function') {
      throw new Error('30분 BP 모델 로더를 찾을 수 없습니다.');
    }
    return getStandardModels()
      .map(normalizeModelByPart)
      .sort((a, b) => a.sales - b.sales);
  }

  function interpolateAllocation(salesWon) {
    const anchors = getNormalizedAnchors();
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
    PARTS.forEach(part => {
      const a = lower.allocation[part];
      const b = upper.allocation[part];
      byPart[part] = a.map((value, index) => value + (b[index] - value) * weight);
      const sum = byPart[part].reduce((s, v) => s + v, 0);
      if (sum > 0) byPart[part] = byPart[part].map(v => v / sum);
    });

    return { byPart, lower, upper, weight, method };
  }

  // Convert raw headcounts to operational 0.5-person units while preserving each part's
  // daily headcount-sum as closely as possible (largest-remainder method).
  function balanceToHalf(rawValues) {
    const safe = rawValues.map(v => Math.max(0, Number(v) || 0));
    const exactHalfUnits = safe.map(v => v * 2);
    const baseUnits = exactHalfUnits.map(v => Math.floor(v + 1e-10));
    const targetUnits = Math.round(exactHalfUnits.reduce((s, v) => s + v, 0));
    let remaining = Math.max(0, targetUnits - baseUnits.reduce((s, v) => s + v, 0));

    const order = exactHalfUnits
      .map((v, index) => ({ index, remainder: v - Math.floor(v + 1e-10), raw: safe[index] }))
      .sort((a, b) => (b.remainder - a.remainder) || (b.raw - a.raw) || (a.index - b.index));

    for (let i = 0; i < order.length && remaining > 0; i += 1) {
      baseUnits[order[i].index] += 1;
      remaining -= 1;
    }

    return baseUnits.map(units => units / 2);
  }

  function buildStandardTimetable(salesWon) {
    if (typeof getPartAllocationRatios !== 'function') {
      throw new Error('Part Allocation V1.0 로더를 찾을 수 없습니다.');
    }
    if (typeof getActiveDiagnosisConfig !== 'function' || typeof tierHoursDaily !== 'function') {
      throw new Error('표준인시 V1.0 계산기준을 찾을 수 없습니다.');
    }

    const sales = Math.max(1_000_000, Math.min(40_000_000, Math.round((Number(salesWon) || 0) / 1_000_000) * 1_000_000));
    const config = getActiveDiagnosisConfig();
    const guestCount = sales / MIXED_GUEST_UNIT_PRICE;
    const target2 = tierHoursDaily(config.CURVE.TIERS['2차목표'], guestCount, config.CURVE);
    const partRatios = getPartAllocationRatios(sales);
    const allocation = interpolateAllocation(sales);

    const rawByPart = {};
    const hcByPart = {};
    const partHours = {};
    const roundedPartHours = {};

    PARTS.forEach(part => {
      partHours[part] = target2 * Number(partRatios[part] || 0);
      rawByPart[part] = allocation.byPart[part].map(ratio => partHours[part] * ratio / HALF_HOUR);
      hcByPart[part] = balanceToHalf(rawByPart[part]);
      roundedPartHours[part] = hcByPart[part].reduce((sum, hc) => sum + hc * HALF_HOUR, 0);
    });

    const slotTotals = SLOT_LABELS.map((_, i) => PARTS.reduce((sum, part) => sum + hcByPart[part][i], 0));
    const roundedTotalHours = slotTotals.reduce((sum, hc) => sum + hc * HALF_HOUR, 0);

    return {
      sales,
      guestCount,
      guestUnitPrice: MIXED_GUEST_UNIT_PRICE,
      target2,
      roundedTotalHours,
      totalHourDiff: roundedTotalHours - target2,
      parts: PARTS.slice(),
      slots: SLOT_LABELS.slice(),
      partRatios,
      partHours,
      roundedPartHours,
      rawByPart,
      hcByPart,
      slotTotals,
      source: {
        method: allocation.method,
        lowerSales: allocation.lower.sales,
        lowerTitle: allocation.lower.title,
        upperSales: allocation.upper.sales,
        upperTitle: allocation.upper.title,
        weight: allocation.weight,
      },
    };
  }

  global.AshleyStandardTimetable = {
    PARTS,
    SLOT_LABELS,
    MIXED_GUEST_UNIT_PRICE,
    build: buildStandardTimetable,
  };
})(window);
