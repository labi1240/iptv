const http = require("http");
const https = require("https");
const { chromium } = require("playwright");

const PORT = 8089;

// Store the latest extracted stream URL and extraction timestamp
let currentStream = {
  url: null,
  extractedAt: null,
};

// ─── Extract stream URL using Playwright ───
async function extractStreamUrl(embedUrl) {
  console.log("\n🔍 Extracting fresh stream URL...");
  console.log(`   From: ${embedUrl}`);

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  // Anti-detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  let streamUrl = null;

  // Set up a promise that resolves when m3u8 is intercepted
  const foundPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log("   ⏰ Timeout — no m3u8 found in 40s");
      resolve(null);
    }, 40000);

    page.on("request", (request) => {
      const url = request.url();
      // Match the actual stream m3u8 (not chrome extension or ad junk)
      if (url.includes(".m3u8") && url.startsWith("https://") && !url.includes("chrome-extension")) {
        console.log("   ✅ Intercepted m3u8:", url);
        clearTimeout(timeout);
        resolve(url);
      }
    });
  });

  try {
    // Load the outer embed page — it contains an iframe to pooembed which auto-loads the player
    console.log("   📡 Loading embed page...");
    await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    
    console.log("   ⏳ Waiting for m3u8 stream request (up to 40s)...");
    streamUrl = await foundPromise;

  } catch (e) {
    console.error("   ❌ Extraction error:", e.message);
  }

  await browser.close();

  if (streamUrl) {
    currentStream.url = streamUrl;
    currentStream.extractedAt = Date.now();
    console.log("   🎯 Stream URL ready\n");
  } else {
    console.log("   ❌ Could not find stream URL\n");
  }

  return streamUrl;
}

