// Ashley Schedule Tool - UP Parser (Step UP-1)
// 정식 입력 포맷: Schedule_PartInfo_*.up
// 역할: UP 파일 검증 → #파트정보_업로드 시트 확인 → 헤더 검증 → 행 데이터 파싱
// 주의: 이 단계에서는 30분 단위 인력표/진단 계산을 만들지 않습니다.
//
// 전제: index.html에서 ExcelJS가 먼저 로드되어 있어야 합니다.
// 예) <script src="https://cdn.jsdelivr.net/npm/exceljs/dist/exceljs.min.js"></script>

(function (global) {
  'use strict';

  const UP_SHEET_NAME = '#파트정보_업로드';

  const UP_REQUIRED_HEADERS = [
    '매장명',
    '일자',
    '예상매출',
    '아이디',
    '이름',
    '근무구분',
    '오전파트',
    '오후파트',
    '출근',
    '퇴근',
    '근무시간'
  ];

  // 기존 진단엔진이 사용하는 파트명.
  // UP-3에서는 이름이 명확히 일치하는 값만 자동 매핑한다.
  // '파트1', '파트4', '라이브'처럼 의미가 확정되지 않은 값은 임의 변환하지 않는다.
  const DIAGNOSIS_PARTS = [
    '스시', '콜드', '베이커리', '핫', '그릴', '피파',
    'DMO', '데코이', '폴리싱', '홀'
  ];

  const PART_ALIASES = {
    '스시': '스시',
    '콜드': '콜드',
    '베이커리': '베이커리',
    '핫': '핫',
    '그릴': '그릴',
    '피파': '피파',
    '피/파': '피파',
    '피자파스타': '피파',
    '피자/파스타': '피파',
    'DMO': 'DMO',
    'dmo': 'DMO',
    '데코이': '데코이',
    '폴리싱': '폴리싱',
    '홀': '홀',
    '관리': '홀'
  };

  /** 
   * .up 파일을 읽어 정규화된 데이터로 반환합니다.
   *
   * 반환 예:
   * {
   *   sourceType: 'up',
   *   fileName: 'Schedule_PartInfo_2026-09-08.up',
   *   sheetName: '#파트정보_업로드',
   *   storeName: '...',
   *   rowCount: 335,
   *   dates: [{ key, label, date, sales }],
   *   salesByDate: { '2026-09-08': 6523616, ... },
   *   rows: [...]
   * }
   */
  async function parseUpFile(file) {
    validateFile(file);

    if (typeof ExcelJS === 'undefined') {
      throw new Error('ExcelJS가 로드되지 않았습니다. index.html의 ExcelJS script를 확인해주세요.');
    }

    const buffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();

    try {
      await workbook.xlsx.load(buffer);
    } catch (error) {
      throw new Error(
        'UP 파일을 읽을 수 없습니다. 파트정보 추출 UP 파일인지 확인해주세요.'
      );
    }

    return parseUpWorkbook(workbook, file.name);
  }

  function validateFile(file) {
    if (!file) {
      throw new Error('UP 파일을 선택해주세요.');
    }

    const fileName = String(file.name || '');
    const ext = fileName.split('.').pop().toLowerCase();

    if (ext !== 'up') {
      throw new Error('지원하지 않는 파일 형식입니다. .up 파일을 업로드해주세요.');
    }
  }

  function parseUpWorkbook(workbook, fileName) {
    const sheet = workbook.getWorksheet(UP_SHEET_NAME);

    if (!sheet) {
      throw new Error(
        `"${UP_SHEET_NAME}" 시트를 찾을 수 없습니다. 파트정보 UP 파일인지 확인해주세요.`
      );
    }

    const headerMap = buildHeaderMap(sheet);
    const missingHeaders = UP_REQUIRED_HEADERS.filter(
      header => !headerMap[header]
    );

    if (missingHeaders.length > 0) {
      throw new Error(
        '지원하지 않는 UP 파일 형식입니다. 필수 항목이 없습니다: ' +
        missingHeaders.join(', ')
      );
    }

    const rows = [];
    const dateMap = new Map();
    let storeName = '';

    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const getValue = header =>
        unwrapCellValue(sheet.getCell(rowNumber, headerMap[header]).value);

      const rawDate = getValue('일자');
      const employeeId = cleanText(getValue('아이디'));
      const employeeName = cleanText(getValue('이름'));

      // 완전히 빈 행은 제외
      if (isBlank(rawDate) && !employeeId && !employeeName) {
        continue;
      }

      const dateInfo = normalizeDate(rawDate);

      // 날짜가 없는 설명/빈 행은 진단 데이터에서 제외
      if (!dateInfo) {
        continue;
      }

      const rowStoreName = cleanText(getValue('매장명'));
      if (!storeName && rowStoreName) {
        storeName = rowStoreName;
      }

      const sales = parseNumber(getValue('예상매출'));
      const startMinutes = parseTimeToMinutes(getValue('출근'));
      const endMinutes = parseTimeToMinutes(getValue('퇴근'));
      const workHours = parseWorkHours(getValue('근무시간'));

      const parsedRow = {
        rowNumber,
        storeName: rowStoreName,
        dateKey: dateInfo.key,
        dateLabel: dateInfo.label,
        date: dateInfo.date,

        sales: sales ?? 0,

        employeeId,
        name: employeeName || '(이름없음)',
        workType: cleanText(getValue('근무구분')),

        morningPart: cleanText(getValue('오전파트')),
        afternoonPart: cleanText(getValue('오후파트')),

        startMinutes,
        endMinutes,
        startTime: minutesToTimeText(startMinutes),
        endTime: minutesToTimeText(endMinutes),
        workHours
      };

      rows.push(parsedRow);

      // 같은 날짜가 여러 근무자 행에 반복되므로 날짜별 매출은 1개로 묶음
      if (!dateMap.has(dateInfo.key)) {
        dateMap.set(dateInfo.key, {
          key: dateInfo.key,
          label: dateInfo.label,
          date: dateInfo.date,
          sales: sales ?? 0
        });
      } else if (!dateMap.get(dateInfo.key).sales && sales) {
        dateMap.get(dateInfo.key).sales = sales;
      }
    }

    if (rows.length === 0) {
      throw new Error('UP 파일에서 근무 데이터를 찾을 수 없습니다.');
    }

    const dates = Array.from(dateMap.values()).sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );

    const salesByDate = {};
    dates.forEach(item => {
      salesByDate[item.key] = item.sales;
    });

    return {
      sourceType: 'up',
      fileName,
      sheetName: UP_SHEET_NAME,
      storeName,
      rowCount: rows.length,
      dates,
      salesByDate,
      rows
    };
  }

  function buildHeaderMap(sheet) {
    const headerMap = {};

    for (let col = 1; col <= sheet.columnCount; col++) {
      const header = cleanText(unwrapCellValue(sheet.getCell(1, col).value));
      if (header) {
        headerMap[header] = col;
      }
    }

    return headerMap;
  }

  // ExcelJS의 formula/richText 객체도 가능한 한 실제 표시값으로 풀어냄
  function unwrapCellValue(value) {
    if (value === null || value === undefined) return value;

    if (typeof value === 'object' && !(value instanceof Date)) {
      if (Object.prototype.hasOwnProperty.call(value, 'result')) {
        return value.result;
      }

      if (Array.isArray(value.richText)) {
        return value.richText.map(item => item.text || '').join('');
      }

      if (Object.prototype.hasOwnProperty.call(value, 'text')) {
        return value.text;
      }
    }

    return value;
  }

  function cleanText(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === '';
  }

  function parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    const cleaned = String(value).replace(/,/g, '').replace(/[^0-9.-]/g, '');
    const number = Number(cleaned);

    return Number.isFinite(number) ? number : null;
  }

  function parseWorkHours(value) {
    if (value === null || value === undefined || value === '') return 0;

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    const match = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return 0;

    const number = Number(match[0]);
    return Number.isFinite(number) ? number : 0;
  }

  function normalizeDate(value) {
    let date = null;

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      date = new Date(
        value.getFullYear(),
        value.getMonth(),
        value.getDate()
      );
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      // Excel serial date
      const excelEpoch = new Date(1899, 11, 30);
      const converted = new Date(
        excelEpoch.getTime() + Math.round(value * 86400000)
      );
      date = new Date(
        converted.getFullYear(),
        converted.getMonth(),
        converted.getDate()
      );
    } else {
      const text = cleanText(value);
      if (!text) return null;

      // YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD
      const ymd = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
      if (ymd) {
        date = new Date(
          Number(ymd[1]),
          Number(ymd[2]) - 1,
          Number(ymd[3])
        );
      } else {
        const parsed = new Date(text);
        if (!Number.isNaN(parsed.getTime())) {
          date = new Date(
            parsed.getFullYear(),
            parsed.getMonth(),
            parsed.getDate()
          );
        }
      }
    }

    if (!date || Number.isNaN(date.getTime())) return null;

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

    return {
      date,
      key: `${yyyy}-${mm}-${dd}`,
      label: `${date.getMonth() + 1}/${date.getDate()} ${dayNames[date.getDay()]}`
    };
  }

  function parseTimeToMinutes(value) {
    if (value === null || value === undefined || value === '') return null;

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.getHours() * 60 + value.getMinutes();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      // Excel 시간은 보통 0~1 사이의 하루 비율
      if (value >= 0 && value < 1) {
        return Math.round(value * 24 * 60);
      }

      // 혹시 9, 18.5 형태로 들어온 경우
      if (value >= 0 && value <= 24) {
        return Math.round(value * 60);
      }

      return null;
    }

    const text = cleanText(value);

    // 09:00 / 9:00 / 09:00:00
    const colonMatch = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (colonMatch) {
      const hour = Number(colonMatch[1]);
      const minute = Number(colonMatch[2]);

      if (hour >= 0 && hour <= 24 && minute >= 0 && minute < 60) {
        return hour * 60 + minute;
      }
    }

    // 9 / 18.5
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 24) {
      return Math.round(numeric * 60);
    }

    return null;
  }

  function minutesToTimeText(minutes) {
    if (minutes === null || minutes === undefined) return '';

    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;

    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }


  /**
   * Step UP-3
   * 파싱된 UP 행을 30분 단위 실제 배치 데이터로 변환한다.
   *
   * 중요:
   * 1) 오전파트=오후파트 또는 한쪽만 있는 경우에만 파트 전체 근무시간 적용
   * 2) 오전/오후 파트가 서로 다르면 전환시각이 UP에 없으므로 임의로 반분하지 않음
   * 3) 알 수 없는 파트명은 미매핑 목록으로 남김
   * 4) 근무구분만 '주방'이고 세부파트가 비어 있는 경우도 파트진단에서 제외
   */
  function buildThirtyMinuteActuals(parsedUp, options = {}) {
    if (!parsedUp || !Array.isArray(parsedUp.rows)) {
      throw new Error('먼저 UP 파일을 파싱해주세요.');
    }

    const slotSizeMin = Number(options.slotSizeMin || 30);
    const slotStartMin = Number(options.slotStartMin ?? (8 * 60 + 30));
    const slotEndMin = Number(options.slotEndMin ?? (22 * 60));

    // UP-5 임시 전환 규칙:
    // 오전파트와 오후파트가 다를 경우 UP 자체에 전환시각이 없으므로
    // 현재는 근무구간의 중간시각을 파트 전환시각으로 사용한다.
    // 추후 원본 추출에서 전환시각 필드가 제공되면 이 규칙만 교체하면 된다.
    const transitionMode = options.transitionMode || 'midpoint';

    const slots = [];
    for (let m = slotStartMin; m < slotEndMin; m += slotSizeMin) {
      slots.push(m);
    }

    const dateKeys = (parsedUp.dates || []).map(d => d.key);
    const actualCounts = {};
    const actualNames = {};
    const allScheduledCounts = {};
    const allScheduledNames = {};

    dateKeys.forEach(dateKey => {
      actualCounts[dateKey] = {};
      actualNames[dateKey] = {};
      allScheduledCounts[dateKey] = {};
      allScheduledNames[dateKey] = {};

      slots.forEach(slot => {
        actualCounts[dateKey][slot] = {};
        actualNames[dateKey][slot] = {};
        DIAGNOSIS_PARTS.forEach(part => {
          actualCounts[dateKey][slot][part] = 0;
          actualNames[dateKey][slot][part] = [];
        });
        allScheduledCounts[dateKey][slot] = 0;
        allScheduledNames[dateKey][slot] = [];
      });
    });

    const unresolvedRows = [];
    const noPartRows = [];
    const transitionedRows = [];
    const invalidTimeRows = [];

    let scheduledRows = 0;
    let eligiblePartRows = 0;
    let mappedRows = 0;

    parsedUp.rows.forEach(row => {
      const start = row.startMinutes;
      const end = row.endMinutes;

      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        if (start !== null || end !== null) {
          invalidTimeRows.push(summarizeRow(row, '출퇴근 시간 오류'));
        }
        return;
      }

      scheduledRows += 1;

      // 전체 근무자 배치는 파트와 무관하게 보관.
      slots.forEach(slot => {
        if (overlapsSlot(start, end, slot, slotSizeMin)) {
          allScheduledCounts[row.dateKey][slot] += 1;
          allScheduledNames[row.dateKey][slot].push(row.name);
        }
      });

      // UP-5 기준: 근무구분은 사용하지 않고 오전파트/오후파트만 본다.
      const amRaw = cleanText(row.morningPart);
      const pmRaw = cleanText(row.afternoonPart);
      const am = mapPartName(amRaw);
      const pm = mapPartName(pmRaw);

      if (!amRaw && !pmRaw) {
        eligiblePartRows += 1;
        noPartRows.push(summarizeRow(row, '오전/오후 파트 공란'));
        return;
      }

      eligiblePartRows += 1;

      // 한쪽만 있거나 양쪽이 같으면 전체 근무시간을 해당 파트로 처리
      if ((amRaw && !pmRaw) || (!amRaw && pmRaw) || (amRaw && pmRaw && amRaw === pmRaw)) {
        const mappedPart = am || pm;
        if (!mappedPart) {
          unresolvedRows.push(summarizeRow(row, `미매핑 파트: ${amRaw || pmRaw}`));
          return;
        }

        mappedRows += 1;
        slots.forEach(slot => {
          if (!overlapsSlot(start, end, slot, slotSizeMin)) return;
          actualCounts[row.dateKey][slot][mappedPart] += 1;
          actualNames[row.dateKey][slot][mappedPart].push(row.name);
        });
        return;
      }

      // 오전/오후 파트가 다른 경우
      if (!am || !pm) {
        unresolvedRows.push(
          summarizeRow(row, `미매핑 전환파트: ${amRaw || '(공란)'} → ${pmRaw || '(공란)'}`)
        );
        return;
      }

      const transitionMin = transitionMode === 'midpoint'
        ? start + ((end - start) / 2)
        : start + ((end - start) / 2);

      mappedRows += 1;
      transitionedRows.push({
        ...summarizeRow(row, `${amRaw} → ${pmRaw}`),
        transitionMinutes: transitionMin,
        transitionTime: minToText(transitionMin)
      });

      slots.forEach(slot => {
        if (!overlapsSlot(start, end, slot, slotSizeMin)) return;

        // 슬롯의 중심시각을 기준으로 오전/오후 파트를 나눈다.
        const slotMid = slot + slotSizeMin / 2;
        const mappedPart = slotMid < transitionMin ? am : pm;

        actualCounts[row.dateKey][slot][mappedPart] += 1;
        actualNames[row.dateKey][slot][mappedPart].push(row.name);
      });
    });

    const coverageRate = eligiblePartRows > 0 ? mappedRows / eligiblePartRows : 0;

    return {
      slots,
      slotSizeMin,
      slotStartMin,
      slotEndMin,
      transitionMode,

      actualCounts,
      actualNames,
      allScheduledCounts,
      allScheduledNames,

      scheduledRows,
      eligiblePartRows,
      mappedRows,
      coverageRate,

      unresolvedRows,
      noPartRows,
      transitionedRows,
      invalidTimeRows,

      // UP-5: 명시 파트 매핑률이 충분하면 파트진단 가능
      canRunPartDiagnosis: coverageRate >= 0.95 &&
        unresolvedRows.length === 0 &&
        noPartRows.length === 0,

      diagnosisParts: [...DIAGNOSIS_PARTS]
    };
  }

  function mapPartName(value) {
    const text = cleanText(value);
    if (!text) return null;
    return PART_ALIASES[text] || null;
  }

  function overlapsSlot(startMin, endMin, slotStart, slotSizeMin) {
    const slotEnd = slotStart + slotSizeMin;
    return startMin < slotEnd && endMin > slotStart;
  }

  function minToText(totalMin) {
    const rounded = Math.round(totalMin);
    const h = Math.floor(rounded / 60);
    const m = rounded % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }


  function summarizeRow(row, reason) {
    return {
      rowNumber: row.rowNumber,
      dateKey: row.dateKey,
      employeeId: row.employeeId,
      name: row.name,
      workType: row.workType,
      morningPart: row.morningPart,
      afternoonPart: row.afternoonPart,
      startTime: row.startTime,
      endTime: row.endTime,
      workHours: row.workHours,
      reason
    };
  }

  // Step UP-3에서 index.html이 사용할 공개 API
  global.AshleyUpParser = {
    parseUpFile,
    parseUpWorkbook,
    buildThirtyMinuteActuals,
    mapPartName,
    requiredHeaders: [...UP_REQUIRED_HEADERS],
    diagnosisParts: [...DIAGNOSIS_PARTS],
    sheetName: UP_SHEET_NAME
  };

})(window);
