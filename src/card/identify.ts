// Who is calling, and may they book? The server resolves the caller to exactly
// one Square customer (never guessing between duplicates) and checks the card
// on file. Runs in the background at call start, again when the caller gives
// another phone or email, and last right before booking.

import { BUSINESS } from '../business';
import type { CallState, CustomerMatch } from '../core/state';
import * as square from '../integrations/square';
import { EnrollmentError, normalizePhone } from './enrollment';

/** Business policy; moves to business config. On unless REQUIRE_CARD_ON_FILE=false. */
export const requireCard = () => process.env.REQUIRE_CARD_ON_FILE !== 'false';

/** Phones/emails a returning caller may try, the first number (caller ID or given) included, before a human takes over. */
const MAX_IDENTIFY_ATTEMPTS = 3;

async function match(customers: square.SquareCustomer[], via: CustomerMatch['via']): Promise<CustomerMatch> {
    if (customers.length === 0) return { status: 'not_found', via };
    if (customers.length > 1) return { status: 'ambiguous', via };
    const id = customers[0]!.id;
    return { status: 'found', via, customerId: id, hasCard: await square.hasEnabledCard(id) };
}

export async function identifyByPhone(raw: string, via: 'caller_id' | 'phone'): Promise<CustomerMatch> {
    return match(await square.searchCustomersByPhone(normalizePhone(raw)), via);
}

export async function identifyByEmail(raw: string): Promise<CustomerMatch> {
    const email = raw.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new EnrollmentError('invalid_email', 'A valid email is required');
    return match(await square.searchCustomersByEmail(email), 'email');
}

/** At call start: look the caller ID up without blocking the greeting. */
export function startCallerLookup(state: CallState): void {
    if (!state.callerPhone) return;
    state.customerLookup = identifyByPhone(state.callerPhone, 'caller_id')
        .then((m) => {
            state.customer ??= m;
            state.identifyAttempts = (state.identifyAttempts ?? 0) + 1;
        })
        .catch((err) => { console.warn('[identify] caller ID lookup failed:', (err as Error).message); });
}

/**
 * The caller gave another phone or email: look it up. A single match replaces
 * what we had; a miss leaves the earlier result and counts as an attempt.
 */
export async function identifyFromPatch(
    state: CallState, input: { phone?: string; email?: string },
): Promise<{ blocked: 'phone' | 'email'; message: string } | undefined> {
    let m: CustomerMatch;
    try {
        m = input.email ? await identifyByEmail(input.email) : await identifyByPhone(input.phone!, 'phone');
    } catch (err) {
        if (err instanceof EnrollmentError && err.code === 'invalid_email') {
            return { blocked: 'email', message: 'That email does not look valid. Ask the caller to spell it again.' };
        }
        if (err instanceof EnrollmentError && err.code === 'invalid_phone') {
            return { blocked: 'phone', message: 'That phone number is not valid. Ask for it again.' };
        }
        throw err;
    }
    state.identifyAttempts = (state.identifyAttempts ?? 0) + 1;
    if (m.status !== 'not_found' || state.customer?.status !== 'found') state.customer = m;
    return undefined;
}

export type Gate =
    | { ok: true; customerId: string }
    | { blocked: 'identify' | 'phone' | 'card' | 'handoff'; message: string };

/**
 * May this caller book now? Waits for the background lookup; after a card link
 * was sent (or with `live`), asks Square again, since the card may be new.
 */
export async function customerGate(state: CallState, opts: { live?: boolean } = {}): Promise<Gate> {
    await state.customerLookup;
    let c = state.customer;

    // The card may have been added since we last looked (card link, or a live check before booking).
    if (c?.status === 'found' && (opts.live || (state.cardLinkSent && !c.hasCard))) {
        c.hasCard = await square.hasEnabledCard(c.customerId!);
    } else if (c?.status !== 'found' && state.firstVisit && state.cardLinkSent) {
        // A new client's profile is created by the card page, under the phone send_card_link gave it.
        const phone = state.callerPhone ?? state.customerPhone;
        if (phone) {
            const m = await identifyByPhone(phone, state.callerPhone ? 'caller_id' : 'phone');
            if (m.status !== 'not_found') state.customer = c = m;
        }
    }

    if (c?.status === 'ambiguous') {
        return { blocked: 'handoff', message: 'Several client profiles match. The front desk will finish this booking and call back.' };
    }
    if (c?.status === 'found') {
        if (c.hasCard || !requireCard()) return { ok: true, customerId: c.customerId! };
        return { blocked: 'card', message: cardMessage(state) };
    }

    // Not found (or no caller ID).
    if (!state.callerPhone && !state.customerPhone && !state.customerEmail) {
        return { blocked: 'phone', message: `Ask "${BUSINESS.questions.phone}" and confirm it as in step 4.` };
    }
    if (state.firstVisit === true) {
        if (!requireCard()) {
            return { blocked: 'handoff', message: 'New clients are set up by the front desk. They will call back to finish this booking.' };
        }
        return { blocked: 'card', message: cardMessage(state) };
    }
    if (state.firstVisit === false) {
        if ((state.identifyAttempts ?? 0) >= MAX_IDENTIFY_ATTEMPTS) {
            return { blocked: 'handoff', message: 'We could not find the caller\'s profile. The front desk will find it and call back to finish this booking.' };
        }
        return {
            blocked: 'identify',
            message: ((state.identifyAttempts ?? 0) > 1 ? 'That did not find a profile either. ' : 'Say you could not find their profile under that number. ')
                + 'Ask for another phone number or the email they used with us, and save it as customerPhone or customerEmail.',
        };
    }
    return {
        blocked: 'identify',
        message: `Ask exactly: "${BUSINESS.questions.firstVisit}" Save the answer as firstVisit.`,
    };
}

function cardMessage(state: CallState): string {
    return state.cardLinkSent
        ? 'The card is not on file yet. Ask the caller to finish the secure link, and continue when they say it is done.'
        : 'A card on file is required before booking. Explain the cancellation policy, ask for their email, '
            + 'and send the secure link with send_card_link.';
}
