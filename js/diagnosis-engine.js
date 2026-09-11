// Ashley Schedule Tool - Diagnosis Calculation Engine
// Calculation engine only. Numeric V1 standards are loaded from Supabase via config-source.js.

const ALL_MODEL_PARTS = ['스시','콜드','베이커리','핫','그릴','피파','DMO','데코이','폴리싱','홀'];


const NO_EXTRAPOLATE_PARTS = ['DMO', '데코이', '폴리싱', '홀'];


// V1.0 curve
// 숫자 기준은 코드에 두지 않고 Supabase에서 전달받은 curveConfig만 사용한다.
function tierHoursDaily(p, n, curveConfig) {
  if (!p || !curveConfig) {
    throw new Error('표준인시 계산기준이 없습니다. Supabase model_config 로드를 확인해주세요.');
  }
  const base1200 = p.a + p.b * Math.pow(curveConfig.KNOT, p.c);
  if (n <= curveConfig.KNOT) return Math.max(curveConfig.FLOOR, p.a + p.b * Math.pow(n, p.c));
  return base1200 + curveConfig.SLOPE * (n - curveConfig.KNOT);
}

// ==================== 슬롯 단위 총인원 보존 정수화 (Largest Remainder Method) ====================
// rawValues: { part: rawNumber, ... } - 같은 30분 슬롯 안의 여러 파트 raw값
// capFn: (part) => capNumber|null - 해당 파트의 상한(없으면 null)
// 반환: { part: 정수, ... } - 총합이 round(rawValues 합)과 최대한 같아지도록 largest remainder로 배분


