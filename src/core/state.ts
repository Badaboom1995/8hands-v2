// CallState — the server-side record of what has been established on a call.
// The model proposes facts through the update_call_state tool; the server
// decides what becomes true. Nothing here is read from transcripts.

import crypto from 'node:crypto';

import { z } from 'zod';

import { matchByName, normalize } from './names';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Design add-on levels, as the business defines them (moves to business config). */
export const DESIGN_LEVELS = [
    'none', 'simple', 'medium', 'hard', 'extra_hard', 'xxtra_hard', 'extra_per_nail', 'custom_request',
] as const;

export const CallStatePatch = z.object({
    intent: z.enum(['book', 'question', 'reschedule', 'cancel', 'other']).optional()
        .describe('Why the caller is calling, once it is clear.'),
    request: z.string().min(1).optional()
        .describe('What the caller wants, in plain words, with every service answer so far, '
            + 'e.g. "manicure", then "gel manicure, Master level". Send the whole updated phrase. '
            + 'Design goes in design/designDescription, not here.'),
    design: z.enum(DESIGN_LEVELS).optional()
        .describe('Nail design level. "none" if the caller wants no design or the service has no color; '
            + '"custom_request" if the level stays unclear or depends on a photo.'),
    designDescription: z.string().min(1).optional()
        .describe('The design in the caller\'s own words, e.g. "French tip", "cat eye on two nails".'),
    service: z.string().min(1).optional()
        .describe('The matching catalog service, exactly as square_services named it. Only after looking it up.'),
    option: z.string().min(1).optional()
        .describe('Option of that service (master level, polish…), exactly as square_services named it.'),
    master: z.string().min(1).optional()
        .describe('Master the caller asked for by name. When a time is picked, the server sets the master of that slot.'),
    location: z.string().min(1).optional()
        .describe('Studio the caller wants, as the caller named it, or "any" if either is fine. '
            + 'When a time is picked, the server sets the studio of that slot.'),
    date: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD.').optional()
        .describe('Preferred date, format YYYY-MM-DD. Resolve "tomorrow" etc. before saving.'),
    time: z.string().regex(/^\d{1,2}(:\d{2})? (AM|PM)$/, 'Use a time exactly as square_availability returned it, e.g. "2 PM".').optional()
        .describe('The time the caller picked, exactly as square_availability returned it, e.g. "2:30 PM". '
            + 'Only a time square_availability returned is accepted; the server then fills in its master and studio.'),
    customerName: z.string().min(1).optional()
        .describe("Caller's name, if given."),
    customerPhone: z.string().min(1).optional()
        .describe("A phone number the caller gave to find their profile, only when a tool asked for it."),
    customerEmail: z.string().min(3).optional()
        .describe('An email the caller gave to find their profile, spelled back and confirmed, only when a tool asked for it.'),
    firstVisit: z.boolean().optional()
        .describe('true if the caller says this is their first visit, false if they have been before. Only when a tool asked.'),
    notes: z.string().min(1).optional()
        .describe('Anything else relevant the caller said, in one short line.'),
}).strict().refine((p) => Object.keys(p).length > 0, { message: 'Provide at least one field.' });

export type CallStatePatch = z.infer<typeof CallStatePatch>;

export interface CallState {
    intent?: CallStatePatch['intent'];
    request?: string;
    design?: (typeof DESIGN_LEVELS)[number];
    designDescription?: string;
    service?: string;
    option?: string;
    master?: string;
    location?: string;
    date?: string;
    time?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    firstVisit?: boolean;
    /** Appended, never overwritten. */
    notes: string[];
    /** Every open time from the last availability search. Server only. */
    offeredSlots?: Slot[];
    /** The offered slot bound to `time`. Server only; this is what gets booked. */
    slot?: Slot;
    /** Fields the slot filled in because the caller had no preference. Server only. */
    filledBySlot?: ('master' | 'location')[];
    /** What the last availability search covered. Server only. */
    searchWindow?: SearchWindow;
    /** Fingerprint of the last read-back the caller heard. Server only. */
    reviewed?: string;
    /** The booking created on this call. Server only; the model sees its status. */
    booking?: { id: string; status: string };
    /** A card-on-file link was sent on this call. */
    cardLinkSent?: boolean;
    /** Stable per call; seeds idempotency keys. Server only. */
    callId: string;
    /** Caller ID from the phone line, E.164. Server only. */
    callerPhone?: string;
    /** Who the caller is in the booking provider. Server only; the model sees a summary. */
    customer?: CustomerMatch;
    /** The caller ID lookup started at call start. Server only. */
    customerLookup?: Promise<void>;
    /** Other phones/emails tried to find the profile. Server only. */
    identifyAttempts?: number;
}

