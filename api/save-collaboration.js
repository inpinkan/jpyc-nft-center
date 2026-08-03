const REGISTRY_KEY = "jpyc:collaborations:v1";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
  res.setHeader("Cache-Control", "no-store");
}

function isAdmin(req) {
  const expected = process.env.JNC_ADMIN_KEY;
  const received = String(req.headers["x-admin-key"] || "");
  return Boolean(expected) && received === expected;
}

function normalizeAddress(value) {
  return String(value || "").trim();
}

function isEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function safeText(value, max) {
  return String(value || "").trim().slice(0, max);
}

async function kvGet(url, token, key) {
  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`KV get failed: ${JSON.stringify(data)}`);
  return data.result || null;
}

async function kvSet(url, token, key, value) {
  const response = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(value)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`KV set failed: ${JSON.stringify(data)}`);
  return data;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  if (!isAdmin(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      return res.status(500).json({ ok: false, error: "KV env is not configured" });
    }

    const input = req.body || {};
    const chain = input.chain || {};
    const paymentToken = input.paymentToken || {};

    const address = normalizeAddress(paymentToken.address);
    const symbol = safeText(paymentToken.symbol, 16).toUpperCase();
    const projectId = safeText(
      input.projectId || `${chain.key || "chain"}-${symbol || "token"}`,
      80
    )
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (!projectId) {
      return res.status(400).json({ ok: false, error: "projectId is required" });
    }
    if (!chain.key || !chain.name || !Number.isInteger(Number(chain.chainId))) {
      return res.status(400).json({ ok: false, error: "Valid chain is required" });
    }
    if (!safeText(paymentToken.name, 60) || !symbol) {
      return res.status(400).json({ ok: false, error: "Token name and symbol are required" });
    }
    if (!isEvmAddress(address)) {
      return res.status(400).json({ ok: false, error: "Invalid token contract address" });
    }
    if (!safeText(paymentToken.logoUrl, 1000)) {
      return res.status(400).json({ ok: false, error: "Token logo URL is required" });
    }

    const now = new Date().toISOString();
    const registry = (await kvGet(url, token, REGISTRY_KEY)) || [];
    const list = Array.isArray(registry) ? registry : [];

    const previous = list.find((item) => item.projectId === projectId);
    const record = {
      schemaVersion: 1,
      projectType: "jnc-collaboration-token",
      projectId,
      enabled: input.enabled !== false,
      chain: {
        key: safeText(chain.key, 30),
        name: safeText(chain.name, 60),
        chainId: Number(chain.chainId),
        nativeSymbol: safeText(chain.nativeSymbol, 16).toUpperCase()
      },
      paymentToken: {
        name: safeText(paymentToken.name, 60),
        symbol,
        displaySymbol: `$${symbol}`,
        address,
        logoUrl: safeText(paymentToken.logoUrl, 1000),
        logoCid: safeText(paymentToken.logoCid, 200),
        otherImageUrl: safeText(paymentToken.otherImageUrl, 1000),
        otherImageCid: safeText(paymentToken.otherImageCid, 200)
      },
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };

    const next = list.filter((item) => item.projectId !== projectId);
    next.push(record);
    next.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    await kvSet(url, token, REGISTRY_KEY, next);

    return res.status(200).json({
      ok: true,
      key: REGISTRY_KEY,
      collaboration: record,
      count: next.length
    });
  } catch (error) {
    console.error("save-collaboration error:", error);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      detail: error?.message || String(error)
    });
  }
}
