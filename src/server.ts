// agent-v2 entry — routes only. Transport logic lives in transport.ts,
// per-client dialects in codec-*.ts, agent logic in session.ts.
// Run from repo root:  npx tsx agent-v2/server.ts   → http://localhost:3100

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { browserCodec } from './codecs/browser';
import { GREETING, INSTRUCTIONS } from './instructions';
import { attachCall } from './core/transport';
import { checkAvailabilityTool } from './tools/availability';
import { updateCallStateTool } from './tools/update-state';

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const PORT = Number(process.env.AGENT_V2_PORT || 3100);
const DEBUG = Boolean(process.env.AGENT_V2_DEBUG);

if (!API_KEY) {
    console.error('OPENAI_API_KEY is required');
    process.exit(1);
}

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, 'web', 'index.html')));
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

const browserWss = new WebSocketServer({ server, path: '/ws' });
browserWss.on('connection', (ws) => {
    attachCall(ws, browserCodec(), {
        apiKey: API_KEY,
        model: MODEL,
        instructions: INSTRUCTIONS,
        greeting: GREETING,
        audioFormat: { type: 'audio/pcm', rate: 24000 },
        tools: [updateCallStateTool, checkAvailabilityTool],
        debug: DEBUG,
    });
});

// Later: a /twilio WebSocketServer here, attachCall(ws, twilioCodec(), {
//     ...same options, audioFormat: { type: 'audio/pcmu' },
// }) — plus the TwiML webhook.

server.listen(PORT, () => {
    console.log(`agent-v2 web UI: http://localhost:${PORT} (model: ${MODEL})`);
});
