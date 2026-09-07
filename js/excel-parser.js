// Ashley Schedule Tool - Excel Parser
// Step 4 refactor: Excel workbook/sheet parsing separated from index.html.
// Converts uploaded Excel sheets into the structured inputs used by diagnosis logic.

async function loadScheduleWorkbook(file) {
  const buf = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const kitchenSheet = wb.getWorksheet('주방');
  const hallSheet = wb.getWorksheet('홀') || null;
  if (!kitchenSheet) throw new Error('"주방" 시트를 찾을 수 없습니다.');
  return { workbook: wb, kitchenSheet, hallSheet };
}

// ==================== 레이아웃/셀 헬퍼 ====================
function detectLayout(sheet) {
  for (let r = 1; r <= sheet.rowCount; r++) {
    for (let c = 1; c <= sheet.columnCount; c++) {
      if (sheet.getCell(r, c).value === '이름') {
        let dateCol = -1;
        for (let cc = c; cc <= sheet.columnCount; cc++) {
          if (sheet.getCell(r, cc).value instanceof Date) { dateCol = cc; break; }
        }
        if (dateCol > 0) return { headerRow: r, dataStartRow: r + 2, dateBlockStartCol: dateCol, nameCol: c };
      }
    }
  }
  throw new Error('"' + sheet.name + '" 시트에서 "이름" 헤더를 찾을 수 없습니다.');
}
function findRowWithText(sheet, text, fromRow) {
  for (let r = (fromRow || 1); r <= sheet.rowCount; r++) {
    for (let c = 1; c <= sheet.columnCount; c++) {
      if (sheet.getCell(r, c).value === text) return r;
    }
  }
  return -1;
}
function getCellFillHex(cell) {
  const fill = cell.fill;
  if (fill && fill.type === 'pattern' && fill.fgColor && fill.fgColor.argb) {
    return '#' + fill.fgColor.argb.slice(2).toUpperCase();
  }
  return null;
}

// 매장 자체 색상범례 자동탐지 (헤더행 바로 위 줄에서 파트명+배경색)
function detectColorLegend(sheet, layout) {
  const legendRow = layout.headerRow - 1;
  if (legendRow < 1) return null;
  const map = {};
  let found = 0;
  for (let c = 1; c <= sheet.columnCount; c++) {
    const cell = sheet.getCell(legendRow, c);
    const text = (cell.value || '').toString().trim();
    if (PARTS.indexOf(text) !== -1) {
      const hex = getCellFillHex(cell);
      if (hex && hex !== '#FFFFFF' && hex !== '#000000') { map[hex] = text; found++; }
    }
  }
  return found > 0 ? map : null;
}

// 매장휴무 등 공지가 있는 날짜는 진단에서 제외
function getExcludedDayLabels(sheet, layout, dateHeaders) {
  const noticeRow = layout.headerRow + 1;
  const excluded = new Set();
  for (let i = 0; i < DATE_BLOCK_COUNT; i++) {
    if (!dateHeaders[i]) continue;
    const startCol = layout.dateBlockStartCol + i * 2;
    const notice = sheet.getCell(noticeRow, startCol).value;
    const text = (notice || '').toString().replace(/\s/g, '');
    if (text.indexOf('매장휴무') !== -1) excluded.add(dateHeaders[i]);
  }
  return excluded;
}

// ==================== 시각/매출 파싱 ====================
function parseShiftTimes(startVal, endVal) {
  if (typeof startVal === 'number' && typeof endVal === 'number') return { startNum: startVal, endNum: endVal };
  if (typeof startVal === 'string' && startVal.indexOf('공휴일') !== -1 && typeof endVal === 'string') {
    const m = endVal.trim().match(/^(\d+(?:\.\d+)?)\s*~\s*(\d+(?:\.\d+)?)$/);
    if (m) return { startNum: parseFloat(m[1]), endNum: parseFloat(m[2]) };
  }
  return null;
}
function parseSalesNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return isNaN(n) || n === 0 ? null : n;
}
function isWeekendLabel(lbl) { return /[토일]\s*$/.test(lbl.trim()); }
function formatDateLabel(dateVal, dayName) {
  let s = dateVal instanceof Date ? (dateVal.getMonth() + 1) + '/' + dateVal.getDate() : String(dateVal);
  if (dayName) s += ' ' + dayName;
  return s;
}
function overlapMinutes(aS, aE, bS, bE) { return Math.max(0, Math.min(aE, bE) - Math.max(aS, bS)); }

