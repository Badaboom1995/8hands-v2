// PIN gate for the browser test page (/, /ws, dev endpoints). Off when TEST_PAGE_PIN is unset.
// A correct PIN sets an HttpOnly cookie holding an HMAC of the PIN, so changing the PIN logs everyone out.

import crypto from 'node:crypto';
import type http from 'node:http';

const PIN = process.env.TEST_PAGE_PIN || '';
const COOKIE = 'test_pin';
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60_000;

const fails = new Map<string, { count: number; since: number }>();

export const pinGateEnabled = PIN.length > 0;

function cookieValue(): string {
    return crypto.createHmac('sha256', PIN).update('8hands-test-page').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function clientIp(req: http.IncomingMessage): string {
    return String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() || req.socket.remoteAddress || '?';
}

/** True if the request may use the test page. */
export function hasPin(req: http.IncomingMessage): boolean {
    if (!pinGateEnabled) return true;
    const cookies = Object.fromEntries(
        String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=') as [string, string]),
    );
    return typeof cookies[COOKIE] === 'string' && safeEqual(cookies[COOKIE], cookieValue());
}

/** Check a submitted PIN; on success set the cookie. Returns an error message or null. */
export function submitPin(req: http.IncomingMessage, res: http.ServerResponse, pin: string): string | null {
    const ip = clientIp(req);
    const now = Date.now();
    const f = fails.get(ip);
    if (f && now - f.since > FAIL_WINDOW_MS) fails.delete(ip);
    if ((fails.get(ip)?.count ?? 0) >= MAX_FAILS) return 'Too many attempts. Try again later.';
    if (!safeEqual(pin, PIN)) {
        const cur = fails.get(ip) ?? { count: 0, since: now };
        cur.count++;
        fails.set(ip, cur);
        return 'Wrong PIN.';
    }
    fails.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('set-cookie', `${COOKIE}=${cookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
    return null;
}

export function pinPage(error?: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>8Hands test</title>
<style>body{font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f6f6f4}
form{display:grid;gap:12px;padding:28px;background:#fff;border-radius:12px;box-shadow:0 2px 12px #0001}
input{font:24px ui-monospace,monospace;letter-spacing:.3em;text-align:center;width:9ch;padding:8px}
button{font:16px system-ui;padding:8px}.e{color:#b00020;margin:0;text-align:center}</style></head>
<body><form method="post" action="/pin"><label for="pin">Enter PIN</label>
<input id="pin" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" autofocus required>
${error ? `<p class="e">${error}</p>` : ''}<button>Open</button></form></body></html>`;
}
