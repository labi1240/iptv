const { chromium } = require("playwright");

(async () => {
  console.log("🚀 Starting Star Sports (Dadocric) Extraction...");
  
  const browser = await chromium.launch({
    headless: false, // Use headed mode to see what's happening
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  const streamUrls = new Set();

  // Intercept ALL network responses to find the playlist by content-type
  page.on("response", async (response) => {
    const url = response.url();
    const headers = response.headers();
    const contentType = headers["content-type"] || "";
    
    if (
      url.includes(".m3u8") || 
      contentType.includes("mpegurl") || 
      contentType.includes("x-mpegURL") ||
      url.includes("/playlist") ||
      url.includes("/master")
    ) {
      if (!streamUrls.has(url)) {
        console.log("\n✅ STREAM PLAYLIST FOUND:", url);
        console.log("   Content-Type:", contentType);
        console.log("   Referer:", headers["referer"] || "None");
        streamUrls.add(url);
      }
    }
  });

  // Keep the request interception for .ts chunks as a backup indicator
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes(".ts") && !url.includes("google") && !url.includes("analytics")) {
        // Just log a dot to show activity
        process.stdout.write(".");
    }
  });

  console.log("📡 Navigating to Star Sports embed...\n");

  try {
    await page.goto(
      "https://dadocric.st/player.php?id=starsp&v=m",
      { waitUntil: "networkidle", timeout: 45000 }
    );
  } catch (e) {
    console.log("⚠️ Initial navigation timeout/error, but continuing detection...");
  }

  console.log("⏳ Waiting for player to initialize...");
  await page.waitForTimeout(5000);

  // Try to find and click any play button
  const frames = page.frames();
  console.log(`\n📋 Found ${frames.length} frames`);

  for (const frame of frames) {
    try {
      const url = frame.url();
      console.log(`   Inspecting Frame: ${url}`);
      
      const playSelectors = [
        '.jw-icon-display', 
        '.play-button', 
        '[aria-label="Play"]', 
        '.vjs-big-play-button', 
        'svg', 
        '.play-icon',
        'video'
      ];
      
      for (const selector of playSelectors) {
        const btn = frame.locator(selector).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.log(`   ▶️ Found play element (${selector}), clicking...`);
          await btn.click({ force: true }).catch(() => {});
          await page.waitForTimeout(2000);
        }
      }
      
      // Center click fallback
      await frame.click('body', { position: { x: 300, y: 200 }, timeout: 2000 }).catch(() => {});
      
    } catch (err) {
      // Ignore frame errors
    }
  }

  console.log("\n📡 Monitoring for stream URLs (30 seconds)...");
  for (let i = 0; i < 6; i++) {
    process.stdout.write(".");
    await page.waitForTimeout(5000);
    await page.mouse.click(640, 360).catch(() => {});
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 SUMMARY - Stream Results:");
  console.log("=".repeat(60));

  if (streamUrls.size > 0) {
    Array.from(streamUrls).forEach((url, i) => {
      console.log(`\n[${i + 1}] ${url}`);
    });
  } else {
    console.log("❌ No definitive stream URLs intercepted.");
  }

  console.log("\n💡 Browser will remain open for 2 minutes for manual inspection.");
  await page.waitForTimeout(120000);

  await browser.close();
})();
