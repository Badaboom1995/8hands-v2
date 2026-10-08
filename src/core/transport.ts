// Generic call transport: one handler for every client kind.
// A CallCodec translates between the client's wire dialect and the
// session's inner format; everything else (lifecycle, relay, cleanup)
// is identical for all transports and lives in attachCall().

import WebSocket from 'ws';

import { AgentSession, type AgentSessionOptions } from './session';
import { CallRecorder, type EndReason } from '../calls/recorder';
import { composeAppointment, type Appointment } from '../tools/square/compose';
import type { CallState } from './state';
import type { CallTotals, TurnStats } from './stats';

// Inner format for inbound client messages.
export type InboundMsg =
    | { kind: 'text'; text: string }
    | { kind: 'audio'; data: string }
    /** Test UI: price and time the appointment in call state. */
    | { kind: 'calculate' }
    /** The phone line is up (Twilio `start`); carries the caller ID. */
    | { kind: 'start'; callerPhone?: string; calledPhone?: string; callSid?: string }
    /** Not a call we accept: hang up. */
    | { kind: 'reject'; reason: string }
    | { kind: 'ignore' };

// One codec instance per connection (may hold per-call state, e.g. Twilio's streamSid).
// Each encoder returns a wire frame for that client, or null to skip the event.
export interface CallCodec {
    channel: 'phone' | 'browser';
    /** Start the session on the first `start` message, not on connect (caller ID arrives there). */
    waitsForStart?: boolean;
    decode(raw: string): InboundMsg;
    ready?(model: string): string | null;
    audio(base64Pcm: string): string | null;
    agentTextDelta?(delta: string): string | null;
    userTranscript?(text: string): string | null;
    interrupt(): string | null;
    turnDone?(): string | null;
    stats?(stats: { turn: TurnStats; total: CallTotals }): string | null;
    toolCall?(info: { name: string; args: unknown; result: unknown }): string | null;
    state?(state: CallState): string | null;
    error?(message: string): string | null;
    calculation?(result: Appointment | { error: string }): string | null;
}

export function attachCall(ws: WebSocket, codec: CallCodec, opts: AgentSessionOptions, meta: { businessId: string }): void {
    const out = (frame: string | null | undefined): void => {
        if (frame && ws.readyState === WebSocket.OPEN) ws.send(frame);
    };

    let session: AgentSession | null = null;
    let recorder: CallRecorder | null = null;
    let endReason: EndReason | null = null;
    const start = (line: { callerPhone?: string; calledPhone?: string; callSid?: string }): AgentSession => {
        const { callerPhone } = line;
        console.log(`call started${callerPhone ? ` from ${callerPhone}` : ''}`);
        const s = new AgentSession({ ...opts, callerPhone }, {
            onReady: () => out(codec.ready?.(opts.model)),
            onAudio: (data) => out(codec.audio(data)),
            onAgentTextDelta: (delta) => out(codec.agentTextDelta?.(delta)),
            onUserTranscript: (text) => out(codec.userTranscript?.(text)),
            onInterrupt: () => out(codec.interrupt()),
            onTurnDone: () => out(codec.turnDone?.()),
            onStats: (stats) => out(codec.stats?.(stats)),
            onToolCall: (info) => out(codec.toolCall?.(info)),
            onState: (state) => out(codec.state?.(state)),
            onError: (message) => out(codec.error?.(message)),
            onClose: () => {
                endReason ??= 'openai_closed';
                if (ws.readyState === WebSocket.OPEN) ws.close();
            },
            onTrace: (e) => recorder?.record(e),
        });
        recorder = new CallRecorder({
            callId: s.state.callId,
            businessId: meta.businessId,
            channel: codec.channel,
            model: opts.model,
            callerPhone,
            calledPhone: line.calledPhone,
            twilioCallSid: line.callSid,
        }, () => ({ state: s.state, totals: s.stats.totals() }));
        return s;
    };
    if (!codec.waitsForStart) session = start({ callerPhone: opts.callerPhone });

    ws.on('message', (data) => {
        const msg = codec.decode(data.toString());
        if (msg.kind === 'start') session ??= start({ ...msg, callerPhone: msg.callerPhone ?? opts.callerPhone });
        else if (msg.kind === 'reject') {
            console.warn(`call rejected: ${msg.reason}`);
            ws.close();
        } else if (!session) return;
        else if (msg.kind === 'text') session.sendText(msg.text);
        else if (msg.kind === 'audio') session.sendAudio(msg.data);
        else if (msg.kind === 'calculate' && codec.calculation) {
            composeAppointment(session.state).then(
                (result) => out(codec.calculation!(result)),
                (err) => out(codec.calculation!({ error: err instanceof Error ? err.message : String(err) })),
            );
        }
    });

    ws.on('close', () => {
        if (!session) return;
        endReason ??= 'caller_hangup'; // before session.close(): its onClose may fire synchronously
        session.close();
        void recorder?.end(endReason);
    });
}
