// update_call_state — the one tool the model uses to record what it learned.
// Silent: on success the conversation just continues.

import { defineTool } from '../core/tools';
import { applyPatch, bindSlot, CallStatePatch, describeState, freshReadBack } from '../core/state';

export const updateCallStateTool = defineTool({
    name: 'update_call_state',
    description:
        'Save facts the caller just gave you: intent, what they want, master, location, date, '
        + 'time of day, name, phone, or a short note. Call this right after learning '
        + 'something new, before you reply. Send only the fields that changed. '
        + 'Returns everything confirmed so far and what is still missing. '
        + 'When a time is picked, also returns readBack: the booking summary to read to the caller.',
    args: CallStatePatch,
    mode: 'silent',
    handler: (patch, ctx) => {
        const { time, ...facts } = patch;
        const saved = applyPatch(ctx.state, facts);
        if (time) {
            const bound = bindSlot(ctx.state, time);
            if ('blocked' in bound) return { ...bound, saved, ...describeState(ctx.state) };
            saved.push(...bound.changed.filter((k) => !saved.includes(k)));
        }
        const readBack = freshReadBack(ctx.state);
        return { saved, ...describeState(ctx.state), ...(readBack ? { readBack } : {}) };
    },
});
