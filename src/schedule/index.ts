import type { LocationSchedule } from './generate';
import { pacificAve } from './pacific-ave';
import { unionSt } from './union-st';

export const schedules: Record<string, LocationSchedule> = {
    [pacificAve.config.id]: pacificAve,
    [unionSt.config.id]: unionSt,
};
