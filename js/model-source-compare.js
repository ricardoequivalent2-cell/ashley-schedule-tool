(() => {
  const PART_KEYS = ['데코이','폴리싱','스시','콜드','베이커리','핫','그릴','피파','DMO','홀'];
  const EPSILON = 1e-9;

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const detailsEl = $('details');
  const runBtn = $('runBtn');

  function setStatus(kind, text) {
    statusEl.className = `status ${kind}`;
    statusEl.textContent = text;
  }

  function normalizeModels(models) {
    return [...models].sort((a, b) => {
      const salesDiff = Number(a.sales) - Number(b.sales);
      if (salesDiff !== 0) return salesDiff;
      return String(a.title || '').localeCompare(String(b.title || ''), 'ko');
    });
  }

  function numericEqual(a, b) {
    return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= EPSILON;
  }

  async function runComparison() {
    try {
      setStatus('pending', 'Supabase 데이터를 불러와 전체 비교 중...');
      detailsEl.textContent = '비교 중...';

      if (typeof EMBEDDED_STANDARD_MODELS === 'undefined') {
        throw new Error('EMBEDDED_STANDARD_MODELS를 찾을 수 없습니다. js/standard-models.js 로딩을 확인하세요.');
      }

      const response = await fetch('/api/standard-models', { cache: 'no-store' });
      const payload = await response.json();

      if (!response.ok || !payload.ok || !Array.isArray(payload.models)) {
        throw new Error(payload.error || `DB API 조회 실패 (${response.status})`);
      }

      const localModels = normalizeModels(EMBEDDED_STANDARD_MODELS);
      const dbModels = normalizeModels(payload.models);
      const mismatches = [];
      let comparedValues = 0;

      $('localCount').textContent = localModels.length;
      $('dbCount').textContent = dbModels.length;

      if (localModels.length !== dbModels.length) {
        mismatches.push(`모델 수 불일치: 로컬 ${localModels.length} / DB ${dbModels.length}`);
      }

      const maxModels = Math.max(localModels.length, dbModels.length);

      for (let i = 0; i < maxModels; i++) {
        const local = localModels[i];
        const db = dbModels[i];

        if (!local || !db) {
          mismatches.push(`모델 인덱스 ${i}: ${!local ? '로컬 없음' : ''}${!db ? ' DB 없음' : ''}`.trim());
          continue;
        }

        comparedValues += 2;
        if (String(local.title) !== String(db.title)) {
          mismatches.push(`[모델 ${i + 1}] title 불일치\n  로컬: ${local.title}\n  DB: ${db.title}`);
        }
        if (!numericEqual(local.sales, db.sales)) {
          mismatches.push(`[${local.title}] sales 불일치: 로컬 ${local.sales} / DB ${db.sales}`);
        }

        const localSlots = Object.keys(local.table || {}).sort((a,b)=>Number(a)-Number(b));
        const dbSlots = Object.keys(db.table || {}).sort((a,b)=>Number(a)-Number(b));
        comparedValues += 1;
        if (localSlots.length !== dbSlots.length) {
          mismatches.push(`[${local.title}] 슬롯 수 불일치: 로컬 ${localSlots.length} / DB ${dbSlots.length}`);
        }

        const maxSlots = Math.max(localSlots.length, dbSlots.length);
        for (let slotIndex = 0; slotIndex < maxSlots; slotIndex++) {
          const localSlot = local.table?.[String(slotIndex)];
          const dbSlot = db.table?.[String(slotIndex)];

          if (!localSlot || !dbSlot) {
            mismatches.push(`[${local.title}] 슬롯 ${slotIndex}: ${!localSlot ? '로컬 없음' : ''}${!dbSlot ? ' DB 없음' : ''}`.trim());
            continue;
          }

          for (const part of PART_KEYS) {
            comparedValues++;
            if (!numericEqual(localSlot[part], dbSlot[part])) {
              mismatches.push(
                `[${local.title}] 슬롯 ${slotIndex} / ${part} 불일치: 로컬 ${localSlot[part]} / DB ${dbSlot[part]}`
              );
            }
          }
        }
      }

      $('valueCount').textContent = comparedValues.toLocaleString('ko-KR');
      $('mismatchCount').textContent = mismatches.length.toLocaleString('ko-KR');

      if (mismatches.length === 0) {
        setStatus('success', '100% 일치 · 기존 기준모델과 Supabase 데이터가 동일합니다.');
        detailsEl.textContent = [
          '검증 성공',
          `- 로컬 모델: ${localModels.length}`,
          `- DB 모델: ${dbModels.length}`,
          `- DB 슬롯: ${payload.slotCount}`,
          `- 비교한 값: ${comparedValues.toLocaleString('ko-KR')}`,
          '- 불일치: 0',
          '',
          'Step 10에서 실제 계산 데이터 소스를 Supabase로 전환해도 됩니다.'
        ].join('\n');
      } else {
        setStatus('fail', `불일치 ${mismatches.length}건 발견 · 아직 DB 전환하면 안 됩니다.`);
        detailsEl.textContent = [
          `총 불일치: ${mismatches.length}건`,
          '아래는 최대 100건까지 표시합니다.',
          '',
          ...mismatches.slice(0, 100)
        ].join('\n');
      }
    } catch (error) {
      $('mismatchCount').textContent = '-';
      setStatus('fail', '비교 실행 실패');
      detailsEl.textContent = error.stack || error.message || String(error);
    }
  }

  runBtn.addEventListener('click', runComparison);
  runComparison();
})();
