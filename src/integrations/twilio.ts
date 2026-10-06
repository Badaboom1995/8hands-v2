// Twilio Voice: webhook signature check, TwiML for a Media Stream, and the
// one-time token that ties the stream back to a signed webhook.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * X-Twilio-Signature: base64 HMAC-SHA1 (auth token) of the full URL Twilio
 * requested plus every POST param, sorted by name, as name+value.
 */
export function validTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined): boolean {
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!token || !signature) return false;
    const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
    const expected = createHmac('sha1', token).update(data).digest();
    const got = Buffer.from(signature, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
}

// The stream URL can't carry a query string, and Twilio doesn't sign the
// WebSocket handshake in a way we rely on. Instead the signed webhook issues
// a short-lived token, passed as a <Parameter>, and the stream's `start`
// event must present it once.
const STREAM_TOKEN_TTL_MS = 60_000;
const streamTokens = new Map<string, number>();

export function issueStreamToken(): string {
    const now = Date.now();
    for (const [t, exp] of streamTokens) if (exp < now) streamTokens.delete(t);
    const token = randomBytes(24).toString('base64url');
    streamTokens.set(token, now + STREAM_TOKEN_TTL_MS);
    return token;
}

export function consumeStreamToken(token: string | undefined): boolean {
    if (!token) return false;
    const exp = streamTokens.get(token);
    streamTokens.delete(token);
    return exp !== undefined && exp >= Date.now();
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Connect the call's audio to our WebSocket; caller ID and token ride along as stream parameters. */
export function streamTwiml(streamUrl: string, params: Record<string, string>): string {
    const p = Object.entries(params)
        .map(([name, value]) => `<Parameter name="${xml(name)}" value="${xml(value)}"/>`)
        .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(streamUrl)}">${p}</Stream></Connect></Response>`;
}
