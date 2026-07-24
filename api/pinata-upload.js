export const config = {
  api: {
    bodyParser: false
  }
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB foundation limit

function safeFileName(value) {
  return String(value || "pnc-upload")
    .replace(/[^\w.\-() ]+/g, "_")
    .slice(0, 180);
}

async function readMultipartForm(req) {
  const origin = `https://${req.headers.host || "localhost"}`;
  const request = new Request(new URL(req.url || "/api/pinata-upload", origin), {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half"
  });
  return await request.formData();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const jwt = process.env.PINATA_JWT;
    if (!jwt) {
      return res.status(500).json({
        ok: false,
        error: "PINATA_JWT is not configured"
      });
    }

    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return res.status(415).json({
        ok: false,
        error: "multipart/form-data is required"
      });
    }

    const incoming = await readMultipartForm(req);
    const file = incoming.get("file");

    if (!(file instanceof Blob)) {
      return res.status(400).json({
        ok: false,
        error: "file is required"
      });
    }

    if (file.size <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Uploaded file is empty"
      });
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return res.status(413).json({
        ok: false,
        error: "File is larger than the current 100 MB upload limit"
      });
    }

    const requestedName = incoming.get("name");
    const fileName = safeFileName(requestedName || file.name || "pnc-upload");

    const pinataForm = new FormData();
    pinataForm.append("file", file, fileName);
    pinataForm.append("pinataMetadata", JSON.stringify({
      name: fileName,
      keyvalues: {
        app: "Pi NFT Center",
        uploader: "PNC Media Foundation"
      }
    }));

    const pinataRes = await fetch(
      "https://api.pinata.cloud/pinning/pinFileToIPFS",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`
        },
        body: pinataForm
      }
    );

    const rawText = await pinataRes.text();
    let pinataJson;

    try {
      pinataJson = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        ok: false,
        error: "Invalid JSON from Pinata",
        detail: rawText.slice(0, 1000)
      });
    }

    if (!pinataRes.ok) {
      return res.status(pinataRes.status).json({
        ok: false,
        error: "Pinata upload failed",
        detail: pinataJson
      });
    }

    const hash =
      pinataJson.IpfsHash ||
      pinataJson.cid ||
      pinataJson.ipfsHash;

    if (!hash) {
      return res.status(502).json({
        ok: false,
        error: "Pinata response did not include a CID",
        detail: pinataJson
      });
    }

    return res.status(200).json({
      ok: true,
      cid: hash,
      IpfsHash: hash,
      ipfsHash: hash,
      uri: `ipfs://${hash}`,
      fileUri: `ipfs://${hash}`,
      fileName,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      raw: pinataJson
    });
  } catch (err) {
    console.error("PNC Pinata upload error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      detail: err?.message || String(err)
    });
  }
}
