export const DRAFT_STATUSES = ['pending', 'stale', 'superseded', 'approved', 'applied', 'rejected'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

const TRANSITIONS: Record<DraftStatus, readonly DraftStatus[]> = {
  pending: ['stale', 'approved', 'rejected', 'superseded'],
  stale: ['superseded', 'rejected', 'approved'],
  approved: ['applied', 'superseded'],
  superseded: [],
  applied: [],
  rejected: [],
};

export function canTransition(from: DraftStatus, to: DraftStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** A draft is stale when the hire has moved on since it was written. */
export function isStale(basedOnVersion: number, currentVersion: number): boolean {
  return currentVersion > basedOnVersion;
}

/**
 * What an approval of `draft` means, given the hire's current version.
 * Approving a stale draft never applies it: the desk must regenerate.
 */
export function approvalOutcome(
  status: DraftStatus,
  basedOnVersion: number,
  currentVersion: number,
): 'apply' | 'regenerate' | 'reject-invalid' {
  if (status === 'stale' || (status === 'pending' && isStale(basedOnVersion, currentVersion))) return 'regenerate';
  if (status === 'pending') return 'apply';
  return 'reject-invalid';
}
