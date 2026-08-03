const REGISTRY_KEY = "jpyc:collaborations:v1";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
  res.setHeader("Cache-Control", "no-store");
}

function isAdmin(req) {
  const expected = String(process.env.JNC_ADMIN_KEY || "");
  const received = String(req.headers["x-admin-key"] || "");
  return Boolean(expected) && received === expected;
}

function safeText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeAddress(value) {
  return safeText(value, 42);
}

function isEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
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

async function readRegistry(url, token) {
  const result = await runKvCommand(url, token, ["GET", REGISTRY_KEY]);
  return parseRegistry(result);
}

async function writeRegistry(url, token, registry) {
  const serialized = JSON.stringify(registry);
  await runKvCommand(url, token, ["SET", REGISTRY_KEY, serialized]);

  const verified = await readRegistry(url, token);
  if (JSON.stringify(verified) !== serialized) {
    throw new Error("KV write verification failed.");
  }
  return verified;
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
    const url = String(process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
    const token = String(process.env.KV_REST_API_TOKEN || "");

    if (!url || !token) {
      return res.status(500).json({ ok: false, error: "KV env is not configured" });
    }

    const input = req.body || {};
    const chain = input.chain || {};
    const paymentToken = input.paymentToken || {};

    const chainKey = safeText(chain.key, 30).toLowerCase();
    const chainName = safeText(chain.name, 60);
    const chainId = Number(chain.chainId);
    const nativeSymbol = safeText(chain.nativeSymbol, 16).toUpperCase();

    const tokenName = safeText(paymentToken.name, 60);
    const symbol = safeText(paymentToken.symbol, 16).toUpperCase();
    const address = normalizeAddress(paymentToken.address);
    const logoUrl = safeText(paymentToken.logoUrl, 1000);
    const logoCid = safeText(paymentToken.logoCid, 200);

    const projectId = safeText(
      input.projectId || `${chainKey || "chain"}-${symbol || "token"}`,
      80
    )
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (!projectId) {
      return res.status(400).json({ ok: false, error: "projectId is required" });
    }
    if (!chainKey || !chainName || !Number.isInteger(chainId) || chainId <= 0) {
      return res.status(400).json({ ok: false, error: "Valid chain is required" });
    }
    if (!tokenName || !symbol) {
      return res.status(400).json({ ok: false, error: "Token name and symbol are required" });
    }
    if (!isEvmAddress(address)) {
      return res.status(400).json({ ok: false, error: "Invalid token contract address" });
    }
    if (!logoUrl) {
      return res.status(400).json({ ok: false, error: "Token logo URL is required" });
    }

    const registry = await readRegistry(url, token);
    const duplicate = registry.find(item =>
      item.projectId !== projectId &&
      String(item.chain?.key || "").toLowerCase() === chainKey &&
      String(item.paymentToken?.address || "").toLowerCase() === address.toLowerCase()
    );

    if (duplicate) {
      return res.status(409).json({
        ok: false,
        error: "The same chain and token contract are already registered"
      });
    }

    const now = new Date().toISOString();
    const previous = registry.find(item => item.projectId === projectId);

    const record = {
      schemaVersion: 1,
      projectType: "jnc-payment-token",
      projectId,
      enabled: input.enabled !== false,
      chain: {
        key: chainKey,
        name: chainName,
        chainId,
        nativeSymbol
      },
      paymentToken: {
        name: tokenName,
        symbol,
        displaySymbol: `$${symbol}`,
        address,
        logoUrl,
        logoCid
      },
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };

    const next = registry.filter(item => item.projectId !== projectId);
    next.push(record);
    next.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    const verified = await writeRegistry(url, token, next);

    return res.status(200).json({
      ok: true,
      key: REGISTRY_KEY,
      collaboration: record,
      count: verified.length
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
