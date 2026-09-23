// Card-on-file enrollment.
//
// The agent never sees card data. On the call we learn phone + email; the server
// creates a short-lived session and sends a link to /card-on-file#<token>. The
// page loads Square's Web Payments form, the caller enters the card, Square
// returns a token, and complete() turns it into a Customer + Card in Square.
//
// Sessions are in memory for now (one process, 30-minute expiry).

import crypto from 'node:crypto';

import * as square from '../integrations/square';

const EXPIRY_MINUTES = 30;
const MAX_COMPLETION_ATTEMPTS = 5;

export class EnrollmentError extends Error {
    constructor(readonly code: string, message: string, readonly status = 400) {
        super(message);
    }
}

interface Session {
    id: string;
    tokenHash: string;
    phone: string;
    email: string;
    customerId: string | null;
    status: 'pending' | 'completed';
    expiresAt: number;
    attempts: number;
}

const sessions = new Map<string, Session>(); // key: tokenHash

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const idem = (sessionId: string, step: string) => crypto.createHash('sha256').update(`${sessionId}:${step}`).digest('hex').slice(0, 45);

/** Digits only, E.164 with US default. */
export function normalizePhone(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (raw.trim().startsWith('+') && digits.length >= 8) return `+${digits}`;
    throw new EnrollmentError('invalid_phone', 'A valid phone number is required');
}

const normalizeEmail = (e: string) => {
    const v = e.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new EnrollmentError('invalid_email', 'A valid email is required');
    return v;
};

function splitName(full: string): { givenName: string; familyName: string } {
    const parts = full.trim().replace(/\s+/g, ' ').split(' ');
    if (parts.length < 2 || !parts[0]) throw new EnrollmentError('invalid_name', 'First and last name are required');
    return { givenName: parts[0], familyName: parts.slice(1).join(' ') };
}

// ── Customer + card lookup (the booking gate reads this) ──

export type CardLookup =
    | { kind: 'none' }                                   // no profile for this phone
    | { kind: 'one'; customerId: string; hasCard: boolean }
    | { kind: 'ambiguous'; count: number };               // several profiles, a human decides

export async function lookupCardOnFile(phoneRaw: string): Promise<CardLookup> {
    const phone = normalizePhone(phoneRaw);
    const customers = await square.searchCustomersByPhone(phone);
    if (customers.length === 0) return { kind: 'none' };
    if (customers.length === 1) {
        return { kind: 'one', customerId: customers[0].id, hasCard: await square.hasEnabledCard(customers[0].id) };
    }
    // Several profiles: never pick one (not by card, visits, recency, or email). A human decides.
    return { kind: 'ambiguous', count: customers.length };
}

// ── Session lifecycle ──

export async function startEnrollment(input: { phone: string; email: string }): Promise<
    { started: true; url: string; expiresAt: string; expiresInMinutes: number } | { started: false; reason: 'already_has_card' | 'ambiguous' }
> {
    const phone = normalizePhone(input.phone);
    const email = normalizeEmail(input.email);
    const lookup = await lookupCardOnFile(phone);
    if (lookup.kind === 'ambiguous') return { started: false, reason: 'ambiguous' };
    if (lookup.kind === 'one' && lookup.hasCard) return { started: false, reason: 'already_has_card' };

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const session: Session = {
        id: crypto.randomUUID(),
        tokenHash: hashToken(rawToken),
        phone,
        email,
        customerId: lookup.kind === 'one' ? lookup.customerId : null,
        status: 'pending',
        expiresAt: Date.now() + EXPIRY_MINUTES * 60_000,
        attempts: 0,
    };
    sessions.set(session.tokenHash, session);

    const base = process.env.PUBLIC_BASE_URL || 'http://localhost:3100';
    const url = `${base}/card-on-file#${rawToken}`;
    await sendEnrollmentEmail({ to: email, url, expiresInMinutes: EXPIRY_MINUTES });
    return { started: true, url, expiresAt: new Date(session.expiresAt).toISOString(), expiresInMinutes: EXPIRY_MINUTES };
}

