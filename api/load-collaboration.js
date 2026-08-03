const REGISTRY_KEY = "jpyc:collaborations:v1";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
  res.setHeader("Cache-Control", "no-store");
}

function isAdmin(req) {
  const expected = process.env.JNC_ADMIN_KEY;
  const received = String(req.headers["x-admin-key"] || "");
  return Boolean(expected) && received === expected;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;

    if (!url || !token) {
      return res.status(500).json({ ok: false, error: "KV env is not configured" });
    }

    const response = await fetch(`${url}/get/${encodeURIComponent(REGISTRY_KEY)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "KV get failed",
        detail: data
      });
    }

    const registry = Array.isArray(data.result) ? data.result : [];
    const adminMode = String(req.query?.admin || "") === "1";

    if (adminMode && !isAdmin(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const collaborations = adminMode
      ? registry
      : registry.filter((item) => item && item.enabled === true);

    return res.status(200).json({
      ok: true,
      key: REGISTRY_KEY,
      collaborations,
      count: collaborations.length
    });
  } catch (error) {
    console.error("load-collaboration error:", error);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      detail: error?.message || String(error)
    });
  }
}
