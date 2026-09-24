// check_availability — free slots at the studio saved in call state.

import { z } from 'zod';

import { defineTool } from '../core/tools';
import { schedules } from '../schedule';
import { collectDays, isoDate } from '../schedule/generate';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const checkAvailabilityTool = defineTool({
    name: 'check_availability',
    description:
        'Look up open appointment slots at the studio already saved in call state. '
        + 'Returns free start times per day. '
        + 'range "day" = one day, "week" = 7 days, "month" = the next 30 days. '
        + 'Days the studio is closed are omitted; a day with empty freeSlots is fully booked. '
        + 'Use startDate for a specific day the caller asked about; omit it to start from today.',
    mode: 'report',
    args: z.object({
        range: z.enum(['day', 'week', 'month']).describe('How much of the calendar to return.'),
        startDate: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD.').optional()
            .describe('First day to check, format YYYY-MM-DD. Defaults to today.'),
    }),
    handler: (args, ctx) => {
        const locationId = ctx.state.location;
        if (!locationId) {
            return { blocked: 'location', message: 'Ask which studio the caller wants and save it first.' };
        }
        const schedule = schedules[locationId];
        if (!schedule) throw new Error(`no schedule for location ${locationId}`);

        const today = isoDate(new Date());
        const start = args.startDate || today;
        const count = args.range === 'day' ? 1 : args.range === 'week' ? 7 : 30;
        const days = collectDays(schedule, start, count);
        const location = schedule.config.name;
        if (days.length === 0) {
            return {
                location, today, days: [],
                note: 'No bookable days in this range — outside the 30-day window or the studio is closed.',
            };
        }
        return { location, today, range: args.range, days };
    },
});
