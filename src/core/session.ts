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
    onError: (message: string) => void;
    onClose: () => void;
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
                instructions: `Say exactly this, verbatim, in a warm natural tone, and nothing else: "${greeting}"`,
            },
        });
    }

    // ── Tool execution ──
    //
    // Every tool call ends with a function_call_output and then a response.create
    // whose instructions depend on the outcome (see followUpInstructions):
    //   silent tool, success            → continue, say nothing about it
    //   report tool, success            → acknowledge briefly, share the result
    //   failure, retries left           → tell the caller you need a moment, call again
    //   success after a failure         → say it's sorted, move on
    //   failure, retries exhausted      → apologize, continue without that detail
    //
    // Invalid arguments can only be fixed by the model, so they go straight back.
    // Execution failures (handler threw) are retried server-side first; the model
    // only hears about them if all attempts fail.

    private static readonly MODEL_RETRY_LIMIT = 2;       // attempts per tool before giving up
    private static readonly EXEC_RETRY_ATTEMPTS = 3;     // server-side retries on handler throw
    private static readonly EXEC_RETRY_BACKOFF_MS = 300;
    private static readonly POST_TOOL_PAUSE_MS = 1000;

    /** Consecutive failed attempts per tool name, cleared on success. */
    private readonly failedAttempts = new Map<string, number>();

    private async runTool(name: string, callId: string, rawArgs: string): Promise<void> {
        const tool = (this.opts.tools || []).find((t) => t.name === name);
        let args: unknown = {};
        let result: unknown;

        if (!tool) {
            result = { error: 'unknown_tool', message: `no tool named ${name}` } satisfies ToolError;
        } else {
            const parsed = parseToolArgs(tool, rawArgs);
            if (!parsed.ok) {
                result = parsed.error;
            } else {
                args = parsed.args;
                result = await this.executeWithRetry(tool, parsed.args);
            }
        }

        const failed = isToolError(result);
        const priorFailures = this.failedAttempts.get(name) ?? 0;
        const attempts = failed ? priorFailures + 1 : priorFailures;
        if (failed) this.failedAttempts.set(name, attempts);
        else this.failedAttempts.delete(name);

        this.events.onToolCall({ name, args, result });
        this.send({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(result),
            },
        });

        const instructions = this.followUpInstructions({
            mode: tool?.mode ?? 'silent',
            failed,
            attempts,
            recovered: !failed && priorFailures > 0,
        });
        // Report tools get a guaranteed beat before the agent speaks the result:
        // fast tools otherwise make "let me check" and the answer collide.
        const pause = tool?.mode === 'report' && !failed ? AgentSession.POST_TOOL_PAUSE_MS : 0;
        setTimeout(() => {
            this.send({ type: 'response.create', response: { instructions } });
        }, pause);
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

    private followUpInstructions(o: {
        mode: 'silent' | 'report';
        failed: boolean;
        attempts: number;
        recovered: boolean;
    }): string {
        if (o.failed && o.attempts < AgentSession.MODEL_RETRY_LIMIT) {
            return 'The tool call failed; the result explains why. Briefly tell the caller you '
                + 'need a moment because of a small technical problem on your side, in the language '
                + 'you have been speaking. Then call the same tool again with corrected arguments. '
                + 'Do not ask the caller to repeat anything they already said.';
        }
        if (o.failed) {
            return 'The tool call failed again. Apologize briefly, say you will make a note of it '
                + 'for the front desk, and continue the conversation without that detail. Do not retry.';
        }
        if (o.recovered) {
            return 'The retry worked. Tell the caller briefly that it is sorted now, then continue '
                + 'with the next question. Do not explain what went wrong.';
        }
        if (o.mode === 'silent') {
            return 'Continue the conversation naturally from where it was. Do not mention that you '
                + 'saved, noted, or recorded anything. If facts are still missing, ask for the next one.';
        }
        return 'Open with a brief natural acknowledgment that you checked, like '
            + '"Okay, found it" or "Alright, here is what I see" (vary it, do not '
            + 'repeat the same phrase every time), then share the result. Keep it '
            + 'short and spoken-style; when listing times, offer at most 2-3 options.';
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
                    if (this.opts.greeting) this.speakGreeting(this.opts.greeting);
                }
                break;

            case 'response.output_audio.delta':
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

            case 'response.function_call_arguments.done':
                void this.runTool(event.name, event.call_id, event.arguments);
                break;

            case 'response.done': {
                const usage = event.response?.usage;
                if (usage) this.events.onStats(this.stats.addTurn(usage));
                this.events.onTurnDone();
                break;
            }

            case 'error':
                console.error('[openai error]', JSON.stringify(event.error));
                this.events.onError(event.error?.message || 'unknown');
                break;
        }
    }
}
