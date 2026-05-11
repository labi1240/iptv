/**
 * Universal M3U8 Stream Extractor
 * 
 * Extracts m3u8/mpd/streaming URLs from ANY webpage by intercepting
 * network requests via Playwright.
 */

const { chromium } = require("playwright");

// Stream-related file extensions and patterns
const STREAM_PATTERNS = [
  ".m3u8",
  ".mpd",
  "/manifest",
  "/playlist",
  "/master.m3u8",
  "/index.m3u8",
  "/chunklist",
  ".smil",
];

// Ignore these (false positives)
const IGNORE_PATTERNS = [
  "chrome-extension://",
  "data:",
  "blob:",
  "about:",
  "javascript:",
  "google-analytics",
  "googletagmanager",
  "facebook.com/tr",
  "doubleclick.net",
];

async function extractStreams(targetUrl) {
  const foundStreams = [];
  const seenUrls = new Set();

  const browser = await chromium.launch({
    headless: true, // Use headless for server usage
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  try {
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

    // Monitor ALL network responses to find the playlist by content-type
    page.on("response", async (response) => {
      const url = response.url();
      const headers = response.headers();
      const contentType = headers["content-type"] || "";
      
      if (IGNORE_PATTERNS.some((p) => url.includes(p))) return;

      const isStream = STREAM_PATTERNS.some((p) => url.toLowerCase().includes(p)) || 
                      contentType.includes("mpegurl") || 
                      contentType.includes("x-mpegURL");

      if (isStream && !seenUrls.has(url)) {
        seenUrls.add(url);
        console.log(`✅ Stream detected: ${url}`);
        foundStreams.push({
          url,
          referer: headers.referer || headers.Referer || targetUrl,
          origin: headers.origin || headers.Origin || "none",
          type: url.includes(".mpd") ? "DASH" : "HLS",
        });
      }
    });

    await page.goto(targetUrl, {
      waitUntil: "load",
      timeout: 60000,
    });

    // Wait for network to settle
    await page.waitForLoadState("networkidle").catch(() => {});

    // Try to trigger loading by scrolling
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(2000);

    // Try to click the center of the page (often triggers players)
    await page.mouse.click(640, 360).catch(() => {});

    // Wait for streams to appear
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(2000);
      if (foundStreams.length > 0) {
        const prevCount = foundStreams.length;
        await page.waitForTimeout(3000);
        if (foundStreams.length === prevCount) break;
      }
    }

    // Deep DOM Inspection for players
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const playerSources = await frame.evaluate(() => {
          const sources = [];
          if (typeof jwplayer !== "undefined") {
            try {
              const item = jwplayer().getPlaylistItem();
              if (item?.file) sources.push({ player: "JWPlayer", url: item.file });
            } catch (e) {}
          }
          if (typeof videojs !== "undefined") {
            try {
              document.querySelectorAll(".video-js").forEach((el) => {
                const src = videojs(el.id).currentSrc();
                if (src) sources.push({ player: "VideoJS", url: src });
              });
            } catch (e) {}
          }
          document.querySelectorAll("video").forEach((v) => {
            if (v.src && v.src.startsWith("http")) sources.push({ player: "HTML5", url: v.src });
            if (v.currentSrc && v.currentSrc.startsWith("http")) sources.push({ player: "HTML5", url: v.currentSrc });
          });
          return sources;
        });

        for (const src of playerSources) {
          if (!seenUrls.has(src.url) && src.url.includes(".m3u8")) {
            seenUrls.add(src.url);
            foundStreams.push({
              url: src.url,
              referer: frame.url(),
              type: "HLS",
              source: src.player,
            });
          }
        }
      } catch (e) {}
    }

  } catch (e) {
    console.error("Extraction error:", e.message);
  } finally {
    await browser.close();
  }

  return foundStreams;
}

// Export for server usage
module.exports = { extractStreams };

// CLI Usage
if (require.main === module) {
  const TARGET_URL = process.argv[2];
  if (!TARGET_URL) {
    console.log("Usage: node extract.js <URL>");
    process.exit(1);
  }

  (async () => {
    console.log(`\n🔍 Extracting streams from: ${TARGET_URL}\n`);
    const streams = await extractStreams(TARGET_URL);
    if (streams.length === 0) {
      console.log("❌ No streams found.");
    } else {
      streams.forEach((s, i) => {
        console.log(`[${i+1}] ${s.type}: ${s.url}`);
        console.log(`    Referer: ${s.referer}`);
      });
    }
  })();
}
