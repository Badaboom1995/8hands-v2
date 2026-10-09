// Visit history: the caller's past visits, read live from Square, and the
// server-side rules for services that depend on them (free fix, refill).
//
// The agent learns the process from free_fix_instructions / refill_instructions,
// reads the facts with square_visit_history, and saves the service like any
// other. Before any search or booking of such a service, historyGate checks the
// rules again here: the model decides what to offer, the server decides what
// may be booked.

import { z } from 'zod';

import { BUSINESS } from '../../business';
import { historyService, type CallState } from '../../core/state';
import { defineTool } from '../../core/tools';
import {
    listCustomerBookings, listLocations, teamMemberNames, variationItemNames, type SquareBooking,
} from '../../integrations/square';
import { dayLabel, localDate, matchByName, normalize } from './shared';

const DAY_MS = 86_400_000;

/** One past visit: a past, accepted booking. */
export interface Visit {
    /** Local date YYYY-MM-DD. */
    date: string;
    /** "Mon, Oct 5" */
    day: string;
    /** Calendar days before today, in the business time zone. */
    daysAgo: number;
    /** Provider item names, in booking order. */
    services: string[];
    /** Names, aligned with ref.teamMemberIds. */
    masters: string[];
    studio: string;
    extensions: boolean;
    /** Provider ids. Never shown to the model. */
    ref: { bookingId: string; locationId: string; teamMemberIds: string[] };
}

type Rules = typeof BUSINESS.history;

