-- Call log: one row per call, every event of the call in order.

CREATE TABLE calls (
    id                      uuid PRIMARY KEY,
    business_id             text NOT NULL,
    environment             text NOT NULL,              -- Railway environment, or 'local'
    channel                 text NOT NULL,              -- phone | browser
    twilio_call_sid         text UNIQUE,
    caller_phone            text,
    called_phone            text,
    model                   text NOT NULL,
    commit_sha              text,
    started_at              timestamptz NOT NULL,
    ended_at                timestamptz,
    duration_ms             integer,
    end_reason              text,                       -- caller_hangup | openai_closed | server_shutdown
    turns                   integer NOT NULL DEFAULT 0,
    input_tokens            integer NOT NULL DEFAULT 0,
    cached_tokens           integer NOT NULL DEFAULT 0,
    output_tokens           integer NOT NULL DEFAULT 0,
    openai_cost_usd         numeric(10,6) NOT NULL DEFAULT 0,
    transcription_cost_usd  numeric(10,6) NOT NULL DEFAULT 0,
    twilio_cost_usd         numeric(10,6),
    total_cost_usd          numeric(10,6) NOT NULL DEFAULT 0,
    avg_latency_ms          integer,
    max_latency_ms          integer,
    final_state             jsonb,
    outcome                 text                        -- booked | not_booked | info_only
);

CREATE INDEX calls_started_at ON calls (started_at DESC);
CREATE INDEX calls_business_started_at ON calls (business_id, started_at DESC);
CREATE INDEX calls_caller_phone ON calls (caller_phone);

CREATE TABLE call_events (
    id           bigserial PRIMARY KEY,
    call_id      uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
    seq          integer NOT NULL,
    at           timestamptz NOT NULL,
    t_ms         integer NOT NULL,                      -- ms since call start
    kind         text NOT NULL,                         -- caller_message | agent_message | response | tool_call | state_change | interrupt | error
    text         text,
    tool_name    text,
    status       text,
    cost_usd     numeric(10,6),
    latency_ms   integer,
    duration_ms  integer,
    response_id  text,
    payload      jsonb NOT NULL DEFAULT '{}',
    UNIQUE (call_id, seq)
);
