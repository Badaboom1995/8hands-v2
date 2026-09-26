// The appointment as Square services: the main service the caller chose, plus
// the design and add-ons mapped through the business profile. Server only.

import { BUSINESS, type CatalogRef } from '../../business';
import type { CallState } from '../../core/state';
import { listServiceItems, type SquareVariation } from '../../integrations/square';
import { groupServices, matchByName, minutes, optionName, price, type Service } from './shared';

export interface AppointmentPart {
    role: 'main' | 'design' | 'addon';
    /** What the caller asked for, e.g. "hand spa". */
    label: string;
    service: string;
    option: string;
    minutes?: number;
    /** "$30" */
    price?: string;
    cents: number;
}

export interface Appointment {
    parts: AppointmentPart[];
    totalMinutes: number;
    /** "$240" */
    totalPrice: string;
    /** What could not be mapped or measured; a non-empty list means the totals are incomplete. */
    problems: string[];
}

/** Build the appointment from call state and the live catalog. */
export async function composeAppointment(state: CallState): Promise<Appointment> {
    const services = groupServices(await listServiceItems());
    const parts: AppointmentPart[] = [];
    const problems: string[] = [];

    const part = (role: AppointmentPart['role'], label: string, ref: CatalogRef, exactMinutes?: number) => {
        const found = findVariation(services, ref);
        if (typeof found === 'string') {
            problems.push(`${label}: ${found}`);
            return;
        }
        const { service, variation } = found;
        parts.push({
            role, label,
            service: service.name,
            option: optionName(variation),
            minutes: exactMinutes ?? minutes(variation),
            price: price(variation),
            cents: variation.item_variation_data?.price_money?.amount ?? 0,
        });
    };

    const addons = (state.addons ?? []).map((key) => ({ key, ref: BUSINESS.addonServices[key] }));
    for (const { key } of addons.filter((a) => !a.ref)) problems.push(`${key}: no catalog mapping`);
    const mapped = addons.filter((a): a is { key: string; ref: CatalogRef } => Boolean(a.ref));
    const addonLabel = (key: string) => BUSINESS.addons[key] ?? key;

    for (const a of mapped.filter((x) => x.ref.before)) part('addon', addonLabel(a.key), a.ref);

    if (state.service) {
        // The chosen slot knows the booked master's own duration.
        part('main', state.request ?? state.service, { service: state.service, option: state.option }, state.slot?.minutes);
    } else {
        problems.push('main service: not chosen yet (service/option empty)');
    }

    if (state.design === 'custom_request') {
        problems.push(`design "${state.designDescription ?? 'custom'}": custom request, time and price unknown`);
    } else if (state.design && state.design !== 'none') {
        const ref = BUSINESS.designServices[state.design];
        if (ref) part('design', state.designDescription ?? state.design, ref);
        else problems.push(`design ${state.design}: no catalog mapping`);
    }

    for (const a of mapped.filter((x) => !x.ref.before)) part('addon', addonLabel(a.key), a.ref);

    const cents = parts.reduce((sum, p) => sum + p.cents, 0);
    const currency = parts.length ? services.flatMap((s) => s.variations)
        .find((v) => v.item_variation_data?.price_money)?.item_variation_data?.price_money?.currency ?? 'USD' : 'USD';
    return {
        parts,
        totalMinutes: parts.reduce((sum, p) => sum + (p.minutes ?? 0), 0),
        totalPrice: new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 })
            .format(cents / 100),
        problems: [...problems, ...parts.filter((p) => p.minutes === undefined).map((p) => `${p.label}: no duration in catalog`)],
    };
}

/** One variation for a catalog reference, or why there isn't exactly one. */
function findVariation(services: Service[], ref: CatalogRef): { service: Service; variation: SquareVariation } | string {
    const byName = matchByName(ref.service, services, (s) => s.name);
    if (byName.length !== 1) return byName.length ? `"${ref.service}" matches several services` : `no service "${ref.service}"`;
    const service = byName[0]!;
    const variations = service.variations.length === 1 && !ref.option ? service.variations
        : ref.option ? matchByName(ref.option, service.variations, optionName) : [];
    if (variations.length !== 1) {
        return ref.option
            ? `"${ref.option}" ${variations.length ? 'matches several options' : 'is not an option'} of ${service.name}`
            : `${service.name} has several options, none chosen`;
    }
    return { service, variation: variations[0]! };
}
