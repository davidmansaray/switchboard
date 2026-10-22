/**
 * Approval tiers: which hire fields the desk may change on its own (logged) and
 * which need an approver. Mirrors `app.approval_tiers`; the DB copy is what the
 * UI shows, this copy is what tools enforce (they must agree; a test checks it).
 */
export type Tier = 'auto' | 'approval';

export const APPROVAL_TIERS = {
  poNumber: { tier: 'auto', description: 'Customer purchase order number' },
  invoiceAddress: { tier: 'auto', description: 'Invoice address' },
  siteContactId: { tier: 'auto', description: 'Site contact person' },
  discountPct: { tier: 'approval', description: 'Discount on the hire' },
  totalPence: { tier: 'approval', description: 'Hire price' },
  deliveryDate: { tier: 'approval', description: 'Delivery date' },
  deliverySlot: { tier: 'approval', description: 'Delivery slot' },
  durationDays: { tier: 'approval', description: 'Hire duration' },
  status: { tier: 'approval', description: 'Hire status, incl. cancellation' },
  lineStatus: { tier: 'approval', description: 'Line status, incl. partial cancellation' },
} as const satisfies Record<string, { tier: Tier; description: string }>;

export type TieredField = keyof typeof APPROVAL_TIERS;

export function tierOf(field: string): Tier {
  // Unknown fields need approval: fail closed.
  return (APPROVAL_TIERS as Record<string, { tier: Tier }>)[field]?.tier ?? 'approval';
}

/** A change set is auto-appliable only if every field in it is `auto`. */
export function classifyChange(fields: readonly string[]): { tier: Tier; approvalFields: string[] } {
  const approvalFields = fields.filter((f) => tierOf(f) === 'approval');
  return { tier: fields.length > 0 && approvalFields.length === 0 ? 'auto' : 'approval', approvalFields };
}
