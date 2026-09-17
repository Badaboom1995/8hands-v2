// Minimal Square REST client (fetch-based). Only what the agent needs.

const ENV = process.env.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
const BASE = ENV === 'production' ? 'https://connect.squareup.com/v2' : 'https://connect.squareupsandbox.com/v2';
const VERSION = '2026-08-20';

export const squareEnvironment = ENV;

export class SquareError extends Error {
    constructor(readonly status: number, readonly errors: { category?: string; code?: string; detail?: string }[]) {
        super(errors[0]?.detail || `Square request failed (${status})`);
    }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = process.env.SQUARE_ACCESS_TOKEN;
    if (!token) throw new Error('SQUARE_ACCESS_TOKEN is not set');
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Square-Version': VERSION, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { errors?: SquareError['errors'] };
    if (!res.ok || (json.errors && json.errors.length)) throw new SquareError(res.status, json.errors ?? []);
    return json as T;
}

export interface SquareCustomer {
    id: string;
    given_name?: string;
    family_name?: string;
    email_address?: string;
    phone_number?: string;
}

export interface SquareCard {
    id: string;
    enabled?: boolean;
    card_brand?: string;
    last_4?: string;
    customer_id?: string;
}

/** Every customer whose phone matches exactly (E.164). */
export async function searchCustomersByPhone(phone: string): Promise<SquareCustomer[]> {
    const out: SquareCustomer[] = [];
    let cursor: string | undefined;
    do {
        const r = await call<{ customers?: SquareCustomer[]; cursor?: string }>('POST', '/customers/search', {
            ...(cursor ? { cursor } : {}),
            query: { filter: { phone_number: { exact: phone } } },
        });
        out.push(...(r.customers ?? []));
        cursor = r.cursor;
    } while (cursor);
    return out;
}

export async function createCustomer(input: {
    idempotencyKey: string; givenName: string; familyName: string; email: string; phone: string;
}): Promise<SquareCustomer> {
    const r = await call<{ customer: SquareCustomer }>('POST', '/customers', {
        idempotency_key: input.idempotencyKey,
        given_name: input.givenName,
        family_name: input.familyName,
        email_address: input.email,
        phone_number: input.phone,
    });
    return r.customer;
}

export async function updateCustomer(id: string, input: {
    givenName: string; familyName: string; email: string; phone: string;
}): Promise<SquareCustomer> {
    const r = await call<{ customer: SquareCustomer }>('PUT', `/customers/${id}`, {
        given_name: input.givenName,
        family_name: input.familyName,
        email_address: input.email,
        phone_number: input.phone,
    });
    return r.customer;
}

/** True if the customer has at least one enabled card on file. */
export async function hasEnabledCard(customerId: string): Promise<boolean> {
    let cursor: string | undefined;
    do {
        const q = new URLSearchParams({ customer_id: customerId, include_disabled: 'false' });
        if (cursor) q.set('cursor', cursor);
        const r = await call<{ cards?: SquareCard[]; cursor?: string }>('GET', `/cards?${q}`);
        if ((r.cards ?? []).some((c) => c.enabled !== false)) return true;
        cursor = r.cursor;
    } while (cursor);
    return false;
}

export async function createCard(input: {
    idempotencyKey: string; sourceId: string; customerId: string; cardholderName: string;
}): Promise<SquareCard> {
    const r = await call<{ card: SquareCard }>('POST', '/cards', {
        idempotency_key: input.idempotencyKey,
        source_id: input.sourceId,
        card: { customer_id: input.customerId, cardholder_name: input.cardholderName },
    });
    return r.card;
}
