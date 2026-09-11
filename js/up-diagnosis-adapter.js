// Ashley Schedule Tool - UP Diagnosis Adapter (Step UP-4)
// 목적:
//   UP Parser가 만든 행/30분 실제배치를 기존 V1 진단 계산 구조에 연결한다.
//
// 안전 원칙:
//   - 총인시 진단: UP의 '근무시간' 합계를 사용하여 항상 실행
//   - 표준시간표: 예상매출/객수 + 기존 V1 기준모델로 항상 생성
//   - 파트진단: V1 표준파트로 설명되지 않는 실제 근무인시가 있으면 자동 차단
//               (예: '관리'). 해당 인시를 다른 파트로 임의 배분하지 않는다.

(function (global) {
  'use strict';

  const HALL_PARTS = ['데코이', '폴리싱', '홀'];

  async function computeDiagnosisFromUp(parsedUp, upActuals) {
    if (!parsedUp || !upActuals) {
      throw new Error('UP 파싱 결과가 없습니다.');
    }

    if (!global.AshleyStandardTimetable) {
      throw new Error('정석 시간표 V2 계산 모듈을 찾을 수 없습니다.');
    }
    await global.AshleyStandardTimetable.ensureLoaded();

    const rawModels = getStandardModels();
    if (typeof getActiveDiagnosisConfig !== 'function') {
      throw new Error('계산기준 로더(config-source.js)를 찾을 수 없습니다.');
    }
    const calcConfig = getActiveDiagnosisConfig();

    const slots = getTimeSlots();
    const hourPerSlot = SLOT_SIZE_MIN / 60;

    const dateMetaByKey = {};
    const keyByLabel = {};
    (parsedUp.dates || []).forEach(d => {
      dateMetaByKey[d.key] = d;
      keyByLabel[d.label] = d.key;
    });
    const dateHeaders = (parsedUp.dates || []).map(d => d.label);

    // ------------------------------------------
    // 1. 일자별 실제 근무인시
    // ------------------------------------------
    const dailyHours = {};
    dateHeaders.forEach(label => {
      dailyHours[label] = {
        total: 0,
        kitchen: 0,
        hall: 0,
        other: 0
      };
    });

    (parsedUp.rows || []).forEach(row => {
      const meta = dateMetaByKey[row.dateKey];
      if (!meta) return;
      const label = meta.label;
      const hours = Number(row.workHours || 0);
      if (!Number.isFinite(hours) || hours <= 0) return;

      dailyHours[label].total += hours;

      // UP-5 기준: 근무구분은 사용하지 않고 오전파트/오후파트만 본다.
      const rawAm = String(row.morningPart || '').trim();
      const rawPm = String(row.afternoonPart || '').trim();
      const am = global.AshleyUpParser.mapPartName(rawAm);
      const pm = global.AshleyUpParser.mapPartName(rawPm);

      if (!rawAm && !rawPm) {
        dailyHours[label].other += hours;
        return;
      }

      // 한쪽만 있거나 동일 파트
      if ((rawAm && !rawPm) || (!rawAm && rawPm) || (rawAm && rawPm && rawAm === rawPm)) {
        const mapped = am || pm;
        if (mapped && PARTS.indexOf(mapped) !== -1) {
          dailyHours[label].kitchen += hours;
        } else if (mapped && HALL_PARTS.indexOf(mapped) !== -1) {
          dailyHours[label].hall += hours;
        } else {
          dailyHours[label].other += hours;
        }
        return;
      }

      // 오전/오후가 다른 경우: 현재 UP-5의 midpoint 규칙과 동일하게 50:50 분할
      if (am && pm) {
        const half = hours / 2;
        if (PARTS.indexOf(am) !== -1) dailyHours[label].kitchen += half;
        else if (HALL_PARTS.indexOf(am) !== -1) dailyHours[label].hall += half;
        else dailyHours[label].other += half;

        if (PARTS.indexOf(pm) !== -1) dailyHours[label].kitchen += half;
        else if (HALL_PARTS.indexOf(pm) !== -1) dailyHours[label].hall += half;
        else dailyHours[label].other += half;
      } else {
        dailyHours[label].other += hours;
      }
    });

    const totalOtherHours = round1(
      dateHeaders.reduce((sum, label) => sum + dailyHours[label].other, 0)
    );

    const partDiagnosisAvailable =
      upActuals.canRunPartDiagnosis &&
      totalOtherHours < 0.1 &&
      upActuals.unresolvedRows.length === 0 &&
      upActuals.noPartRows.length === 0;

    const partBlockReasons = [];
    if (!upActuals.canRunPartDiagnosis) {
      partBlockReasons.push(
        `표준파트 매핑률 ${Math.round(upActuals.coverageRate * 100)}%`
      );
    }
    if (totalOtherHours >= 0.1) {
      partBlockReasons.push(`V1 표준파트 외 실제인시 ${totalOtherHours}h`);
    }
    if (upActuals.unresolvedRows.length) {
      partBlockReasons.push(`미매핑 파트 ${upActuals.unresolvedRows.length}행`);
    }
    if (upActuals.noPartRows.length) {
      partBlockReasons.push(`파트 공란 ${upActuals.noPartRows.length}행`);
    }

    // ------------------------------------------
    // 2. 결과 컨테이너
    // ------------------------------------------
    const heatmap = {};
    const standardSchedule = {};
    const tierDiagnosis = {};
    const blockDiagnosis = {};
    const hallBlockDiagnosis = {};
    const diagnosisList = [];

    // ------------------------------------------
    // 3. 날짜별 V1 표준인시 + 표준시간표
    // ------------------------------------------
    dateHeaders.forEach(label => {
      const dateKey = keyByLabel[label];
      const meta = dateMetaByKey[dateKey];
      const salesVal = Number(meta && meta.sales || 0);

      const price = isWeekendLabel(label)
        ? calcConfig.GUEST_UNIT_PRICE_WEEKEND
        : calcConfig.GUEST_UNIT_PRICE_WEEKDAY;
      const guestCount = price > 0 ? salesVal / price : 0;

      const hurdle = tierHoursDaily(calcConfig.CURVE.TIERS['최소허들'], guestCount, calcConfig.CURVE);
      const target1 = tierHoursDaily(calcConfig.CURVE.TIERS['1차목표'], guestCount, calcConfig.CURVE);
      const target2 = tierHoursDaily(calcConfig.CURVE.TIERS['2차목표'], guestCount, calcConfig.CURVE);

      // V2 기준 통일:
      // - 총량 진단 경계는 기존 2차목표(BHAG) 곡선을 유지한다.
      // - 파트/30분/시간대 진단의 표준배치는 '정석 시간표 V2'를 그대로 사용한다.
      // - 정석 시간표 V2는 Supabase의 Part Allocation + 30분 BP + 운영시간(09:00~22:00)
      //   + 0.5HC + 매출 증가 시 슬롯별 HC 비감소 규칙을 적용한다.
      // - 일간 진단에서는 혼합 객단가가 아니라 해당 일자의 평일/주말 객단가를 사용한다.
      const allTargetParts = PARTS.concat(['홀']);
      const timetable = global.AshleyStandardTimetable.buildForDiagnosis(salesVal, price);

      standardSchedule[label] = {};
      heatmap[label] = {};
      slots.forEach(slot => {
        standardSchedule[label][slot] = {};
        heatmap[label][slot] = {};
        allTargetParts.forEach(part => {
          standardSchedule[label][slot][part] = 0;
        });
      });

      const timetableIndexByLabel = {};
      (timetable.slots || []).forEach((slotLabel, index) => {
        timetableIndexByLabel[String(slotLabel).slice(0, 5)] = index;
      });

      slots.forEach(slot => {
        const labelText = minToLabel(slot);
        const idx = timetableIndexByLabel[labelText];
        if (idx === undefined) return; // 예: 08:30은 DB 운영시간 밖이므로 표준 HC=0
        allTargetParts.forEach(part => {
          standardSchedule[label][slot][part] = Number(((timetable.hcByPart || {})[part] || [])[idx] || 0);
        });
      });

      // V2는 0.5HC 및 단조증가 보정 때문에 표시 인시가 곡선 Target2와 소폭 다를 수 있다.
      // 진단 상세/문제위치는 실제 화면에 보이는 정석 시간표 합계를 사용하고,
      // 총인시 상태판정은 원래의 연속형 Target2 곡선을 유지한다.
      let scheduleTargetHours = 0;
      slots.forEach(slot => {
        allTargetParts.forEach(part => {
          scheduleTargetHours += ((standardSchedule[label][slot] || {})[part] || 0) * hourPerSlot;
        });
      });

      // ----------------------------------------
      // 총인시 진단: UP 근무시간 합계를 그대로 사용
      // ----------------------------------------
      const h = dailyHours[label];
      const actualTotal = h.total;

      let verdict;
      if (actualTotal > hurdle) verdict = '과다 · 즉시개선';
      else if (actualTotal > target1) verdict = '개선 필요';
      else if (actualTotal > target2) verdict = '양호 · BHAG 추가개선';
      else verdict = '2차목표(BHAG) 달성';

      tierDiagnosis[label] = {
        guestCount: Math.round(guestCount),
        actualTotal: round1(actualTotal),
        hurdle: round1(hurdle),
        target1: round1(target1),
        target2: round1(target2),
        standardScheduleHours: round1(scheduleTargetHours),
        standardScheduleSales: Number(timetable.sales || 0),
        verdict,
        kitchenActualHours: round1(h.kitchen),
        hallActualHours: round1(h.hall),
        otherActualHours: round1(h.other),
        salesVal: Math.round(salesVal),
        kitchenScaleFactor: 1,
        hallScaleFactor: 1
      };

      // ----------------------------------------
      // 파트진단: 안전조건 충족 시에만 실행
      // ----------------------------------------
      if (partDiagnosisAvailable) {
        const actualForKey = upActuals.actualCounts[dateKey] || {};
        const namesForKey = upActuals.actualNames[dateKey] || {};

        let rawKitchenSlotHours = 0;
        let rawHallSlotHours = 0;
        slots.forEach(slot => {
          PARTS.forEach(part => {
            rawKitchenSlotHours += ((actualForKey[slot] || {})[part] || 0) * hourPerSlot;
          });
          HALL_PARTS.forEach(part => {
            rawHallSlotHours += ((actualForKey[slot] || {})[part] || 0) * hourPerSlot;
          });
        });

        const kitchenScaleFactor =
          rawKitchenSlotHours > 0 ? h.kitchen / rawKitchenSlotHours : 1;
        const hallScaleFactor =
          rawHallSlotHours > 0 ? h.hall / rawHallSlotHours : 1;

        tierDiagnosis[label].kitchenScaleFactor = kitchenScaleFactor;
        tierDiagnosis[label].hallScaleFactor = hallScaleFactor;

        const hallActualSlotData = {};

        slots.forEach(slot => {
          PARTS.forEach(part => {
            const actual = ((actualForKey[slot] || {})[part]) || 0;
            const std = (standardSchedule[label][slot] || {})[part] || 0;
            const diff = actual - std;
            heatmap[label][slot][part] = round1(diff);

            if (Math.abs(diff) >= 1) {
              const namesHere = (((namesForKey[slot] || {})[part]) || []);
              diagnosisList.push({
                date: label,
                time: minToLabel(slot),
                part,
                actual,
                standard: round1(std),
                diff: round1(diff),
                type: diff > 0 ? '과다' : '부족',
                names: namesHere,
                action: diff > 0
                  ? `현재 배치(${namesHere.length ? namesHere.join(', ') : '(배치 인원 없음)'}) 중 ${Math.abs(round1(diff))}명분 재배치 또는 계약시간 조정 검토`
                  : `${part} 인원 ${Math.abs(round1(diff))}명 추가 배치 필요`
              });
            }
          });

          const hallActual =
            (((actualForKey[slot] || {})['데코이']) || 0) +
            (((actualForKey[slot] || {})['폴리싱']) || 0) +
            (((actualForKey[slot] || {})['홀']) || 0);
          hallActualSlotData[slot] = hallActual;

          const hallStd = (standardSchedule[label][slot] || {})['홀'] || 0;
          heatmap[label][slot]['홀'] = round1(hallActual - hallStd);
        });

        blockDiagnosis[label] =
          computeBlockDiagnosis(actualForKey, heatmap[label], slots, kitchenScaleFactor);

        hallBlockDiagnosis[label] = SHIFT_BLOCKS.map(block => {
          let actualCount = 0;
          let stdCount = 0;

          slots.forEach(slot => {
            if (slot >= block.startMin && slot < block.endMin) {
              actualCount += hallActualSlotData[slot] || 0;
              stdCount += (standardSchedule[label][slot] || {})['홀'] || 0;
            }
          });

          const actualHours = round1(actualCount * hourPerSlot * hallScaleFactor);
          const standardHours = round1(stdCount * hourPerSlot);
          const netDiffHours = round1(actualHours - standardHours);
          const verdict =
            Math.abs(netDiffHours) < 0.5
              ? '적정'
              : (netDiffHours > 0 ? '과다' : '부족');

          return {
            name: block.name,
            timeLabel: minToLabel(block.startMin) + '~' + minToLabel(block.endMin),
            actualHours,
            standardHours,
            netDiffHours,
            verdict
          };
        });
      } else {
        // UI에서 "파트진단 보류"로 처리할 수 있도록 비워둔다.
        blockDiagnosis[label] = [];
        hallBlockDiagnosis[label] = [];
      }
    });

    const priorityList = {};
    dateHeaders.forEach(label => {
      const items = diagnosisList
        .filter(d => d.date === label)
        .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      priorityList[label] = items.slice(0, 5).map((d, i) =>
        Object.assign({ rank: i + 1 }, d)
      );
    });

    const weeklySummary = computeWeeklySummary(tierDiagnosis, dateHeaders);
    weeklySummary.totalOther = round1(
      dateHeaders.reduce((s, d) => s + (tierDiagnosis[d].otherActualHours || 0), 0)
    );

    const weeklyBlockSummary = partDiagnosisAvailable
      ? computeWeeklyBlockSummary(blockDiagnosis, dateHeaders)
      : [];
    const weeklyHallBlockSummary = partDiagnosisAvailable
      ? computeWeeklyBlockSummary(hallBlockDiagnosis, dateHeaders)
      : [];

    return {
      inputSource: 'up',
      partDiagnosisAvailable,
      partDiagnosisBlockReason: partBlockReasons.join(' · '),
      upMappingSummary: {
        scheduledRows: upActuals.scheduledRows,
        eligiblePartRows: upActuals.eligiblePartRows,
        mappedRows: upActuals.mappedRows,
        coverageRate: upActuals.coverageRate,
        nonStandardHours: totalOtherHours,
        transitionedRows: upActuals.transitionedRows.length,
        transitionMode: upActuals.transitionMode,
        unresolvedRows: upActuals.unresolvedRows.length,
        noPartRows: upActuals.noPartRows.length
      },

      heatmap,
      standardSchedule,
      diagnosisList,
      priorityList,
      tierDiagnosis,
      blockDiagnosis,
      hallBlockDiagnosis,
      weeklySummary,
      weeklyBlockSummary,
      weeklyHallBlockSummary,
      dateHeaders,
      slots
    };
  }

  function round1(v) {
    return Math.round((Number(v) || 0) * 10) / 10;
  }

  global.AshleyUpDiagnosisAdapter = {
    computeDiagnosisFromUp
  };

})(window);
