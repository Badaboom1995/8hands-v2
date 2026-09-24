// square_masters — who can be booked: the studios they work at, their level,
// and the services they do, read live from Square.

import { z } from 'zod';

import { BUSINESS } from '../../business';
import { defineTool } from '../../core/tools';
import {
    listBookableTeam, listLocations, listServiceItems, type SquareServiceItem, type SquareTeamMember,
} from '../../integrations/square';
import { groupServices, matchByName, normalize, staffNames } from './shared';

export const squareMastersTool = defineTool({
    name: 'square_masters',
    description:
        'Look up the masters (staff) who can be booked. '
        + 'With name: each matching master with the studios they work at, their level, and their services. '
        + 'Several matches with the same name are different people. '
        + 'Without name: every master\'s name. '
        + 'Use the name exactly as returned when you call square_availability.',
    mode: 'report',
    args: z.object({
        name: z.string().min(1).optional()
            .describe('Master name as the caller said it, in Latin letters (e.g. "Ksenia"). Omit to list everyone.'),
    }),
    handler: async (args) => {
        const [team, items, locations] = await Promise.all([listBookableTeam(), listServiceItems(), listLocations()]);
        const services = groupServices(items);
        const names = staffNames(team);

        // A master is someone who performs at least one bookable service.
        const masters = team
            .map((m) => ({
                name: names.get(m.id)!,
                studios: studiosOf(m, locations),
                levels: levelsOf(m.id, items),
                services: services
                    .filter((s) => s.variations.some((v) => v.item_variation_data?.team_member_ids?.includes(m.id)))
                    .map((s) => s.name),
            }))
            .filter((m) => m.services.length > 0);

        if (!args.name) return { masters: masters.map((m) => m.name) };

        const found = matchByName(args.name, masters, (m) => m.name);
        if (!found.length) {
            return {
                masters: [],
                note: `No master named "${args.name}".`,
                allMasters: masters.map((m) => m.name),
            };
        }
        return {
            masters: found,
            ...(found.length > 1 ? { note: 'These are different people. Ask which studio narrows it to one.' } : {}),
            ...(found.some((m) => m.levels.length > 1)
                ? { levelNote: 'A master with several levels: ask the level question as usual.' } : {}),
        };
    },
});

/** Studios the master is assigned to in Square. Availability is the final word on a given day. */
function studiosOf(m: SquareTeamMember, locations: { id: string; name: string }[]): string[] {
    const a = m.assigned_locations;
    if (!a || a.assignment_type === 'ALL_CURRENT_AND_FUTURE_LOCATIONS') return locations.map((l) => l.name);
    return locations.filter((l) => a.location_ids?.includes(l.id)).map((l) => l.name);
}

/** Levels from the service and option names this master is listed on, per the business's level words. */
function levelsOf(memberId: string, items: SquareServiceItem[]): string[] {
    const found = new Set<string>();
    for (const item of items) {
        for (const v of item.item_data?.variations ?? []) {
            if (!v.item_variation_data?.team_member_ids?.includes(memberId)) continue;
            const words = normalize(`${item.item_data?.name ?? ''} ${v.item_variation_data?.name ?? ''}`).split(' ');
            const level = BUSINESS.levels.find((l) => l.words.some((w) => words.includes(w)));
            if (level) found.add(level.name);
        }
    }
    return BUSINESS.levels.map((l) => l.name).filter((n) => found.has(n));
}
