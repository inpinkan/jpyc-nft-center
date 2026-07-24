export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { walletAddress, state } = req.body || {};

    if (!walletAddress) {
      return res.status(400).json({ ok: false, error: "walletAddress is required" });
    }

    if (!state) {
      return res.status(400).json({ ok: false, error: "state is required" });
    }

    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;

    if (!url || !token) {
      return res.status(500).json({ ok: false, error: "KV env is not configured" });
    }

    const key = `pnc:wallet:${String(walletAddress).toLowerCase()}`;

    const kvRes = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(state),
    });

    const data = await kvRes.json();

    if (!kvRes.ok) {
      return res.status(kvRes.status).json({
        ok: false,
        error: "KV save failed",
        detail: data,
      });
    }

    return res.status(200).json({ ok: true, key, result: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error", detail: String(err) });
  }
}
