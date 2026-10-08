// Call log: one CallRecorder per call. Buffers the session's trace events and
// writes them to Postgres in batches (every second and at hang-up), never in
// the audio path. If the database is unreachable the rows stay buffered and
// are retried; if they still can't be written at the end, they go to stdout
// in full so nothing is lost.

import { db } from '../db';
import { fetchCallPrice } from '../integrations/twilio';
import type { CallState } from '../core/state';
import type { CallTotals } from '../core/stats';
import type { TraceEvent } from '../core/trace';

export interface CallInfo {
    callId: string;
    businessId: string;
    channel: 'phone' | 'browser';
    model: string;
    callerPhone?: string;
    calledPhone?: string;
    twilioCallSid?: string;
}

export type EndReason = 'caller_hangup' | 'openai_closed' | 'server_shutdown';

const FLUSH_MS = 1000;
const FINAL_ATTEMPTS = 3;
/** Twilio prices a call a little after it ends. */
const TWILIO_PRICE_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

const active = new Set<CallRecorder>();

/** Finish every live call's log (e.g. on SIGTERM before a redeploy). */
export function endAllCalls(reason: EndReason): Promise<void> {
    return Promise.all([...active].map((r) => r.end(reason))).then(() => undefined);
}

type EventRow = ReturnType<CallRecorder['row']>;

export class CallRecorder {
    private readonly startedAt = Date.now();
    private seq = 0;
    private pending: EventRow[] = [];
    private callInserted = false;
    private writing: Promise<void> = Promise.resolve();
    private readonly timer: ReturnType<typeof setInterval>;
    private ended = false;
    private dbFailing = false;

    private readonly latencies: number[] = [];
    private transcriptionCost = 0;

    constructor(
        private readonly info: CallInfo,
        /** Final call state and token totals, read at hang-up. */
        private readonly snapshot: () => { state: CallState; totals: CallTotals },
    ) {
        active.add(this);
        this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    }

    record(e: TraceEvent): void {
        if (e.kind === 'caller_message' && e.costUsd) this.transcriptionCost += e.costUsd;
        if (e.kind === 'response' && e.latencyMs !== undefined
            && (e.payload.latency as { trigger?: string } | null)?.trigger === 'caller') {
            this.latencies.push(e.latencyMs);
        }
        this.pending.push(this.row(e));
        if (this.ended) void this.flush(); // a late event after hang-up
    }

    private row(e: TraceEvent) {
        return {
            call_id: this.info.callId,
            seq: ++this.seq,
            at: new Date(e.at),
            t_ms: e.at - this.startedAt,
            kind: e.kind,
            text: e.text ?? null,
            tool_name: e.toolName ?? null,
            status: e.status ?? null,
            cost_usd: e.costUsd ?? null,
            latency_ms: e.latencyMs === undefined ? null : Math.round(e.latencyMs),
            duration_ms: e.durationMs === undefined ? null : Math.round(e.durationMs),
            response_id: e.responseId ?? null,
            payload: e.payload,
        };
    }

