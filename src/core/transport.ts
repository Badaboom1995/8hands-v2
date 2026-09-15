// Generic call transport: one handler for every client kind.
// A CallCodec translates between the client's wire dialect and the
// session's inner format; everything else (lifecycle, relay, cleanup)
// is identical for all transports and lives in attachCall().

import WebSocket from 'ws';

import { AgentSession, type AgentSessionOptions } from './session';
import type { CallState } from './state';
import type { CallTotals, TurnStats } from './stats';

// Inner format for inbound client messages.
export type InboundMsg =
    | { kind: 'text'; text: string }
    | { kind: 'audio'; data: string }
    | { kind: 'ignore' };

// One codec instance per connection (may hold per-call state, e.g. Twilio's streamSid).
// Each encoder returns a wire frame for that client, or null to skip the event.
export interface CallCodec {
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
}

export function attachCall(ws: WebSocket, codec: CallCodec, opts: AgentSessionOptions): void {
    console.log('call started');

    const out = (frame: string | null | undefined): void => {
        if (frame && ws.readyState === WebSocket.OPEN) ws.send(frame);
    };

    const session = new AgentSession(opts, {
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
            if (ws.readyState === WebSocket.OPEN) ws.close();
        },
    });

    ws.on('message', (data) => {
        const msg = codec.decode(data.toString());
        if (msg.kind === 'text') session.sendText(msg.text);
        else if (msg.kind === 'audio') session.sendAudio(msg.data);
    });

    ws.on('close', () => {
        console.log(`call ended: ${session.stats.summaryLine()}`);
        session.close();
    });
}
