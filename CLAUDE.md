\[be concise in responses\]

# CLAUDE.md — 8Hands v2 (agent)

This repo is a **from-scratch rebuild of the 8Hands agent only**. New architecture, no
code carried over. Landing, onboarding, dashboard, billing, waitlist, reactivation, and
other product surfaces are **out of scope** here.

The previous codebase at `/Users/alexey/projects/8Hands` is reference for *behavior and
domain knowledge only*, not for structure. Do not port its code or copy its design.

---

## 1. What the agent is

**8Hands is an AI front desk for local service businesses** (nail salons, beauty
studios, spas, clinics). The agent answers the business's phone and SMS like a good
human receptionist: understands why the client is calling, answers questions from the
business's own knowledge, finds real appointment slots, books them into the business's
booking system, and hands off to a human when it lacks authority.

First vertical: nail salons and beauty studios in the Bay Area / LA. Real businesses the
v1 agent served: a Russian-speaking spa with a sales funnel, a nail studio with two
locations on Square, a salon with six locations. The agent must work for all of them
from one codebase.

**Channels:**
- Voice: inbound phone calls via Twilio, OpenAI Realtime API (speech-to-speech).
- SMS: inbound texts via Twilio, text LLM.

**Booking providers to support:** Square first (catalog, variations, staff, availability,
customers, bookings), Google Calendar second. Booking is optional per business; the agent
must work with no provider connected.

---

## 2. What the agent must do on a call

1. **Greet** with the business's own greeting, in the business's language(s).
2. **Determine intent first.** A call is not always a booking. Intents include: new
   booking, question about a service / design / price / duration / staff, refill,
   free fix / repair, reschedule, cancel, complaint / refund / discount / policy
   exception, "connect me with my master", anything else that needs a human.
   Answer a simple question directly. Do not turn every call into a qualification flow.
3. **Qualify once, in natural order.** Collect what the business needs before searching:
   service (and variation / tier if the catalog has them), staff preference if any,
   location if the business has more than one, date / time window, client name and
   phone. Ask only for what is missing. Never re-ask what the client already said.
4. **Search real availability** from the provider. Offer 2–3 concrete times, not the
   whole list. Never invent slots.
5. **Confirm and book** the exact slot the client chose: same service, staff, location,
   time. Read back one authoritative confirmation built from server state.
6. **Card-on-file gate** (business policy, Zorina requires it). Before any booking is
   created, the server resolves the caller to exactly one Square customer (by phone;
   several matches → human) and checks the Cards API for at least one enabled card.
   No card → no booking. The agent explains the cancellation policy, asks for an email,
   and the server sends a secure enrollment link (Square Web Payments page; the agent
   never hears or stores card data). Booking resumes only after Square shows an active
   card. The model never sees card ids or numbers. Availability checks may run before
   the gate; CreateBooking may not.
7. **Optional sales layer** for businesses that have one: a discovery question, then two
   offers, objection handling, then booking. Configured per business, absent by default.
8. **Hand off** to a human anything the agent cannot do with certainty: unmapped
   service, policy exception, refund, staff message, provider failure. Say honestly
   what will happen next. Never promise what the server or a human has not done.
9. **Follow the business's policies and wording** (cancellation, deposits, prepayment,
   card-on-file, banned phrases, pronunciations) as configured, never hardcoded.

---

## 3. Non-negotiable rules (learned the hard way in v1)

- **Multi-tenant from line one.** No business names, service names, prices, scripts,
  payment links, tier names, timezones, or language lists in source code. Shared logic
  may branch on *data facts* ("locations > 1", "catalog has tiers"), never on business
  identity.
- **Server owns state; model owns speech.** Service, location, staff, date, slot,
  price, payment, and booking status are server-confirmed facts, set only through
  structured tool calls. The model never extracts facts from transcript, never guesses
  an ambiguous service into a real catalog item, never invents a slot, price, policy,
  or discount. Critical transitions are server gates, not prompt rules.
