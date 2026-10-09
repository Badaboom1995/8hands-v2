// Read side of the call log, for the /calls pages: a list of calls in a date
// range (business-local dates), and one call with every event.

import { BUSINESS } from '../business';
import { db } from '../db';
import { localDate, localMidnight } from '../tools/square/shared';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 1000;

export class CallLogError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

function requireDb() {
    if (!db) throw new CallLogError(503, 'No database configured (DATABASE_URL).');
    return db;
}

/** Calls that started on [from, to] (inclusive, business-local dates), newest first. */
export async function listCalls(q: { from?: string | null; to?: string | null; environment?: string | null }) {
    const sql = requireDb();
    const tz = BUSINESS.timezone;
    const today = localDate(Date.now(), tz);
    const from = q.from && ISO_DATE.test(q.from) ? q.from : today;
    const to = q.to && ISO_DATE.test(q.to) ? q.to : today;
    const start = new Date(localMidnight(from, tz));
    const end = new Date(localMidnight(to, tz, 1));
    const env = q.environment || null;
    const calls = await sql`
        SELECT id, environment, channel, caller_phone, called_phone, model, started_at, ended_at, duration_ms,
               end_reason, turns, openai_cost_usd, transcription_cost_usd, twilio_cost_usd, total_cost_usd,
               avg_latency_ms, max_latency_ms, outcome
        FROM calls
        WHERE started_at >= ${start} AND started_at < ${end}
          AND (${env}::text IS NULL OR environment = ${env})
        ORDER BY started_at DESC
        LIMIT ${MAX_ROWS}`;
    const environments = (await sql`SELECT DISTINCT environment FROM calls ORDER BY environment`)
        .map((r: { environment: string }) => r.environment);
    return { timezone: tz, from, to, calls, environments, truncated: calls.length === MAX_ROWS };
}

/** One call and all its events, in time order. */
export async function getCall(id: string) {
    if (!UUID.test(id)) throw new CallLogError(404, 'No such call.');
    const sql = requireDb();
    const [call] = await sql`SELECT * FROM calls WHERE id = ${id}`;
    if (!call) throw new CallLogError(404, 'No such call.');
    const events = await sql`
        SELECT seq, at, t_ms, kind, text, tool_name, status, cost_usd, latency_ms, duration_ms, response_id, payload
        FROM call_events WHERE call_id = ${id} ORDER BY t_ms, seq`;
    return { timezone: BUSINESS.timezone, call, events };
}