/** The caller resolved to a booking-provider customer, never guessed between duplicates. */
export interface CustomerMatch {
    status: 'found' | 'not_found' | 'ambiguous';
    via: 'caller_id' | 'phone' | 'email';
    customerId?: string;
    hasCard?: boolean;
}

/** The dates, hours and studios an availability search covered. */
export interface SearchWindow {
    dates: string[];
    fromHour: number;
    toHour: number;
    studios: string[];
}

/** One open time from an availability search. */
export interface Slot {
    /** Local date YYYY-MM-DD. */
    date: string;
    /** "Tue, Sep 29" */
    day: string;
    /** "2 PM", as the agent says it. */
    time: string;
    studio: string;
    master?: string;
    /** "$120", as the agent says it. */
    price?: string;
    minutes?: number;
    /** UTC instant. */
    startAt: string;
    /** Provider data needed to book it (ids, versions). Never shown to the model. */
    ref: Record<string, unknown>;
}

/** Fields a chosen slot depends on; changing one drops the slot. */
const SLOT_INPUTS = ['service', 'option', 'location', 'master', 'date'] as const;

/** What a booking needs, in the order the receptionist asks for it. */
const BOOKING_ORDER = ['request', 'location', 'design', 'date', 'service', 'option', 'time'] as const;

export function createCallState(callerPhone?: string): CallState {
    return { notes: [], callId: crypto.randomUUID(), callerPhone };
}

function sameName(a: string, b: string): boolean {
    return normalize(a) === normalize(b) || matchByName(a, [b], (x) => x).length > 0;
}

/**
 * Merge a validated patch (without `time`, see bindSlot) into the state.
 * Returns the fields that changed. Changing what a chosen slot depends on
 * drops the slot: a new search is needed, the old slot is never edited.
 */
export function applyPatch(state: CallState, patch: Omit<CallStatePatch, 'time'>): string[] {
    const changed: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (key === 'notes') {
            state.notes.push(value as string);
            changed.push(key);
            continue;
        }
        const current = (state as unknown as Record<string, unknown>)[key];
        const same = typeof current === 'string' && typeof value === 'string'
            && (key === 'location' || key === 'master' ? sameName(value, current) : value === current);
        if (same) continue;
        if (state.slot && (SLOT_INPUTS as readonly string[]).includes(key)) {
            dropSlot(state);
            changed.push('time');
        }
        (state as unknown as Record<string, unknown>)[key] = value;
        changed.push(key);
    }
    return changed;
}

/** Forget the chosen slot, and anything it filled in for a caller with no preference. */
export function dropSlot(state: CallState): void {
    for (const key of state.filledBySlot ?? []) {
        if (key === 'master') state.master = undefined;
        else state.location = 'any';
    }
    state.slot = undefined;
    state.time = undefined;
    state.filledBySlot = undefined;
}

export type BindResult =
    | { changed: string[] }
    | { blocked: 'time' | 'date' | 'master' | 'location' | 'search'; message: string; [detail: string]: unknown };

/** 15 for "3 PM" / "3:30 PM"; undefined if unparseable. */
function hourOf(time: string): number | undefined {
    const m = /^(\d{1,2})(?::\d{2})?\s*(AM|PM)$/i.exec(time.trim());
    if (!m) return undefined;
    return (Number(m[1]) % 12) + (m[2]!.toUpperCase() === 'PM' ? 12 : 0);
}

/**
 * Bind the time the caller picked to exactly one offered slot, narrowed by
 * the date, master and studio already in state. On success the slot's own
 * date, master and studio become state.
 */
