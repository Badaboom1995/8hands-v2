// update_call_state — the one tool the model uses to record what it learned.
// Silent: on success the conversation just continues.

import { customerGate, identifyFromPatch } from '../card/identify';
import { defineTool } from '../core/tools';
import { applyPatch, bindSlot, CallStatePatch, describeState, freshReadBack, needsReadBack } from '../core/state';

export const updateCallStateTool = defineTool({
    name: 'update_call_state',
    description:
        'Save what the caller just told you. In that reply say nothing, except "Okay, let me check that for you." '
        + 'if a lookup follows; answer after the result. '
        + 'Send only changed fields. Returns confirmed and missing, plus readBack or blocked.',
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
