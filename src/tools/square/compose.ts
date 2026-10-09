// The appointment as Square services: the main service the caller chose, plus
// the design and add-ons mapped through the business profile, in the order they
// are done. Server only; the model sees labels, totals and times.

import { BUSINESS, type CatalogRef } from '../../business';
import { historyService, serviceWords, type CallState } from '../../core/state';
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
    variationId: string;
    /** Team members who do this service. */
    performers: string[];
}

export interface AppointmentProblem {
    role: AppointmentPart['role'];
    label: string;
    message: string;
    /** A custom design: not timed or priced, the studio confirms it. Not a reason to stop. */
    custom?: boolean;
}

export interface Appointment {
    parts: AppointmentPart[];
    totalMinutes: number;
    cents: number;
    /** "$240" */
    totalPrice: string;
    /** Team members who do every part. */
    performers: string[];
    /** What could not be mapped or measured; the totals leave these out. */
    problems: AppointmentProblem[];
}

/** Build the appointment from call state and the live catalog. */
export async function composeAppointment(state: CallState, services?: Service[]): Promise<Appointment> {
    services ??= groupServices(await listServiceItems());
    const parts: AppointmentPart[] = [];
    const problems: AppointmentProblem[] = [];
    // Once a time is chosen, Square's own duration for each service in it.
    const booked = new Map(state.slot?.ref.segments.map((s) => [s.serviceVariationId, s.durationMinutes]));

    const part = (role: AppointmentPart['role'], label: string, ref: CatalogRef) => {
        const found = findVariation(services, ref);
        if (typeof found === 'string') {
            problems.push({ role, label, message: found });
            return;
        }
        const { service, variation } = found;
        parts.push({
            role, label,
            service: service.name,
            option: optionName(variation),
            minutes: booked.get(variation.id) ?? minutes(variation),
            price: price(variation),
            cents: variation.item_variation_data?.price_money?.amount ?? 0,
            variationId: variation.id,
            performers: variation.item_variation_data?.team_member_ids ?? [],
        });
    };

    const addonLabel = (key: string) => BUSINESS.addons[key] ?? key;
    const addons: { key: string; ref: CatalogRef }[] = [];
    for (const key of state.addons ?? []) {
        const ref = BUSINESS.addonServices[key];
        if (ref) addons.push({ key, ref });
        else problems.push({ role: 'addon', label: addonLabel(key), message: 'no catalog mapping' });
    }

    for (const a of addons.filter((x) => x.ref.before)) part('addon', addonLabel(a.key), a.ref);

    if (state.service) {
        part('main', serviceWords(state) ?? state.service, { service: state.service, option: state.option });
        // A paid repair is its service once per nail; a free fix is one appointment.
        const main = parts.at(-1);
        if (historyService(state.service) === 'paidRepair' && main?.role === 'main') {
            for (let i = 1; i < (state.quantity ?? 1); i++) parts.push({ ...main });
        }
    } else {
        problems.push({ role: 'main', label: 'main service', message: 'not chosen yet (service/option empty)' });
    }

    if (state.design === 'custom_request') {
        problems.push({
            role: 'design', label: state.designDescription ?? 'custom design',
            message: 'custom request, time and price unknown', custom: true,
        });
    } else if (state.design && state.design !== 'none') {
        const ref = BUSINESS.designServices[state.design];
        const label = state.designDescription ?? state.design;
        if (ref) part('design', label, ref);
        else problems.push({ role: 'design', label, message: 'no catalog mapping' });
    }

    for (const a of addons.filter((x) => !x.ref.before)) part('addon', addonLabel(a.key), a.ref);

    for (const p of parts.filter((x) => x.minutes === undefined)) {
        problems.push({ role: p.role, label: p.label, message: 'no duration in catalog' });
    }
    const cents = parts.reduce((sum, p) => sum + p.cents, 0);
    const currency = services.flatMap((s) => s.variations)
        .find((v) => v.item_variation_data?.price_money)?.item_variation_data?.price_money?.currency ?? 'USD';
    return {
        parts,
        totalMinutes: parts.reduce((sum, p) => sum + (p.minutes ?? 0), 0),
        cents,
        totalPrice: cents === 0 && parts.length ? 'free'
            : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 })
                .format(cents / 100),
        performers: parts.length
            ? parts.map((p) => p.performers).reduce((a, b) => a.filter((id) => b.includes(id)))
            : [],
        problems,
    };
}

export type Bookable =
    | { appointment: Appointment; note?: string }
    | { blocked: 'service' | 'handoff' | 'master'; message: string; [detail: string]: unknown };

/**
 * The appointment, if it can be searched and booked: the main service is known,
 * every design and add-on maps to one catalog service, and someone does them all.
 * A custom design is left out with a note.
 */
export async function bookableAppointment(state: CallState, services?: Service[]): Promise<Bookable> {
    const appointment = await composeAppointment(state, services);
    const main = appointment.problems.find((p) => p.role === 'main');
    if (main) {
        return {
            blocked: 'service',
            message: `Main service: ${main.message}. Look it up with square_services and save service and option with update_call_state.`,
        };
    }
    const unbookable = appointment.problems.filter((p) => !p.custom);
    if (unbookable.length) {
        return {
            blocked: 'handoff',
            message: `${unbookable.map((p) => p.label).join(', ')} can't be booked by phone. `
                + 'Say the front desk will add it, or book without it if the caller agrees.',
        };
    }
    if (!appointment.performers.length) {
        return {
            blocked: 'master',
            message: `No one does ${appointment.parts.map((p) => p.label).join(' and ')} together. `
                + 'Say so, and ask what the caller would like to change.',
        };
    }
    const custom = appointment.problems.find((p) => p.custom);
    return {
        appointment,
        ...(custom ? { note: `The design "${custom.label}" is not in this time or price; the studio will confirm it.` } : {}),
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
