import { describe, expect, test } from 'bun:test';

import { BUSINESS } from '../../business';
import { addDays, isVisit, windowFor, type Visit } from './history';
import { localDate } from './shared';

const rules = {
    lookbackDays: 90,
    extensionServices: ['Nail Extension', 'Nail Extension Refill'],
    freeFix: { service: 'FREE Fix', words: 'free nail fix', days: 7 },
    paidRepair: { service: 'Extension for 1 nail', words: 'nail repair' },
    refill: { service: 'Nail Extension Refill', words: 'extensions refill', days: { min: 28, max: 35 } },
    maxRepairNails: 5,
};

const TODAY = localDate(Date.now(), BUSINESS.timezone);
let n = 0;
function visit(daysAgo: number, service: string, master = 'm1'): Visit {
    const date = addDays(TODAY, -daysAgo);
    return {
        date, day: date, daysAgo, services: [service], masters: [master], studio: 'Pacific Avenue',
        extensions: rules.extensionServices.includes(service),
        ref: { bookingId: `b${++n}`, locationId: 'L1', teamMemberIds: [`id-${master}`] },
    };
}

describe('free fix window', () => {
    test('no visits → paid', () => expect(windowFor('freeFix', [], TODAY, rules).ok).toBe(false));
    test('visit 3 days ago → bookable through day 7 after it', () => {
        expect(windowFor('freeFix', [visit(3, 'Russian Manicure')], TODAY, rules))
            .toEqual({ ok: true, from: TODAY, to: addDays(TODAY, 4), masters: [{ id: 'id-m1', name: 'm1' }] });
    });
    test('visit 7 days ago → today only (inclusive)', () => {
        const w = windowFor('freeFix', [visit(7, 'Russian Manicure')], TODAY, rules);
        expect(w.ok && [w.from, w.to]).toEqual([TODAY, TODAY]);
    });
    test('visit 8 days ago → paid', () => expect(windowFor('freeFix', [visit(8, 'Russian Manicure')], TODAY, rules).ok).toBe(false));
    test('any service counts, pedicure too', () => expect(windowFor('freeFix', [visit(2, 'Smart Pedicure')], TODAY, rules).ok).toBe(true));
    test('every master of the last visit day', () => {
        const w = windowFor('freeFix', [visit(3, 'Russian Manicure', 'a'), visit(3, 'Smart Pedicure', 'b')], TODAY, rules);
        expect(w.ok && w.masters?.map((m) => m.name)).toEqual(['a', 'b']);
    });
    test('a repair does not start a new window', () => {
        expect(windowFor('freeFix', [visit(2, 'FREE Fix'), visit(10, 'Russian Manicure')], TODAY, rules).ok).toBe(false);
    });
});

describe('refill window', () => {
    test('no extensions → not a refill', () => expect(windowFor('refill', [visit(3, 'Russian Manicure')], TODAY, rules).ok).toBe(false));
    test('20 days ago → from day 28 to day 35 after it', () => {
        const last = visit(20, 'Nail Extension');
        expect(windowFor('refill', [last], TODAY, rules)).toEqual({ ok: true, from: addDays(last.date, 28), to: addDays(last.date, 35) });
    });
    test('30 days ago → from today to day 35', () => {
        const last = visit(30, 'Nail Extension');
        expect(windowFor('refill', [last], TODAY, rules)).toEqual({ ok: true, from: TODAY, to: addDays(last.date, 35) });
    });
    test('35 days ago → today only', () => {
        const w = windowFor('refill', [visit(35, 'Nail Extension Refill')], TODAY, rules);
        expect(w.ok && [w.from, w.to]).toEqual([TODAY, TODAY]);
    });
    test('36 days ago → too late', () => expect(windowFor('refill', [visit(36, 'Nail Extension')], TODAY, rules).ok).toBe(false));
    test('the latest extensions visit decides', () => {
        const w = windowFor('refill', [visit(10, 'Nail Extension Refill'), visit(30, 'Nail Extension')], TODAY, rules);
        expect(w.ok && w.from).toBe(addDays(TODAY, 18));
    });
});

describe('isVisit', () => {
    const now = Date.now();
    const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
    const b = (status: string, start: string) => ({ id: 'x', status, start_at: start, location_id: 'L' });
    test('past accepted counts', () => expect(isVisit(b('ACCEPTED', at(-96)), now)).toBe(true));
    test('future does not', () => expect(isVisit(b('ACCEPTED', at(24)), now)).toBe(false));
    test('cancelled and no-show do not', () => {
        expect(isVisit(b('CANCELLED_BY_SELLER', at(-96)), now)).toBe(false);
        expect(isVisit(b('NO_SHOW', at(-96)), now)).toBe(false);
    });
});
