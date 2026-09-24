// agent-v2 entry — routes only. Transport logic lives in transport.ts,
// per-client dialects in codec-*.ts, agent logic in session.ts.
// Run from repo root:  npx tsx agent-v2/server.ts   → http://localhost:3100

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { completeEnrollment, EnrollmentError, getPublicSession, startEnrollment } from './card/enrollment';
import { startCallerLookup } from './card/identify';
import { browserCodec } from './codecs/browser';
import { GREETING, INSTRUCTIONS } from './instructions';
import { sendCardLinkTool } from './tools/card-link';
import { squareAvailabilityTool } from './tools/square/availability';
import { squareBookTool } from './tools/square/book';
import { squareMastersTool } from './tools/square/masters';
import { squareServicesTool } from './tools/square/services';
import { updateCallStateTool } from './tools/update-state';
import { attachCall } from './core/transport';

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
const PORT = Number(process.env.AGENT_V2_PORT || 3100);
const DEBUG = Boolean(process.env.AGENT_V2_DEBUG);

if (!API_KEY) {
    console.error('OPENAI_API_KEY is required');
    process.exit(1);
}

const WEB = path.join(__dirname, 'web');

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > 64_000) reject(new Error('body too large')); });
        req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

function sendHtml(res: http.ServerResponse, file: string): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(WEB, file)));
}

const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    try {
        if (req.method === 'GET' && (url === '/' || url === '/index.html')) return sendHtml(res, 'index.html');
        if (req.method === 'GET' && url.startsWith('/card-on-file')) return sendHtml(res, 'card-on-file.html');

        // Card-on-file enrollment (public page ↔ server)
        if (req.method === 'POST' && url === '/api/card-enrollment/session') {
            const body = await readJson(req);
            return sendJson(res, 200, getPublicSession(String(body.token ?? '')));
        }
        if (req.method === 'POST' && url === '/api/card-enrollment/complete') {
            const b = await readJson(req);
            const out = await completeEnrollment({
                token: String(b.token ?? ''), sourceId: String(b.sourceId ?? ''),
                fullName: String(b.fullName ?? ''), email: String(b.email ?? ''), consent: b.consent === true,
            });
            return sendJson(res, 200, { success: true, customerId: out.customerId });
        }
        // Dev helper until the agent tool exists: start a session and get the link.
        if (req.method === 'POST' && url === '/api/card-enrollment/start') {
            const b = await readJson(req);
            return sendJson(res, 200, await startEnrollment({ phone: String(b.phone ?? ''), email: String(b.email ?? '') }));
        }

        res.writeHead(404);
        res.end('not found');
    } catch (err) {
        if (err instanceof EnrollmentError) return sendJson(res, err.status, { code: err.code, message: err.message });
        console.error('[http]', err);
        sendJson(res, 500, { code: 'internal', message: (err as Error).message });
    }
});

const browserWss = new WebSocketServer({ server, path: '/ws' });
browserWss.on('connection', (ws, req) => {
    // The browser test UI simulates caller ID with ?phone=.
    const callerPhone = new URL(req.url ?? '/', 'http://localhost').searchParams.get('phone') || undefined;
    attachCall(ws, browserCodec(), {
        apiKey: API_KEY,
        model: MODEL,
        instructions: INSTRUCTIONS,
        greeting: GREETING,
        audioFormat: { type: 'audio/pcm', rate: 24000 },
        tools: [updateCallStateTool, squareServicesTool, squareMastersTool, squareAvailabilityTool, squareBookTool, sendCardLinkTool],
        callerPhone,
        onCallStart: startCallerLookup,
        debug: DEBUG,
    });
});

// Later: a /twilio WebSocketServer here, attachCall(ws, twilioCodec(), {
//     ...same options, audioFormat: { type: 'audio/pcmu' },
// }) — plus the TwiML webhook.

server.listen(PORT, () => {
    console.log(`agent-v2 web UI: http://localhost:${PORT} (model: ${MODEL})`);
});
