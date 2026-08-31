import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET 요청만 허용됩니다.' });
    return;
  }
  try {
    const storeNames = await kv.smembers('store-index');
    const records = [];
    for (const name of storeNames) {
      const r = await kv.get('store:' + name);
      if (r) records.push(r);
    }
    records.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    res.status(200).json({ stores: records });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
