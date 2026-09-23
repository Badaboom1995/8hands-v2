// square_masters — who can be booked, and what each of them does, read live from Square.

import { z } from 'zod';

import { defineTool } from '../../core/tools';
import { listBookableTeam, listServiceItems } from '../../integrations/square';
import { groupServices, matchByName, staffNames } from './shared';

export const squareMastersTool = defineTool({
    name: 'square_masters',
    description:
        'Look up the masters (staff) who can be booked. '
        + 'With name: the matching masters and the services each one does. '
        + 'Without name: every master\'s name. '
        + 'Use the name exactly as returned when you call square_availability.',
    mode: 'report',
    filler: 'checking our team',
    args: z.object({
        name: z.string().min(1).optional()
            .describe('Master name as the caller said it, in Latin letters (e.g. "Ksenia"). Omit to list everyone.'),
    }),
    handler: async (args) => {
        const [team, items] = await Promise.all([listBookableTeam(), listServiceItems()]);
        const services = groupServices(items);
        const names = staffNames(team);

        // A master is someone who performs at least one bookable service.
        const masters = team
            .map((m) => ({
                id: m.id,
                name: names.get(m.id)!,
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
        return { masters: found.map(({ name, services }) => ({ name, services })) };
    },
});