    async end(reason: EndReason): Promise<void> {
        if (this.ended) return;
        this.ended = true;
        clearInterval(this.timer);
        active.delete(this);

        const endedAt = Date.now();
        const { state, totals } = this.snapshot();
        const openaiCost = totals.cost;
        const lat = this.latencies;
        const summary = {
            ended_at: new Date(endedAt),
            duration_ms: endedAt - this.startedAt,
            end_reason: reason,
            turns: totals.turns,
            input_tokens: totals.input,
            cached_tokens: totals.cached,
            output_tokens: totals.output,
            openai_cost_usd: openaiCost,
            transcription_cost_usd: this.transcriptionCost,
            total_cost_usd: openaiCost + this.transcriptionCost,
            avg_latency_ms: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
            max_latency_ms: lat.length ? Math.round(Math.max(...lat)) : null,
            final_state: JSON.parse(JSON.stringify(state)),
            outcome: outcomeOf(state),
        };
        console.log(`call ended (${reason}): ${Math.round(summary.duration_ms / 1000)}s, ${totals.turns} responses, `
            + `$${summary.total_cost_usd.toFixed(4)} before Twilio, latency avg ${summary.avg_latency_ms ?? '-'} / max ${summary.max_latency_ms ?? '-'} ms`);
        if (!db) return;

        for (let attempt = 1; attempt <= FINAL_ATTEMPTS; attempt++) {
            await this.flush();
            if (!this.pending.length && this.callInserted) {
                try {
                    await db`UPDATE calls SET ${db(summary)} WHERE id = ${this.info.callId}`;
                    break;
                } catch (err) {
                    console.error(`[calls] final update failed (attempt ${attempt}):`, (err as Error).message);
                }
            }
            if (attempt < FINAL_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000));
            else this.dump(summary);
        }
        if (this.info.twilioCallSid) this.scheduleTwilioPrice(0);
    }

    /** Write buffered rows. Serialized: one write at a time, the call row first. */
    private flush(): Promise<void> {
        if (!db) {
            this.pending = [];
            return Promise.resolve();
        }
        this.writing = this.writing.then(async () => {
            if (!this.callInserted) await this.insertCall();
            if (!this.callInserted || !this.pending.length) return;
            const batch = this.pending;
            this.pending = [];
            try {
                await db!`INSERT INTO call_events ${db!(batch)} ON CONFLICT (call_id, seq) DO NOTHING`;
                this.dbOk();
            } catch (err) {
                this.pending = batch.concat(this.pending);
                this.dbFailed(err);
            }
        });
        return this.writing;
    }

    private async insertCall(): Promise<void> {
        const i = this.info;
        try {
            await db!`INSERT INTO calls ${db!({
                id: i.callId,
                business_id: i.businessId,
                environment: process.env.RAILWAY_ENVIRONMENT_NAME || 'local',
                channel: i.channel,
                twilio_call_sid: i.twilioCallSid ?? null,
                caller_phone: i.callerPhone ?? null,
                called_phone: i.calledPhone ?? null,
                model: i.model,
                commit_sha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
                started_at: new Date(this.startedAt),
            })} ON CONFLICT (id) DO NOTHING`;
            this.callInserted = true;
            this.dbOk();
        } catch (err) {
            this.dbFailed(err);
        }
    }

    private dbOk(): void {
        if (this.dbFailing) console.log(`[calls] ${this.info.callId}: database writes recovered`);
        this.dbFailing = false;
    }

    private dbFailed(err: unknown): void {
        if (!this.dbFailing) console.error(`[calls] ${this.info.callId}: database write failed, buffering:`, (err as Error).message);
        this.dbFailing = true;
    }

    /** Last resort: the whole call log to stdout. */
    private dump(summary: Record<string, unknown>): void {
        console.error(`[calls] ${this.info.callId}: could not write the call log; full log follows`);
        console.log(JSON.stringify({ call: { ...this.info, startedAt: new Date(this.startedAt), ...summary }, events: this.pending }));
        this.pending = [];
    }

    private scheduleTwilioPrice(attempt: number): void {
        const delay = TWILIO_PRICE_DELAYS_MS[attempt];
        if (delay === undefined) {
            console.warn(`[calls] ${this.info.callId}: Twilio never priced call ${this.info.twilioCallSid}`);
            return;
        }
        setTimeout(async () => {
            try {
                const price = await fetchCallPrice(this.info.twilioCallSid!);
                if (price === null) return this.scheduleTwilioPrice(attempt + 1);
                await db!`UPDATE calls SET twilio_cost_usd = ${price},
                    total_cost_usd = openai_cost_usd + transcription_cost_usd + ${price}
                    WHERE id = ${this.info.callId}`;
            } catch (err) {
                console.error(`[calls] ${this.info.callId}: Twilio price failed:`, (err as Error).message);
                this.scheduleTwilioPrice(attempt + 1);
            }
        }, delay).unref?.();
    }
}

function outcomeOf(state: CallState): string | null {
    if (state.booking) return 'booked';
    if (state.intent === 'book' || state.intent === 'reschedule') return 'not_booked';
    return state.intent ? 'info_only' : null;
}