function requirePending(token: string): Session {
    const s = token ? sessions.get(hashToken(token)) : undefined;
    if (!s || s.status !== 'pending') throw new EnrollmentError('link_unavailable', 'This secure link is missing or has already been used', 404);
    if (Date.now() > s.expiresAt) throw new EnrollmentError('link_expired', 'This secure link has expired', 410);
    return s;
}

/** What the public page needs to render Square's card form. */
export function getPublicSession(token: string) {
    const s = requirePending(token);
    const applicationId = process.env.SQUARE_APPLICATION_ID;
    const locationId = process.env.SQUARE_LOCATION_ID;
    if (!applicationId || !locationId) throw new EnrollmentError('square_unavailable', 'Square is not configured', 500);
    return {
        salonName: process.env.BUSINESS_NAME || 'Test Studio',
        squareApplicationId: applicationId,
        squareLocationId: locationId,
        squareEnvironment: square.squareEnvironment,
        expiresAt: new Date(s.expiresAt).toISOString(),
        email: s.email,
        policy: { under24HoursPercent: 50, sameDayPercent: 100 }, // TODO: business config
    };
}

/** Called by the page with Square's card token. Creates/updates the customer, stores the card. */
export async function completeEnrollment(input: {
    token: string; sourceId: string; fullName: string; email: string; consent: boolean;
}): Promise<{ customerId: string; cardId: string }> {
    if (input.consent !== true || !input.sourceId?.trim()) {
        throw new EnrollmentError('invalid_request', 'Consent and a Square card token are required');
    }
    const name = splitName(input.fullName);
    const email = normalizeEmail(input.email);
    const s = requirePending(input.token);
    if (s.attempts >= MAX_COMPLETION_ATTEMPTS) throw new EnrollmentError('attempt_limit', 'Too many attempts', 429);
    s.attempts += 1;

    // Re-resolve the customer now; profiles may have changed since the call.
    let customerId = s.customerId;
    if (!customerId) {
        const found = await square.searchCustomersByPhone(s.phone);
        if (found.length === 1) customerId = found[0].id;
        else if (found.length > 1) {
            // Never pick between duplicate profiles; a human resolves them.
            throw new EnrollmentError('ambiguous_customer', 'Existing customer profiles could not be resolved safely', 409);
        }
    }
    const fields = { givenName: name.givenName, familyName: name.familyName, email, phone: s.phone };
    if (customerId) await square.updateCustomer(customerId, fields);
    else customerId = (await square.createCustomer({ idempotencyKey: idem(s.id, 'create-customer'), ...fields })).id;

    const card = await square.createCard({
        idempotencyKey: idem(s.id, `create-card-${s.attempts}`),
        sourceId: input.sourceId,
        customerId,
        cardholderName: `${name.givenName} ${name.familyName}`,
    });
    if (!card.id || card.enabled === false) throw new EnrollmentError('card_not_enabled', 'Square did not return an enabled card', 502);

    s.customerId = customerId;
    s.status = 'completed';
    return { customerId, cardId: card.id };
}

// ── Delivery ──
// Email via Resend when RESEND_API_KEY is set; otherwise the link is logged so
// it can be opened by hand in development.

async function sendEnrollmentEmail(input: { to: string; url: string; expiresInMinutes: number }): Promise<void> {
    const key = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!key || !from) {
        console.log(`[card-on-file] no email provider configured; link for ${input.to}: ${input.url}`);
        return;
    }
    const salon = process.env.BUSINESS_NAME || 'Test Studio';
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from, to: input.to,
            subject: `Add a card on file for ${salon}`,
            html: `<p>Hi,</p><p>To finish your booking with ${salon}, please add a card on file. No charge is made today.</p>
<p><a href="${input.url}">Add card securely via Square</a></p><p>This link expires in ${input.expiresInMinutes} minutes.</p>`,
        }),
    });
    if (!res.ok) throw new Error(`email delivery failed (${res.status})`);
}