/** YYYY-MM-DD plus n days. */
export function addDays(date: string, n: number): string {
    const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + n));
    return d.toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to`, both YYYY-MM-DD. */
function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

const sameService = (a: string, b: string) => normalize(a) === normalize(b);

/** A booking is a visit if it was accepted and has already started; cancelled and no-shows are not. */
export function isVisit(b: SquareBooking, now: number): boolean {
    return b.status === 'ACCEPTED' && Date.parse(b.start_at) <= now;
}

// ---- Reading history ----

/** The customer's visits in the lookback window, newest first. */
export async function loadVisits(customerId: string, now = Date.now()): Promise<Visit[]> {
    const tz = BUSINESS.timezone;
    const rules = BUSINESS.history;
    const bookings = (await listCustomerBookings(customerId, new Date(now - rules.lookbackDays * DAY_MS), new Date(now + 60_000)))
        .filter((b) => isVisit(b, now))
        .sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at));

    const segments = bookings.flatMap((b) => b.appointment_segments ?? []);
    const [items, staff, locations] = await Promise.all([
        variationItemNames([...new Set(segments.map((s) => s.service_variation_id).filter((id): id is string => !!id))]),
        teamMemberNames([...new Set(segments.map((s) => s.team_member_id).filter((id): id is string => !!id))]),
        listLocations(),
    ]);
    const studio = new Map(locations.map((l) => [l.id, l.name]));
    const today = localDate(now, tz);

    return bookings.map((b) => {
        const segs = b.appointment_segments ?? [];
        const services = segs.map((s) => items.get(s.service_variation_id ?? '') ?? 'Unknown service');
        const teamMemberIds = [...new Set(segs.map((s) => s.team_member_id).filter((id): id is string => !!id))];
        const date = localDate(Date.parse(b.start_at), tz);
        return {
            date,
            day: dayLabel(Date.parse(b.start_at), tz),
            daysAgo: daysBetween(date, today),
            services,
            masters: teamMemberIds.map((id) => staff.get(id) ?? 'Staff'),
            studio: studio.get(b.location_id) ?? 'another location',
            extensions: services.some((s) => rules.extensionServices.some((e) => sameService(s, e))),
            ref: { bookingId: b.id, locationId: b.location_id, teamMemberIds },
        };
    });
}

/** Per-call cache, kept outside call state: one Square read per caller per call. */
const cache = new WeakMap<CallState, { customerId: string; visits: Promise<Visit[]> }>();

type Identified = { customerId: string } | { blocked: 'identify' | 'handoff'; message: string };

async function identified(state: CallState): Promise<Identified> {
    await state.customerLookup;
    const c = state.customer;
    if (c?.status === 'ambiguous') {
        return { blocked: 'handoff', message: 'Several client profiles match. The front desk will check the visit history and call back.' };
    }
    if (c?.status !== 'found') {
        return {
            blocked: 'identify',
            message: 'The caller is not identified yet. Ask for the phone number or email they used with us, '
                + 'save it as customerPhone or customerEmail, then try again.',
        };
    }
    return { customerId: c.customerId! };
}

function visitsFor(state: CallState, customerId: string): Promise<Visit[]> {
    let hit = cache.get(state);
    if (hit?.customerId !== customerId) {
        hit = { customerId, visits: loadVisits(customerId) };
        cache.set(state, hit);
        hit.visits.catch(() => cache.delete(state)); // a failed read is retried next time
    }
    return hit.visits;
}

// ---- Rules ----

/**
 * When and with whom a history service may be booked, from the visits alone.
 * Dates are appointment dates, inclusive. Pure, for tests.
 */
export type Window =
    | { ok: true; from: string; to: string; masters?: { id: string; name: string }[] }
    | { ok: false; reason: string };

export function windowFor(kind: 'freeFix' | 'refill', visits: Visit[], today: string, rules: Rules = BUSINESS.history): Window {
    if (kind === 'freeFix') {
        // Repairs don't start a new free-fix window; the original work does.
        const repairs = [rules.freeFix.service, rules.paidRepair.service];
        const original = visits.filter((v) => !v.services.every((s) => repairs.some((r) => sameService(s, r))));
        const last = original[0];
        if (!last) return { ok: false, reason: `No visit with us in the last ${rules.lookbackDays} days, so a repair is paid: ${rules.paidRepair.service}, per nail.` };
        const to = addDays(last.date, rules.freeFix.days);
        if (to < today) {
            return { ok: false, reason: `The last visit was ${last.day}, more than ${rules.freeFix.days} days ago, so a repair is paid: ${rules.paidRepair.service}, per nail, any master.` };
        }
        const masters = new Map<string, string>();
        for (const v of original.filter((x) => x.date === last.date)) {
            v.ref.teamMemberIds.forEach((id, i) => masters.set(id, v.masters[i] ?? 'Staff'));
        }
        return { ok: true, from: today, to, masters: [...masters].map(([id, name]) => ({ id, name })) };
    }

    const last = visits.find((v) => v.extensions);
    if (!last) {
        return { ok: false, reason: `No extensions with us in the last ${rules.lookbackDays} days, so this is not a refill. `
            + 'Ask whether they were done under another number or at another salon.' };
    }
    const from = addDays(last.date, rules.refill.days.min);
    const to = addDays(last.date, rules.refill.days.max);
    if (to < today) {
        return { ok: false, reason: `The last extensions were ${last.day}, more than ${rules.refill.days.max} days ago. The front desk decides; say they will call back.` };
    }
    return { ok: true, from: from > today ? from : today, to };
}

export type GateResult =
    | { ok: true; from?: string; to?: string; teamMemberIds?: string[] }
    | { blocked: string; message: string };

/**
 * May the history service in state be searched or booked? Checks the caller,
 * the window (against the requested dates), and for a free fix the master.
 * Other services pass untouched. Used by square_availability and square_book.
 */
export async function historyGate(
    state: CallState, req: { from: string; to: string; master?: string; teamMemberId?: string },
): Promise<GateResult> {
    const kind = historyService(state.service);
    if (!kind) return { ok: true };
    const rules = BUSINESS.history;

    if (kind === 'paidRepair') {
        if ((state.quantity ?? 0) > rules.maxRepairNails) {
            return { blocked: 'handoff', message: `More than ${rules.maxRepairNails} nails: the front desk sets the time and calls back.` };
        }
        return { ok: true };
    }
    if (kind === 'freeFix' && (state.quantity ?? 0) > rules.maxRepairNails) {
        return { blocked: 'handoff', message: `More than ${rules.maxRepairNails} nails: the front desk sets the time and calls back.` };
    }

    const who = await identified(state);
    if ('blocked' in who) return who;
    const today = localDate(Date.now(), BUSINESS.timezone);
    const w = windowFor(kind, await visitsFor(state, who.customerId), today);
    if (!w.ok) return { blocked: 'history', message: w.reason };

    const what = kind === 'freeFix' ? 'A free fix' : 'A refill';
    const from = req.from > w.from ? req.from : w.from;
    const to = req.to < w.to ? req.to : w.to;
    if (from > to) {
        const tz = BUSINESS.timezone;
        const label = (d: string) => dayLabel(Date.parse(`${d}T12:00:00Z`), tz);
        return { blocked: 'date', message: `${what} can be booked ${w.from === w.to ? `only on ${label(w.from)}` : `from ${label(w.from)} to ${label(w.to)}`}. Ask for a day in that range.` };
    }

    if (kind === 'refill') return { ok: true, from, to };

    // Free fix: only with a master who did the last visit.
    const masters = w.masters ?? [];
    const named = req.master && normalize(req.master) !== 'any' ? req.master : undefined;
    const picked = req.teamMemberId ? masters.filter((m) => m.id === req.teamMemberId)
        : named ? matchByName(named, masters, (m) => m.name) : masters;
    if (!picked.length) {
        return { blocked: 'handoff', message: `A free fix is done by the master of the last visit (${masters.map((m) => m.name).join(' or ')}). Another master: the front desk arranges it and calls back.` };
    }
    if (picked.length > 1) {
        return { blocked: 'master', message: `The last visit had several masters (${picked.map((m) => m.name).join(', ')}). Ask which one did the nails that need fixing, and save that master.` };
    }
    return { ok: true, from, to, teamMemberIds: [picked[0]!.id] };
}

// ---- Tool ----

export const squareVisitHistoryTool = defineTool({
    name: 'square_visit_history',
    description:
        'The caller\'s past visits with us (newest first, last 90 days): day, days ago, services, masters, studio, '
        + 'and whether it was extensions. Facts only; free_fix_instructions and refill_instructions say how to use them. '
        + 'The caller must be identified first.',
    mode: 'report',
    args: z.object({}),
    handler: async (_args, ctx) => {
        const who = await identified(ctx.state);
        if ('blocked' in who) return who;
        const visits = await visitsFor(ctx.state, who.customerId);
        return {
            today: localDate(Date.now(), BUSINESS.timezone),
            visits: visits.map((v) => ({
                day: v.day, date: v.date, daysAgo: v.daysAgo, services: v.services, masters: v.masters,
                studio: v.studio, extensions: v.extensions,
            })),
        };
    },
});