// ─── Proxy an upstream URL with proper headers (using curl to bypass TLS fingerprinting) ───
function proxyRequest(targetUrl, res) {
  const { spawn } = require("child_process");

  const isM3u8 = targetUrl.includes(".m3u8");

  console.log(`[PROXY] ${targetUrl.substring(0, 80)}...`);

  const curlArgs = [
    "-s",                           // silent
    "-L",                           // follow redirects
    "-H", "Referer: https://pooembed.eu/",
    "-H", "Origin: https://pooembed.eu",
    "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "-H", "Accept: */*",
    "-w", "\n%{http_code}",         // append HTTP status code at end
    targetUrl,
  ];

  const curl = spawn("curl", curlArgs);

  const chunks = [];
  curl.stdout.on("data", (chunk) => chunks.push(chunk));

  curl.stderr.on("data", (data) => {
    console.error("[CURL STDERR]", data.toString());
  });

  curl.on("close", (code) => {
    const fullOutput = Buffer.concat(chunks);
    
    // Extract HTTP status code from last line
    const fullStr = fullOutput.toString("binary");
    const lastNewline = fullStr.lastIndexOf("\n");
    const statusCode = parseInt(fullStr.substring(lastNewline + 1).trim(), 10) || 200;
    const bodyBuffer = fullOutput.slice(0, lastNewline >= 0 ? lastNewline : fullOutput.length);

    console.log(`[PROXY] ${statusCode} ${targetUrl.substring(0, 60)}...`);

    if (statusCode === 403 || statusCode === 401) {
      res.writeHead(403, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      res.end("Token expired — click 'Refresh Stream' to get a new one");
      return;
    }

    if (isM3u8) {
      // Rewrite m3u8 URLs to go through proxy
      const body = bodyBuffer.toString("utf-8");
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      const rewritten = body
        .split("\n")
        .map((line) => {
          line = line.trim();
          if (line.startsWith("#") || line === "") return line;
          let absoluteUrl = line.startsWith("http") ? line : baseUrl + line;
          return `http://localhost:${PORT}/proxy?url=${encodeURIComponent(absoluteUrl)}`;
        })
        .join("\n");

      res.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(rewritten);
    } else {
      // Binary data (.ts segments etc.)
      res.writeHead(statusCode, {
        "Content-Type": "video/mp2t",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(bodyBuffer);
    }
  });

  curl.on("error", (err) => {
    console.error("[CURL ERROR]", err.message);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Proxy error: " + err.message);
  });
}

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;

  // ── Serve player UI ──
  if (pathname === "/" || pathname === "/player") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getPlayerHTML());
    return;
  }

  // ── Extract fresh stream URL ──
  if (pathname === "/extract") {
    const embedUrl = parsed.searchParams.get("embed");
    if (!embedUrl) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing ?embed= parameter" }));
      return;
    }
    try {
      const url = await extractStreamUrl(embedUrl);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url, extractedAt: currentStream.extractedAt }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Get current stream info ──
  if (pathname === "/stream-info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        url: currentStream.url,
        extractedAt: currentStream.extractedAt,
        ageSeconds: currentStream.extractedAt
          ? Math.floor((Date.now() - currentStream.extractedAt) / 1000)
          : null,
      })
    );
    return;
  }

  // ── Proxy endpoint ──
  if (pathname === "/proxy") {
    const targetUrl = parsed.searchParams.get("url");
    if (!targetUrl) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing ?url= parameter");
      return;
    }
    proxyRequest(targetUrl, res);
    return;
  }

  // ── 404 ──
  res.writeHead(404);
  res.end("Not Found");
});

function getPlayerHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🏏 StreamVault — Live Player</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;900&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: #0a0a0f;
      color: #e4e4e7;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .header {
      width: 100%;
      padding: 16px 32px;
      display: flex;
      align-items: center;
      gap: 16px;
      background: linear-gradient(135deg, rgba(16,16,24,0.95), rgba(20,20,35,0.9));
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }

    .logo {
      font-size: 24px;
      font-weight: 900;
      background: linear-gradient(135deg, #818cf8, #c084fc, #f472b6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .badge {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .badge.live {
      background: rgba(239,68,68,0.2);
      color: #f87171;
      border: 1px solid rgba(239,68,68,0.3);
    }

    .badge.live::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ef4444;
      margin-right: 6px;
      animation: blink 1s infinite;
    }

    @keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0.3 } }

    .main { width: 100%; max-width: 1280px; margin: 20px auto; padding: 0 20px; }

    .video-wrapper {
      position: relative;
      width: 100%;
      aspect-ratio: 16/9;
      background: #111118;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 25px 60px -12px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.05);
    }

    video { width: 100%; height: 100%; display: block; background: #000; }

    .overlay {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      background: rgba(10,10,15,0.92);
      backdrop-filter: blur(8px);
      z-index: 10;
      transition: opacity 0.4s;
    }
    .overlay.hidden { opacity: 0; pointer-events: none; }

    .spinner {
      width: 44px; height: 44px;
      border: 3px solid rgba(129,140,248,0.2);
      border-top-color: #818cf8;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .overlay-text { margin-top: 14px; font-size: 14px; color: #a1a1aa; font-weight: 500; }

    .extract-hero {
      margin-top: 16px;
      text-align: center;
    }

    .extract-hero button {
      padding: 14px 36px;
      border: none;
      border-radius: 12px;
      background: linear-gradient(135deg, #818cf8, #6366f1);
      color: white;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      font-family: 'Inter', sans-serif;
      transition: all 0.2s;
      box-shadow: 0 4px 20px rgba(99,102,241,0.4);
    }
    .extract-hero button:hover {
      transform: translateY(-1px);
      box-shadow: 0 8px 30px rgba(99,102,241,0.5);
    }
    .extract-hero button:disabled {
      opacity: 0.6; cursor: not-allowed; transform: none;
    }

    .match-bar {
      margin-top: 16px;
      padding: 16px 20px;
      background: rgba(20,20,30,0.8);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
    }

    .match-title { font-size: 16px; font-weight: 700; }
    .match-sub { font-size: 12px; color: #71717a; margin-top: 2px; }
    .quality-badge {
      padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: 600;
      background: rgba(129,140,248,0.12); color: #a5b4fc;
      border: 1px solid rgba(129,140,248,0.2);
    }

    .controls {
      margin-top: 12px;
      display: flex; gap: 10px; flex-wrap: wrap;
    }

    .url-wrap { flex: 1; min-width: 250px; position: relative; }

    .url-input {
      width: 100%; padding: 12px 110px 12px 14px;
      border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);
      background: rgba(20,20,30,0.8); color: #e4e4e7;
      font-size: 12px; font-family: 'Inter', monospace;
      outline: none; transition: border-color 0.2s;
    }
    .url-input:focus { border-color: rgba(129,140,248,0.4); }

    .play-btn {
      position: absolute; right: 5px; top: 50%; transform: translateY(-50%);
      padding: 7px 16px; border: none; border-radius: 6px;
      background: linear-gradient(135deg, #818cf8, #6366f1);
      color: white; font-size: 12px; font-weight: 600; cursor: pointer;
      font-family: 'Inter', sans-serif;
    }

    .refresh-btn {
      padding: 12px 20px; border: 1px solid rgba(52,211,153,0.3);
      border-radius: 8px; background: rgba(52,211,153,0.1);
      color: #6ee7b7; font-size: 12px; font-weight: 600;
      cursor: pointer; font-family: 'Inter', sans-serif;
      white-space: nowrap;
    }
    .refresh-btn:hover { background: rgba(52,211,153,0.2); }

    .status {
      margin-top: 10px; padding: 8px 14px;
      border-radius: 6px; font-size: 12px; font-weight: 500;
      display: none;
    }
    .status.ok { display:block; background:rgba(34,197,94,0.1); color:#4ade80; border:1px solid rgba(34,197,94,0.2); }
    .status.err { display:block; background:rgba(239,68,68,0.1); color:#f87171; border:1px solid rgba(239,68,68,0.2); }
    .status.load { display:block; background:rgba(129,140,248,0.1); color:#a5b4fc; border:1px solid rgba(129,140,248,0.2); }

    .footer { margin-top: auto; padding: 16px; font-size: 11px; color: #27272a; }
  </style>
</head>
<body>

<div class="header">
  <span class="logo">StreamVault</span>
  <span class="badge live">Live</span>
</div>

<div class="main">
  <div class="video-wrapper">
    <video id="video" controls autoplay></video>
    <div class="overlay" id="overlay">
      <div class="spinner" id="spinner"></div>
      <div class="overlay-text" id="overlayText">Paste any embed URL below and extract</div>
      <div class="extract-hero" style="margin-top:24px;">
        <button id="bigExtractBtn" onclick="extractAndPlay()">🔍 Extract & Play Stream</button>
      </div>
    </div>
  </div>

  <div class="match-bar">
    <div style="flex:1;">
      <div class="match-sub" style="margin-bottom:6px;">📡 Embed / Streaming Page URL</div>
      <div style="display:flex;gap:8px;">
        <input class="url-input" id="embedUrl" style="padding-right:14px;" placeholder="Paste any embed URL here (e.g. https://embedsports.top/embed/...)">
        <button class="refresh-btn" onclick="extractAndPlay()" style="white-space:nowrap;">🔍 Extract</button>
      </div>
    </div>
  </div>

  <div class="controls">
    <div class="url-wrap">
      <input class="url-input" id="streamUrl" placeholder="m3u8 URL will appear here after extraction (or paste manually)...">
      <button class="play-btn" onclick="playUrl()">▶ Play</button>
    </div>
    <button class="refresh-btn" onclick="extractAndPlay()">🔄 Refresh</button>
  </div>

  <div class="status" id="status"></div>
</div>

<div class="footer">StreamVault • Local proxy player with auto-extraction</div>

<script>
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const overlayText = document.getElementById('overlayText');
const spinner = document.getElementById('spinner');
const statusEl = document.getElementById('status');
const bigBtn = document.getElementById('bigExtractBtn');
let hls = null;

function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

function playUrl() {
  const raw = document.getElementById('streamUrl').value.trim();
  if (!raw) { setStatus('Enter a stream URL first', 'err'); return; }
  startHls(raw);
}

function startHls(rawUrl) {
  const proxied = '/proxy?url=' + encodeURIComponent(rawUrl);

  if (hls) hls.destroy();

  overlay.classList.remove('hidden');
  overlayText.textContent = 'Connecting to stream...';
  spinner.style.display = 'block';
  bigBtn.style.display = 'none';
  setStatus('Connecting...', 'load');

  if (!Hls.isSupported()) {
    video.src = proxied;
    video.addEventListener('loadedmetadata', () => {
      overlay.classList.add('hidden');
      video.play();
      setStatus('Playing (Safari native HLS)', 'ok');
    });
    return;
  }

  hls = new Hls({
    maxBufferSize: 0,
    maxBufferLength: 10,
    liveSyncDurationCount: 7,
    enableWorker: true,
    lowLatencyMode: true,
  });

  hls.loadSource(proxied);
  hls.attachMedia(video);

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    overlay.classList.add('hidden');
    video.play().catch(() => {});
    setStatus('✅ Stream connected — 1080p HLS', 'ok');
  });

  hls.on(Hls.Events.ERROR, (_, data) => {
    if (data.fatal) {
      setStatus('❌ ' + data.type + ': ' + data.details, 'err');
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        overlayText.textContent = 'Network error — retrying...';
        setTimeout(() => hls.startLoad(), 3000);
      }
    }
  });
}

async function extractAndPlay() {
  const embedUrl = document.getElementById('embedUrl').value.trim();
  if (!embedUrl) {
    setStatus('Paste an embed/streaming URL first', 'err');
    return;
  }

  bigBtn.disabled = true;
  bigBtn.textContent = '⏳ Extracting...';
  overlay.classList.remove('hidden');
  spinner.style.display = 'block';
  overlayText.textContent = 'Launching browser to extract stream...';
  setStatus('🔍 Extracting from: ' + embedUrl.substring(0, 60) + '...', 'load');

  try {
    const res = await fetch('/extract?embed=' + encodeURIComponent(embedUrl));
    const data = await res.json();

    if (data.url) {
      document.getElementById('streamUrl').value = data.url;
      setStatus('✅ Extracted! Playing now...', 'ok');
      startHls(data.url);
    } else {
      setStatus('❌ No m3u8 found — try a different URL or wait for stream to go live', 'err');
      overlayText.textContent = 'No stream found';
      spinner.style.display = 'none';
      bigBtn.style.display = 'block';
      bigBtn.disabled = false;
      bigBtn.textContent = '🔍 Extract & Play Stream';
    }
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
    overlayText.textContent = 'Error — try again';
    spinner.style.display = 'none';
    bigBtn.style.display = 'block';
    bigBtn.disabled = false;
    bigBtn.textContent = '🔍 Extract & Play Stream';
  }
}
</script>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║       🔍 StreamVault — Universal Stream Player             ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║  Player:  http://localhost:${PORT}/                            ║
║                                                            ║
║  1. Open the player URL above                              ║
║  2. Paste ANY embed/streaming page URL                     ║
║  3. Click Extract — it finds & plays the m3u8              ║
║                                                            ║
║  Also available:                                           ║
║    node extract.js <URL>   (standalone extractor)          ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);
});