// ==================== 기준모델(표준시간표) 파싱 ====================
function parseStandardModels(sheet) {
  let headerRow = -1;
  for (let r = 1; r <= sheet.rowCount; r++) {
    for (let c = 1; c <= sheet.columnCount; c++) {
      if (sheet.getCell(r, c).value === '구분') { headerRow = r; break; }
    }
    if (headerRow > 0) break;
  }
  if (headerRow === -1) throw new Error('"기준모델" 시트에서 "구분" 헤더를 찾을 수 없습니다.');

  const blockCols = [];
  for (let c = 1; c <= sheet.columnCount; c++) {
    if (sheet.getCell(headerRow, c).value === '구분') blockCols.push(c);
  }
  const timeRe = /\d{1,2}:\d{2}\s*~\s*\d{1,2}:\d{2}/;
  let timeStartRow = headerRow + 1, timeEndRow = timeStartRow;
  for (let r = timeStartRow; r <= sheet.rowCount; r++) {
    const v = sheet.getCell(r, blockCols[0]).value;
    if (v && timeRe.test(String(v))) timeEndRow = r; else break;
  }

  const models = [];
  blockCols.forEach(sc => {
    const partNames = [];
    for (let i = 1; i <= 10; i++) {
      let name = sheet.getCell(headerRow, sc + i).value;
      name = (name === '베이') ? '베이커리' : name;
      partNames.push(name);
    }
    let sales = 0;
    for (let rr = headerRow - 1; rr >= Math.max(1, headerRow - 3); rr--) {
      const n = parseSalesNumber(sheet.getCell(rr, sc).value);
      if (n) { sales = n; break; }
    }
    const table = {};
    for (let r = timeStartRow; r <= timeEndRow; r++) {
      const slotIdx = r - timeStartRow;
      table[slotIdx] = {};
      partNames.forEach((name, i) => {
        if (ALL_MODEL_PARTS.indexOf(name) === -1) return;
        const v = sheet.getCell(r, sc + 1 + i).value;
        table[slotIdx][name] = typeof v === 'number' ? v : 0;
      });
    }
    models.push({ sales, table });
  });
  return models;
}

// ==================== 근무시간/매출 요약행 ====================
function getSummaryRowValues(sheet, layout, rowIdx) {
  const result = {};
  for (let i = 0; i < DATE_BLOCK_COUNT; i++) {
    const startCol = layout.dateBlockStartCol + i * 2;
    const dateVal = sheet.getCell(layout.headerRow, startCol).value;
    const dayName = sheet.getCell(layout.headerRow, startCol + 1).value;
    const label = formatDateLabel(dateVal, dayName);
    const v = sheet.getCell(rowIdx, startCol).value;
    result[label] = v;
  }
  return result;
}

function computeSheetDailyTotalHours(sheet, layout) {
  const workHoursRow = findRowWithText(sheet, '근무시간', layout.dataStartRow);
  if (workHoursRow === -1) return {};
  const raw = getSummaryRowValues(sheet, layout, workHoursRow);
  const result = {};
  Object.keys(raw).forEach(label => {
    result[label] = parseSalesNumber(raw[label]) || 0;
  });
  return result;
}

function getSalesInputs(sheet, layout) {
  const salesRow = findRowWithText(sheet, '예상 총매출', layout.dataStartRow);
  if (salesRow === -1) return {};
  const raw = getSummaryRowValues(sheet, layout, salesRow);
  const result = {};
  Object.keys(raw).forEach(label => { result[label] = parseSalesNumber(raw[label]) || 0; });
  return result;
}

