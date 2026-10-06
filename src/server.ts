// agent-v2 entry — routes only. Transport logic lives in core/transport.ts,
// per-client dialects in codecs/, agent logic in core/session.ts.
// Run:  bun run dev   → http://localhost:3100

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { completeEnrollment, EnrollmentError, getPublicSession, startEnrollment } from './card/enrollment';
import { startCallerLookup } from './card/identify';
import { browserCodec } from './codecs/browser';
import { twilioCodec } from './codecs/twilio';
import { GREETING_V2 as GREETING, instructionsV2 } from './instructions-v2';
import { sendCardLinkTool } from './tools/card-link';
import { squareAvailabilityTool } from './tools/square/availability';
import { squareBookTool } from './tools/square/book';
import { squareMastersTool } from './tools/square/masters';
import { squareServicesTool } from './tools/square/services';
import { updateCallStateTool } from './tools/update-state';
import { attachCall } from './core/transport';
import { hasPin, pinGateEnabled, pinPage, submitPin } from './http/pin-gate';
import { consumeStreamToken, issueStreamToken, streamTwiml, validTwilioSignature } from './integrations/twilio';
import type { AgentSessionOptions } from './core/session';

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
const PORT = Number(process.env.PORT || process.env.AGENT_V2_PORT || 3100);
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

function readForm(req: http.IncomingMessage): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > 64_000) reject(new Error('body too large')); });
        req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))));
        req.on('error', reject);
    });
}

/** Host the caller reached us on (ngrok/proxy forward the public one). */
function publicHost(req: http.IncomingMessage): string {
    return String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${PORT}`);
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
        if (req.method === 'GET' && url === '/health') return sendJson(res, 200, { ok: true });
        if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
            if (!hasPin(req)) {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                return res.end(pinPage());
            }
            return sendHtml(res, 'index.html');
        }
        if (req.method === 'POST' && url === '/pin') {
            const error = submitPin(req, res, String((await readForm(req)).pin ?? ''));
            if (error) {
                res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                return res.end(pinPage(error));
            }
            res.writeHead(303, { location: '/' });
            return res.end();
        }
        if (req.method === 'GET' && url.startsWith('/card-on-file')) return sendHtml(res, 'card-on-file.html');

        // Twilio: incoming call → stream its audio to /twilio/media.
        if (req.method === 'POST' && url === '/twilio/voice') {
            const params = await readForm(req);
            const host = publicHost(req);
            const signature = req.headers['x-twilio-signature'] as string | undefined;
            if (!validTwilioSignature(`https://${host}${url}`, params, signature)) {
                console.warn('[twilio] rejected webhook: bad or missing signature (check TWILIO_AUTH_TOKEN and the webhook URL)');
                res.writeHead(403);
                return res.end('forbidden');
            }
            console.log(`[twilio] incoming call ${params.CallSid} from ${params.From} to ${params.To}`);
            res.writeHead(200, { 'content-type': 'text/xml' });
            return res.end(streamTwiml(`wss://${host}/twilio/media`, { token: issueStreamToken(), from: params.From ?? '' }));
        }

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
            if (!hasPin(req)) return sendJson(res, 401, { code: 'pin_required', message: 'PIN required' });
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

const sessionOptions = (): Omit<AgentSessionOptions, 'audioFormat' | 'callerPhone'> => ({
    apiKey: API_KEY,
    model: MODEL,
    instructions: instructionsV2(),
    greeting: GREETING,
    tools: [updateCallStateTool, squareServicesTool, squareMastersTool, squareAvailabilityTool, squareBookTool, sendCardLinkTool],
    onCallStart: startCallerLookup,
    debug: DEBUG,
});

const browserWss = new WebSocketServer({ noServer: true });
browserWss.on('connection', (ws, req) => {
    // The browser test UI simulates caller ID with ?phone=.
    const callerPhone = new URL(req.url ?? '/', 'http://localhost').searchParams.get('phone') || undefined;
    attachCall(ws, browserCodec(), { ...sessionOptions(), audioFormat: { type: 'audio/pcm', rate: 24000 }, callerPhone });
});

// Twilio Media Stream; caller ID comes in the stream's `start` event.
const twilioWss = new WebSocketServer({ noServer: true });
twilioWss.on('connection', (ws) => {
    attachCall(ws, twilioCodec({ acceptToken: consumeStreamToken }), { ...sessionOptions(), audioFormat: { type: 'audio/pcmu' } });
});

// Several WebSocket servers on one HTTP server: route the upgrade by path.
server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const wss = pathname === '/ws' ? browserWss : pathname === '/twilio/media' ? twilioWss : null;
    if (!wss) return socket.destroy();
    if (wss === browserWss && !hasPin(req)) {
        return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(PORT, () => {
    console.log(`agent-v2 web UI: http://localhost:${PORT} (model: ${MODEL}, test page PIN ${pinGateEnabled ? 'on' : 'off'})`);
});
