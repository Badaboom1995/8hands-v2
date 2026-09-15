// update_call_state — the one tool the model uses to record what it learned.
// Silent: on success the conversation just continues.

import { defineTool } from '../core/tools';
import { applyPatch, CallStatePatch, describeState } from '../core/state';

export const updateCallStateTool = defineTool({
    name: 'update_call_state',
    description:
        'Save facts the caller just gave you: intent, service, staff, location, date, '
        + 'time of day, name, phone, or a short note. Call this right after learning '
        + 'something new, before you reply. Send only the fields that changed. '
        + 'Returns everything confirmed so far and what is still missing.',
    args: CallStatePatch,
    mode: 'silent',
    handler: (patch, ctx) => {
        const changed = applyPatch(ctx.state, patch);
        return { saved: changed, ...describeState(ctx.state) };
    },
});
