// square_masters — who can be booked: the studios they work at, their level,
// and the services they do, read live from Square. The same lookup resolves a
// master the caller names (see update_call_state).

import { z } from 'zod';

import { BUSINESS } from '../../business';
import type { CallState } from '../../core/state';
import { defineTool } from '../../core/tools';
import {
    listBookableTeam, listServiceItems, searchAvailability, SquareError,
    type SquareLocation, type SquareServiceItem, type SquareTeamMember,
} from '../../integrations/square';
import { groupServices, listStudios, matchByName, normalize, staffNames } from './shared';

export interface Master {
    name: string;
    /** Served studios where Square has open times for them; see availableStudios. */
    studios: string[];
    /** Their level: from their own option ("TOP Esther"), else the highest they are listed on. */
    level?: string;
    services: string[];
}

/** Server-only: the team member and one option they do, to ask Square where they work. */
interface MasterRecord extends Master {
    id: string;
    /** Their own option if they have one, else one at their level. */
    probeVariationId?: string;
}

const STUDIO_WINDOW_DAYS = 14;

/** Every bookable master who performs at least one service at a served studio, live from Square. */
async function loadRecords(): Promise<{ records: MasterRecord[]; studios: SquareLocation[] }> {
    const [team, items, studios] = await Promise.all([listBookableTeam(), listServiceItems(), listStudios()]);
    const services = groupServices(items);
    const names = staffNames(team);
    const records = team
        .map((m) => ({
            id: m.id,
            name: names.get(m.id)!,
            studios: assignedStudios(m, studios),
            ...levelOf(m.id, names.get(m.id)!, items),
            services: services
                .filter((s) => s.variations.some((v) => v.item_variation_data?.team_member_ids?.includes(m.id)))
                .map((s) => s.name),
        }))
        .filter((m) => m.services.length > 0 && m.studios.length > 0);
    return { records, studios };
}

const toMaster = ({ name, studios, level, services }: MasterRecord): Master => ({ name, studios, level, services });

/** Every master, with studios from assignments (cheap; names only are shown). */
export async function loadMasters(): Promise<Master[]> {
    return (await loadRecords()).records.map(toMaster);
}

/**
 * Masters matching a name the caller said; several matches are different people.
 * Their studios come from Square availability, which is the truth; assignments are not.
 */
export async function findMasters(name: string): Promise<{ found: Master[]; all: Master[] }> {
    const { records, studios } = await loadRecords();
    const found = await Promise.all(matchByName(name, records, (m) => m.name)
        .map(async (m) => ({ ...m, studios: await availableStudios(m, studios) })));
    return { found: found.map(toMaster), all: records.map(toMaster) };
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
        };
    },
});

/** Served studios the master is assigned to in Square. Often wrong; only a fallback and a filter. */
function assignedStudios(m: SquareTeamMember, studios: SquareLocation[]): string[] {
    const a = m.assigned_locations;
    if (!a || a.assignment_type === 'ALL_CURRENT_AND_FUTURE_LOCATIONS') return studios.map((l) => l.name);
    return studios.filter((l) => a.location_ids?.includes(l.id)).map((l) => l.name);
}

/**
 * Served studios where Square has open times for the master in the next two
 * weeks. None anywhere (fully booked, or off): their assigned studios.
 */
async function availableStudios(m: MasterRecord, studios: SquareLocation[]): Promise<string[]> {
    if (!m.probeVariationId) return m.studios;
    const startAt = new Date(Date.now() + 60_000).toISOString();
    const endAt = new Date(Date.now() + STUDIO_WINDOW_DAYS * 86_400_000).toISOString();
    const open = await Promise.all(studios.map(async (l) => {
        try {
            const found = await searchAvailability({
                locationId: l.id, startAt, endAt,
                segments: [{ serviceVariationId: m.probeVariationId!, teamMemberIds: [m.id] }],
            });
            return found.length > 0;
        } catch (err) {
            if (err instanceof SquareError && err.status === 400) return false; // they don't work here
            throw err;
        }
    }));
    const names = studios.filter((_, i) => open[i]).map((l) => l.name);
    return names.length ? names : m.studios;
}

/**
 * The master's level. Their own option ("TOP Esther", "MASTER Gina") names it;
 * without one, the highest level among the options they are listed on. Also an
 * option of that kind, to look up where they work.
 */
function levelOf(memberId: string, name: string, items: SquareServiceItem[]): { level?: string; probeVariationId?: string } {
    const own = new Map<string, string>();
    const listed = new Map<string, string>();
    const first = normalize(name).split(' ')[0]!;
    for (const item of items) {
        for (const v of item.item_data?.variations ?? []) {
            if (!v.item_variation_data?.team_member_ids?.includes(memberId)) continue;
            const words = normalize(`${item.item_data?.name ?? ''} ${v.item_variation_data?.name ?? ''}`).split(' ');
            const level = BUSINESS.levels.find((l) => l.words.some((w) => words.includes(w)));
            if (!level) continue;
            if (!listed.has(level.name)) listed.set(level.name, v.id);
            if (words.includes(first) && !own.has(level.name)) own.set(level.name, v.id);
        }
    }
    const highest = (found: Map<string, string>) => BUSINESS.levels
        .filter((l) => found.has(l.name))
        .sort((a, b) => b.rank - a.rank)
        .map((l) => ({ level: l.name, probeVariationId: found.get(l.name) }))[0];
    return highest(own) ?? highest(listed) ?? {};
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
    const masterInfo = { name: m.name, studios: m.studios, level: m.level };
    const saved: string[] = [];
    // A named master's level is theirs; the caller is never asked.
    if (m.level && state.level !== m.level) {
        state.level = m.level;
        saved.push('level');
    }
    if (wanted && !m.studios.some((s) => sameStudio(wanted, s))) {
        return {
            blocked: 'master',
            message: `${m.name} works only at ${m.studios.join(' and ')}. Ask if that studio is okay, or another master at ${wanted}.`,
            masterInfo,
        };
    }
    if (m.studios.length === 1 && !wanted) {
        state.location = m.studios[0];
        saved.push('location');
    }
    return { saved, masterInfo };
}
