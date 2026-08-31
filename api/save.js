import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST 요청만 허용됩니다.' });
    return;
  }
  try {
    const { storeName, headline, weeklySummary, result } = req.body;
    if (!storeName) {
      res.status(400).json({ error: 'storeName이 필요합니다.' });
      return;
    }

    const record = {
      storeName,
      headline: headline || null,
      weeklySummary: weeklySummary || null,
      result: result || null,
      savedAt: new Date().toISOString(),
    };

    await kv.set('store:' + storeName, record);
    await kv.sadd('store-index', storeName);

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
