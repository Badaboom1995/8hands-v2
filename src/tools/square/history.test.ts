import { describe, expect, test } from 'bun:test';

import type { Visit } from '../../core/state';
import { classify, isVisit } from './history';

const rules = {
    lookbackDays: 90,
    extensionServices: ['Nail Extension', 'Nail Extension Refill'],
    refillDays: { min: 28, max: 35 },
    freeFixDays: 7,
    repairServices: ['FREE Fix', 'Extension for 1 nail'],
};

let n = 0;
function visit(daysAgo: number, service: string, master = 'm1', date?: string): Visit {
    return {
        date: date ?? `d-${daysAgo}`, day: '', daysAgo, services: [service], masters: [master], studio: 'Pacific Avenue',
        extensions: rules.extensionServices.includes(service),
        ref: { bookingId: `b${++n}`, locationId: 'L1', teamMemberIds: [master] },
    };
}

describe('repair', () => {
    test('no visits → paid', () => expect(classify('c', [], rules).repair).toBe('paid'));
    test('day 7 is free (inclusive)', () => expect(classify('c', [visit(7, 'Russian Manicure')], rules).repair).toBe('free_fix'));
    test('day 8 is paid', () => expect(classify('c', [visit(8, 'Russian Manicure')], rules).repair).toBe('paid'));
    test('any service counts, pedicure too', () => expect(classify('c', [visit(2, 'Smart Pedicure')], rules).repair).toBe('free_fix'));
    test('two masters on the last visit day → unclear', () => {
        const h = classify('c', [visit(3, 'Russian Manicure', 'a', 'x'), visit(3, 'Smart Pedicure', 'b', 'x')], rules);
        expect(h.repair).toBe('free_fix_unclear_master');
    });
    test('a repair does not start a new window', () => {
        const h = classify('c', [visit(2, 'FREE Fix'), visit(10, 'Russian Manicure')], rules);
        expect(h.repair).toBe('paid');
        expect(h.lastVisit?.services).toEqual(['Russian Manicure']);
    });
});

describe('refill', () => {
    test('no extensions → no_recent_extensions', () => expect(classify('c', [visit(3, 'Russian Manicure')], rules).refill).toBe('no_recent_extensions'));
    test('27 days → too_early', () => expect(classify('c', [visit(27, 'Nail Extension')], rules).refill).toBe('too_early'));
    test('28 and 35 days → eligible', () => {
        expect(classify('c', [visit(28, 'Nail Extension')], rules).refill).toBe('eligible');
        expect(classify('c', [visit(35, 'Nail Extension Refill')], rules).refill).toBe('eligible');
    });
    test('36 days → too_late', () => expect(classify('c', [visit(36, 'Nail Extension')], rules).refill).toBe('too_late'));
    test('the latest extensions visit decides', () => {
        expect(classify('c', [visit(10, 'Nail Extension Refill'), visit(30, 'Nail Extension')], rules).refill).toBe('too_early');
    });
});

describe('isVisit', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    const b = (status: string, start: string) => ({ id: 'x', status, start_at: start, location_id: 'L' });
    test('past accepted counts', () => expect(isVisit(b('ACCEPTED', '2026-10-05T18:00:00Z'), now)).toBe(true));
    test('future does not', () => expect(isVisit(b('ACCEPTED', '2026-10-09T18:00:00Z'), now)).toBe(false));
    test('cancelled and no-show do not', () => {
        expect(isVisit(b('CANCELLED_BY_SELLER', '2026-10-05T18:00:00Z'), now)).toBe(false);
        expect(isVisit(b('NO_SHOW', '2026-10-05T18:00:00Z'), now)).toBe(false);
    });
});