export function bindSlot(state: CallState, time: string): BindResult {
    const offered = state.offeredSlots ?? [];
    // What the caller actually asked for; values the current slot filled in don't count.
    const filled = state.slot ? state.filledBySlot ?? [] : [];
    const master = filled.includes('master') ? undefined : state.master;
    const location = filled.includes('location') ? 'any' : state.location;
    if (!offered.length) {
        return { blocked: 'time', message: 'No times have been offered yet. Check times with square_availability first.' };
    }
    const canonical = (t: string) => t.trim().toUpperCase().replace(/:00(?= )/, '').replace(/\s+/g, ' ');
    const narrow = (slots: Slot[]) => {
        let out = slots;
        if (state.date) out = out.filter((s) => s.date === state.date);
        if (master) out = matchByName(master, out, (s) => s.master ?? '');
        if (location && location !== 'any') out = matchByName(location, out, (s) => s.studio);
        return out;
    };
    const found = narrow(offered.filter((s) => canonical(s.time) === canonical(time)));

    if (!found.length) {
        const w = state.searchWindow;
        const hour = hourOf(time);
        const outside = w && (
            (state.date && !w.dates.includes(state.date))
            || (hour !== undefined && (hour < w.fromHour || hour >= w.toHour))
            || (location && location !== 'any' && !w.studios.some((st) => matchByName(location, [st], (x) => x).length)));
        if (outside) {
            return {
                blocked: 'search',
                message: `${time}${state.date ? ` on ${state.date}` : ''} was not searched yet. Check it with square_availability.`,
            };
        }
        const open = [...new Set(narrow(offered).map((s) => `${s.day} ${s.time}`))];
        const step = Math.max(1, Math.ceil(open.length / 8));
        return {
            blocked: 'time',
            message: `${time} was not one of the open times. Offer only times square_availability returned.`,
            openTimes: open.filter((_, i) => i % step === 0),
        };
    }
    const unique = (f: (s: Slot) => string | undefined) => [...new Set(found.map(f).filter(Boolean))] as string[];
    const days = unique((s) => s.day);
    if (days.length > 1) return { blocked: 'date', message: `${time} is open on several days; ask which day.`, days };
    const studios = unique((s) => s.studio);
    if (studios.length > 1) return { blocked: 'location', message: `${time} is open at several studios; ask which one.`, studios };
    const masters = unique((s) => s.master);
    if (masters.length > 1) return { blocked: 'master', message: `${time} is open with several masters; ask which one.`, masters };

    const slot = found[0]!;
    if (state.slot) dropSlot(state);
    const changed = ['time'];
    const filledNow: ('master' | 'location')[] = [];
    if (!state.location || state.location === 'any') filledNow.push('location');
    if (!state.master && slot.master) filledNow.push('master');
    if (state.date !== slot.date) changed.push('date');
    if (state.location !== slot.studio) changed.push('location');
    if (slot.master && state.master !== slot.master) changed.push('master');
    Object.assign(state, { slot, time: slot.time, date: slot.date, location: slot.studio, filledBySlot: filledNow });
    if (slot.master) state.master = slot.master;
    return { changed };
}

/** What a read-back promises: the exact slot and what the caller asked for. */
export function fingerprint(state: CallState): string | undefined {
    const s = state.slot;
    if (!s) return undefined;
    return [
        s.startAt, s.ref.locationId, s.ref.teamMemberId, s.ref.serviceVariationId,
        state.request ?? '', state.design ?? '', state.designDescription ?? '',
    ].join('|');
}

/** One-sentence confirmation built from server state, e.g. "Gel manicure with Irina, Thu, Sep 24 at 3 PM, Pacific Avenue, $120." */
export function readBack(state: CallState): string | undefined {
    const s = state.slot;
    if (!s) return undefined;
    const what = state.request ? state.request[0]!.toUpperCase() + state.request.slice(1) : 'Your appointment';
    const design = state.design && state.design !== 'none'
        ? `, ${state.designDescription ?? 'custom'} design${state.design === 'custom_request' ? ' (the studio will confirm it)' : ''}`
        : '';
    return `${what}${design}${s.master ? ` with ${s.master}` : ''}, ${s.day} at ${s.time}, ${s.studio}${s.price ? `, ${s.price}` : ''}.`;
}

/**
 * If the slot or request changed since the caller last heard a read-back,
 * return a fresh one and remember it as heard.
 */
export function freshReadBack(state: CallState): string | undefined {
    if (!needsReadBack(state)) return undefined;
    state.reviewed = fingerprint(state);
    return readBack(state);
}

/** A slot is chosen and the caller hasn't heard this exact read-back yet. */
export function needsReadBack(state: CallState): boolean {
    const fp = fingerprint(state);
    return Boolean(fp && fp !== state.reviewed && !state.booking);
}

/** Server-only fields; never shown to the model. */
const HIDDEN = new Set([
    'notes', 'offeredSlots', 'slot', 'filledBySlot', 'searchWindow', 'reviewed', 'booking', 'callId', 'callerPhone',
    'customer', 'customerLookup', 'identifyAttempts',
]);

/** What the model sees after each save: confirmed facts and what is still missing. */
export function describeState(state: CallState): { confirmed: Record<string, unknown>; missing: string[] } {
    const confirmed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state)) {
        if (value !== undefined && !HIDDEN.has(key)) confirmed[key] = value;
    }
    if (state.notes.length > 0) confirmed.notes = state.notes;
    if (state.booking) confirmed.booking = state.booking.status;
    if (state.customer?.status === 'found') {
        confirmed.client = state.customer.hasCard ? 'known, card on file' : 'known, no card on file';
    }

    const missing: string[] = [];
    const booking = state.intent === 'book' || state.intent === 'reschedule'
        || BOOKING_ORDER.some((key) => state[key] !== undefined);
    if (booking) {
        for (const key of BOOKING_ORDER) {
            if (state[key] === undefined) missing.push(key);
        }
    }
    return { confirmed, missing };
}
