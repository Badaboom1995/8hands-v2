// square_availability — open times for the whole appointment in call state
// (service, design, add-ons, back to back with one master), read live from Square.
// Searches one studio, or every studio in parallel when none is given.

import { z } from 'zod';

import { defineTool } from '../../core/tools';
import { ISO_DATE } from '../../core/state';
import { listBookableTeam, listServiceItems, type SquareLocation } from '../../integrations/square';
import { bookableAppointment } from './compose';
import { dayLabel, groupServices, listStudios, localDate, matchByName, normalize, spread, staffNames } from './shared';
import { findSlots } from './slots';

const TIMES_PER_DAY = 6;
const MAX_DAYS_SHOWN = 7;

export const squareAvailabilityTool = defineTool({
    name: 'square_availability',
    description:
        'Look up open times for the appointment in call state: the saved service and option, '
        + 'plus the design and extras, done back to back by one master. '
        + 'master exactly as square_masters returned it. Without location it searches every studio. '
        + 'Returns the whole visit\'s price and minutes and, per studio and day, a spread of open start '
        + 'times with the master for each; "more" counts times not listed. Days with no open times are left out.',
    mode: 'report',
    args: z.object({
        location: z.string().min(1).optional().describe('Studio the caller wants. Omit to search every studio.'),
        master: z.string().min(1).optional().describe('Master the caller asked for. Omit, or "any", for anyone.'),
        startDate: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD.').optional()
            .describe('First day to search, YYYY-MM-DD. Defaults to today.'),
        days: z.number().int().min(1).max(28).optional().describe('How many days to search, 1–28. Defaults to 1.'),
        partOfDay: z.enum(['morning', 'afternoon', 'evening']).optional()
            .describe('Only times in this part of the day: morning before 12, afternoon 12–5, evening after 5.'),
    }),
    handler: async (args, ctx) => {
        const [items, allLocations, team] = await Promise.all([listServiceItems(), listStudios(), listBookableTeam()]);
        const names = staffNames(team);

        const bookable = await bookableAppointment(ctx.state, groupServices(items));
        if ('blocked' in bookable) return bookable;
        const { appointment, note } = bookable;
        const labels = appointment.parts.map((p) => p.label);

        // Master → team member id, who must do every part.
        let teamMemberIds = appointment.performers;
        if (args.master && normalize(args.master) !== 'any') {
            const found = matchByName(args.master, team, (m) => names.get(m.id)!);
            if (found.length !== 1) {
                return {
                    blocked: 'master',
                    message: found.length
                        ? `"${args.master}" matches several masters; ask which one.`
                        : `No master named "${args.master}". Check with square_masters.`,
                    ...(found.length ? { candidates: found.map((m) => names.get(m.id)) } : {}),
                };
            }
            const master = found[0]!;
            const notDone = appointment.parts.filter((p) => !p.performers.includes(master.id));
            if (notDone.length) {
                return {
                    blocked: 'master',
                    message: `${names.get(master.id)} does not do ${notDone.map((p) => p.label).join(' or ')}.`,
                    mastersForAll: appointment.performers.map((id) => names.get(id)).filter(Boolean),
                };
            }
            teamMemberIds = [master.id];
        }

        // Location → one studio, or all of them.
        let locations: SquareLocation[] = allLocations;
        if (args.location) {
            const found = matchByName(args.location, allLocations, (l) => l.name);
            if (found.length !== 1) {
                return {
                    blocked: 'location',
                    message: found.length
                        ? `"${args.location}" matches several studios; ask which one.`
                        : `No studio named "${args.location}".`,
                    studios: (found.length ? found : allLocations).map((l) => l.name),
                };
            }
            locations = found;
        }

        const { perLocation, window } = await findSlots({
            variationIds: appointment.parts.map((p) => p.variationId),
            locations, names, teamMemberIds, price: appointment.totalPrice,
            startDate: args.startDate, days: args.days ?? 1, partOfDay: args.partOfDay,
        });
        // Every open time goes into state, so the caller's pick binds to an exact slot.
        ctx.state.offeredSlots = perLocation.flatMap((l) => l.slots);
        ctx.state.searchWindow = window;

        const results = perLocation.map(({ location, slots, unavailable }) => {
            const byDay = new Map<string, { day: string; times: { time: string; master?: string }[] }>();
            for (const slot of slots) {
                const entry = byDay.get(slot.date) ?? { day: slot.day, times: [] };
                entry.times.push({ time: slot.time, master: slot.master });
                byDay.set(slot.date, entry);
            }
            const allDays = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
            return {
                studio: location.name,
                ...(unavailable ? { note: 'This appointment cannot be booked at this studio.' } : {}),
                days: allDays.slice(0, MAX_DAYS_SHOWN).map(([date, d]) => {
                    const shown = spread(d.times, TIMES_PER_DAY);
                    return { date, day: d.day, times: shown, ...(d.times.length > shown.length ? { more: d.times.length - shown.length } : {}) };
                }),
                ...(allDays.length > MAX_DAYS_SHOWN ? { moreDays: allDays.length - MAX_DAYS_SHOWN } : {}),
            };
        });

        const now = Date.now();
        const tz = locations[0]?.timezone || 'UTC';
        return {
            today: `${localDate(now, tz)} (${dayLabel(now, tz)})`,
            includes: labels,
            price: appointment.totalPrice,
            minutes: appointment.totalMinutes,
            ...(note ? { designNote: note } : {}),
            results,
            ...(results.every((r) => r.days.length === 0) ? { note: 'No open times in this window.' } : {}),
        };
    },
});
