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
function proxyRequest(targetUrl, originalReferer, res) {
    const isM3u8 = targetUrl.includes('.m3u8');
    const referer = originalReferer || 'https://google.com';

    console.log(`[PROXY] Fetching: ${targetUrl.substring(0, 80)}...`);

    const curlArgs = [
        '-s', '-L',
        '--compressed',
        '--insecure',
        '--http1.1',
        '-H', `Referer: ${referer}`,
        '-H', `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`,
        '-H', 'Accept: */*',
        '-w', '\n%{http_code}',
        targetUrl,
    ];

    const curl = spawn('curl', curlArgs);
    const chunks = [];
    curl.stdout.on('data', (chunk) => chunks.push(chunk));
    
        curl.on('close', (code) => {
            const fullOutput = Buffer.concat(chunks);
            const fullStr = fullOutput.toString('binary');
            const lastNewline = fullStr.lastIndexOf('\n');
            const statusCode = parseInt(fullStr.substring(lastNewline + 1).trim(), 10) || 200;
            const bodyBuffer = fullOutput.slice(0, lastNewline >= 0 ? lastNewline : fullOutput.length);

            console.log(`[PROXY] Status: ${statusCode} for ${targetUrl.substring(0, 50)}...`);

            if (statusCode === 403 || statusCode === 401) {
                console.log(`❌ Proxy Denied (403/401)`);
                res.status(403).end('Access Denied by upstream');
                return;
            }

            if (code !== 0) {
                console.log(`❌ Proxy Curl Error Code: ${code}`);
                res.status(500).end('Internal Proxy Error');
                return;
            }

        if (isM3u8) {
            const body = bodyBuffer.toString('utf-8');
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
            res.set('Content-Type', 'video/mp2t');
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Cache-Control', 'public, max-age=3600'); // TS segments can be cached
            res.status(statusCode).send(bodyBuffer);
        }
    });
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
