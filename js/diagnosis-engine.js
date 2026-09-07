// Ashley Schedule Tool - Diagnosis Calculation Engine
// Step 3 refactor: calculation rules separated from index.html.
// Keep UI/Excel parsing in index.html for now.

const ALL_MODEL_PARTS = ['스시','콜드','베이커리','핫','그릴','피파','DMO','데코이','폴리싱','홀'];

const GUEST_UNIT_PRICE_WEEKDAY = 21138;
const GUEST_UNIT_PRICE_WEEKEND = 24889;

const CURVE = {
  FLOOR: 90, KNOT: 1200, SLOPE: 0.164532,
  TIERS: {
    '최소허들': { a: 47.6487, b: 0.5936, c: 0.8431 },
    '1차목표': { a: 61.9593, b: 0.1823, c: 0.9948 },
    '2차목표': { a: 60.09, b: 0.1403, c: 1.023 },
  },
};

const NO_EXTRAPOLATE_PARTS = ['DMO', '데코이', '폴리싱', '홀'];

// 파트별 CAP 규칙
const PART_CAP_RULES = {
  'DMO':   [{ maxSales: 20000000, cap: 1 }],
  '데코이': [{ maxSales: 20000000, cap: 1 }],
  '폴리싱': [{ maxSales: 20000000, cap: 1 }],
};

function getPartCap(part, salesVal) {
  const rules = PART_CAP_RULES[part];
  if (!rules) return null;
  for (const r of rules) {
    if (salesVal <= r.maxSales) return r.cap;
  }
  return null;
}

// V1.0 curve
function tierHoursDaily(p, n, curveConfig = CURVE) {
  const base1200 = p.a + p.b * Math.pow(curveConfig.KNOT, p.c);
  if (n <= curveConfig.KNOT) return Math.max(curveConfig.FLOOR, p.a + p.b * Math.pow(n, p.c));
  return base1200 + curveConfig.SLOPE * (n - curveConfig.KNOT);
}

function normalizeModelTable(model) {
  let total = 0;
  Object.keys(model.table).forEach(slot => {
    ALL_MODEL_PARTS.forEach(p => { total += (model.table[slot][p] || 0); });
  });
  const normTable = {};
  Object.keys(model.table).forEach(slot => {
    normTable[slot] = {};
    ALL_MODEL_PARTS.forEach(p => { normTable[slot][p] = total > 0 ? (model.table[slot][p] || 0) / total : 0; });
  });
  return { sales: model.sales, table: normTable };
}
function scaleShapeTable(shapeTable, scaleFactor) {
  const scaled = {};
  Object.keys(shapeTable).forEach(slot => {
    scaled[slot] = {};
    Object.keys(shapeTable[slot]).forEach(p => { scaled[slot][p] = shapeTable[slot][p] * scaleFactor; });
  });
  return scaled;
}

function interpolateStandard(models, targetSales) {
  const sorted = models.slice().sort((a, b) => a.sales - b.sales);
  const slotCount = Object.keys(sorted[0].table).length;
  let lower, upper, ratio, isOutOfRange = false;

  if (sorted.length === 1) { lower = upper = sorted[0]; ratio = 0; }
  else if (targetSales < sorted[0].sales) {
    lower = sorted[0]; upper = sorted[1];
    ratio = (targetSales - lower.sales) / (upper.sales - lower.sales);
    isOutOfRange = true;
  } else if (targetSales > sorted[sorted.length - 1].sales) {
    lower = sorted[sorted.length - 2]; upper = sorted[sorted.length - 1];
    ratio = (targetSales - lower.sales) / (upper.sales - lower.sales);
    isOutOfRange = true;
  } else {
    lower = sorted[0]; upper = sorted[sorted.length - 1];
    for (let i = 0; i < sorted.length - 1; i++) {
      if (targetSales >= sorted[i].sales && targetSales <= sorted[i + 1].sales) { lower = sorted[i]; upper = sorted[i + 1]; break; }
    }
    ratio = (upper.sales === lower.sales) ? 0 : (targetSales - lower.sales) / (upper.sales - lower.sales);
  }

  const clampedRatio = ratio < 0 ? 0 : 1;
  const result = {};
  for (let si = 0; si < slotCount; si++) {
    result[si] = {};
    ALL_MODEL_PARTS.forEach(p => {
      const lv = (lower.table[si] && lower.table[si][p]) || 0;
      const uv = (upper.table[si] && upper.table[si][p]) || 0;
      const useRatio = (isOutOfRange && NO_EXTRAPOLATE_PARTS.indexOf(p) !== -1) ? clampedRatio : ratio;
      const v = lv + (uv - lv) * useRatio;
      result[si][p] = Math.max(0, v);
    });
  }
  return result;
}

function truncateHeadcount(v) {
  if (v <= 0) return 0;
  if (v < 1) return 1;
  return Math.floor(v);
}

// ==================== 슬롯 단위 총인원 보존 정수화 (Largest Remainder Method) ====================
// rawValues: { part: rawNumber, ... } - 같은 30분 슬롯 안의 여러 파트 raw값
// capFn: (part) => capNumber|null - 해당 파트의 상한(없으면 null)
// 반환: { part: 정수, ... } - 총합이 round(rawValues 합)과 최대한 같아지도록 largest remainder로 배분
function allocateSlotHeadcounts(rawValues, capFn) {
  const parts = Object.keys(rawValues);
  const rawTotal = parts.reduce((s, p) => s + (rawValues[p] || 0), 0);
  const targetTotal = Math.max(0, Math.round(rawTotal + 1e-9)); // 부동소수점 오차(예: 1.7+1.4+0.8+0.6=4.499999999999999) 보정

  const cap = {};
  parts.forEach(p => { cap[p] = capFn ? capFn(p) : null; });

  // 1) CAP 적용 (원본과 cap 중 작은 값)
  const capped = {};
  parts.forEach(p => {
    const raw = rawValues[p] || 0;
    capped[p] = (cap[p] !== null && cap[p] !== undefined && raw > cap[p]) ? cap[p] : raw;
  });

  // 2) 우선 floor
  const result = {};
  parts.forEach(p => { result[p] = Math.floor(capped[p]); });
  let floorSum = parts.reduce((s, p) => s + result[p], 0);
  let remaining = targetTotal - floorSum;

  // 3) 남는 인원을 remainder 큰 순으로, cap에 걸리지 않은(여유 있는) 파트에 +1씩 배분
  //    (한 바퀴에 최대 1명씩만 주고, remaining이 남으면 다음 바퀴 반복 - cap에 안 걸린 파트가 있는 한 총인원 보존)
  let guard = 0;
  while (remaining > 0 && guard < 50) {
    guard++;
    const candidates = parts
      .filter(p => (cap[p] === null || cap[p] === undefined) || result[p] < cap[p])
      .map(p => ({ part: p, remainder: capped[p] - Math.floor(capped[p]) }))
      .sort((a, b) => b.remainder - a.remainder);
    if (!candidates.length) break; // 전부 cap 도달 -> 더 이상 배분 불가(총인원 부득이 감소)
    const give = Math.min(remaining, candidates.length);
    for (let i = 0; i < give; i++) { result[candidates[i].part] += 1; }
    remaining -= give;
  }

  return result;
}



