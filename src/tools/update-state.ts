// update_call_state — the one tool the model uses to record what it learned.
// Silent: on success the conversation just continues.

import { customerGate, identifyFromPatch } from '../card/identify';
import { defineTool } from '../core/tools';
import {
    applyPatch, bindSlot, CallStatePatch, describeState, freshReadBack, needsReadBack, SLOT_INPUTS,
} from '../core/state';
import { resolveNamedMaster } from './square/masters';
import { recheckSlot } from './square/research';

export const updateCallStateTool = defineTool({
    name: 'update_call_state',
    description:
        'Save what the caller just told you. A reply that calls only this tool says nothing; '
        + 'answer after the result. '
        + 'Send only changed fields. Returns confirmed and missing, plus readBack or blocked.',
    args: CallStatePatch,
    mode: 'silent',
    handler: async (patch, ctx) => {
        const state = ctx.state;
        const { time, ...facts } = patch;
        const before = state.slot;
        const saved = applyPatch(state, facts);

        // Only the design or add-ons changed after a time was chosen: the length
        // changed, so check whether that same time still fits.
        const inputs = saved.filter((k) => (SLOT_INPUTS as readonly string[]).includes(k));
        if (before && !state.slot && !time && inputs.length && inputs.every((k) => k === 'design' || k === 'addons')) {
            const moved = await recheckSlot(state, before);
            if (moved) return { ...moved, saved, ...describeState(state) };
        }

        // Another phone or email to find the caller's profile.
        if (saved.includes('customerPhone') || saved.includes('customerEmail')) {
            const invalid = await identifyFromPatch(state, {
                phone: saved.includes('customerPhone') ? state.customerPhone : undefined,
                email: saved.includes('customerEmail') ? state.customerEmail : undefined,
            });
            if (invalid) return { ...invalid, saved, ...describeState(state) };
        }

        // A named master: the server finds them in Square; their studio and level become facts.
        let masterInfo: object | undefined;
        if (saved.includes('master') && state.master) {
            const resolved = await resolveNamedMaster(state);
            if ('blocked' in resolved) {
                const kept = state.master ? saved : saved.filter((k) => k !== 'master');
                return { ...resolved, saved: kept, ...describeState(state) };
            }
            masterInfo = resolved.masterInfo;
            saved.push(...resolved.saved.filter((k) => !saved.includes(k)));
        }

        if (time) {
            const bound = bindSlot(state, time);
            if ('blocked' in bound) return { ...bound, saved, ...describeState(state) };
            saved.push(...bound.changed.filter((k) => !saved.includes(k)));
        }

        // Who the caller is is settled early (after the studio): a phone with no
        // profile, or a returning client not found, gets its next question now.
        // The card itself is checked at the read-back.
        if (['customerPhone', 'customerEmail', 'firstVisit'].some((k) => saved.includes(k)) && !needsReadBack(state)) {
            const gate = await customerGate(state);
            if ('blocked' in gate && gate.blocked !== 'card') return { ...gate, saved, ...describeState(state) };
        }

        // Before the caller hears a read-back, they must be a client we may book for.
        if (needsReadBack(state)) {
            const gate = await customerGate(state);
            if (!('ok' in gate)) return { ...gate, saved, ...describeState(state) };
            return { saved, ...describeState(state), readBack: freshReadBack(state) };
        }
        return { saved, ...describeState(state), ...(masterInfo ? { masterInfo } : {}) };
    },
});
