// Square availability → Slots. Shared by square_availability (first search)
// and square_book (fresh times when the chosen slot was taken).

import type { SearchWindow, Slot } from '../../core/state';
import {
    searchAvailability, SquareError, type SquareLocation, type SquareVariation,
} from '../../integrations/square';
import { dayLabel, localDate, localHour, localMidnight, minutes, price, timeLabel } from './shared';

export const PART_OF_DAY = { morning: [0, 12], afternoon: [12, 17], evening: [17, 24] } as const;
export type PartOfDay = keyof typeof PART_OF_DAY;

export interface SlotSearch {
    variation: SquareVariation;
    locations: SquareLocation[];
    /** Spoken names by team member id. */
    names: Map<string, string>;
    teamMemberIds?: string[];
    /** Local YYYY-MM-DD; defaults to today. */
    startDate?: string;
    days: number;
    partOfDay?: PartOfDay;
}

export interface SlotResult {
    perLocation: { location: SquareLocation; slots: Slot[]; unavailable?: string }[];
    window: SearchWindow;
}

/** Every open time for one variation, across the given studios, as Slots. */
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
                serviceVariationId: q.variation.id,
                teamMemberIds: q.teamMemberIds,
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
            const segment = a.appointment_segments[0];
            slots.push({
                date: localDate(at, tz),
                day: dayLabel(at, tz),
                time: timeLabel(at, tz),
                studio: location.name,
                master: q.names.get(segment?.team_member_id ?? ''),
                price: price(q.variation),
                minutes: segment?.duration_minutes ?? minutes(q.variation),
                startAt: a.start_at,
                ref: {
                    locationId: a.location_id,
                    teamMemberId: segment?.team_member_id,
                    serviceVariationId: segment?.service_variation_id,
                    serviceVariationVersion: segment?.service_variation_version,
                    durationMinutes: segment?.duration_minutes,
                },
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
