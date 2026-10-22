/** View models the UI renders. Built on the server from the real tables (lib/data.ts). */

export type DeskStatus = 'idle' | 'running' | 'queued' | 'awaiting_approval' | 'recovering';
export type DraftStatus = 'pending' | 'stale' | 'superseded' | 'approved' | 'applied' | 'rejected';
export type Delivery = 'delivered' | 'queued' | 'persisted' | 'discarded' | 'blocked' | 'failed';
export type SignalSource = 'email' | 'note' | 'transcript' | 'document' | 'field_edit' | 'status_change' | 'approval' | 'schedule';
export type LedgerStatus = 'recorded' | 'skipped_duplicate' | 'rejected_version' | 'rejected' | 'fenced';
export type LoopStatus = 'open' | 'decided' | 'closed';
export type RunState = 'running' | 'completed' | 'crashed' | 'fenced' | 'failed';

export type Staff = { id: string; name: string; role: 'staff' | 'approver'; title: string };

export type LineView = {
  lineNo: number;
  kind: string;
  model: string;
  description: string;
  short: string;
  spec: string | null;
  fleetNo: string | null;
  status: 'booked' | 'on_hire' | 'cancelled';
  weeklyRatePence: number;
  ipaf: string | null;
  lolerDue: string | null;
  lolerMonths: number | null;
};

export type SignalView = {
  id: string;
  short: string;
  at: string;
  hireRef: string;
  source: SignalSource;
  /** Mastra call: message (sendMessage), queued-message, signal, queued-signal, schedule, or evidence (fetched by a tool). */
  type: string;
  delivery: Delivery;
  /** A queued signal that a run has since picked up. */
  pickedUp: boolean;
  actor: string;
  thread: string | null;
  summary: string;
  mergedInto: string | null;
  waitsFor: string | null;
  runId: string | null;
  backend: string;
};

export type DeskView = {
  ref: string;
  version: number;
  customer: string;
  site: string;
  siteArea: string | null;
  status: DeskStatus;
  step: string | null;
  activeRun: string | null;
  lines: LineView[];
  awaiting: string[];
  queued: SignalView[];
  lastSignal: SignalView | null;
  /** When the desk's run was lost: lease expiry for the countdown. */
  leaseEndsAt: string | null;
};

export type FieldChange = { field: string; from: string; to: string };
export type EvidenceRef = { id: string; sourceType: string; label: string };

export type DraftView = {
  id: string;
  ref: string;
  hireRef: string;
  customer: string;
  status: DraftStatus;
  kind: string;
  intent: string;
  title: string;
  to: string | null;
  summary: string;
  /** Hire price before VAT this draft would set, or a credit (negative). */
  totalPence: number | null;
  basedOnVersion: number;
  hireVersion: number;
  staleReason: string | null;
  /** "v4 → v5 by Jo Barrett (field edit)": who moved the hire past this draft. */
  staleBy: string | null;
  supersedesRef: string | null;
  supersededByRef: string | null;
  /** Against the draft it superseded (D-7 → D-8). */
  changes: FieldChange[];
  /** Stale only: what moved on the hire since the draft was written. */
  staleChanges: FieldChange[];
  evidence: EvidenceRef[];
  reply: { subject: string; body: string; to: string[] } | null;
  createdAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
  decisions: Array<{ by: string; decision: string; channel: string; at: string; hireVersion: number }>;
};

export type LoopView = { key: string; status: LoopStatus; text: string };

export type LedgerRow = { id: string; tool: string; status: LedgerStatus; actionKey: string; run: string | null; note: string | null; at: string };
export type EmailSent = { id: string; subject: string; to: string; thread: string | null; idempotencyKey: string; at: string };
export type CreditNoteView = { ref: string; amountPence: number; reason: string; at: string };
export type StepView = { id: string; at: string; text: string; status: string | null; run: string | null; kind: string };
export type RunView = { runId: string; short: string; fence: number; state: RunState; startedAt: string; endedAt: string | null; backend: string };

export type HireFacts = {
  deliveryDate: string;
  offHireDate: string;
  weeks: number;
  deliverySlot: string;
  poNumber: string | null;
  invoiceAddress: string | null;
  discountPct: number;
  waiverRatePct: number;
  waiverSigned: boolean;
  damageWaiver: boolean;
  transportPence: number;
  netPence: number;
  waiverPence: number;
  subtotalPence: number;
  status: string;
  updatedBy: string | null;
};

export type DeskDetail = {
  desk: DeskView;
  facts: HireFacts;
  contact: { name: string; email: string } | null;
  drafts: DraftView[];
  loops: LoopView[];
  ledger: LedgerRow[];
  emails: EmailSent[];
  creditNotes: CreditNoteView[];
  steps: StepView[];
  runs: RunView[];
  signals: SignalView[];
  schedule: { cron: string; label: string; next: string; ifActive: string; ifIdle: string; id: string | null };
};

export type ScenarioView = {
  beats: Array<{ n: number; status: 'playing' | 'done' | 'failed'; error: string | null }>;
  next: number | null;
  busy: boolean;
};

export type RuntimeView = {
  /** The agent process is down (a crash is newer than the last boot). */
  workerDown: boolean;
  lastCrashAt: string | null;
  /** When the dead worker's run lease lapses (Mastra's retryAt), for the countdown. */
  leaseEndsAt: string | null;
  lastBootAt: string | null;
  crashArmed: string | null;
  backend: string | null;
  llmMode: string | null;
  crashEnabled: boolean;
  resetEnabled: boolean;
};

export type BoardView = {
  now: string;
  desks: DeskView[];
  waiting: DraftView[];
  signals: SignalView[];
  signalsToday: number;
  scenario: ScenarioView;
  runtime: RuntimeView;
  detail: DeskDetail | null;
};
