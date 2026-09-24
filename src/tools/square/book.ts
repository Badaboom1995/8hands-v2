// square_book — book the slot the caller confirmed. No arguments: everything
// comes from server state. Checks, in order: already booked → slot chosen →
// one known customer with a card on file (live) → caller heard the current
// read-back → slot still open in Square → CreateBooking.

import crypto from 'node:crypto';

import { z } from 'zod';

import { customerGate } from '../../card/identify';
import { dropSlot, fingerprint, readBack, type CallState, type Slot } from '../../core/state';
import { defineTool } from '../../core/tools';
import {
    createBooking, listBookableTeam, listServiceItems, searchAvailability, SquareError,
} from '../../integrations/square';
import { listStudios, staffNames } from './shared';
import { findSlots } from './slots';

interface SlotRef {
    locationId: string;
    teamMemberId: string;
    serviceVariationId: string;
    serviceVariationVersion: number;
    durationMinutes: number;
}

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

        const ref = slot.ref as unknown as SlotRef;
        if (!(await stillOpen(slot, ref))) return await slotTaken(state, slot, ref);

        let booking;
        try {
            booking = await createBooking({
                idempotencyKey: crypto.createHash('sha256')
                    .update([state.callId, slot.startAt, ref.teamMemberId, ref.serviceVariationId].join('|')).digest('hex'),
                startAt: slot.startAt,
                locationId: ref.locationId,
                customerId: gate.customerId,
                teamMemberId: ref.teamMemberId,
                serviceVariationId: ref.serviceVariationId,
                serviceVariationVersion: ref.serviceVariationVersion,
                durationMinutes: ref.durationMinutes,
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
            confirmation: readBack(state),
            ...(pending ? { message: 'The studio still has to accept it; say they will confirm shortly.' } : {}),
        };
    },
});

/** Ask Square again for exactly this start, master and option. */
async function stillOpen(slot: Slot, ref: SlotRef): Promise<boolean> {
    const start = Date.parse(slot.startAt);
    try {
        const found = await searchAvailability({
            locationId: ref.locationId,
            startAt: slot.startAt,
            endAt: new Date(start + 3600_000).toISOString(), // Square's minimum range is 1 hour
            serviceVariationId: ref.serviceVariationId,
            teamMemberIds: [ref.teamMemberId],
        });
        return found.some((a) => Date.parse(a.start_at) === start);
    } catch (err) {
        if (err instanceof SquareError && err.status === 400) return false; // e.g. the time is now in the past
        throw err;
    }
}

/** The slot is gone: search that day again and offer the nearest times. */
async function slotTaken(state: CallState, slot: Slot, ref: SlotRef) {
    const masterWasAsked = !state.filledBySlot?.includes('master');
    const locationWasAsked = !state.filledBySlot?.includes('location');
    const [items, locations, team] = await Promise.all([listServiceItems(), listStudios(), listBookableTeam()]);
    const variation = items.flatMap((i) => i.item_data?.variations ?? []).find((v) => v.id === ref.serviceVariationId);
    dropSlot(state);
    if (!variation) {
        return { blocked: 'handoff', message: 'That time was just taken and this service can no longer be booked by phone.' };
    }

    const { perLocation, window } = await findSlots({
        variation,
        locations: locationWasAsked ? locations.filter((l) => l.id === ref.locationId) : locations,
        names: staffNames(team),
        teamMemberIds: masterWasAsked ? [ref.teamMemberId] : undefined,
        startDate: slot.date,
        days: 1,
    });
    state.offeredSlots = perLocation.flatMap((l) => l.slots);
    state.searchWindow = window;

    const start = Date.parse(slot.startAt);
    const nearest = [...state.offeredSlots]
        .sort((a, b) => Math.abs(Date.parse(a.startAt) - start) - Math.abs(Date.parse(b.startAt) - start))
        .slice(0, 3)
        .map((s) => `${s.time}${s.master ? ` with ${s.master}` : ''}${locationWasAsked ? '' : ` at ${s.studio}`}`);
    return {
        blocked: 'slot_taken',
        message: nearest.length
            ? `${slot.time} was just taken. Offer these instead.`
            : `${slot.time} was just taken and nothing else is open that day. Offer to check another day.`,
        openTimes: nearest,
    };
}

function sellerNote(state: CallState): string {
    const parts = ['Booked by phone assistant.'];
    if (state.request) parts.push(`Request: ${state.request}.`);
    if (state.design && state.design !== 'none') {
        const label = state.design === 'custom_request' ? 'to be confirmed by the studio' : `level ${state.design}`;
        parts.push(`Design: ${state.designDescription ?? 'custom'} (${label}); not included in this booking's time or price.`);
    }
    if (state.notes.length) parts.push(`Notes: ${state.notes.join('; ')}.`);
    return parts.join(' ');
}
