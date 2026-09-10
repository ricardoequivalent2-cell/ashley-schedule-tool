import { kv } from '@vercel/kv';

function normalizeDateKey(value) {
  if (!value) return '';
  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

function inferWeekStart(record) {
  const explicit = record?.adminWeeklySummary?.weekStart;
  if (explicit) return normalizeDateKey(explicit);

  const headers = record?.result?.dateHeaders;
  if (Array.isArray(headers) && headers.length) {
    const normalized = headers.map(normalizeDateKey).filter(Boolean).sort();
    if (normalized.length) return normalized[0];
  }
  return '';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET 요청만 허용됩니다.' });
    return;
  }

  try {
    const store = String(req.query.store || '').trim();
    const weekStart = normalizeDateKey(req.query.weekStart || '');

    if (!store) {
      res.status(400).json({ error: 'store 파라미터가 필요합니다.' });
      return;
    }

    let record = null;

    if (weekStart) {
      record = await kv.get(`store-week:${store}:${weekStart}`);
    }

    if (!record) {
      const latest = await kv.get('store:' + store);
      if (latest) {
        const latestWeekStart = inferWeekStart(latest);
        if (!weekStart || !latestWeekStart || latestWeekStart === weekStart) {
          record = latest;
        }
      }
    }

    if (!record || !record.result) {
      res.status(404).json({
        error: '해당 매장·주차의 상세 진단이 저장되어 있지 않습니다. 해당 주차 UP를 한 번 다시 진단하면 이후부터 상세 조회가 가능합니다.'
      });
      return;
    }

    const resolvedWeekStart = inferWeekStart(record) || weekStart;
    const weekLabel = record?.adminWeeklySummary?.weekLabel || resolvedWeekStart;

    res.status(200).json({
      ok: true,
      storeName: store,
      weekStart: resolvedWeekStart,
      weekLabel,
      record
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