- **Provider is the source of truth for the catalog.** The booking provider confirms
  service / variation, duration, price, staff assignment, and availability. Business
  config holds policies, wording, and mappings. The model never sees or speaks internal
  provider IDs. If a mapping does not exist, hand off; do not pick a "similar" service.
- **Any language.** Languages come from business config as ISO 639-1 codes. No
  RU/EN/ES-only paths. Transcription language must come from config.
- **Audio over transcript.** In Realtime the model hears audio; transcripts are an
  approximate async log. Never use transcript quality as a proxy for comprehension and
  never feed transcript text back as fact.
- **Small prompts.** Generic template plus business data slots. Keep the system prompt
  under ~4k tokens. Bloated prompts made v1 narrate its actions, ignore banned words,
  and mispronounce names.
- **Silence on non-speech.** Background noise, music, side conversation, line noise:
  the agent stays quiet and waits. No "I didn't catch that" after every cough.
- **Never truncate logs or transcripts.** Full per-call traces (events, tool calls with
  args and results, timings, token usage and cost) are how voice bugs get found.
- **Multi-location is first-class.** Location is a real entity with its own hours,
  timezone, and staff. Never default silently to the first location.
- **Encrypted provider credentials at rest.**
- **Keep tenant config and code separate so a new business is data, not a deploy.**

---

## 4. Domain knowledge worth reading

Under `/Users/alexey/projects/8Hands/`:

- `docs/zorina_front_desk_workflows.md` — the best description of how a good salon
  receptionist handles calls (Russian). Intent handling, qualification order, refill vs
  repair, named-staff lookup, handoff rules. Treat as the behavioral spec.
  **Copied here as `docs-old/zorina_front_desk_workflows.md`; read
  `docs-old/front-desk-summary.md` first (English, condensed: services and their
  relations, call scenario, rules, edge cases).**
- `dev-local/zorina-config.json` — the live v1 tenant record: policy text, FAQ, synced
  price list, forbidden phrases, and `salesPlaybookJson` with `bookingIntake` (services,
  facts, exact question wording) and `bookingProviderMapping` (facts → Square variation
  ids, refill/free-fix history rules). **Copied here as `docs-old/zorina-config.json`.**
  Note: it says Zorina offers Gel-X; the workflow doc says it does not. Ask Anastasia.
- `docs/project_journal.md` — every real call failure found in v1 with root causes
  (skipped qualification, wrong slot bound, guessed service, silent location default,
  cross-area service changes, partial intake lost). Use as a test-case source.
- `docs/voice_fix_ledger.md` — behavioral invariants: payment wording, feminine Russian
  voice, how times are spoken in Russian, language scope, audio-over-transcript.
- `docs/VOICE_AGENT_ARCHITECTURE.md` — the multilingual playbook JSON shape (offers,
  cause taxonomy → discovery question → two offers, objection handlers, localized
  strings). Useful as input for designing v2 business config, not as a spec.
- `tests/evals/` — contract evals (language, payment, escalation, booking gate) worth
  re-creating for v2.

In this repo:

