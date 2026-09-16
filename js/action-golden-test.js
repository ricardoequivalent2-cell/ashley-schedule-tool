// Golden Test fixture derived from Ashley FINAL workbook 04_매출별_예시.
// Production calculation does NOT use these values. They are verification-only expected outputs.
const FINAL_ACTION_GOLDEN_CASES = [
  { salesWon:5000000, expected:{guests:221.23893805309734,weeklyGuests:1549,bakeryRatio:0.06507936507936507,bakeryAppliedDay:2.46547619,sushiTotal:2.441012790082163,v1Minimum:103.9406998556987,bakeryMinimum:4.298918562513723,actionMinimum:97.20076850310281,v1Target1:101.17454690206935,bakeryTarget1:4.118899084579116,actionTarget1:94.61463502740807,v1Guideline:95.2339888294452,bakeryGuideline:3.732291336995639,actionGuideline:89.06068470236738}},
  { salesWon:10000000, expected:{guests:442.4778761061947,weeklyGuests:3097,bakeryRatio:0.06281588447653429,bakeryAppliedDay:4.479357142857142,sushiTotal:3.9214700245954375,v1Minimum:148.63095562254063,bakeryMinimum:4.857027795165263,actionMinimum:139.85245780277992,v1Target1:140.1076105021113,bakeryTarget1:4.321626332726743,actionTarget1:131.86451414478913,v1Guideline:131.50751551060688,bakeryGuideline:3.7814037592531795,actionGuideline:123.80464172675826}},
  { salesWon:20000000, expected:{guests:884.9557522123894,weeklyGuests:6195,bakeryRatio:0.05918481295365718,bakeryAppliedDay:8.524785714285715,sushiTotal:6.910162271399763,v1Minimum:228.80083488162836,bakeryMinimum:5.0167489018240605,actionMinimum:216.87392370840453,v1Target1:217.69358492202434,bakeryTarget1:4.35936839053538,actionTarget1:206.42405426008918,v1Guideline:205.22041039423448,bakeryGuideline:3.6211458891698154,actionGuideline:194.6891022336649}},
  { salesWon:30000000, expected:{guests:1327.4336283185842,weeklyGuests:9292,bakeryRatio:0.05638926784902228,bakeryAppliedDay:12.426166667142857,sushiTotal:9.884965629315202,v1Minimum:302.79653527066466,bakeryMinimum:4.648308263990577,actionMinimum:288.26326137735884,v1Target1:293.76770151793676,bakeryTarget1:4.13917893914371,actionTarget1:279.7435569494778,v1Guideline:279.2369845351326,bakeryGuideline:3.3198024471620275,actionGuideline:266.03221645865534}},
  { salesWon:40000000, expected:{guests:1769.9115044247787,weeklyGuests:12389,bakeryRatio:0.054831288343558285,bakeryAppliedDay:16.581714285714288,sushiTotal:12.85976898723064,v1Minimum:375.5981503149124,bakeryMinimum:4.012816195509821,actionMinimum:358.72556513217194,v1Target1:366.5693165621845,bakeryTarget1:3.517753608607947,actionTarget1:350.19179396634587,v1Guideline:352.0385995793804,bakeryGuideline:2.721015675885173,actionGuideline:336.45781491626457}}
];

function finalActionActualFields(r) {
  return {
    guests:r.guests, weeklyGuests:r.weeklyGuests,
    bakeryRatio:Number(r.partAllocation['베이커리']) || 0,
    bakeryAppliedDay:r.bakery.appliedHoursDay,
    sushiTotal:r.sushi.total,
    v1Minimum:r.v1.minimum, bakeryMinimum:r.bakerySaving.minimum, actionMinimum:r.action.minimum,
    v1Target1:r.v1.target1, bakeryTarget1:r.bakerySaving.target1, actionTarget1:r.action.target1,
    v1Guideline:r.v1.guideline, bakeryGuideline:r.bakerySaving.guideline, actionGuideline:r.action.guideline
  };
}

async function runFinalActionGoldenTests(tolerance = 1e-6) {
  const results = [];
  for (const tc of FINAL_ACTION_GOLDEN_CASES) {
    const r = await calculateFinalActionStandardReady(tc.salesWon);
    const actual = finalActionActualFields(r);
    const diffs = {};
    let pass = true;
    for (const [key, expected] of Object.entries(tc.expected)) {
      const a = Number(actual[key]);
      const e = Number(expected);
      const diff = Math.abs(a - e);
      diffs[key] = diff;
      if (!Number.isFinite(a) || diff > tolerance) pass = false;
    }
    results.push({ salesWon:tc.salesWon, pass, actual, expected:tc.expected, diffs });
  }
  return { pass: results.every(r => r.pass), tolerance, results };
}
