// check_availability tool + the in-memory schedule it reads.
// The schedule is generated once per server start: 30 days from today,
// hourly slots within working hours (Tue–Sun 10:00–20:00), a random
// subset already "taken". Future booking tool will mutate this store.

import { z } from 'zod';

import { defineTool } from '../core/tools';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const OPEN_HOUR = 10;
const LAST_START_HOUR = 19; // last appointment starts at 19:00, salon closes 20:00
const CLOSED_WEEKDAY = 1;   // Monday
const DAYS_GENERATED = 30;
const TAKEN_RATIO = 0.4;

export interface DayAvailability {
    date: string;      // YYYY-MM-DD
    weekday: string;
    freeSlots: string[]; // ['10:00', '13:00', ...]; empty = fully booked; absent day = closed
}

// Local-time date key (YYYY-MM-DD). Never toISOString() here: that converts
// to UTC and shifts the date for timezones ahead of it.
function isoDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseLocalDate(iso: string): Date {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function generateSchedule(): Map<string, DayAvailability> {
    const schedule = new Map<string, DayAvailability>();
    const start = new Date();
    for (let i = 0; i < DAYS_GENERATED; i++) {
        const day = new Date(start);
        day.setDate(start.getDate() + i);
        if (day.getDay() === CLOSED_WEEKDAY) continue;
        const freeSlots: string[] = [];
        for (let hour = OPEN_HOUR; hour <= LAST_START_HOUR; hour++) {
            if (Math.random() >= TAKEN_RATIO) {
                freeSlots.push(hour < 12 ? `${hour} AM` : `${hour === 12 ? 12 : hour - 12} PM`);
            }
        }
        schedule.set(isoDate(day), {
            date: isoDate(day),
            weekday: WEEKDAYS[day.getDay()],
            freeSlots,
        });
    }
    return schedule;
}

// Shared store — the future create_booking tool imports and mutates this.
export const schedule = generateSchedule();

function collectDays(startDate: string, count: number): DayAvailability[] {
    const days: DayAvailability[] = [];
    const start = parseLocalDate(startDate);
    for (let i = 0; i < count; i++) {
        const day = new Date(start);
        day.setDate(start.getDate() + i);
        const entry = schedule.get(isoDate(day));
        if (entry) days.push(entry);
    }
    return days;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const checkAvailabilityTool = defineTool({
    name: 'check_availability',
    description:
        'Look up open appointment slots. Returns free start times per day. '
        + 'range "day" = one day, "week" = 7 days, "month" = the next 30 days. '
        + 'Days the salon is closed are omitted; a day with empty freeSlots is fully booked. '
        + 'Use startDate for a specific day the caller asked about; omit it to start from today.',
    mode: 'report',
    args: z.object({
        range: z.enum(['day', 'week', 'month']).describe('How much of the calendar to return.'),
        startDate: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD.').optional()
            .describe('First day to check, format YYYY-MM-DD. Defaults to today.'),
    }),
    handler: (args) => {
        const today = isoDate(new Date());
        const start = args.startDate || today;
        const count = args.range === 'day' ? 1 : args.range === 'week' ? 7 : 30;
        const days = collectDays(start, count);
        if (days.length === 0) {
            return {
                days: [],
                note: 'No bookable days in this range — outside the generated 30-day window or salon closed.',
                today,
            };
        }
        return { today, range: args.range, days };
    },
});
