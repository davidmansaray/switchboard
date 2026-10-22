import { describe, expect, it } from 'vitest';
import { checkReply } from '../../src/tools/desk-tools';

/** The reply-text checker: every fact a customer reads must come from the hire, in any common spelling. */
const hire = { deliveryDate: '2026-11-04', durationDays: 14, discountPct: '10', waiverRatePct: '12' }; // Wed 4 Nov → Wed 18 Nov
const allowed = [385_200, 428_000, 86_000];
const check = (body: string, percents: number[] = []) => checkReply(body, allowed, hire, { percents });

describe('checkReply', () => {
  it('accepts facts the hire supports, in long and short forms', () => {
    expect(check('Delivery Wednesday 4 November, off-hire Wed 18 Nov. Price £3,852.00 (was £4,280.00), 10% off.')).toEqual({ ok: true, unsupported: [] });
    expect(check('About £3,852 before VAT, 20% VAT on top, 12% damage waiver.').ok).toBe(true);
    expect(check('See you on 04/11 for delivery.').ok).toBe(true);
  });

  it('catches amounts that are not on the hire, with or without pence, commas or a GBP prefix', () => {
    expect(check('Hire price: £3,999.00').unsupported).toEqual(['£3,999.00']);
    expect(check('Hire price: £3999').unsupported).toEqual(['£3999']);
    expect(check('Hire price GBP 3700').unsupported).toEqual(['GBP 3700']);
    expect(check('Roughly £4k all in').unsupported).toEqual(['£4k']);
  });

  it('catches weekdays in short form and dates that are not the delivery or off-hire date', () => {
    expect(check('Delivery Fri 6 Nov').unsupported).toEqual(['Fri', '6 Nov']);
    expect(check('Delivered Thursday').unsupported).toEqual(['Thursday']);
    expect(check('Booked for 5th November').unsupported).toEqual(['5th November']);
    expect(check('Booked for 05/11').unsupported).toEqual(['05/11']);
  });

  it('catches percentages that are not the discount, the waiver rate, VAT or the draft’s own discount', () => {
    expect(check('We can do 15% off').unsupported).toEqual(['15%']);
    expect(check('We can do 15% off', [15]).ok).toBe(true);
    expect(check('A 12.5 per cent saving').unsupported).toEqual(['12.5 per cent']);
  });
});
