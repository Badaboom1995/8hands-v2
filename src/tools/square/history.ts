// square_visit_history — the caller's past visits and what they qualify for:
// a free fix (recent visit, same master) or a paid repair, and a refill (last
// extensions done here within the window). Read live from Square for the
// identified caller; the rules are business data (BUSINESS.history).

import { z } from 'zod';

import { BUSINESS } from '../../business';
import type { CallState, Visit, VisitHistory } from '../../core/state';
import { defineTool } from '../../core/tools';
import {
    listCustomerBookings, listLocations, teamMemberNames, variationItemNames, type SquareBooking,
} from '../../integrations/square';
import { dayLabel, localDate, normalize } from './shared';

const DAY_MS = 86_400_000;

/** Whole calendar days from `date` to `today`, both YYYY-MM-DD. */
function daysBetween(date: string, today: string): number {
    const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
    return Math.round((utc(today) - utc(date)) / DAY_MS);
}

const isAny = (names: string[], list: string[]) => {
    const wanted = new Set(list.map(normalize));
    return names.some((n) => wanted.has(normalize(n)));
};

/** A booking is a visit if it was accepted and has already started; cancelled and no-shows are not. */
export function isVisit(b: SquareBooking, now: number): boolean {
    return b.status === 'ACCEPTED' && Date.parse(b.start_at) <= now;
}

/** Apply the business's rules to visits, newest first. Pure, for tests. */
export function classify(customerId: string, visits: Visit[], rules = BUSINESS.history): VisitHistory {
    // Repairs don't start a new free-fix window; the original work does.
    const original = visits.filter((v) => !v.services.every((s) => isAny([s], rules.repairServices)));
    const lastVisit = original[0];
    let repair: VisitHistory['repair'] = 'paid';
    if (lastVisit && lastVisit.daysAgo <= rules.freeFixDays) {
        const sameDay = original.filter((v) => v.date === lastVisit.date);
        const masters = new Set(sameDay.flatMap((v) => v.ref.teamMemberIds));
        repair = masters.size === 1 ? 'free_fix' : 'free_fix_unclear_master';
    }

    const lastExtensions = visits.find((v) => v.extensions);
    let refill: VisitHistory['refill'] = 'no_recent_extensions';
    if (lastExtensions) {
        const d = lastExtensions.daysAgo;
        refill = d < rules.refillDays.min ? 'too_early' : d > rules.refillDays.max ? 'too_late' : 'eligible';
    }
    return { customerId, visits, lastVisit, lastExtensions, repair, refill };
}

/** The customer's visits in the lookback window, newest first, classified. */
export async function loadVisitHistory(customerId: string, now = Date.now()): Promise<VisitHistory> {
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

    const visits: Visit[] = bookings.map((b) => {
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
            extensions: isAny(services, rules.extensionServices),
            ref: { bookingId: b.id, locationId: b.location_id, teamMemberIds },
        };
    });
    return classify(customerId, visits, rules);
}

/** What the model hears about a visit: no ids. */
const describe = (v: Visit | undefined) => v && {
    day: v.day, daysAgo: v.daysAgo, services: v.services, masters: v.masters, studio: v.studio,
};

const REPAIR_NOTE: Record<VisitHistory['repair'], string> = {
    free_fix: 'A repair is free with the master of the last visit.',
    free_fix_unclear_master: 'A repair is free, but the last visit day had several masters: ask which one did the nails that need fixing.',
    paid: 'No visit in the free-fix window: a repair is paid per nail, with any master.',
};

const REFILL_NOTE: Record<VisitHistory['refill'], string> = {
    eligible: 'A refill is possible.',
    too_early: 'Too soon for a refill: the front desk decides.',
    too_late: 'Too long ago for a refill: the front desk decides.',
    no_recent_extensions: 'No extensions with us recently: ask whether they were done under another number or at another salon.',
};

export const squareVisitHistoryTool = defineTool({
    name: 'square_visit_history',
    description:
        'Look up the caller\'s past visits with us (last 90 days): date, services, masters, studio. '
        + 'Also says whether a nail repair is free (recent visit, same master) or paid, and whether '
        + 'an extensions refill is possible. Use it when the caller asks about a repair, a fix, a broken '
        + 'nail, a refill, or a past visit. The caller must be identified first.',
    mode: 'report',
    args: z.object({}),
    handler: async (_args, ctx) => {
        const state: CallState = ctx.state;
        await state.customerLookup;
        const c = state.customer;
        if (c?.status === 'ambiguous') {
            return { blocked: 'identify', message: 'Several client profiles match this number. The front desk will check the history and call back.' };
        }
        if (c?.status !== 'found') {
            return {
                blocked: 'identify',
                message: 'The caller is not identified yet. Ask for the phone number or email they used with us, '
                    + 'save it as customerPhone or customerEmail, then look again.',
            };
        }
        if (state.history?.customerId !== c.customerId) state.history = await loadVisitHistory(c.customerId!);
        const h = state.history!;
        return {
            visits: h.visits.length,
            lastVisit: describe(h.lastVisit) ?? null,
            lastExtensions: describe(h.lastExtensions) ?? null,
            repair: h.repair,
            refill: h.refill,
            note: `${REPAIR_NOTE[h.repair]} ${REFILL_NOTE[h.refill]}`,
        };
    },
});
