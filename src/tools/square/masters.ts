// square_masters — who can be booked: the studios they work at, their level,
// and the services they do, read live from Square. The same lookup resolves a
// master the caller names (see update_call_state).

import { z } from 'zod';

import { BUSINESS } from '../../business';
import type { CallState } from '../../core/state';
import { defineTool } from '../../core/tools';
import {
    listBookableTeam, listServiceItems, type SquareLocation, type SquareServiceItem, type SquareTeamMember,
} from '../../integrations/square';
import { groupServices, listStudios, matchByName, normalize, staffNames } from './shared';

export interface Master {
    name: string;
    studios: string[];
    levels: string[];
    services: string[];
}

/** Every bookable master who performs at least one service at a served studio, live from Square. */
export async function loadMasters(): Promise<Master[]> {
    const [team, items, studios] = await Promise.all([listBookableTeam(), listServiceItems(), listStudios()]);
    const services = groupServices(items);
    const names = staffNames(team);
    return team
        .map((m) => ({
            name: names.get(m.id)!,
            studios: studiosOf(m, studios),
            levels: levelsOf(m.id, items),
            services: services
                .filter((s) => s.variations.some((v) => v.item_variation_data?.team_member_ids?.includes(m.id)))
                .map((s) => s.name),
        }))
        .filter((m) => m.services.length > 0 && m.studios.length > 0);
}

/** Masters matching a name the caller said; several matches are different people. */
export async function findMasters(name: string): Promise<{ found: Master[]; all: Master[] }> {
    const all = await loadMasters();
    return { found: matchByName(name, all, (m) => m.name), all };
}

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
        if (!args.name) return { masters: (await loadMasters()).map((m) => m.name) };

        const { found, all } = await findMasters(args.name);
        if (!found.length) {
            return { masters: [], note: `No master named "${args.name}".`, allMasters: all.map((m) => m.name) };
        }
        return {
            masters: found,
            ...(found.length > 1 ? { note: 'These are different people. Ask which studio narrows it to one.' } : {}),
            ...(found.some((m) => m.levels.length > 1)
                ? { levelNote: 'A master with several levels: ask the level question as usual.' } : {}),
        };
    },
});

/** Served studios the master is assigned to in Square. Availability is the final word on a given day. */
function studiosOf(m: SquareTeamMember, studios: SquareLocation[]): string[] {
    const a = m.assigned_locations;
    if (!a || a.assignment_type === 'ALL_CURRENT_AND_FUTURE_LOCATIONS') return studios.map((l) => l.name);
    return studios.filter((l) => a.location_ids?.includes(l.id)).map((l) => l.name);
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

const sameStudio = (a: string, b: string) => matchByName(a, [b], (x) => x).length > 0;

/**
 * The caller named a master (state.master): resolve them to one person in
 * Square. Their studio and level become state when there is only one of each.
 * Several people with that name, or none: blocked, never a guess.
 */
export async function resolveNamedMaster(state: CallState): Promise<
    | { blocked: 'master'; message: string; [detail: string]: unknown }
    | { saved: string[]; masterInfo: Omit<Master, 'services'> }
> {
    const asked = state.master!;
    const { found, all } = await findMasters(asked);
    const wanted = state.location && state.location !== 'any' ? state.location : undefined;
    const matches = found.length > 1 && wanted
        ? (found.filter((m) => m.studios.some((s) => sameStudio(wanted, s))).length
            ? found.filter((m) => m.studios.some((s) => sameStudio(wanted, s))) : found)
        : found;

    if (!matches.length) {
        state.master = undefined;
        return { blocked: 'master', message: `No master named "${asked}". Say so and offer what exists.`, masters: all.map((m) => m.name) };
    }
    if (matches.length > 1) {
        state.master = undefined;
        return {
            blocked: 'master',
            message: `Several masters are named "${asked}". Ask which studio, then save the master again.`,
            candidates: matches.map((m) => ({ name: m.name, studios: m.studios })),
        };
    }

    const m = matches[0]!;
    state.master = m.name;
    const masterInfo = { name: m.name, studios: m.studios, levels: m.levels };
    if (wanted && !m.studios.some((s) => sameStudio(wanted, s))) {
        return {
            blocked: 'master',
            message: `${m.name} works only at ${m.studios.join(' and ')}. Ask if that studio is okay, or another master at ${wanted}.`,
            masterInfo,
        };
    }
    const saved: string[] = [];
    if (m.studios.length === 1 && !wanted) {
        state.location = m.studios[0];
        saved.push('location');
    }
    if (m.levels.length === 1 && !state.level) {
        state.level = m.levels[0];
        saved.push('level');
    }
    return { saved, masterInfo };
}
