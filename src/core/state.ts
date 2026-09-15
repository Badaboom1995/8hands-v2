// CallState — the server-side record of what has been established on a call.
// The model proposes facts through the update_call_state tool; the server
// decides what becomes true. Nothing here is read from transcripts.

import { z } from 'zod';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const CallStatePatch = z.object({
    intent: z.enum(['book', 'question', 'reschedule', 'cancel', 'other']).optional()
        .describe('Why the caller is calling, once it is clear.'),
    service: z.string().min(1).optional()
        .describe('Service the caller wants, as they said it (e.g. "gel manicure").'),
    staff: z.string().min(1).optional()
        .describe('Specific staff member the caller asked for, if any.'),
    location: z.string().min(1).optional()
        .describe('Location the caller wants, if the business has more than one.'),
    date: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD.').optional()
        .describe('Preferred date, format YYYY-MM-DD. Resolve "tomorrow" etc. before saving.'),
    timeOfDay: z.enum(['morning', 'afternoon', 'evening']).optional()
        .describe('Preferred part of the day, if the caller expressed one.'),
    customerName: z.string().min(1).optional()
        .describe("Caller's name."),
    customerPhone: z.string().min(1).optional()
        .describe("Caller's phone number, digits as spoken."),
    notes: z.string().min(1).optional()
        .describe('Anything else relevant the caller said, in one short line.'),
}).strict().refine((p) => Object.keys(p).length > 0, { message: 'Provide at least one field.' });

export type CallStatePatch = z.infer<typeof CallStatePatch>;

export interface CallState {
    intent?: CallStatePatch['intent'];
    service?: string;
    staff?: string;
    location?: string;
    date?: string;
    timeOfDay?: CallStatePatch['timeOfDay'];
    customerName?: string;
    customerPhone?: string;
    /** Appended, never overwritten. */
    notes: string[];
}

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
    if (state.intent === 'book' || state.intent === 'reschedule') {
        for (const key of ['service', 'date', 'customerName', 'customerPhone'] as const) {
            if (state[key] === undefined) missing.push(key);
        }
    }
    return { confirmed, missing };
}
