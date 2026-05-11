const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    headless: false, // Use headed mode so you can see what's happening
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  const streamUrls = [];

  // Intercept ALL network requests to find m3u8/mpd/streaming URLs
  page.on("request", (request) => {
    const url = request.url();
    if (
      url.includes(".m3u8") ||
      url.includes(".mpd") ||
      url.includes("/playlist") ||
      url.includes("/master") ||
      url.includes("/index") ||
      url.includes("manifest")
    ) {
      console.log("\n🎯 STREAM URL FOUND:", url);
      console.log("   Headers:", JSON.stringify(request.headers(), null, 2));
      streamUrls.push({
        url,
        headers: request.headers(),
      });
    }
  });

  page.on("response", async (response) => {
    const url = response.url();
    const contentType = response.headers()["content-type"] || "";
    if (
      url.includes(".m3u8") ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL")
    ) {
      console.log("\n✅ M3U8 RESPONSE:", url);
      console.log("   Status:", response.status());
      console.log("   Content-Type:", contentType);
    }
  });

  console.log("📡 Navigating to embed page...\n");

  // Navigate to the embed page
  await page.goto(
    "https://streamed.pk/watch/punjab-kings-vs-delhi-capitals-2464280/admin/1",
    { waitUntil: "networkidle", timeout: 30000 }
  );

  console.log("⏳ Waiting for page to load...");
  await page.waitForTimeout(5000);

  // Try to access the iframe content
  const frames = page.frames();
  console.log(`\n📋 Found ${frames.length} frames`);

  for (const frame of frames) {
    const url = frame.url();
    console.log("   Frame URL:", url);

    // Inspect all likely player frames
    if (url.includes("player") || url.includes("embed") || url.includes("bello") || url.includes("php")) {
      console.log("\n🔍 Inspecting frame:", url);

      // Try clicking play button inside the frame
      try {
        console.log("\n▶️  Attempting to click play...");
        const playButton = frame.locator('.jw-icon-display, .play-button, [aria-label="Play"], .vjs-big-play-button, svg, .play-icon').first();
        if (await playButton.isVisible({ timeout: 5000 })) {
            await playButton.click({ force: true });
            console.log("   Clicked play button");
        } else {
            console.log("   No visible play button, trying center click...");
            await frame.click('body', { position: { x: 300, y: 200 } }).catch(() => {});
        }
        await page.waitForTimeout(5000);
      } catch (e) {
        console.log("   Click failed:", e.message);
      }
    }
  }

  // Wait a bit more for any lazy-loaded streams
  console.log("\n⏳ Waiting for additional network requests...");
  await page.waitForTimeout(10000);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 SUMMARY - All Stream URLs Found:");
  console.log("=".repeat(60));

  if (streamUrls.length > 0) {
    streamUrls.forEach((s, i) => {
      console.log(`\n[${i + 1}] ${s.url}`);
      console.log(`    Referer: ${s.headers.referer || 'N/A'}`);
      console.log(`    Origin: ${s.headers.origin || 'N/A'}`);
    });
  } else {
    console.log("❌ No stream URLs intercepted.");
  }

  console.log("\n💡 Press Ctrl+C to close the browser when done.");
  await page.waitForTimeout(60000); // Keep open for manual check

  await browser.close();
})();
