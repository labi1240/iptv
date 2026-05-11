const { chromium } = require("playwright");

(async () => {
  console.log("🚀 Starting Willow HD Extraction...");
  
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

  // Intercept ALL network requests
  page.on("request", (request) => {
    const url = request.url();
    // Broaden search criteria
    if (
      url.includes(".m3u8") ||
      url.includes(".mpd") ||
      url.includes("/playlist") ||
      url.includes("/master") ||
      url.includes("/index") ||
      url.includes("manifest") ||
      url.includes(".ts") ||
      url.includes("key") ||
      url.includes("hls")
    ) {
      if (!streamUrls.has(url)) {
        console.log("\n🎯 POTENTIAL STREAM URL FOUND:", url);
        console.log("   Method:", request.method());
        console.log("   Headers:", JSON.stringify(request.headers(), null, 2));
        streamUrls.add(url);
      }
    }
  });

  console.log("📡 Navigating to Willow HD embed...\n");

  try {
    await page.goto(
      "https://playerado.top/embed2.php?id=willowhd",
      { waitUntil: "networkidle", timeout: 60000 }
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
      
      // Look for play buttons or just click the center
      const playSelectors = [
        '.jw-icon-display', 
        '.play-button', 
        '[aria-label="Play"]', 
        '.vjs-big-play-button', 
        'svg', 
        '.play-icon',
        '#player',
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
      console.log("   🖱️ Attempting center click fallback...");
      await frame.click('body', { position: { x: 300, y: 200 }, timeout: 2000 }).catch(() => {});
      
    } catch (err) {
      console.log(`   ❌ Frame inspection error: ${err.message}`);
    }
  }

  console.log("\n📡 Monitoring for stream URLs (60 seconds)...");
  // Keep monitoring for a minute
  for (let i = 0; i < 12; i++) {
    process.stdout.write(".");
    await page.waitForTimeout(5000);
    // Occasionally click center to keep active
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
    console.log("   Note: The player may be using an encrypted or non-standard transport.");
  }

  console.log("\n💡 Browser will remain open for 2 minutes for manual inspection.");
  await page.waitForTimeout(120000);

  await browser.close();
})();

