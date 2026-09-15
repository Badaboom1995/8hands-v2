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
    readonly state: CallState = createCallState();

    private ready = false;
    private queued: string[] = [];

    constructor(opts: AgentSessionOptions, events: AgentSessionEvents) {
        this.opts = opts;
        this.events = events;
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

    // Server-triggered opening turn: a response.create whose per-response
    // instructions pin the exact wording, so the greeting is deterministic
    // rather than left to the model.
    private speakGreeting(greeting: string): void {
        this.send({
            type: 'response.create',
            response: {
                instructions: `${this.opts.instructions}\n\nSay exactly this, verbatim, in a warm natural tone, and nothing else: "${greeting}"`,
            },
        });
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
    private static readonly POST_TOOL_PAUSE_MS = 1000;
    /** Minimum silence between the end of a filler phrase and the result speech. */
    private static readonly FILLER_PAUSE_MS = 500;

    /** Consecutive failed attempts per tool name, cleared on success. */
    private readonly failedAttempts = new Map<string, number>();
    /** Tool to force on the next response, after the "need a moment" speech finishes. */
    private pendingRetry: string | null = null;

    // ── Filler phrase ──
    //
    // The model speaks one short sentence ("let me check the schedule") while the
    // handler runs. We measure the filler's audio from the bytes we stream, so we
    // know when playback ends and can hold the result until FILLER_PAUSE_MS later.

    /** Resolves with the wall-clock time the current filler's audio ends. */
    private fillerDone: ((audioEndsAt: number) => void) | null = null;
    private audioFirstAt = 0;
    private audioBytes = 0;

    private speakFiller(what: string): Promise<number> {
        return new Promise((resolve) => {
            this.fillerDone = resolve;
            this.send({
                type: 'response.create',
                response: {
                    tool_choice: 'none',
                    instructions: `${this.opts.instructions}\n\nSay one short sentence telling the `
                        + `caller you are ${what}, in the language the caller is speaking. Nothing else.`,
                },
            });
        });
    }

    /** Duration of the audio streamed in the current response, from byte count. */
    private audioEndsAt(): number {
        const format = this.opts.audioFormat || { type: 'audio/pcm', rate: 24000 };
        const bytesPerMs = format.type === 'audio/pcmu' ? 8 : 48; // pcmu 8kHz×1B, pcm16 24kHz×2B
        return this.audioFirstAt + this.audioBytes / bytesPerMs;
    }

    private async runTool(name: string, callId: string, rawArgs: string): Promise<void> {
        const tool = (this.opts.tools || []).find((t) => t.name === name);
        // For the trace: what the model sent, even if it fails to parse.
        let args: unknown = safeJson(rawArgs);
        let outcome: unknown;
        let notBefore = 0; // earliest time the result response may be requested

        if (!tool) {
            outcome = { error: 'unknown_tool', message: `no tool named ${name}` } satisfies ToolError;
        } else {
            const parsed = parseToolArgs(tool, rawArgs);
            if (!parsed.ok) {
                outcome = parsed.error;
            } else {
                args = parsed.args;
                const run = this.executeWithRetry(tool, parsed.args);
                if (tool.filler) {
                    const fillerEndsAt = await this.speakFiller(tool.filler);
                    notBefore = fillerEndsAt + AgentSession.FILLER_PAUSE_MS;
                }
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

        if (willRetry) {
            // Speech only now; the forced retry goes out when this response is done.
            this.pendingRetry = name;
            this.send({ type: 'response.create', response: { tool_choice: 'none' } });
            return;
        }

        // With a filler: wait until FILLER_PAUSE_MS after its audio ends. Without
        // one, report tools still get a beat so "let me check" and the answer
        // don't collide.
        let pause = 0;
        if (notBefore) pause = Math.max(0, notBefore - Date.now());
        else if (tool?.mode === 'report' && !failed) pause = AgentSession.POST_TOOL_PAUSE_MS;
        setTimeout(() => this.send({ type: 'response.create' }), pause);
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
                this.events.onInterrupt();
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
                const usage = event.response?.usage;
                if (usage) this.events.onStats(this.stats.addTurn(usage));
                this.events.onTurnDone();

                const calls = (event.response?.output ?? []).filter(
                    (item: any) => item.type === 'function_call',
                );
                if (calls.length > 0) {
                    for (const call of calls) void this.runTool(call.name, call.call_id, call.arguments);
                } else if (this.fillerDone) {
                    // The filler just finished generating; report when its audio ends.
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