- `src/` — the v2 agent. Layout:
  - `core/session.ts` — one OpenAI Realtime connection per call; runs tools from
    `response.done`, owns `CallState`, stamps every tool result with
    `status: ok | blocked | error | recovered | gave_up`, then sends a bare `response.create`.
    A handler returns `{ blocked, message }` when a precondition (e.g. location) is
    not in state yet; the model asks for it instead of retrying.
    On `error` it sends a speech-only response, then one with `tool_choice: required`.
    A response that ends `cancelled`/`failed` is logged and shown in the UI; if no new
    response starts within 1.5 s (or the "try again in Xs" of a rate-limit failure) and
    the caller isn't speaking, the session requests one (max 4 in a row), so a lost
    response never freezes the call. Several tool calls in one reply run in order and
    trigger one follow-up response. The OpenAI account's Realtime limit is 40k tokens
    per minute (cached tokens count); one busy call can hit it.
  - The session prompt is set once. Never send `instructions` on `response.create`:
    it replaces the prompt for that response, and since the prompt starts the model's
    context, everything after it (tools, conversation, audio) misses the prompt cache.
    One-off directions (greeting, filler) are a system message item (`direct()`) appended to the
    conversation, then a bare `response.create`. What to say per `status` is a rule in
    the prompt.
  - `instructions-v2.ts` — the prompt `server.ts` uses: a template (role, booking flow,
    rules, tool calls, edge cases) built from the business profile. `instructions.ts`
    is the previous prompt; `instructions-test-retry.ts` has deliberately wrong enum
    values plus an `exposedArgs` schema, to exercise the retry path.
  - `business.ts` — the business profile (names, greeting, exact questions, design
    levels, card policy, level words in the catalog). Tenant data; moves to the DB.
  - `core/state.ts` — `CallState`, the server-owned record of what the caller has
    established, plus the Zod patch schema the model must satisfy to change it.
  - `core/tools.ts` — `defineTool` with a Zod args schema and `mode: 'silent' | 'report'`.
    The reply that calls a report tool says "let me check…" itself; the result is spoken
    no sooner than 500 ms after that audio ends (audio length measured from streamed
    bytes). Optional `filler` ("checking the schedule") makes the server have the model
    say one extra sentence while the handler runs; no tool uses it today. Tool calls are
    synchronous by design; Realtime has no true background.
  - `core/transport.ts`, `codecs/` — one call lifecycle, per-client wire dialects.
  - `tools/` — `update_call_state` (silent; the only way facts enter state) and
    `check_availability` (report; reads the studio from state).
  - `schedule/` — in-memory stub schedules, one file per studio with its own hours.
  - `integrations/square.ts` — minimal fetch-based Square REST client (customers, cards,
    locations, catalog services, bookable team, availability). All external API clients
    live in `integrations/`.
  - `tools/square/` — `square_services`, `square_masters`, `square_availability` (live
    Square reads; names only, never ids) and `square_book`. `slots.ts` turns Square
    availability into `Slot`s kept in `CallState.offeredSlots`; saving `time` binds the
    pick to one of them (`bindSlot`) and returns a server-built `readBack`.
    `square_book` takes no args and books only the slot whose read-back the caller last
    heard (fingerprint), after phone → one customer with a card → live re-check.
  - History services (free fix, paid repair, refill) are ordinary services the model saves with
    `update_call_state` (`service`/`option`; `quantity` = nails for a repair). The process is
    loaded on demand: `free_fix_instructions` / `refill_instructions`
    (`tools/square/history-instructions.ts`, built from `BUSINESS.history` + live catalog), so the
    session prompt stays small. `square_visit_history` (`tools/square/history.ts`) returns facts
    only: past `ACCEPTED` visits, newest first (day, daysAgo, services, masters, studio,
    extensions). The server enforces the rules in `historyGate`, called by `square_availability`
    (clamps the dates; free fix searches only the last visit's master) and `square_book` (exact
    slot): free fix = last non-repair visit ≤ `freeFix.days` before the appointment, same master;
    refill = appointment `refill.days.min..max` after the last extensions visit; > `maxRepairNails`
    → front desk. Windows count to the appointment date (our default, not confirmed by the owner).
    Visits are cached per call outside `CallState`. Paid repair = its service once per nail.
    Unit tests: `bun test`.
  - `tools/card-link.ts` — `send_card_link(email)`, starts card-on-file enrollment.
  - Caller ID: `AgentSessionOptions.callerPhone`; the browser test UI sends it as `/ws?phone=`.
  - Twilio voice: `POST /twilio/voice` (signature-checked with `TWILIO_AUTH_TOKEN` against
    `https://<Host>/twilio/voice`) returns TwiML `<Connect><Stream>` to `wss://<Host>/twilio/media`
    with a one-time token and `From` as stream parameters. `codecs/twilio.ts` passes μ-law
    through (session runs `audio/pcmu`), sends `clear` on barge-in. `attachCall` starts the
    session on the stream's `start` event (`codec.waitsForStart`), where caller ID arrives.
    Number `+1 424 383 6254` → Railway `/twilio/voice`. Local dev: `ngrok http 3100` and repoint
    the number's "A call comes in" webhook to `https://<ngrok>/twilio/voice` (then back).
    Trial account: calls only from verified numbers, plays a trial notice + "press any key" first.
  - `card/enrollment.ts` — card-on-file gate and enrollment sessions (in memory, 30 min,
    hashed one-time token). `lookupCardOnFile(phone)` → none | one{hasCard} | ambiguous.
    `startEnrollment` sends the link (Resend if `RESEND_API_KEY`+`EMAIL_FROM`, else logs it);
    `completeEnrollment` creates/updates the Square customer and stores the card.
  - `web/card-on-file.html` — public page at `/card-on-file#<token>`, ported from v1:
    Square Web Payments card form, name/email/consent, policy text. Routes:
    `POST /api/card-enrollment/session|complete`, dev helper `POST /api/card-enrollment/start`.
    Sandbox test card token for end-to-end tests: `cnon:card-nonce-ok`.

