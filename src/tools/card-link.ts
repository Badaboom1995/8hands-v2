// send_card_link — email the caller a secure link to put a card on file.
// The agent never hears or sees card data; Square's page collects it.

import { z } from 'zod';

import { EnrollmentError, normalizePhone, startEnrollment } from '../card/enrollment';
import { defineTool } from '../core/tools';

export const sendCardLinkTool = defineTool({
    name: 'send_card_link',
    description:
        'Email the caller a secure link to add a card on file, when square_book says a card is required. '
        + 'Call it after explaining the cancellation policy and getting their email.',
    mode: 'report',
    filler: 'sending the link',
    args: z.object({
        email: z.string().min(3).describe('Caller\'s email, as they spelled it, e.g. "anna.lee@gmail.com".'),
    }).strict(),
    handler: async (args, ctx) => {
        const rawPhone = ctx.state.callerPhone ?? ctx.state.customerPhone;
        if (!rawPhone) {
            return { blocked: 'phone', message: "Ask for the caller's phone number and save it as customerPhone first." };
        }
        let result;
        try {
            result = await startEnrollment({ phone: normalizePhone(rawPhone), email: args.email });
        } catch (err) {
            if (err instanceof EnrollmentError && err.code === 'invalid_email') {
                return { blocked: 'email', message: 'That email does not look valid. Ask the caller to spell it again.' };
            }
            if (err instanceof EnrollmentError && err.code === 'invalid_phone') {
                return { blocked: 'phone', message: 'The phone number is not valid. Ask for it again.' };
            }
            throw err;
        }
        if (!result.started && result.reason === 'already_has_card') {
            return { note: 'A card is already on file. Go ahead and book.' };
        }
        if (!result.started) {
            return { blocked: 'handoff', message: 'Several client profiles share this phone. The front desk will finish this booking and call back.' };
        }
        ctx.state.cardLinkSent = true;
        return {
            sent: true,
            expiresInMinutes: result.expiresInMinutes,
            message: 'Tell the caller the link is on its way to their email. When they say the card is added, book again.',
        };
    },
});
