import { createLocationSchedule } from './generate';

// Pacific Ave studio: every day 10:00–20:00.
export const pacificAve = createLocationSchedule({
    id: 'pacific_ave',
    name: 'Pacific Ave',
    openHour: 10,
    closeHour: 20,
    closedWeekdays: [],
});
