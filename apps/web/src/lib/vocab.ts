/** Yard Board vocabulary: the words the depot uses for each state. */
import type { DeskStatus, DraftStatus } from './types';

export const DESK_STATUS: Record<DeskStatus, { label: string; hint: string }> = {
  idle: { label: 'Idle', hint: 'No active run. The next signal wakes the desk.' },
  running: { label: 'Running', hint: 'Durable run in progress.' },
  queued: { label: 'Queued', hint: 'Running, with signals waiting for this run to finish.' },
  awaiting_approval: { label: 'Awaiting approval', hint: 'A draft is waiting for an approver.' },
  recovering: { label: 'Recovering', hint: 'Worker lost; the durable run is being recovered.' },
};

export const DRAFT_STATUS: Record<DraftStatus, string> = {
  pending: 'Pending approval',
  stale: 'Stale',
  superseded: 'Superseded',
  approved: 'Approved',
  applied: 'Applied',
  rejected: 'Rejected',
};

export const COLUMNS: Array<{ id: DeskStatus; label: string; statuses: DeskStatus[]; empty: string }> = [
  { id: 'running', label: 'Running', statuses: ['running', 'recovering'], empty: 'No runs in progress' },
  { id: 'queued', label: 'Queued', statuses: ['queued'], empty: 'No signals waiting in a pocket' },
  { id: 'awaiting_approval', label: 'Awaiting approval', statuses: ['awaiting_approval'], empty: 'Sign-off slot is clear' },
  { id: 'idle', label: 'Idle', statuses: ['idle'], empty: 'Every desk is working' },
];

export const LEDGER_LABEL: Record<string, string> = {
  recorded: 'Recorded',
  skipped_duplicate: 'Skipped: duplicate',
  rejected_version: 'Refused: stale version',
  rejected: 'Refused',
  fenced: 'Fenced',
};

export const LOOP_LABEL = { open: 'Open', decided: 'Decided', closed: 'Closed' } as const;
export const LINE_STATUS = { booked: 'Booked', on_hire: 'On hire', cancelled: 'Cancelled' } as const;
export const RUN_LABEL = { running: 'running', completed: 'completed', crashed: 'crashed', fenced: 'fenced', failed: 'failed' } as const;

export type Mech = 'signal' | 'schedule' | 'durable' | 'memory' | 'tool' | 'app';

/** Architecture Overlay: the Mastra facility (or app code) behind each region. Checked against @mastra/core 1.78. */
export const MECH: Record<Mech, { label: string; api: string; owner: 'mastra' | 'app'; note: string; where: string }> = {
  signal: {
    label: 'Signal',
    api: 'sendMessage · queueMessage · sendSignal · queueSignal',
    owner: 'mastra',
    note: 'Inbound events reach the desk as signals. Staff edits and approvals are queued, so they never interrupt a run.',
    where: 'Signals stream · card pockets',
  },
  schedule: {
    label: 'Schedule',
    api: 'mastra.schedules · ifActive: persist · ifIdle: wake',
    owner: 'mastra',
    note: 'The 07:00 pre-delivery sweep is a schedule bound to the hire thread. No external cron.',
    where: 'Desk › Schedule · “Fire 07:00 sweep”',
  },
  durable: {
    label: 'Durable agent run',
    api: 'durable: true · recovery: auto · run fencing',
    owner: 'mastra',
    note: 'One long-lived thread per hire. A run survives a worker crash; a newer fence generation stops a zombie writing.',
    where: 'Rack (run state) · Desk › Trace',
  },
  memory: {
    label: 'Working memory',
    api: 'workingMemory (thread) · observational memory',
    owner: 'mastra',
    note: 'Open loops (who is waiting on what) live in the desk’s working memory, not in the hire row.',
    where: 'Desk › Working memory',
  },
  tool: {
    label: 'Tool precondition',
    api: 'expected_version + action_key',
    owner: 'mastra',
    note: 'Guarantees live in the tools: a stale version or a repeated action key is refused, whatever the run does.',
    where: 'Desk › Draft chain · Action ledger',
  },
  app: {
    label: 'App code',
    api: 'Next.js + Postgres',
    owner: 'app',
    note: 'Drafts, approvals, versioned rows, the action ledger and this UI are ordinary application code.',
    where: 'Sign-off slot · Hire rows · Simulator',
  },
};

export function intentLabel(intent: string): string {
  if (intent === 'discount') return 'Pricing + reply';
  if (intent === 'waiver-chaser') return 'Waiver chaser';
  if (intent === 'off-hire') return 'Off-hire confirmation';
  if (intent.startsWith('cancel-line')) return 'Partial cancellation';
  return 'Draft';
}
