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
  **Copied here as `docs-old/zorina_front_desk_workflows.md`.**
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
  - The session prompt is set once. Never send `instructions` on `response.create`
    (it replaces the prompt for that response). Only the greeting does, with the
    prompt prepended. What to say per `status` is a rule in the prompt.
  - `instructions-test-retry.ts` — test prompt with deliberately wrong enum values
    plus an `exposedArgs` schema, to exercise the retry path. `server.ts` currently
    uses it; switch back to `instructions.ts` for normal runs.
  - `core/state.ts` — `CallState`, the server-owned record of what the caller has
    established, plus the Zod patch schema the model must satisfy to change it.
  - `core/tools.ts` — `defineTool` with a Zod args schema, `mode: 'silent' | 'report'`,
    and optional `filler` ("checking the schedule"): the agent speaks one filler
    sentence while the handler runs, and the result is spoken no sooner than
    500 ms after the filler audio ends (audio length measured from streamed bytes).
    Tool calls are synchronous by design; Realtime has no true background.
  - `core/transport.ts`, `codecs/` — one call lifecycle, per-client wire dialects.
  - `tools/` — `update_call_state` (silent; the only way facts enter state) and
    `check_availability` (report; reads the studio from state).
  - `schedule/` — in-memory stub schedules, one file per studio with its own hours.
  - `square/client.ts` — minimal fetch-based Square REST client (customers, cards).
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
- Everything else (DB, hosting, queue, eval harness): decide and write here.

```bash
bun install
bun run dev          # bun --watch src/server.ts → http://localhost:3100
bun run typecheck    # tsc --noEmit
```

Env vars live in a local `.env` (gitignored; Bun loads it automatically):
`OPENAI_API_KEY` (required), `OPENAI_REALTIME_MODEL` (default `gpt-realtime`),
`AGENT_V2_PORT` (default 3100), `AGENT_V2_DEBUG`, `SQUARE_ENVIRONMENT` (`sandbox`),
`SQUARE_ACCESS_TOKEN`, `SQUARE_APPLICATION_ID` (Web Payments SDK), `SQUARE_LOCATION_ID`,
`PUBLIC_BASE_URL` (link base for the card page), optional `RESEND_API_KEY` + `EMAIL_FROM`,
`BUSINESS_NAME`.

Square sandbox (base `https://connect.squareupsandbox.com/v2`): a copy of the Zorina
catalog. Locations `Pacific Avenue` = `LT9W3A6W3QJ35`, `Union Street` = `L6A2FZ9VR8WY3`
(plus `Default Test Account` = `LDJ8HE5NK6T1Z`); 32 APPOINTMENTS_SERVICE items with tier
variations (TOP Master / MASTER / JUNIOR), 26 team members, half-hourly alignment.
**Only `LDJ8HE5NK6T1Z` is subscribed to appointments**: availability search on the two
named studios returns `Location not subscribed to appointments`. Availability at the
default location works (Mon–Fri 9–17, 120-min segments, staff Ruth and Anastasia).
Staff with availability (Sept 2026): Pacific Ave = Irina, Carla; Union St = Ksenia, Esther,
Gina, Elvira, Aruzhan, Anastasia. Customers: 2 test profiles (same phone, a duplicate on
purpose), 0 cards on file.

Conventions:
- `bun run typecheck` clean before commit.
- Contract evals for language, payment, escalation, and booking gates, run per business
  config.
- No tracked `.env`; list required env vars here as they appear.
