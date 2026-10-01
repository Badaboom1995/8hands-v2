// Square availability → Slots. Shared by square_availability (first search),
// square_book (fresh times when the chosen slot was taken) and the re-check
// after the design or add-ons change.

import type { SearchWindow, Slot, SlotRef } from '../../core/state';
import { searchAvailability, SquareError, type SquareLocation } from '../../integrations/square';
import { dayLabel, localDate, localHour, localMidnight, timeLabel } from './shared';

export const PART_OF_DAY = { morning: [0, 12], afternoon: [12, 17], evening: [17, 24] } as const;
export type PartOfDay = keyof typeof PART_OF_DAY;

export interface SlotSearch {
    /** Square variation ids, in the order the services are done. */
    variationIds: string[];
    locations: SquareLocation[];
    /** Spoken names by team member id. */
    names: Map<string, string>;
    /** Who may do the whole appointment; omit for anyone. */
    teamMemberIds?: string[];
    /** Total price, as the agent says it. */
    price?: string;
    /** Local YYYY-MM-DD; defaults to today. */
    startDate?: string;
    days: number;
    partOfDay?: PartOfDay;
}

export interface SlotResult {
    perLocation: { location: SquareLocation; slots: Slot[]; unavailable?: string }[];
    window: SearchWindow;
}

/** Every start time where the whole appointment fits, one master throughout, across the given studios. */
export async function findSlots(q: SlotSearch): Promise<SlotResult> {
    const now = Date.now();
    const range = q.partOfDay ? PART_OF_DAY[q.partOfDay] : ([0, 24] as const);
    const dates = new Set<string>();

    const perLocation = await Promise.all(q.locations.map(async (location) => {
        const tz = location.timezone || 'UTC';
        const startDate = q.startDate ?? localDate(now, tz);
        for (let i = 0; i < q.days; i++) dates.add(localDate(localMidnight(startDate, tz, i) + 12 * 3600_000, tz));
        const startAt = Math.max(localMidnight(startDate, tz), now + 60_000);
        const endAt = localMidnight(startDate, tz, q.days);
        if (endAt <= startAt) return { location, slots: [] };

        let found;
        try {
            found = await searchAvailability({
                locationId: location.id,
                startAt: new Date(startAt).toISOString(),
                endAt: new Date(endAt).toISOString(),
                segments: q.variationIds.map((id) => ({ serviceVariationId: id, teamMemberIds: q.teamMemberIds })),
            });
        } catch (err) {
            // A 400 is about this studio (e.g. nobody here does this option); others should retry.
            if (err instanceof SquareError && err.status === 400) return { location, slots: [], unavailable: err.message };
            throw err;
        }

        const slots: Slot[] = [];
        for (const a of found) {
            const at = Date.parse(a.start_at);
            const hour = localHour(at, tz);
            if (hour < range[0] || hour >= range[1]) continue;
            const staff = new Set(a.appointment_segments.map((s) => s.team_member_id));
            if (staff.size !== 1) continue; // one master does the whole appointment
            const ref: SlotRef = {
                locationId: a.location_id,
                segments: a.appointment_segments.map((s) => ({
                    teamMemberId: s.team_member_id,
                    serviceVariationId: s.service_variation_id,
                    serviceVariationVersion: s.service_variation_version,
                    durationMinutes: s.duration_minutes,
                })),
            };
            slots.push({
                date: localDate(at, tz),
                day: dayLabel(at, tz),
                time: timeLabel(at, tz),
                studio: location.name,
                master: q.names.get([...staff][0]!),
                price: q.price,
                minutes: ref.segments.reduce((sum, s) => sum + s.durationMinutes, 0),
                startAt: a.start_at,
                ref,
            });
        }
        return { location, slots };
    }));

    return {
        perLocation,
        window: {
            dates: [...dates].sort(),
            fromHour: range[0],
            toHour: range[1],
            studios: q.locations.map((l) => l.name),
        },
    };
}

/** Up to three offered times closest to `startAt`, as the agent says them. */
export function nearestTimes(slots: Slot[], startAt: string, withStudio: boolean): string[] {
    const start = Date.parse(startAt);
    return [...slots]
        .sort((a, b) => Math.abs(Date.parse(a.startAt) - start) - Math.abs(Date.parse(b.startAt) - start))
        .slice(0, 3)
        .map((s) => `${s.time}${s.master ? ` with ${s.master}` : ''}${withStudio ? ` at ${s.studio}` : ''}`);
}
