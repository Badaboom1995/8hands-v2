// CallState — the server-side record of what has been established on a call.
// The model proposes facts through the update_call_state tool; the server
// decides what becomes true. Nothing here is read from transcripts.

import { z } from 'zod';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const CallStatePatch = z.object({
    intent: z.enum(['book', 'question', 'reschedule', 'cancel', 'other']).optional()
        .describe('Why the caller is calling, once it is clear.'),
    service: z.enum(['manicure']).optional()
        .describe('Service the caller wants. Only manicure is offered for now.'),
    manicureType: z.enum(['gel', 'polish', 'cuticle_only']).optional()
        .describe('Kind of manicure: gel, regular polish, or cuticle work only (no color).'),
    location: z.enum(['pacific_ave', 'union_st']).optional()
        .describe('Which studio the caller wants.'),
    date: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD.').optional()
        .describe('Preferred date, format YYYY-MM-DD. Resolve "tomorrow" etc. before saving.'),
    time: z.string().regex(/^\d{1,2} (AM|PM)$/, 'Use a time exactly as check_availability returned it, e.g. "2 PM".').optional()
        .describe('The slot the caller chose, exactly as check_availability returned it, e.g. "2 PM".'),
    customerName: z.string().min(1).optional()
        .describe("Caller's name, if given."),
    customerPhone: z.string().min(1).optional()
        .describe("Caller's phone number, if given."),
    notes: z.string().min(1).optional()
        .describe('Anything else relevant the caller said, in one short line.'),
}).strict().refine((p) => Object.keys(p).length > 0, { message: 'Provide at least one field.' });

export type CallStatePatch = z.infer<typeof CallStatePatch>;

export interface CallState {
    intent?: CallStatePatch['intent'];
    service?: CallStatePatch['service'];
    manicureType?: CallStatePatch['manicureType'];
    location?: CallStatePatch['location'];
    date?: string;
    time?: string;
    customerName?: string;
    customerPhone?: string;
    /** Appended, never overwritten. */
    notes: string[];
}

/** What a booking needs, in the order the receptionist asks for it. */
const BOOKING_ORDER = ['service', 'manicureType', 'location', 'date', 'time'] as const;

export function createCallState(): CallState {
    return { notes: [] };
}

/** Merge a validated patch into the state. Returns the fields that changed. */
export function applyPatch(state: CallState, patch: CallStatePatch): string[] {
    const changed: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (key === 'notes') {
            state.notes.push(value as string);
        } else {
            (state as unknown as Record<string, unknown>)[key] = value;
        }
        changed.push(key);
    }
    return changed;
}

/** What the model sees after each save: confirmed facts and what is still missing. */
export function describeState(state: CallState): { confirmed: Record<string, unknown>; missing: string[] } {
    const { notes, ...rest } = state;
    const confirmed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) confirmed[key] = value;
    }
    if (notes.length > 0) confirmed.notes = notes;

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
