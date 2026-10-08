// Per-call trace: everything that happened on a call, in order, untruncated.
// The session emits these; a recorder (calls/recorder.ts) stores them.
// Each event maps 1:1 to a row in `call_events`.

export type TraceKind =
    | 'caller_message'   // what the caller said (async transcription, approximate)
    | 'agent_message'    // what the agent said (transcript of its audio)
    | 'response'         // one model response: usage, cost, status, latency
    | 'tool_call'        // args, result, status, run time
    | 'state_change'     // call state after a tool changed it
    | 'interrupt'        // caller spoke over the agent
    | 'error';

export interface TraceEvent {
    kind: TraceKind;
    /** Wall clock, ms. */
    at: number;
    text?: string;
    toolName?: string;
    /** Tool: ok | blocked | error | recovered | gave_up. Response: completed | cancelled | failed | incomplete. */
    status?: string;
    costUsd?: number;
    /** Response: caller stopped speaking (or call connected, for the greeting) → first agent audio. */
    latencyMs?: number;
    /** Tool run time; length of a message's audio. */
    durationMs?: number;
    responseId?: string;
    /** Everything else, untruncated. */
    payload: Record<string, unknown>;
}
