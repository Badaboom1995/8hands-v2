// square_availability — open times for one service option, read live from Square.
// Searches one studio, or every studio in parallel when none is given.

import { z } from 'zod';

import { defineTool } from '../../core/tools';
import { ISO_DATE } from '../../core/state';
import { listBookableTeam, listLocations, listServiceItems, type SquareLocation } from '../../integrations/square';
import { dayLabel, groupServices, localDate, matchByName, minutes, optionName, price, spread, staffNames } from './shared';
import { findSlots } from './slots';
const TIMES_PER_DAY = 6;
const MAX_DAYS_SHOWN = 7;

export const squareAvailabilityTool = defineTool({
    name: 'square_availability',
    description:
        'Look up open appointment times for a service. '
        + 'service and option must be names exactly as square_services returned them; '
        + 'master exactly as square_masters returned it. '
        + 'Without location it searches every studio. '
        + 'Returns, per studio and day, a spread of open start times with the master for each; '
        + '"more" counts times not listed. Days with no open times are left out.',
    mode: 'report',
    filler: 'checking the schedule',
    args: z.object({
        service: z.string().min(1).describe('Service name exactly as square_services returned it.'),
        option: z.string().min(1).optional()
            .describe('Option name exactly as square_services returned it. Required when the service has several.'),
        location: z.string().min(1).optional().describe('Studio the caller wants. Omit to search every studio.'),
        master: z.string().min(1).optional().describe('Master the caller asked for. Omit for anyone.'),
        startDate: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD.').optional()
            .describe('First day to search, YYYY-MM-DD. Defaults to today.'),
        days: z.number().int().min(1).max(28).optional().describe('How many days to search, 1–28. Defaults to 1.'),
        partOfDay: z.enum(['morning', 'afternoon', 'evening']).optional()
            .describe('Only times in this part of the day: morning before 12, afternoon 12–5, evening after 5.'),
    }),
    handler: async (args, ctx) => {
        const [items, allLocations, team] = await Promise.all([listServiceItems(), listLocations(), listBookableTeam()]);
        const services = groupServices(items);
        const names = staffNames(team);

        // Service → one Square variation.
        const serviceMatches = matchByName(args.service, services, (s) => s.name);
        if (serviceMatches.length !== 1) {
            return {
                blocked: 'service',
                message: serviceMatches.length
                    ? `"${args.service}" matches several services; ask which one.`
                    : `No service named "${args.service}". Look it up with square_services first.`,
                ...(serviceMatches.length ? { candidates: serviceMatches.map((s) => s.name) } : {}),
            };
        }
        const service = serviceMatches[0]!;
        const optionMatches = service.variations.length === 1 ? service.variations
            : args.option ? matchByName(args.option, service.variations, optionName) : [];
        if (optionMatches.length !== 1) {
            return {
                blocked: 'option',
                message: args.option
                    ? `"${args.option}" does not pick one option of ${service.name}; ask the caller which one.`
                    : `${service.name} has several options; ask the caller which one.`,
                options: (optionMatches.length ? optionMatches : service.variations).map(optionName),
            };
        }
        const variation = optionMatches[0]!;
        const performers = variation.item_variation_data?.team_member_ids ?? [];

        // Master → team member id, who must perform this option.
        let teamMemberIds: string[] | undefined;
        if (args.master) {
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
            if (!performers.includes(master.id)) {
                return {
                    blocked: 'master',
                    message: `${names.get(master.id)} does not do this option.`,
                    mastersForThisOption: performers.map((id) => names.get(id)).filter(Boolean),
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
            variation, locations, names, teamMemberIds,
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
                ...(unavailable ? { note: 'This option cannot be booked at this studio.' } : {}),
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
            service: service.name,
            option: optionName(variation),
            price: price(variation),
            minutes: minutes(variation),
            results,
            ...(results.every((r) => r.days.length === 0) ? { note: 'No open times in this window.' } : {}),
        };
    },
});
