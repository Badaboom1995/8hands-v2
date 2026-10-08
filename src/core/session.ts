// AgentSession — the core of agent-v2.
// Owns one OpenAI Realtime connection for one call. Transport-agnostic:
// the peer (browser today, Twilio later) talks to it via input methods
// and the AgentSessionEvents callbacks, never touches the socket directly.

import WebSocket from 'ws';

import { createCallState, type CallState } from './state';
import { CallStats, type CallTotals, type TurnStats } from './stats';
import { isToolError, parseToolArgs, toRealtimeTool, type AgentTool, type ToolError } from './tools';

export interface AgentSessionOptions {
    apiKey: string;
    model: string;
    instructions: string;
    /** Scripted opening line, spoken by the agent as soon as the session is ready. */
    greeting?: string;
    /** Wire audio format, both directions. Browser: pcm 24k. Twilio: pcmu. */
    audioFormat?: { type: 'audio/pcm'; rate: 24000 } | { type: 'audio/pcmu' };
    /** Server functions the model may call. */
    tools?: AgentTool<any>[];
    voice?: string;
    /** Caller ID from the phone line (Twilio `From`; a test field in the browser). */
    callerPhone?: string;
    /** Runs once with the fresh call state, e.g. to start the caller ID lookup in the background. */
    onCallStart?: (state: CallState) => void;
    debug?: boolean;
}

export interface AgentSessionEvents {
    onReady: () => void;
    /** Base64 PCM16 24kHz chunk of agent speech. */
    onAudio: (base64: string) => void;
    /** Streaming transcript of the agent's speech. */
    onAgentTextDelta: (delta: string) => void;
    /** Async transcription of what the caller said. */
    onUserTranscript: (text: string) => void;
    /** Caller started speaking — stop any playback. */
    onInterrupt: () => void;
    onTurnDone: () => void;
    onStats: (stats: { turn: TurnStats; total: CallTotals }) => void;
    /** A tool was executed (for observability/UI). */
    onToolCall: (info: { name: string; args: unknown; result: unknown }) => void;
    /** Call state after a tool ran (for observability/UI). */
    onState: (state: CallState) => void;
    onError: (message: string) => void;
    onClose: () => void;
}

/** Delay before retrying a failed response: OpenAI's "try again in 1.2s / 841ms" plus a margin. */
function retryDelayMs(message: string | undefined): number {
    const m = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(message ?? '');
    if (!m) return 1500;
    const ms = Number(m[1]) * (m[2]!.toLowerCase() === 's' ? 1000 : 1);
    return Math.max(1500, Math.ceil(ms) + 300);
}

function safeJson(raw: string): unknown {
    try {
        return raw ? JSON.parse(raw) : {};
    } catch {
        return { unparsed: raw };
    }
}

export class AgentSession {
    private readonly ws: WebSocket;
    private readonly opts: AgentSessionOptions;
    private readonly events: AgentSessionEvents;
    readonly stats: CallStats;
    /** Server-owned record of what has been established on this call. */
    readonly state: CallState;

    private ready = false;
    private queued: string[] = [];

    constructor(opts: AgentSessionOptions, events: AgentSessionEvents) {
        this.opts = opts;
        this.events = events;
        this.state = createCallState(opts.callerPhone);
        opts.onCallStart?.(this.state);
        this.stats = new CallStats(opts.model);

        this.ws = new WebSocket(
            `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(opts.model)}`,
            { headers: { Authorization: `Bearer ${opts.apiKey}` } },
        );
        this.ws.on('open', () => this.configure());
        this.ws.on('message', (data) => this.handleEvent(JSON.parse(data.toString())));
        this.ws.on('error', (err) => this.events.onError(err.message));
        this.ws.on('close', () => this.events.onClose());
    }

    // ── Input (called by the transport) ──

