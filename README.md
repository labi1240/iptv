# StreamFinder — Universal IPTV Extractor & Proxy

A powerful tool to extract hidden `.m3u8` live streaming links and play them directly in a web interface using a built-in proxy to bypass Referer restrictions.

## Features
- **Universal Extraction:** Uses Playwright to sniff network traffic and find hidden playlists.
- **Header Proxy:** Built-in Express server that proxies video segments and injects required headers (Referer/User-Agent).
- **Responsive UI:** Modern, dark-mode interface with a built-in HLS player.

## Setup
1. `npm install`
2. `npx playwright install chromium`
3. `npm start`

## Deployment Note
**Important:** This project requires a full Node.js environment with Playwright dependencies. It is **not recommended for Vercel** due to browser limitations in serverless functions. Use **Railway.app**, **Heroku**, or a **VPS** for best results.
