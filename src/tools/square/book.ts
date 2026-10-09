// square_book — book the slot the caller confirmed. No arguments: everything
// comes from server state. Checks, in order: already booked → slot chosen →
// one known customer with a card on file (live) → caller heard the current
// read-back → slot still open in Square → CreateBooking.

import crypto from 'node:crypto';

import { z } from 'zod';

import { customerGate } from '../../card/identify';
import { addonWords, fingerprint, historyService, readBack, type CallState, type Slot } from '../../core/state';
import { defineTool } from '../../core/tools';
import { createBooking, searchAvailability, SquareError } from '../../integrations/square';
import { historyGate } from './history';
import { slotTaken } from './research';

export const squareBookTool = defineTool({
    name: 'square_book',
    description:
        'Book the appointment the caller just confirmed after hearing the readBack. '
        + 'Takes no arguments; everything comes from call state. '
        + 'Call it only after the caller said yes to the latest readBack.',
    mode: 'report',
    args: z.object({}).strict(),
    handler: async (_args, ctx) => {
        const state = ctx.state;
        if (state.booking) {
            return { blocked: 'already_booked', message: 'This appointment is already booked. Changes go to the front desk.' };
        }
        const slot = state.slot;
        if (!slot) {
            return { blocked: 'time', message: 'No time is chosen yet. Offer times with square_availability and save the one the caller picks.' };
        }
        // Live: the card may have been added (or removed) since the read-back.
        const gate = await customerGate(state, { live: true });
        if (!('ok' in gate)) return gate;
        if (fingerprint(state) !== state.reviewed) {
            state.reviewed = fingerprint(state);
            return { blocked: 'review', message: 'Read this to the caller and ask them to confirm first.', readBack: readBack(state) };
        }

        // Free fix, refill: the history rules, once more, for exactly this slot.
        for (const seg of new Set(slot.ref.segments.map((x) => x.teamMemberId))) {
            const ok = await historyGate(state, { from: slot.date, to: slot.date, teamMemberId: seg });
            if ('blocked' in ok) return ok;
        }

        const ref = slot.ref;
        if (!(await stillOpen(slot))) return await slotTaken(state);

        let booking;
        try {
            booking = await createBooking({
                idempotencyKey: crypto.createHash('sha256')
                    .update([state.callId, slot.startAt, ...ref.segments.map((x) => `${x.teamMemberId}:${x.serviceVariationId}`)].join('|'))
                    .digest('hex'),
                startAt: slot.startAt,
                locationId: ref.locationId,
                customerId: gate.customerId,
                segments: ref.segments,
                sellerNote: sellerNote(state),
            });
        } catch (err) {
            // 4xx won't change on retry; a person finishes it. 5xx/network throw → automatic retry, same key.
            if (err instanceof SquareError && err.status >= 400 && err.status < 500) {
                return { blocked: 'handoff', message: `Square refused the booking (${err.message}). The front desk will finish it and call back.` };
            }
            throw err;
        }

        state.booking = { id: booking.id, status: booking.status };
        const pending = booking.status === 'PENDING';
        return {
            booked: true,
            status: pending ? 'pending' : 'confirmed',
            ...(pending ? { message: 'The studio still has to accept it; say they will confirm shortly.' } : {}),
        };
    },
});

/** Ask Square again for exactly this start, with the same services and masters. */
async function stillOpen(slot: Slot): Promise<boolean> {
    const start = Date.parse(slot.startAt);
    try {
        const found = await searchAvailability({
            locationId: slot.ref.locationId,
            startAt: slot.startAt,
            endAt: new Date(start + 3600_000).toISOString(), // Square's minimum range is 1 hour
            segments: slot.ref.segments.map((x) => ({ serviceVariationId: x.serviceVariationId, teamMemberIds: [x.teamMemberId] })),
        });
        return found.some((a) => Date.parse(a.start_at) === start);
    } catch (err) {
        if (err instanceof SquareError && err.status === 400) return false; // e.g. the time is now in the past
        throw err;
    }
}

function sellerNote(state: CallState): string {
    const parts = ['Booked by phone assistant.'];
    if (state.design === 'custom_request') {
        parts.push(`Design: ${state.designDescription ?? 'custom'} (to be confirmed by the studio); not included in this booking's time or price.`);
    } else if (state.design && state.design !== 'none') {
        parts.push(`Design: ${state.designDescription ?? state.design} (level ${state.design}).`);
    }
    if (state.addons?.length) parts.push(`Add-ons: ${addonWords(state.addons)}.`);
    if (state.quantity && historyService(state.service) !== 'refill') parts.push(`Nails: ${state.quantity}.`);
    if (state.notes.length) parts.push(`Notes: ${state.notes.join('; ')}.`);
    return parts.join(' ');
}