    sendText(text: string): void {
        this.send({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text }],
            },
        });
        this.send({ type: 'response.create' });
    }

    sendAudio(base64Pcm: string): void {
        this.send({ type: 'input_audio_buffer.append', audio: base64Pcm });
    }

    close(): void {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
    }

    // ── Internals ──

    // One-off stage directions (e.g. the greeting) go at the end of the
    // conversation as a system message, followed by a bare response.create.
    // Never override `instructions` per response: the prompt is the start of
    // the model's context, so changing it makes the whole call so far — tools,
    // conversation, audio — miss the prompt cache and bill at full price.
    private direct(text: string): void {
        this.send({
            type: 'conversation.item.create',
            item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
        });
    }

    // Server-triggered opening turn with the exact wording, so the greeting is
    // deterministic rather than left to the model.
    private speakGreeting(greeting: string): void {
        this.direct(`Greet the caller now. Say exactly this, verbatim, in a warm natural tone, and nothing else: "${greeting}"`);
        this.send({ type: 'response.create' });
    }

    // ── Tool execution ──
    //
    // Tool calls are picked up from response.done (never mid-response), so the
    // follow-up response.create below can never collide with an active response.
    // The session prompt is set once and never overridden: follow-ups are bare
    // response.create calls, and the model learns the outcome from a `status`
    // field on every tool result (ok | blocked | error | recovered | gave_up). What to say
    // in each case is a static rule in the session prompt.
    //
    // A failure with retries left takes two responses: first speech only
    // (tools disabled, "need a moment"), then one that forces the corrected
    // call. A single response cannot be trusted to both speak and call a tool.
    //
    // Invalid arguments can only be fixed by the model, so they go straight back.
    // Execution failures (handler threw) are retried server-side first; the model
    // only hears about them if all attempts fail.

    private static readonly MODEL_RETRY_LIMIT = 2;       // attempts per tool before giving up
    private static readonly EXEC_RETRY_ATTEMPTS = 3;     // server-side retries on handler throw
    private static readonly EXEC_RETRY_BACKOFF_MS = 300;
    /** Minimum silence between the agent's "let me check…" (or a filler) and the result speech. */
    private static readonly SPEECH_GAP_MS = 500;

    /** Consecutive failed attempts per tool name, cleared on success. */
    private readonly failedAttempts = new Map<string, number>();
    /** Tool to force on the next response, after the "need a moment" speech finishes. */
    private pendingRetry: string | null = null;

    // ── Stall recovery ──
    //
    // A response can end without completing: cancelled because voice detection
    // heard "speech" (often the tail of the agent's own audio, or room noise),
    // or failed on OpenAI's side. Nothing then triggers the next response and
    // the call goes silent until the caller speaks. So after any such response,
    // if no new response starts within RECOVER_MS (or the "try again in Xs" a
    // rate-limit failure names) and the caller isn't speaking, we request one
    // ourselves. A response the server starts on its
    // own (after a real caller turn) cancels the timer, so there is never a
    // second, competing response.

    private static readonly RECOVER_MS = 1500;
    private static readonly RECOVER_LIMIT = 4;           // consecutive recoveries before giving up
    private responseActive = false;
    private callerSpeaking = false;
    private recoverPending = false;
    private recoverAttempts = 0;
    private recoverTimer: ReturnType<typeof setTimeout> | null = null;

    private recoverDelayMs = AgentSession.RECOVER_MS;

    private scheduleRecovery(delayMs = this.recoverDelayMs): void {
        this.recoverDelayMs = delayMs;
        this.recoverPending = true;
        if (this.recoverTimer) clearTimeout(this.recoverTimer);
        this.recoverTimer = null;
        if (this.callerSpeaking) return; // re-armed when the caller stops
        this.recoverTimer = setTimeout(() => {
            this.recoverTimer = null;
            if (!this.recoverPending || this.responseActive || this.callerSpeaking) return;
            this.recoverPending = false;
            if (this.recoverAttempts >= AgentSession.RECOVER_LIMIT) {
                console.warn('[recover] giving up; waiting for the caller');
                return;
            }
            this.recoverAttempts += 1;
            console.warn(`[recover] no response after a stalled one; requesting one (attempt ${this.recoverAttempts})`);
            this.send({ type: 'response.create' });
        }, delayMs);
    }

    private cancelRecovery(): void {
        this.recoverPending = false;
        if (this.recoverTimer) clearTimeout(this.recoverTimer);
        this.recoverTimer = null;
    }

    // ── Speech timing and fillers ──
    //
    // The reply that calls a tool usually also says "let me check…". Audio is
    // streamed faster than it plays, so we measure it from the bytes we stream
    // and hold the result speech until SPEECH_GAP_MS after it ends.
    //
    // A tool may also opt into a filler: the server has the model say one short
    // sentence ("checking the schedule") while the handler runs, and the result
    // waits for that audio instead. No tool uses one today; the model's own
    // "let me check…" is enough.

    private audioFirstAt = 0;
    private audioBytes = 0;
    /** Resolves with the wall-clock time the current filler's audio ends. */
    private fillerDone: ((audioEndsAt: number) => void) | null = null;

    private speakFiller(what: string): Promise<number> {
        return new Promise((resolve) => {
            this.fillerDone = resolve;
            this.direct(`Right now, say one short sentence telling the caller you are ${what}, `
                + 'in the language the caller is speaking. Nothing else. This applies to this one reply only.');
            this.send({ type: 'response.create', response: { tool_choice: 'none' } });
        });
    }

    /** Duration of the audio streamed in the current response, from byte count. */
    private audioEndsAt(): number {
        const format = this.opts.audioFormat || { type: 'audio/pcm', rate: 24000 };
        const bytesPerMs = format.type === 'audio/pcmu' ? 8 : 48; // pcmu 8kHz×1B, pcm16 24kHz×2B
        return this.audioFirstAt + this.audioBytes / bytesPerMs;
    }

    /**
     * Run every tool call from one reply, in order (a save may feed the search
     * after it), send all results, then ask for exactly one next response.
     * One response.create per call would collide: only one response may be
     * active at a time.
     */
    private async runTools(calls: { name: string; call_id: string; arguments: string }[]): Promise<void> {
        // When the calling reply's own speech ends; read before any await, while
        // the audio counters still describe that reply.
        let speechEndsAt = this.audioBytes ? this.audioEndsAt() : 0;
        let retry: string | null = null;
        for (const call of calls) {
            const r = await this.runTool(call.name, call.call_id, call.arguments);
            if (r.fillerEndsAt) speechEndsAt = Math.max(speechEndsAt, r.fillerEndsAt);
            if (r.willRetry && !retry) retry = call.name;
        }

        if (retry) {
            // Speech only now; the forced retry goes out when this response is done.
            this.pendingRetry = retry;
            this.send({ type: 'response.create', response: { tool_choice: 'none' } });
            return;
        }

        // Don't talk over the "let me check…" that came with the calls, or a filler.
        const pause = speechEndsAt ? Math.max(0, speechEndsAt + AgentSession.SPEECH_GAP_MS - Date.now()) : 0;
        setTimeout(() => this.send({ type: 'response.create' }), pause);
    }

    /** Run one tool call and send its result. The caller decides what response comes next. */
    private async runTool(
        name: string, callId: string, rawArgs: string,
    ): Promise<{ willRetry: boolean; fillerEndsAt?: number }> {
        let fillerEndsAt: number | undefined;
        const tool = (this.opts.tools || []).find((t) => t.name === name);
        // For the trace: what the model sent, even if it fails to parse.
        let args: unknown = safeJson(rawArgs);
        let outcome: unknown;

        if (!tool) {
            outcome = { error: 'unknown_tool', message: `no tool named ${name}` } satisfies ToolError;
        } else {
            const parsed = parseToolArgs(tool, rawArgs);
            if (!parsed.ok) {
                outcome = parsed.error;
            } else {
                args = parsed.args;
                const run = this.executeWithRetry(tool, parsed.args);
                if (tool.filler) fillerEndsAt = await this.speakFiller(tool.filler);
                outcome = await run;
            }
        }

        const failed = isToolError(outcome);
        const priorFailures = this.failedAttempts.get(name) ?? 0;
        const attempts = failed ? priorFailures + 1 : priorFailures;
        if (failed) this.failedAttempts.set(name, attempts);
        else this.failedAttempts.delete(name);

        const willRetry = failed && attempts < AgentSession.MODEL_RETRY_LIMIT;
        const blocked = !failed && typeof (outcome as { blocked?: unknown })?.blocked === 'string';
        const status = failed ? (willRetry ? 'error' : 'gave_up')
            : priorFailures > 0 ? 'recovered' : blocked ? 'blocked' : 'ok';
        const result = { status, ...(outcome as object) };

        this.events.onToolCall({ name, args, result });
        this.events.onState(this.state);
        this.send({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(result),
            },
        });

        return { willRetry, fillerEndsAt };
    }

    private sendForcedRetry(_name: string): void {
        // Pinning a specific function makes the Realtime API emit the arguments as
        // plain text instead of a function_call item; 'required' is the usable form.
        this.send({ type: 'response.create', response: { tool_choice: 'required' } });
    }

    private async executeWithRetry(tool: AgentTool<any>, args: unknown): Promise<unknown> {
        let lastError = '';
        for (let attempt = 1; attempt <= AgentSession.EXEC_RETRY_ATTEMPTS; attempt++) {
            try {
                return await tool.handler(args, { state: this.state });
            } catch (err) {
                lastError = (err as Error).message;
                if (this.opts.debug) console.log(`[tool ${tool.name}] attempt ${attempt} failed: ${lastError}`);
                if (attempt < AgentSession.EXEC_RETRY_ATTEMPTS) {
                    await new Promise((r) => setTimeout(r, AgentSession.EXEC_RETRY_BACKOFF_MS * attempt));
                }
            }
        }
        return { error: 'tool_execution_failed', message: lastError } satisfies ToolError;
    }

    private configure(): void {
        const format = this.opts.audioFormat || { type: 'audio/pcm', rate: 24000 };
        this.ws.send(JSON.stringify({
            type: 'session.update',
            session: {
                type: 'realtime',
                instructions: this.opts.instructions,
                tools: (this.opts.tools || []).map(toRealtimeTool),
                tool_choice: 'auto',
                output_modalities: ['audio'],
                audio: {
                    input: {
                        format,
                        transcription: { model: 'gpt-4o-mini-transcribe' },
                        // Filter background noise (salon music, dryers) before VAD and the model hear it.
                        noise_reduction: { type: 'near_field' },
                        // Strict VAD: don't treat mic-startup clicks/hiss as a turn.
                        turn_detection: {
                            type: 'server_vad',
                            threshold: 0.8,
                            prefix_padding_ms: 300,
                            silence_duration_ms: 600,
                        },
                    },
                    output: {
                        format,
                        voice: this.opts.voice || 'marin',
                    },
                },
            },
        }));
    }

    private send(event: Record<string, unknown>): void {
        if (this.ws.readyState !== WebSocket.OPEN && this.ready) return; // call already ended
        const payload = JSON.stringify(event);
        if (this.ready) this.ws.send(payload);
        else this.queued.push(payload);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private handleEvent(event: any): void {
        if (this.opts.debug) console.log('[openai]', event.type);

        switch (event.type) {
            case 'session.updated':
                if (!this.ready) {
                    this.ready = true;
                    for (const payload of this.queued.splice(0)) this.ws.send(payload);
                    this.events.onReady();
                    this.events.onState(this.state);
                    if (this.opts.greeting) this.speakGreeting(this.opts.greeting);
                }
                break;

            case 'response.created':
                this.responseActive = true;
                this.cancelRecovery();
                this.audioFirstAt = 0;
                this.audioBytes = 0;
                break;

            case 'response.output_audio.delta':
                if (!this.audioFirstAt) this.audioFirstAt = Date.now();
                this.audioBytes += Math.floor((event.delta?.length ?? 0) * 3 / 4); // base64 → bytes
                this.events.onAudio(event.delta);
                break;

            case 'response.output_audio_transcript.delta':
                this.events.onAgentTextDelta(event.delta);
                break;

            case 'conversation.item.input_audio_transcription.completed':
                this.events.onUserTranscript(event.transcript);
                break;

            case 'input_audio_buffer.speech_started':
                this.callerSpeaking = true;
                if (this.recoverTimer) clearTimeout(this.recoverTimer);
                this.recoverTimer = null;
                this.events.onInterrupt();
                break;

            case 'input_audio_buffer.speech_stopped':
                this.callerSpeaking = false;
                if (this.recoverPending) this.scheduleRecovery();
                break;

            case 'response.done': {
                if (this.opts.debug) {
                    const r = event.response ?? {};
                    console.log('[response.done]', JSON.stringify({
                        status: r.status,
                        status_details: r.status_details,
                        output: (r.output ?? []).map((o: any) => ({
                            type: o.type, name: o.name, role: o.role, status: o.status,
                            content: (o.content ?? []).map((c: any) => ({ type: c.type, transcript: c.transcript, text: c.text })),
                        })),
                    }));
                }
                this.responseActive = false;
                const status: string | undefined = event.response?.status;
                if (status && status !== 'completed') {
                    // Never silent: log why, and make sure the call keeps going.
                    const details = event.response?.status_details;
                    const reason = details?.reason ?? details?.error?.message ?? details?.type ?? '';
                    console.warn('[response]', status, JSON.stringify(details ?? null));
                    this.events.onError(`response ${status}${reason ? ` (${reason})` : ''}`);
                    this.scheduleRecovery(retryDelayMs(details?.error?.message));
                } else if (status === 'completed') {
                    this.recoverAttempts = 0;
                    this.recoverDelayMs = AgentSession.RECOVER_MS;
                }
                const usage = event.response?.usage;
                if (usage) this.events.onStats(this.stats.addTurn(usage));
                this.events.onTurnDone();

                const calls = (event.response?.output ?? []).filter(
                    (item: any) => item.type === 'function_call',
                );
                if (calls.length > 0) {
                    void this.runTools(calls);
                } else if (this.fillerDone) {
                    // The filler just finished generating; the result waits for its audio.
                    const resolve = this.fillerDone;
                    this.fillerDone = null;
                    resolve(this.audioBytes ? this.audioEndsAt() : Date.now());
                } else if (this.pendingRetry) {
                    // The "need a moment" speech just finished; now force the corrected call.
                    const name = this.pendingRetry;
                    this.pendingRetry = null;
                    this.sendForcedRetry(name);
                }
                break;
            }

            case 'error':
                console.error('[openai error]', JSON.stringify(event.error));
                this.events.onError(event.error?.message || 'unknown');
                break;
        }
    }
}
