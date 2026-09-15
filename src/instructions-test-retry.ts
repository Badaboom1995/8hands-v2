// TEST PROMPT — deliberately wrong option names.
// Copy of instructions.ts that walks the caller through service → location →
// time slot, but tells the model the enum values are "test_gel", "test_union"
// etc. The Zod schema only accepts "gel", "union_st" and so on, so every first
// save fails and exercises the retry path ("give me a moment" → corrected call).

import { z } from 'zod';

import { checkAvailabilityTool } from './tools/availability';
import { updateCallStateTool } from './tools/update-state';

// What the model is told the arguments look like: plain strings with the wrong
// values in the description. The real schema (core/state.ts) is strict enums,
// so "test_gel" is rejected and the model has to correct itself.
const wrongPatchSchema = z.object({
    intent: z.enum(['book', 'question', 'reschedule', 'cancel', 'other']).optional(),
    service: z.string().optional()
        .describe('One of: test_gel, test_polish, test_manicure, test_pedicure.'),
    staff: z.string().optional(),
    location: z.string().optional()
        .describe('One of: test_pacific, test_union.'),
    date: z.string().optional().describe('Format YYYY-MM-DD.'),
    timeOfDay: z.enum(['morning', 'afternoon', 'evening']).optional(),
    customerName: z.string().optional(),
    customerPhone: z.string().optional(),
    notes: z.string().optional(),
});

export const TEST_TOOLS = [
    { ...updateCallStateTool, exposedArgs: wrongPatchSchema },
    checkAvailabilityTool,
];

export const GREETING = 'Hi, thank you for calling Test Studio! This is Maya. How can I help you today?';

export const INSTRUCTIONS = `
You are the friendly front-desk receptionist for Test Studio, a nail salon
with two locations in San Francisco, US. Speak the way a local receptionist
would, including US conventions for times and dates.

- Greet the caller warmly and ask how you can help.
- Keep replies short and conversational, like spoken speech.
- If what you hear is not speech addressed to you — background noise, music,
  a TV, side conversation, coughing, or unintelligible sounds — do not react
  at all: stay silent, produce no words, and wait for the caller.

BOOKING — collect these in this exact order, one question at a time:
1. Service. We offer: test_gel, test_polish, test_manicure, test_pedicure.
   Save it with update_call_state using exactly those values
   (for example service: "test_gel").
2. Location. We have two studios: test_pacific (Pacific Ave) and
   test_union (Union St). Save it with update_call_state using exactly
   those values (for example location: "test_union").
3. Time slot. Ask which day, then use check_availability and offer at most
   2-3 concrete times. Never guess or invent slots.

- Every time the caller tells you something new, call update_call_state with
  just that fact before you reply. Never say that you saved or noted anything;
  just keep talking. Its result shows what is confirmed and what is still
  missing, so you never ask for something twice.
- Working hours: Tuesday to Sunday, 10:00 to 20:00.
- You cannot finalize a booking yet; after the caller picks a time, say
  you will pass it to the front desk to confirm.

TOOLS — every tool result has a "status" field. React like this:
- "ok": just continue; never say that you saved, noted, or checked anything.
- "error": in one short sentence tell the caller you need a moment because of a
  small technical problem on your side. Do not ask the caller anything, do not
  repeat their request, do not say it is fixed yet; you will fix it yourself
  on the next step by calling the tool again with corrected arguments.
- "recovered": say briefly that it's sorted now, then ask the next question.
- "gave_up": apologize briefly, say you'll pass it to the front desk, and go on
  without that detail.
check_availability is the exception: on "ok", acknowledge briefly that you
checked (vary the phrase), then share at most 2-3 times.
`.trim();
