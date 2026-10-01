// Searching the chosen day again for the appointment now in state: after the
// slot was taken (square_book), or after the design or add-ons changed so the
// appointment's length changed (update_call_state).

import { bindSlot, dropSlot, type CallState, type Slot } from '../../core/state';
import { listBookableTeam, listServiceItems } from '../../integrations/square';
import { bookableAppointment } from './compose';
import { groupServices, listStudios, staffNames } from './shared';
import { findSlots, nearestTimes } from './slots';

type Blocked = { blocked: string; message: string; [detail: string]: unknown };

/**
 * Search `previous`'s day again for the appointment in state, keeping its
 * master and studio where the caller chose them. Replaces the offered times.
 */
async function searchDayAgain(state: CallState, previous: Slot, keep: { master: boolean; studio: boolean }):
Promise<Blocked | { slots: Slot[] }> {
    const [items, locations, team] = await Promise.all([listServiceItems(), listStudios(), listBookableTeam()]);
    const bookable = await bookableAppointment(state, groupServices(items));
    if ('blocked' in bookable) return bookable;
    const { appointment } = bookable;

    const names = staffNames(team);
    const masterId = previous.ref.segments[0]!.teamMemberId;
    if (keep.master && !appointment.performers.includes(masterId)) {
        return {
            blocked: 'master',
            message: `${names.get(masterId) ?? 'This master'} does not do all of ${appointment.parts.map((p) => p.label).join(', ')}. `
                + 'Say so and ask if another master is okay.',
        };
    }
    const { perLocation, window } = await findSlots({
        variationIds: appointment.parts.map((p) => p.variationId),
        locations: keep.studio ? locations.filter((l) => l.id === previous.ref.locationId) : locations,
        names,
        teamMemberIds: keep.master ? [masterId] : appointment.performers,
        price: appointment.totalPrice,
        startDate: previous.date,
        days: 1,
    });
    state.offeredSlots = perLocation.flatMap((l) => l.slots);
    state.searchWindow = window;
    return { slots: state.offeredSlots };
}

/** The chosen slot was just taken: offer the nearest times that day. */
export async function slotTaken(state: CallState): Promise<Blocked> {
    const slot = state.slot!;
    const keep = { master: !state.filledBySlot?.includes('master'), studio: !state.filledBySlot?.includes('location') };
    dropSlot(state);
    const found = await searchDayAgain(state, slot, keep);
    if ('blocked' in found) return found;
    const nearest = nearestTimes(found.slots, slot.startAt, !keep.studio);
    return {
        blocked: 'slot_taken',
        message: nearest.length
            ? `${slot.time} was just taken. Offer these instead.`
            : `${slot.time} was just taken and nothing else is open that day. Offer to check another day.`,
        openTimes: nearest,
    };
}

/**
 * The design or add-ons changed after a time was chosen (the slot is already
 * dropped). Keep the same start with the same master and studio if the new
 * appointment still fits; otherwise offer the nearest times that do.
 * Returns undefined when the time was kept.
 */
export async function recheckSlot(state: CallState, previous: Slot): Promise<Blocked | undefined> {
    const found = await searchDayAgain(state, previous, { master: true, studio: true });
    if ('blocked' in found) return found;
    if (found.slots.some((s) => s.startAt === previous.startAt)) {
        const bound = bindSlot(state, previous.time);
        if (!('blocked' in bound)) return undefined;
    }
    const nearest = nearestTimes(found.slots, previous.startAt, false);
    return {
        blocked: 'time',
        message: nearest.length
            ? `With this change ${previous.time} no longer fits. Offer these instead.`
            : `With this change nothing fits that day with ${previous.master ?? 'this master'}. Offer to check another day.`,
        openTimes: nearest,
    };
}
