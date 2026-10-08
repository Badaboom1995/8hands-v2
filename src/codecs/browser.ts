// Codec for the web UI: our own JSON protocol (web/index.html).

import type { CallCodec, InboundMsg } from '../core/transport';

export function browserCodec(): CallCodec {
    return {
        channel: 'browser',
        decode(raw): InboundMsg {
            const msg = JSON.parse(raw);
            if (msg.type === 'text') return { kind: 'text', text: msg.text };
            if (msg.type === 'audio') return { kind: 'audio', data: msg.data };
            if (msg.type === 'calculate') return { kind: 'calculate' };
            return { kind: 'ignore' };
        },
        ready: (model) => JSON.stringify({ type: 'ready', model }),
        audio: (data) => JSON.stringify({ type: 'audio_delta', data }),
        agentTextDelta: (delta) => JSON.stringify({ type: 'agent_text_delta', delta }),
        userTranscript: (text) => JSON.stringify({ type: 'user_transcript', text }),
        interrupt: () => JSON.stringify({ type: 'interrupt' }),
        turnDone: () => JSON.stringify({ type: 'turn_done' }),
        stats: (stats) => JSON.stringify({ type: 'stats', ...stats }),
        toolCall: (info) => JSON.stringify({ type: 'tool_call', ...info }),
        state: (state) => JSON.stringify({ type: 'state', state }),
        error: (message) => JSON.stringify({ type: 'error', message }),
        calculation: (result) => JSON.stringify({ type: 'calculation', result }),
    };
}
