// free_fix_instructions / refill_instructions — the process and rules for the
// services that depend on visit history, loaded only when a caller asks, so
// the session prompt stays small. Built from business data and the live
// catalog (exact service and option names, prices). The server enforces the
// same rules in historyGate.

import { z } from 'zod';

import { BUSINESS, type HistoryService } from '../../business';
import { defineTool } from '../../core/tools';
import { listServiceItems } from '../../integrations/square';
import { groupServices, matchByName, optionName, price, type Service } from './shared';

/** 'service "FREE Fix", option "Regular" ($0)', as the catalog names it now. */
function saveAs(services: Service[], ref: HistoryService): string {
    const found = matchByName(ref.service, services, (s) => s.name)[0];
    const variation = found && (ref.option
        ? matchByName(ref.option, found.variations, optionName)[0]
        : found.variations.length === 1 ? found.variations[0] : undefined);
    if (!found || !variation) return `service "${ref.service}" (not bookable right now: the front desk handles it)`;
    return `service "${found.name}", option "${optionName(variation)}" (${price(variation) ?? 'free'})`;
}

export const freeFixInstructionsTool = defineTool({
    name: 'free_fix_instructions',
    description: 'How to handle a nail repair: a broken, cracked, chipped, or lifted nail, or a "fix". '
        + 'No preamble: call it immediately, before saying anything.',
    mode: 'silent',
    args: z.object({}),
    handler: async () => {
        const h = BUSINESS.history;
        const services = groupServices(await listServiceItems());
        return { instructions: `
NAIL REPAIR
A repair is free (a free fix) when the caller's last visit with us, of any service, was at most
${h.freeFix.days} days before the repair appointment, and it is done by the master of that visit.
Otherwise it is a paid repair, priced per nail, with any master.

1. Call square_visit_history. The last visit that is not itself a repair is the one that counts.
   Confirm it naturally: "Your last visit was <day> with <master> at <studio>, right?"
2. "${BUSINESS.questions.nailCount}" Save the exact number as quantity (skip the question if they said it).
   More than ${h.maxRepairNails} nails, all nails, or both hands: the front desk sets the time; say they will call back.
3. Free fix (last visit ${h.freeFix.days} days ago or less): save ${saveAs(services, h.freeFix)},
   master = the master of that visit, location = that studio. If that day had several masters,
   ask which one did the nails. The caller wants another master: the front desk arranges it.
   Paid repair: tell the price per nail, then save ${saveAs(services, h.paidRepair)}; any master, any studio.
4. Then as usual: the day, the search, 2-3 times, the read-back, the booking.
Never promise a free fix the server has not confirmed: the search and the booking check the history again.
Exceptions, disputes, refunds: the front desk.
`.trim() };
    },
});

export const refillInstructionsTool = defineTool({
    name: 'refill_instructions',
    description: 'How to handle an extensions refill. No preamble: call it immediately, before saying anything.',
    mode: 'silent',
    args: z.object({}),
    handler: async () => {
        const h = BUSINESS.history;
        const services = groupServices(await listServiceItems());
        return { instructions: `
EXTENSIONS REFILL
A refill is only for extensions done with us: the appointment must be ${h.refill.days.min}-${h.refill.days.max}
days after the caller's last extensions visit. Never take the caller's word for it.

1. Call square_visit_history and find the last visit with extensions: true.
   Confirm it naturally: "Your last extensions were <day> with <master> at <studio>, right?"
2. None: ask "I couldn't find a recent extension appointment under this phone number. Were your
   extensions done with us under a different number, or at another salon?"
   Another number: save it as customerPhone and look again.
   Another salon: not a refill. Offer a new set; acrylic or dip on the nails needs removal first;
   gel or hard gel extensions from another salon: the front desk.
3. Too early or too late for the window: the front desk decides; say they will call back.
4. In the window: save area "extensions", extensionsType "refill", and ${saveAs(services, h.refill)}.
   Don't ask the length. Ask if they want the same master; if yes, save that master.
5. Then as usual: design, studio, the day, the search, the read-back, the booking.
`.trim() };
    },
});
