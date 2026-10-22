/**
 * Pure pricing for a hire, matching Northgate's quote layout (and the Yard Board UI):
 *   hire charges = Σ active lines × weekly rate × weeks
 *   net          = hire charges − discount
 *   subtotal     = net + transport            ← the hire price (`hires.total_pence`, "£4,120")
 *   waiver       = net × waiver rate (12%)    ← only if the damage waiver applies
 *   VAT 20% on subtotal + waiver; total = subtotal + waiver + VAT
 */
export type PriceLine = { lineNo: number; weeklyRatePence: number; quantity: number; status: 'booked' | 'on_hire' | 'cancelled' };

export const DEFAULT_WAIVER_PCT = 12;
export const VAT_PCT = 20;

export type PriceBreakdown = {
  hireChargesPence: number;
  discountPence: number;
  netPence: number;
  transportPence: number;
  subtotalPence: number;
  waiverPence: number;
  vatPence: number;
  totalPence: number;
};

export function priceHire(input: {
  lines: readonly PriceLine[];
  durationDays: number;
  discountPct: number;
  damageWaiver: boolean;
  transportPence?: number;
  waiverRatePct?: number;
}): PriceBreakdown {
  const weeks = input.durationDays / 7;
  const hireChargesPence = Math.round(
    input.lines.filter((l) => l.status !== 'cancelled').reduce((s, l) => s + l.weeklyRatePence * l.quantity * weeks, 0),
  );
  const discountPence = Math.round((hireChargesPence * input.discountPct) / 100);
  const netPence = hireChargesPence - discountPence;
  const transportPence = input.transportPence ?? 0;
  const subtotalPence = netPence + transportPence;
  const waiverPence = input.damageWaiver ? Math.round((netPence * (input.waiverRatePct ?? DEFAULT_WAIVER_PCT)) / 100) : 0;
  const vatPence = Math.round(((subtotalPence + waiverPence) * VAT_PCT) / 100);
  return { hireChargesPence, discountPence, netPence, transportPence, subtotalPence, waiverPence, vatPence, totalPence: subtotalPence + waiverPence + vatPence };
}

/** Credit owed when one line is cancelled before delivery: the line's share of the discounted hire charges. */
export function lineCreditPence(line: Pick<PriceLine, 'weeklyRatePence' | 'quantity'>, durationDays: number, discountPct: number): number {
  const gross = line.weeklyRatePence * line.quantity * (durationDays / 7);
  return Math.round(gross * (1 - discountPct / 100));
}

export const gbp = (pence: number) =>
  `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