---

## 5. v2 stack and conventions

- Runtime: **Bun** (no Node, no tsx). TypeScript, ESM, strict.
- Voice: OpenAI Realtime API over WebSocket (`ws`); Twilio media streams next.
- Hosting: **Railway**, project `8hands-agent`, service `agent`, deploys on every push to
  `main` of `Badaboom1995/8hands-v2` (`railway.json`: `bun src/server.ts`, health `/health`,
  1 replica). Public URL `https://agent-production-e6c4.up.railway.app` (= `PUBLIC_BASE_URL`).
  Server listens on `PORT` (Railway) else `AGENT_V2_PORT`. Env vars live in Railway
  (`railway variables --service agent`). Enrollment sessions and stream tokens are in memory:
  keep one replica, and a redeploy drops live calls.
- Test page PIN: `TEST_PAGE_PIN` (6 digits, set in Railway; unset locally = no gate) guards
  `/`, `/ws`, and `/api/card-enrollment/start` via an HttpOnly cookie (`src/http/pin-gate.ts`).
  Twilio, card-on-file, and `/health` routes stay public.
- DB: **Railway Postgres** (service `Postgres`, `us-west2`, same region as `agent`), reached via
  `DATABASE_URL=${{Postgres.DATABASE_URL}}` on the private network. Bun's built-in client
  (`src/db/index.ts`); `src/db/migrations/*.sql` applied at startup (`schema_migrations`).
  Without `DATABASE_URL` (local default) call logs go to stdout only. Local DB:
  `docker run -d --name pg8h -e POSTGRES_PASSWORD=dev -p 55432:5432 postgres:17-alpine`, then
  `DATABASE_URL=postgres://postgres:dev@localhost:55432/postgres`. Browse prod: Railway → Postgres → Data.
- Call log: tables `calls` (one row per call: channel, caller, duration, end reason, tokens,
  OpenAI / transcription / Twilio cost, avg/max latency, final state, outcome) and `call_events`
  (ordered, untruncated: `caller_message`, `agent_message`, `response`, `tool_call`, `state_change`,
  `interrupt`, `error`). The session emits `TraceEvent`s (`core/trace.ts`) via `onTrace`;
  `calls/recorder.ts` buffers and batch-writes them off the audio path, dumps to stdout if the DB
  stays down, closes live calls' logs on SIGTERM, and fills `twilio_cost_usd` from Twilio's
  Calls API 1–15 min after hang-up. Cost is per **response** (caller audio is billed in the next
  response); caller messages carry only their transcription cost. `response.latency_ms` =
  caller stopped speaking (VAD fired) → first agent audio leaving the server, across tool
  round trips (`payload.latency`: trigger `call_start` | `caller` | `tool_result`, `openaiMs`,
  `toolMs`, `silenceMs`); network legs to the caller are not included.
- Everything else (queue, eval harness): decide and write here.

```bash
bun install
bun run dev          # bun --watch src/server.ts → http://localhost:3100
bun run typecheck    # tsc --noEmit
```

