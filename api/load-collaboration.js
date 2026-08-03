const REGISTRY_KEY = "jpyc:collaborations:v1";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
  res.setHeader("Cache-Control", "no-store");
}

function isAdmin(req) {
  const expected = String(process.env.JNC_ADMIN_KEY || "");
  const received = String(req.headers["x-admin-key"] || "");
  return Boolean(expected) && received === expected;
}

function parseRegistry(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function runKvCommand(url, token, command) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(`KV command failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const url = String(process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
    const token = String(process.env.KV_REST_API_TOKEN || "");

    if (!url || !token) {
      return res.status(500).json({ ok: false, error: "KV env is not configured" });
    }

    const adminMode = String(req.query?.admin || "") === "1";
    if (adminMode && !isAdmin(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const raw = await runKvCommand(url, token, ["GET", REGISTRY_KEY]);
    const registry = parseRegistry(raw);
    const collaborations = adminMode
      ? registry
      : registry.filter(item => item?.enabled === true);

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
