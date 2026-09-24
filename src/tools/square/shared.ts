// Helpers shared by the Square read tools: name matching, service grouping,
// time zones, and turning Square values into things the agent can say.

import { BUSINESS } from '../../business';
import { normalize } from '../../core/names';
import {
    listLocations, type SquareLocation, type SquareServiceItem, type SquareTeamMember, type SquareVariation,
} from '../../integrations/square';

export { matchByName, normalize } from '../../core/names';

// ---- Studios ----

/** The Square locations this business books for (business profile), live. */
export async function listStudios(): Promise<SquareLocation[]> {
    const served = new Set(BUSINESS.studios.map(normalize));
    return (await listLocations()).filter((l) => served.has(normalize(l.name)));
}

// ---- Services ----

/** Square items grouped by name (the catalog may hold several items with one name). */
export interface Service {
    name: string;
    variations: SquareVariation[];
}

export function groupServices(items: SquareServiceItem[]): Service[] {
    const byName = new Map<string, Service>();
    for (const item of items) {
        const name = item.item_data?.name?.trim() || 'Unnamed service';
        const key = normalize(name);
        const service = byName.get(key) ?? { name, variations: [] };
        service.variations.push(...(item.item_data?.variations ?? []));
        byName.set(key, service);
    }
    return [...byName.values()];
}

export function optionName(v: SquareVariation): string {
    return v.item_variation_data?.name?.trim() || 'Regular';
}

export function price(v: SquareVariation): string | undefined {
    const m = v.item_variation_data?.price_money;
    if (!m || !m.amount) return undefined;
    return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: m.currency, maximumFractionDigits: m.amount % 100 ? 2 : 0,
    }).format(m.amount / 100);
}

export function minutes(v: SquareVariation): number | undefined {
    const ms = v.item_variation_data?.service_duration;
    return ms ? Math.round(ms / 60000) : undefined;
}

/** "$100–$140" or "$120"; undefined if nothing is priced. */
export function priceRange(vs: SquareVariation[]): string | undefined {
    const priced = vs.filter((v) => v.item_variation_data?.price_money?.amount);
    if (!priced.length) return undefined;
    const amounts = priced.map((v) => v.item_variation_data!.price_money!.amount);
    const lo = priced[amounts.indexOf(Math.min(...amounts))]!;
    const hi = priced[amounts.indexOf(Math.max(...amounts))]!;
    return lo === hi || price(lo) === price(hi) ? price(lo) : `${price(lo)}–${price(hi)}`;
}

/** "45" or "90–150"; undefined if no duration is set. */
export function minutesRange(vs: SquareVariation[]): string | undefined {
    const all = vs.map(minutes).filter((m): m is number => m !== undefined);
    if (!all.length) return undefined;
    const lo = Math.min(...all), hi = Math.max(...all);
    return lo === hi ? String(lo) : `${lo}–${hi}`;
}

// ---- Team ----

/** Spoken names by team member id: given name, or full name when two share it. */
export function staffNames(team: SquareTeamMember[]): Map<string, string> {
    const count = new Map<string, number>();
    for (const m of team) {
        const g = normalize(m.given_name ?? '');
        count.set(g, (count.get(g) ?? 0) + 1);
    }
    const out = new Map<string, string>();
    for (const m of team) {
        const given = m.given_name?.trim() || m.family_name?.trim() || 'Staff';
        const full = [m.given_name, m.family_name].filter(Boolean).join(' ').trim();
        out.set(m.id, (count.get(normalize(m.given_name ?? '')) ?? 0) > 1 && full ? full : given);
    }
    return out;
}

// ---- Time ----

/** Offset of `tz` from UTC at instant `ms`, in ms. */
function tzOffset(ms: number, tz: string): number {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
    return asUtc - (ms - (ms % 1000));
}

/** Midnight of local date `YYYY-MM-DD` in `tz`, plus `addDays`, as a UTC instant. */
export function localMidnight(date: string, tz: string, addDays = 0): number {
    const [y, m, d] = date.split('-').map(Number);
    const guess = Date.UTC(y!, m! - 1, d! + addDays);
    const first = guess - tzOffset(guess, tz);
    return guess - tzOffset(first, tz);
}

/** Local date `YYYY-MM-DD` of an instant in `tz`. */
export function localDate(ms: number, tz: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(ms));
}

export function localHour(ms: number, tz: string): number {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' })
        .format(new Date(ms)));
}

/** "Tue, Sep 29" */
export function dayLabel(ms: number, tz: string): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })
        .format(new Date(ms));
}

/** "2 PM" or "2:30 PM" (ICU puts a narrow no-break space before AM/PM; use a plain one). */
export function timeLabel(ms: number, tz: string): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
        .format(new Date(ms)).replace(/\s/g, ' ').replace(':00 ', ' ');
}

/** Up to `k` items spread evenly across the list, first and last included. */
export function spread<T>(list: T[], k: number): T[] {
    if (list.length <= k) return list;
    return Array.from({ length: k }, (_, i) => list[Math.round((i * (list.length - 1)) / (k - 1))]!);
}