Env vars live in a local `.env` (gitignored; Bun loads it automatically):
`OPENAI_API_KEY` (required), `OPENAI_REALTIME_MODEL` (default `gpt-realtime-2.1`),
`AGENT_V2_PORT` (default 3100), `AGENT_V2_DEBUG`, `SQUARE_ENVIRONMENT` (`sandbox`),
`SQUARE_ACCESS_TOKEN`, `SQUARE_APPLICATION_ID` (Web Payments SDK), `SQUARE_LOCATION_ID`,
`PUBLIC_BASE_URL` (link base for the card page), optional `RESEND_API_KEY` + `EMAIL_FROM`,
`BUSINESS_NAME`, `REQUIRE_CARD_ON_FILE` (default on; `false` disables the card gate),
`TWILIO_AUTH_TOKEN` (required for `/twilio/voice`; unsigned webhooks get 403), `TWILIO_ACCOUNT_SID`
(REST API, e.g. setting a number's `VoiceUrl`; not used by the server yet).

Square sandbox (base `https://connect.squareupsandbox.com/v2`): a copy of the Zorina
catalog. Locations `Pacific Avenue` = `LT9W3A6W3QJ35`, `Union Street` = `L6A2FZ9VR8WY3`
(plus `Default Test Account` = `LDJ8HE5NK6T1Z`, the merchant's main location). All three:
Mon–Fri 09:00–17:00 `America/Los_Angeles`, booking enabled. Business booking profile:
half-hourly alignment, no min lead time, max 1 year, any-staff and multi-service booking
allowed. Checked 2026-09-23:
- **Availability works at Pacific Ave and Union St** (e.g. Russian E-file Manicure,
  Sep 28–Oct 1: 60 slots each). At `LDJ8HE5NK6T1Z` it returns 400 `Search did not find a
  team member who performs the selected service variation`.
- Catalog: 32 `APPOINTMENTS_SERVICE` items, no categories, descriptions, modifiers, or
  taxes. Variation names mix tier (TOP Master / MASTER / JUNIOR), polish (GEL / REGULAR),
  named staff (`TOP Ksenia`, `MASTER Gina`), and length (`Long Extensions with TOP Master`);
  some tiers are split across same-named items. Duration differs per staff variation.
  Packages are priced $0. `service_duration` is in ms; price in cents.
- Team: 30 members = 26 active studio staff (surname literally "Zorina Studio"; speak
  `given_name` only), 3 inactive, owner "Sandbox Seller". 17 have booking profiles.
  Who performs a service comes from the variation's `team_member_ids`. Staff seen in
  availability do not always match `assigned_locations` (e.g. Bika appears at Pacific Ave,
  Esther and Anastasia at Union St); trust availability, not assignments.
  Staff with slots for the manicure above: Pacific Ave = Carla, Bika, Irina, Anna;
  Union St = Ksenia, Gina, Aruzhan, Elvira, Anastasia, Esther.
- Availability search without a staff filter returns one staff member per start time,
  not every free staff member. Results are UTC; `service_variation_version` must be
  passed back on CreateBooking. Availability and list-bookings ranges cap at 31 days.
- Customers (5): Aleksei Belov `+14155550123` (VISA on file), Maya Test `+14155550199`
  (VISA on file), Alex Test 1 `+14155550112` (card on file, made by an enrollment test),
  and "E2E Test Client" ×2 on `+14155550188` (a duplicate on purpose, no cards).
  `+14155550100` and `+14155550177` match no one.
- Bookings: CreateBooking accepts past `start_at`, so visit history is seeded directly. A past
  `ACCEPTED` booking counts as a visit (Square has no "completed"; `NO_SHOW` and cancelled don't).
  Seeded history (2026-10-08): Aleksei — Sep 8 Medium Extensions TOP, Carla, Pacific Ave
  (refill window 28–35 d) and Oct 5 GEL Russian Manicure MASTER, Gina, Union St (free fix
  window ≤7 d); his earlier test-call bookings are cancelled. Maya — Sep 28 FREE Fix, Pacific Ave.
  Test calls that book leave real bookings; cancel them if they disturb a seeded history.

Conventions:
- `bun run typecheck` clean before commit.
- Contract evals for language, payment, escalation, and booking gates, run per business
  config.
- No tracked `.env`; list required env vars here as they appear.
