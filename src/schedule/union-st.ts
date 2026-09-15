import { createLocationSchedule } from './generate';

// Union St studio: 9:00–19:00, closed Mondays.
export const unionSt = createLocationSchedule({
    id: 'union_st',
    name: 'Union St',
    openHour: 9,
    closeHour: 19,
    closedWeekdays: [1],
});
