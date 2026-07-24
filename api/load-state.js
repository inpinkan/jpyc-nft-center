export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { walletAddress } = req.query || {};

    if (!walletAddress) {
      return res.status(400).json({ ok: false, error: "walletAddress required" });
    }

    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;

    if (!url || !token) {
      return res.status(500).json({ ok: false, error: "KV env is not configured" });
    }

    const key = `pnc:wallet:${String(walletAddress).toLowerCase()}`;

    const kvRes = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await kvRes.json();

    if (!kvRes.ok) {
      return res.status(kvRes.status).json({ ok: false, error: "KV get failed", detail: data });
    }

    return res.status(200).json({ ok: true, key, state: data.result || null });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