// ==================== 실배치(주방) ====================
function computeActualCounts(sheet) {
  const layout = detectLayout(sheet);
  const empEndRow = findRowWithText(sheet, '근무인원', layout.dataStartRow);
  if (empEndRow === -1) throw new Error('"근무인원" 요약행을 찾을 수 없습니다.');
  const numRows = empEndRow - layout.dataStartRow;
  const colorMapRaw = detectColorLegend(sheet, layout);
  const colorMap = Object.assign({}, COLOR_TO_PART_DEFAULT, colorMapRaw || {});

  const dateHeaders = [];
  const actualCounts = {};
  const actualNames = {};
  const slots = getTimeSlots();

  for (let i = 0; i < DATE_BLOCK_COUNT; i++) {
    const startCol = layout.dateBlockStartCol + i * 2;
    const endCol = startCol + 1;
    const dateVal = sheet.getCell(layout.headerRow, startCol).value;
    const dayName = sheet.getCell(layout.headerRow, endCol).value;
    const label = formatDateLabel(dateVal, dayName);
    dateHeaders.push(label);

    actualCounts[label] = {};
    actualNames[label] = {};
    slots.forEach(s => {
      actualCounts[label][s] = {};
      actualNames[label][s] = {};
      PARTS.forEach(p => { actualCounts[label][s][p] = 0; actualNames[label][s][p] = []; });
    });

    for (let r = 0; r < numRows; r++) {
      const rowIdx = layout.dataStartRow + r;
      const empName = (sheet.getCell(rowIdx, layout.nameCol).value || '').toString().trim() || '(이름없음)';
      const sCell = sheet.getCell(rowIdx, startCol), eCell = sheet.getCell(rowIdx, endCol);
      const times = parseShiftTimes(sCell.value, eCell.value);
      if (!times) continue;

      const sMin = times.startNum * 60, eMin = times.endNum * 60;
      const startHex = getCellFillHex(sCell), endHex = getCellFillHex(eCell);
      const startPart = startHex ? colorMap[startHex] : null;
      const endPart = endHex ? colorMap[endHex] : null;

      let segs = [];
      if (startPart && endPart && startPart !== endPart) {
        const mid = (sMin + eMin) / 2;
        segs.push({ s: sMin, e: mid, part: startPart }, { s: mid, e: eMin, part: endPart });
      } else if (startPart || endPart) {
        segs.push({ s: sMin, e: eMin, part: startPart || endPart });
      } else if (r >= numRows / 2) {
        // 둘다 무색인데 명단 아래쪽 절반이면 DMO로 간주
        segs.push({ s: sMin, e: eMin, part: 'DMO' });
      }

      segs.forEach(seg => {
        slots.forEach(s => {
          if (s >= seg.s && s < seg.e) {
            actualCounts[label][s][seg.part] = (actualCounts[label][s][seg.part] || 0) + 1;
            if (actualNames[label][s][seg.part].indexOf(empName) === -1) actualNames[label][s][seg.part].push(empName);
          }
        });
      });
    }
  }
  return { actualCounts, actualNames, dateHeaders, layout };
}

// ==================== 실배치(홀, 파트구분 없음) ====================
function computeHallActualCounts(sheet) {
  if (!sheet) return {};
  const layout = detectLayout(sheet);
  const empEndRow = findRowWithText(sheet, '근무인원', layout.dataStartRow);
  const numRows = Math.max(0, (empEndRow === -1 ? layout.dataStartRow - 1 : empEndRow) - layout.dataStartRow);
  if (numRows < 1) return {};

  const slots = getTimeSlots();
  const result = {};
  for (let i = 0; i < DATE_BLOCK_COUNT; i++) {
    const startCol = layout.dateBlockStartCol + i * 2;
    const endCol = startCol + 1;
    const dateVal = sheet.getCell(layout.headerRow, startCol).value;
    const dayName = sheet.getCell(layout.headerRow, endCol).value;
    const label = formatDateLabel(dateVal, dayName);
    result[label] = {};
    slots.forEach(s => { result[label][s] = 0; });

    for (let r = 0; r < numRows; r++) {
      const rowIdx = layout.dataStartRow + r;
      const sVal = sheet.getCell(rowIdx, startCol).value, eVal = sheet.getCell(rowIdx, endCol).value;
      const times = parseShiftTimes(sVal, eVal);
      if (!times) continue;
      const sMin = times.startNum * 60, eMin = times.endNum * 60;
      slots.forEach(s => { if (s >= sMin && s < eMin) result[label][s] += 1; });
    }
  }
  return result;
}

