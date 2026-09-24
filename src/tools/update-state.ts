// update_call_state — the one tool the model uses to record what it learned.
// Silent: on success the conversation just continues.

import { customerGate, identifyFromPatch } from '../card/identify';
import { defineTool } from '../core/tools';
import { applyPatch, bindSlot, CallStatePatch, describeState, freshReadBack, needsReadBack } from '../core/state';

export const updateCallStateTool = defineTool({
    name: 'update_call_state',
    description:
        'Save facts the caller just gave you: intent, what they want, master, location, date, '
        + 'time, or a short note; and phone, email or first visit when a tool asked for them. '
        + 'Call this right after learning something new, before you reply. Send only the fields that changed. '
        + 'Returns everything confirmed so far and what is still missing. '
        + 'When a time is picked, also returns readBack (the booking summary to read to the caller), '
        + 'or, if the caller\'s profile or card is not ready yet, "blocked" with what to do first.',
    args: CallStatePatch,
    mode: 'silent',
    handler: async (patch, ctx) => {
        const state = ctx.state;
        const { time, ...facts } = patch;
        const saved = applyPatch(state, facts);

        // Another phone or email to find the caller's profile.
        if (saved.includes('customerPhone') || saved.includes('customerEmail')) {
            const invalid = await identifyFromPatch(state, {
                phone: saved.includes('customerPhone') ? state.customerPhone : undefined,
                email: saved.includes('customerEmail') ? state.customerEmail : undefined,
            });
            if (invalid) return { ...invalid, saved, ...describeState(state) };
        }

        if (time) {
            const bound = bindSlot(state, time);
            if ('blocked' in bound) return { ...bound, saved, ...describeState(state) };
            saved.push(...bound.changed.filter((k) => !saved.includes(k)));
        }

        // Before the caller hears a read-back, they must be a client we may book for.
        if (needsReadBack(state)) {
            const gate = await customerGate(state);
            if (!('ok' in gate)) return { ...gate, saved, ...describeState(state) };
            return { saved, ...describeState(state), readBack: freshReadBack(state) };
        }
        return { saved, ...describeState(state) };
    },
});
