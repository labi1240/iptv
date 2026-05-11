const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
const { extractStreams } = require('./extract');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Proxy logic ───
async function proxyRequest(targetUrl, originalReferer, res) {
    const isM3u8 = targetUrl.includes('.m3u8');
    const referer = originalReferer || 'https://google.com';

    console.log(`[PROXY] Fetching: ${targetUrl.substring(0, 80)}...`);

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'Referer': referer,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*'
            }
        });

        const statusCode = response.status;
        const contentType = response.headers.get('content-type');
        console.log(`[PROXY] Status: ${statusCode} for ${targetUrl.substring(0, 50)}...`);

        if (!response.ok) {
            console.log(`❌ Proxy Failed: ${statusCode}`);
            res.status(statusCode).send('Error from upstream');
            return;
        }

        const bodyBuffer = await response.arrayBuffer();

        if (isM3u8) {
            const body = Buffer.from(bodyBuffer).toString('utf-8');
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
            const rewritten = body.split('\n').map(line => {
                line = line.trim();
                if (line.startsWith('#') || line === '') return line;
                let absoluteUrl = line.startsWith('http') ? line : baseUrl + line;
                return `/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}`;
            }).join('\n');

            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.set('Pragma', 'no-cache');
            res.set('Expires', '0');
            res.status(200).send(rewritten);
        } else {
            res.set('Content-Type', contentType || 'video/mp2t');
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Cache-Control', 'public, max-age=3600');
            res.status(200).send(Buffer.from(bodyBuffer));
        }
    } catch (error) {
        console.error(`❌ Proxy Fetch Error:`, error.message);
        res.status(500).send('Proxy Connection Error');
    }
}

// ─── Endpoints ───

app.get('/proxy', (req, res) => {
    const { url, referer } = req.query;
    if (!url) return res.status(400).send('Missing url');
    proxyRequest(url, referer, res);
});

app.post('/api/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    console.log(`\n🔍 Extraction request received for: ${url}`);
    try {
        const streams = await extractStreams(url);
        console.log(`✅ Extraction complete. Found ${streams.length} streams.`);
        res.json({ streams });
    } catch (error) {
        console.error('❌ Extraction failed:', error);
        res.status(500).json({ error: 'Failed to extract streams' });
    }
});

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║     🚀 StreamFinder UI + Proxy is running!               ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  URL: http://localhost:${PORT}                             ║
║                                                          ║
║  1. Open the URL in your browser                         ║
║  2. Paste a streaming site URL                           ║
║  3. Play directly in the UI                              ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);
});
