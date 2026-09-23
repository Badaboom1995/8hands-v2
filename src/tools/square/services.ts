// square_services — the bookable service menu, read live from the Square catalog.

import { z } from 'zod';

import { defineTool } from '../../core/tools';
import { listServiceItems } from '../../integrations/square';
import { groupServices, matchByName, minutes, minutesRange, optionName, price, priceRange } from './shared';

export const squareServicesTool = defineTool({
    name: 'square_services',
    description:
        'Look up services the business offers, with prices and durations. '
        + 'Without query: every service name with its price and duration range. '
        + 'With query (e.g. "manicure", "extensions"): matching services with all their options '
        + '(master level, polish, length…), each with its own price and minutes. '
        + 'Use the service and option names exactly as returned when you call square_availability.',
    mode: 'report',
    filler: 'checking our services',
    args: z.object({
        query: z.string().min(1).optional()
            .describe('What the caller asked about, in a few words, in English. Omit for the full list.'),
    }),
    handler: async (args) => {
        const services = groupServices(await listServiceItems());

        if (!args.query) {
            return {
                services: services.map((s) => ({
                    name: s.name,
                    price: priceRange(s.variations),
                    minutes: minutesRange(s.variations),
                    options: s.variations.length,
                })),
            };
        }

        const byService = matchByName(args.query, services, (s) => s.name);
        const byOption = byService.length ? [] : services.filter((s) =>
            matchByName(args.query!, s.variations, optionName).length > 0);
        const found = byService.length ? byService : byOption;
        if (!found.length) {
            return { services: [], note: `Nothing matches "${args.query}". Call again without query for the full list.` };
        }
        return {
            services: found.map((s) => ({
                name: s.name,
                options: s.variations.map((v) => ({ name: optionName(v), price: price(v), minutes: minutes(v) })),
            })),
        };
    },
});
