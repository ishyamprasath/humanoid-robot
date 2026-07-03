// ============================================================
// Robot server — zero dependencies (Node 18+).
//   1. Loads secrets from ./.env (no dotenv package needed)
//   2. Serves the cockpit web app from ./public
//   3. Injects browser-safe secrets at runtime via /js/env.js
//   4. Proxies the NVIDIA Nemotron fallback brain at /api/nvidia
//
// Run:  node server.js   →  http://localhost:8000
// ============================================================

const http = require("http");
const fs   = require("fs");
const path = require("path");

// -----------------------------------------------------------------
// Tiny .env loader — no external deps, tolerant of quotes + comments
// -----------------------------------------------------------------
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const src = fs.readFileSync(envPath, "utf8");
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PORT       = process.env.PORT || 8000;
const PUBLIC_DIR = path.join(__dirname, "public");

const GEMINI_API_KEY     = process.env.GEMINI_API_KEY     || "";
const GEMINI_MODEL       = process.env.GEMINI_MODEL       || "models/gemini-3.1-flash-live-preview";
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || "v1beta";
const VOICE_NAME         = process.env.VOICE_NAME         || "Kore";

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
const NVIDIA_MODEL   = process.env.NVIDIA_MODEL   || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const NVIDIA_URL     = "https://integrate.api.nvidia.com/v1/chat/completions";

if (!GEMINI_API_KEY) console.warn("  ⚠  GEMINI_API_KEY missing — copy .env.example → .env and fill it in.");
if (!NVIDIA_API_KEY) console.warn("  ⚠  NVIDIA_API_KEY missing — fallback brain will be unavailable.");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

// Browser-safe secrets injected at runtime.
// The Gemini WebSocket needs the key client-side, so it goes here.
// The NVIDIA key is NEVER exposed — it's used only by the /api/nvidia proxy.
const envScript = () =>
`// Auto-generated at request time from server .env. Not stored on disk.
window.__ROBOT_ENV__ = ${JSON.stringify({
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GEMINI_API_VERSION,
  VOICE_NAME,
}, null, 2)};
`;

const server = http.createServer(async (req, res) => {
  // ---------- runtime-injected env script ----------
  if (req.method === "GET" && req.url === "/js/env.js") {
    res.writeHead(200, {
      "Content-Type": MIME[".js"],
      "Cache-Control": "no-store",
    });
    return res.end(envScript());
  }

  // ---------- NVIDIA fallback proxy ----------
  if (req.method === "POST" && req.url === "/api/nvidia") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        if (!NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY not configured on server");
        const { messages } = JSON.parse(body || "{}");
        if (!Array.isArray(messages)) throw new Error("messages[] required");
        const upstream = await fetch(NVIDIA_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${NVIDIA_API_KEY}`,
          },
          body: JSON.stringify({
            model: NVIDIA_MODEL,
            messages,
            temperature: 0.7,
            top_p: 0.95,
            max_tokens: 1024,
            stream: false,
          }),
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(text);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }

  // ---------- static files ----------
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404 Not Found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("");
  console.log("  🤖 Robot Cognitive Core");
  console.log(`  ➜  Cockpit:        http://localhost:${PORT}`);
  console.log(`  ➜  Model:          ${GEMINI_MODEL} · voice ${VOICE_NAME}`);
  console.log(`  ➜  Fallback proxy: POST /api/nvidia  (${NVIDIA_MODEL})`);
  console.log("");
  console.log("  Open in Chrome/Edge, press Power On, allow mic + camera.");
  console.log("");
});
