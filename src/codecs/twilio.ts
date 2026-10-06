// Codec for Twilio Media Streams (bidirectional, <Connect><Stream>).
// Audio is G.711 μ-law 8 kHz both ways, passed through untouched: the
// Realtime session runs in audio/pcmu. UI-only events are dropped.

import type { CallCodec, InboundMsg } from '../core/transport';

export function twilioCodec(opts: { acceptToken: (token: string | undefined) => boolean }): CallCodec {
    let streamSid: string | null = null;
    const toCaller = (frame: Record<string, unknown>) => (streamSid ? JSON.stringify({ ...frame, streamSid }) : null);

    return {
        waitsForStart: true,
        decode(raw): InboundMsg {
            const msg = JSON.parse(raw);
            if (msg.event === 'media' && msg.media?.track !== 'outbound') return { kind: 'audio', data: msg.media.payload };
            if (msg.event === 'start') {
                const params: Record<string, string> = msg.start?.customParameters ?? {};
                if (!opts.acceptToken(params.token)) return { kind: 'reject', reason: 'bad stream token' };
                streamSid = msg.start.streamSid;
                console.log(`[twilio] stream ${streamSid} call ${msg.start.callSid}`);
                return { kind: 'start', callerPhone: params.from || undefined };
            }
            return { kind: 'ignore' }; // connected, mark, dtmf, stop
        },
        audio: (payload) => toCaller({ event: 'media', media: { payload } }),
        // Drop the agent audio Twilio has buffered but not yet played.
        interrupt: () => toCaller({ event: 'clear' }),
    };
}
