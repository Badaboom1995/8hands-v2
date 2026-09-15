// In-memory schedule generator, one instance per location.
// 30 days from today, hourly slots within that location's hours, a random
// subset already "taken". The future create_booking tool mutates these stores.

export interface LocationConfig {
    id: string;
    name: string;
    /** First appointment hour, 24h. */
    openHour: number;
    /** Closing hour, 24h. Last appointment starts one hour before. */
    closeHour: number;
    /** 0 = Sunday … 6 = Saturday. */
    closedWeekdays: number[];
}

export interface DayAvailability {
    date: string;        // YYYY-MM-DD
    weekday: string;
    freeSlots: string[]; // ['10 AM', '2 PM', ...]; empty = fully booked; absent day = closed
}

export interface LocationSchedule {
    config: LocationConfig;
    days: Map<string, DayAvailability>;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAYS_GENERATED = 30;
const TAKEN_RATIO = 0.4;

// Local-time date key (YYYY-MM-DD). Never toISOString() here: that converts
// to UTC and shifts the date for timezones ahead of it.
export function isoDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseLocalDate(iso: string): Date {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function slotLabel(hour: number): string {
    if (hour < 12) return `${hour} AM`;
    return `${hour === 12 ? 12 : hour - 12} PM`;
}

export function createLocationSchedule(config: LocationConfig): LocationSchedule {
    const days = new Map<string, DayAvailability>();
    const start = new Date();
    for (let i = 0; i < DAYS_GENERATED; i++) {
        const day = new Date(start);
        day.setDate(start.getDate() + i);
        if (config.closedWeekdays.includes(day.getDay())) continue;
        const freeSlots: string[] = [];
        for (let hour = config.openHour; hour < config.closeHour; hour++) {
            if (Math.random() >= TAKEN_RATIO) freeSlots.push(slotLabel(hour));
        }
        days.set(isoDate(day), { date: isoDate(day), weekday: WEEKDAYS[day.getDay()], freeSlots });
    }
    return { config, days };
}

export function collectDays(schedule: LocationSchedule, startDate: string, count: number): DayAvailability[] {
    const out: DayAvailability[] = [];
    const start = parseLocalDate(startDate);
    for (let i = 0; i < count; i++) {
        const day = new Date(start);
        day.setDate(start.getDate() + i);
        const entry = schedule.days.get(isoDate(day));
        if (entry) out.push(entry);
    }
    return out;
}
