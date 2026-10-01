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

/** Every customer whose email matches exactly (Square compares case-insensitively). */
export async function searchCustomersByEmail(email: string): Promise<SquareCustomer[]> {
    const out: SquareCustomer[] = [];
    let cursor: string | undefined;
    do {
        const r = await call<{ customers?: SquareCustomer[]; cursor?: string }>('POST', '/customers/search', {
            ...(cursor ? { cursor } : {}),
            query: { filter: { email_address: { exact: email } } },
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

// ---- Bookings read side: locations, services, team, availability ----

export interface SquareLocation {
    id: string;
    name: string;
    status?: string;
    timezone?: string;
}

/** Active locations. */
export async function listLocations(): Promise<SquareLocation[]> {
    const r = await call<{ locations?: SquareLocation[] }>('GET', '/locations');
    return (r.locations ?? []).filter((l) => l.status === 'ACTIVE');
}

export interface SquareVariation {
    id: string;
    version?: number;
    is_deleted?: boolean;
    item_variation_data?: {
        name?: string;
        price_money?: { amount: number; currency: string };
        /** Milliseconds. */
        service_duration?: number;
        available_for_booking?: boolean;
        team_member_ids?: string[];
    };
}

export interface SquareServiceItem {
    id: string;
    is_deleted?: boolean;
    item_data?: {
        name?: string;
        product_type?: string;
        is_archived?: boolean;
        variations?: SquareVariation[];
    };
}

/** Appointment services, each with only its bookable variations. Items with none are dropped. */
export async function listServiceItems(): Promise<SquareServiceItem[]> {
    const out: SquareServiceItem[] = [];
    let cursor: string | undefined;
    do {
        const r = await call<{ objects?: SquareServiceItem[]; cursor?: string }>('POST', '/catalog/search', {
            object_types: ['ITEM'],
            ...(cursor ? { cursor } : {}),
        });
        out.push(...(r.objects ?? []));
        cursor = r.cursor;
    } while (cursor);

    return out
        .filter((i) => !i.is_deleted && !i.item_data?.is_archived && i.item_data?.product_type === 'APPOINTMENTS_SERVICE')
        .map((i) => ({
            ...i,
            item_data: {
                ...i.item_data,
                variations: (i.item_data?.variations ?? [])
                    .filter((v) => !v.is_deleted && v.item_variation_data?.available_for_booking),
            },
        }))
        .filter((i) => i.item_data.variations.length > 0);
}

export interface SquareTeamMember {
    id: string;
    given_name?: string;
    family_name?: string;
    assigned_locations?: {
        assignment_type?: 'ALL_CURRENT_AND_FUTURE_LOCATIONS' | 'EXPLICIT_LOCATIONS';
        location_ids?: string[];
    };
}

/** Active team members who have a bookable booking profile. */
export async function listBookableTeam(): Promise<SquareTeamMember[]> {
    const members: (SquareTeamMember & { status?: string })[] = [];
    const bookable = new Set<string>();
    await Promise.all([
        (async () => {
            let cursor: string | undefined;
            do {
                const r = await call<{ team_members?: typeof members; cursor?: string }>('POST', '/team-members/search', {
                    query: { filter: { status: 'ACTIVE' } },
                    limit: 100,
                    ...(cursor ? { cursor } : {}),
                });
                members.push(...(r.team_members ?? []));
                cursor = r.cursor;
            } while (cursor);
        })(),
        (async () => {
            let cursor: string | undefined;
            do {
                const q = new URLSearchParams({ bookable_only: 'true', limit: '100' });
                if (cursor) q.set('cursor', cursor);
                const r = await call<{
                    team_member_booking_profiles?: { team_member_id: string; is_bookable?: boolean }[]; cursor?: string;
                }>('GET', `/bookings/team-member-booking-profiles?${q}`);
                for (const p of r.team_member_booking_profiles ?? []) if (p.is_bookable) bookable.add(p.team_member_id);
                cursor = r.cursor;
            } while (cursor);
        })(),
    ]);
    return members.filter((m) => bookable.has(m.id));
}

export interface SquareAvailability {
    start_at: string;
    location_id: string;
    appointment_segments: {
        duration_minutes: number;
        team_member_id: string;
        service_variation_id: string;
        service_variation_version: number;
    }[];
}

/**
 * Free start times at one location for services done back to back, in order.
 * Square takes each service's duration from the catalog and returns only starts
 * where the whole run fits. Without teamMemberIds it returns one team member per
 * start time, not everyone who is free. The range must be in the future and at
 * most ~31 days.
 */
export async function searchAvailability(input: {
    locationId: string; startAt: string; endAt: string;
    segments: { serviceVariationId: string; teamMemberIds?: string[] }[];
}): Promise<SquareAvailability[]> {
    const r = await call<{ availabilities?: SquareAvailability[] }>('POST', '/bookings/availability/search', {
        query: {
            filter: {
                start_at_range: { start_at: input.startAt, end_at: input.endAt },
                location_id: input.locationId,
                segment_filters: input.segments.map((s) => ({
                    service_variation_id: s.serviceVariationId,
                    ...(s.teamMemberIds ? { team_member_id_filter: { any: s.teamMemberIds } } : {}),
                })),
            },
        },
    });
    return r.availabilities ?? [];
}

export interface SquareBooking {
    id: string;
    version?: number;
    /** PENDING, ACCEPTED, CANCELLED_BY_*, DECLINED, NO_SHOW. */
    status: string;
    start_at: string;
    location_id: string;
    customer_id?: string;
}

export interface BookingSegment {
    teamMemberId: string;
    serviceVariationId: string;
    serviceVariationVersion: number;
    durationMinutes: number;
}

/** One appointment of one or more services back to back. The idempotency key must be stable across retries. */
export async function createBooking(input: {
    idempotencyKey: string;
    startAt: string;
    locationId: string;
    customerId: string;
    segments: BookingSegment[];
    sellerNote?: string;
}): Promise<SquareBooking> {
    const r = await call<{ booking: SquareBooking }>('POST', '/bookings', {
        idempotency_key: input.idempotencyKey,
        booking: {
            start_at: input.startAt,
            location_id: input.locationId,
            location_type: 'BUSINESS_LOCATION',
            customer_id: input.customerId,
            ...(input.sellerNote ? { seller_note: input.sellerNote } : {}),
            appointment_segments: input.segments.map((s) => ({
                team_member_id: s.teamMemberId,
                service_variation_id: s.serviceVariationId,
                service_variation_version: s.serviceVariationVersion,
                duration_minutes: s.durationMinutes,
            })),
        },
    });
    return r.booking;
}
