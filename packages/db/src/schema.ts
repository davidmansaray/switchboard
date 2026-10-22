import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/** All application tables live in the `app` schema; Mastra storage lives in `mastra`. */
export const app = pgSchema('app');

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const pk = () => uuid('id').primaryKey().defaultRandom();

/** Draft refs start at D-7 so the hero hire's first draft is D-7 (seeded drafts on other desks use explicit refs). */
export const draftRefSeq = app.sequence('draft_ref_seq', { startWith: 7 });
export const creditNoteRefSeq = app.sequence('credit_note_ref_seq', { startWith: 301 });

export const staffRole = app.enum('staff_role', ['staff', 'approver']);
export const hireStatus = app.enum('hire_status', ['enquiry', 'confirmed', 'on_hire', 'off_hire', 'cancelled']);
export const lineStatus = app.enum('line_status', ['booked', 'on_hire', 'cancelled']);
export const draftKind = app.enum('draft_kind', ['bundle', 'email', 'update']);
export const draftStatus = app.enum('draft_status', [
  'pending',
  'stale',
  'superseded',
  'approved',
  'applied',
  'rejected',
]);
export const deskRunState = app.enum('desk_run_state', ['idle', 'running', 'queued', 'awaiting_approval', 'recovering']);
export const signalKind = app.enum('signal_kind', ['message', 'queued-message', 'signal', 'queued-signal', 'schedule']);
export const signalOutcome = app.enum('signal_outcome', ['delivered', 'queued', 'persisted', 'discarded', 'blocked', 'failed']);
export const tier = app.enum('approval_tier', ['auto', 'approval']);

export const staff = app.table('staff', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: staffRole('role').notNull(),
  title: text('title').notNull(),
  avatar: text('avatar'),
});

export const customers = app.table('customers', {
  id: pk(),
  name: text('name').notNull(),
  accountRef: text('account_ref').notNull().unique(),
});

export const contacts = app.table('contacts', {
  id: pk(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  role: text('role').notNull(),
  phone: text('phone'),
});

export const hires = app.table(
  'hires',
  {
    id: pk(),
    ref: text('ref').notNull().unique(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    site: text('site').notNull(),
    siteArea: text('site_area'),
    deliveryDate: date('delivery_date').notNull(),
    deliverySlot: text('delivery_slot').notNull().default('AM'),
    durationDays: integer('duration_days').notNull(),
    status: hireStatus('status').notNull().default('confirmed'),
    poNumber: text('po_number'),
    invoiceAddress: text('invoice_address'),
    siteContactId: uuid('site_contact_id').references(() => contacts.id),
    discountPct: numeric('discount_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    damageWaiver: boolean('damage_waiver').notNull().default(true),
    waiverRatePct: numeric('waiver_rate_pct', { precision: 5, scale: 2 }).notNull().default('12'),
    transportPence: integer('transport_pence').notNull().default(0),
    /** Hire price ex waiver and VAT: discounted line charges + transport (the "£4,120"). */
    totalPence: integer('total_pence').notNull().default(0),
    /** Bumped by trigger on every business change (including line changes). */
    version: integer('version').notNull().default(1),
    /** Transaction that produced `version`: several statements in one transaction make one version. */
    versionTxid: text('version_txid'),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('hires_customer_idx').on(t.customerId)],
);

export const hireLines = app.table(
  'hire_lines',
  {
    id: pk(),
    hireId: uuid('hire_id')
      .notNull()
      .references(() => hires.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    kind: text('kind').notNull(),
    model: text('model').notNull(),
    description: text('description').notNull(),
    spec: text('spec'),
    fleetNo: text('fleet_no'),
    status: lineStatus('status').notNull().default('booked'),
    weeklyRatePence: integer('weekly_rate_pence').notNull(),
    quantity: integer('quantity').notNull().default(1),
  },
  (t) => [uniqueIndex('hire_lines_no_uq').on(t.hireId, t.lineNo)],
);

export const hireVersions = app.table(
  'hire_versions',
  {
    hireId: uuid('hire_id')
      .notNull()
      .references(() => hires.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    diff: jsonb('diff').notNull().default(sql`'[]'::jsonb`),
    changedBy: text('changed_by'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.hireId, t.version] })],
);

export const emailThreads = app.table('email_threads', {
  id: pk(),
  hireId: uuid('hire_id')
    .notNull()
    .references(() => hires.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  subject: text('subject').notNull(),
  contactId: uuid('contact_id').references(() => contacts.id),
});

export const emails = app.table(
  'emails',
  {
    id: pk(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => emailThreads.id, { onDelete: 'cascade' }),
    hireId: uuid('hire_id')
      .notNull()
      .references(() => hires.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull().unique(),
    direction: text('direction', { enum: ['in', 'out'] }).notNull(),
    fromAddr: text('from_addr').notNull(),
    toAddrs: text('to_addrs').array().notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('emails_hire_idx').on(t.hireId)],
);

export const notes = app.table('notes', {
  id: pk(),
  hireId: uuid('hire_id')
    .notNull()
    .references(() => hires.id, { onDelete: 'cascade' }),
  authorId: text('author_id')
    .notNull()
    .references(() => staff.id),
  body: text('body').notNull(),
  mentions: text('mentions').array().notNull().default(sql`'{}'::text[]`),
  createdAt: created(),
});

export const transcripts = app.table('transcripts', {
  id: pk(),
  hireId: uuid('hire_id')
    .notNull()
    .references(() => hires.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  participants: text('participants').array().notNull(),
  body: text('body').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
});

export const documents = app.table('documents', {
  id: pk(),
  hireId: uuid('hire_id')
    .notNull()
    .references(() => hires.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  signed: boolean('signed').notNull().default(false),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: created(),
});

export const evidenceChunks = app.table(
  'evidence_chunks',
  {
    id: pk(),
    hireId: uuid('hire_id')
      .notNull()
      .references(() => hires.id, { onDelete: 'cascade' }),
    sourceType: text('source_type', { enum: ['email', 'note', 'transcript', 'document'] }).notNull(),
    sourceId: uuid('source_id').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', content)`),
    createdAt: created(),
  },
  (t) => [
    index('evidence_hire_idx').on(t.hireId),
    index('evidence_tsv_idx').using('gin', t.tsv),
    uniqueIndex('evidence_source_uq').on(t.sourceType, t.sourceId),
  ],
);

export const events = app.table(
  'events',
  {
    id: pk(),
    hireId: uuid('hire_id')
      .notNull()
      .references(() => hires.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    source: text('source', { enum: ['customer', 'staff', 'agent', 'system', 'schedule'] }).notNull(),
    actor: text('actor'),
    /** Inbound dedupe (e.g. email message id, approval idempotency key). */
    dedupeKey: text('dedupe_key').unique(),
    createdAt: created(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    runId: text('run_id'),
  },
  (t) => [index('events_hire_idx').on(t.hireId, t.createdAt), index('events_unprocessed_idx').on(t.processedAt)],
);

export const drafts = app.table(
  'drafts',
  {
    id: pk(),
    ref: text('ref')
      .notNull()
      .unique()
      .default(sql`'D-' || nextval('app.draft_ref_seq')`),
    hireId: uuid('hire_id')
      .notNull()
      .references(() => hires.id, { onDelete: 'cascade' }),
    kind: draftKind('kind').notNull(),
    title: text('title').notNull(),
    payload: jsonb('payload').notNull(),
    basedOnVersion: integer('based_on_version').notNull(),
    evidenceIds: text('evidence_ids').array().notNull().default(sql`'{}'::text[]`),
    status: draftStatus('status').notNull().default('pending'),
    supersedesId: uuid('supersedes_id'),
    /** The desk run that proposed it (links a merged duplicate signal to the signal that started this draft). */
    runId: text('run_id'),
    /** Idempotency key of the proposal; one draft per intent. */
    actionKey: text('action_key').notNull(),
    staleReason: text('stale_reason'),
    createdAt: created(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('drafts_action_uq').on(t.hireId, t.actionKey), index('drafts_hire_idx').on(t.hireId)],
);

export const approvals = app.table('approvals', {
  id: pk(),
  draftId: uuid('draft_id')
    .notNull()
    .references(() => drafts.id, { onDelete: 'cascade' }),
  decidedBy: text('decided_by')
    .notNull()
    .references(() => staff.id),
  decision: text('decision', { enum: ['approved', 'rejected'] }).notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  hireVersionAtDecision: integer('hire_version_at_decision').notNull(),
  channel: text('channel', { enum: ['web', 'mobile'] }).notNull().default('web'),
  note: text('note'),
  createdAt: created(),
});

export const agentActions = app.table(
  'agent_actions',
  {
    id: pk(),
    hireId: uuid('hire_id')
      .notNull()
      .references(() => hires.id, { onDelete: 'cascade' }),
    actionKey: text('action_key').notNull(),
    tool: text('tool').notNull(),
    result: jsonb('result').notNull(),
    runId: text('run_id'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('agent_actions_uq').on(t.hireId, t.actionKey)],
);

/**
 * Every ledgered write attempt, including the ones the ledger refused. `agent_actions`
 * holds what happened; this holds what was tried (the UI's ledger chips).
 */
export const actionAttempts = app.table(
  'action_attempts',
  {
    id: pk(),
    hireId: uuid('hire_id')
      .notNull()
      .references(() => hires.id, { onDelete: 'cascade' }),
    actionKey: text('action_key').notNull(),
    tool: text('tool').notNull(),
    status: text('status', { enum: ['recorded', 'skipped_duplicate', 'rejected_version', 'rejected', 'fenced'] }).notNull(),
    runId: text('run_id'),
    note: text('note'),
    createdAt: created(),
  },
  (t) => [index('action_attempts_hire_idx').on(t.hireId, t.createdAt)],
);

export const outbox = app.table('outbox', {
  id: pk(),
  hireId: uuid('hire_id')
    .notNull()
    .references(() => hires.id, { onDelete: 'cascade' }),
  threadId: uuid('thread_id').references(() => emailThreads.id),
  draftId: uuid('draft_id').references(() => drafts.id),
  toAddrs: text('to_addrs').array().notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: created(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
});

export const creditNotes = app.table('credit_notes', {
  id: pk(),
  ref: text('ref')
    .notNull()
    .unique()
    .default(sql`'CN-' || nextval('app.credit_note_ref_seq')`),
  hireId: uuid('hire_id')
    .notNull()
    .references(() => hires.id, { onDelete: 'cascade' }),
  lineId: uuid('line_id').references(() => hireLines.id),
  amountPence: integer('amount_pence').notNull(),
  reason: text('reason').notNull(),
  actionKey: text('action_key').notNull().unique(),
  createdAt: created(),
});

export const desks = app.table('desks', {
  id: pk(),
  hireId: uuid('hire_id')
    .notNull()
    .unique()
    .references(() => hires.id, { onDelete: 'cascade' }),
  mastraThreadId: text('mastra_thread_id').notNull().unique(),
  resourceId: text('resource_id').notNull(),
  runState: deskRunState('run_state').notNull().default('idle'),
  activeRunId: text('active_run_id'),
  /** The tool call in progress, e.g. "getHire(NH-5520)" (harness backend). */
  currentStep: text('current_step'),
  sweepScheduleId: text('sweep_schedule_id'),
  lastSignalAt: timestamp('last_signal_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const signalsLog = app.table(
  'signals_log',
  {
    id: pk(),
    hireId: uuid('hire_id')
      .notNull()
      .references(() => hires.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    kind: signalKind('kind').notNull(),
    outcome: signalOutcome('outcome').notNull(),
    backend: text('backend', { enum: ['harness', 'app'] }).notNull(),
    tag: text('tag').notNull(),
    contents: text('contents').notNull(),
    attributes: jsonb('attributes').notNull().default(sql`'{}'::jsonb`),
    runId: text('run_id'),
    /** For queued deliveries: the run that was active when this signal arrived. */
    waitsForRunId: text('waits_for_run_id'),
    /** A duplicate intent (e.g. Jo's direct cancel after Sam's email): the earlier signal it merged into. */
    mergedInto: uuid('merged_into'),
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
    createdAt: created(),
  },
  (t) => [index('signals_hire_idx').on(t.hireId, t.createdAt)],
);

/** Fleet register: statutory facts per machine (LOLER 1998 reg. 9 thorough examinations, IPAF PAL category). */
export const fleet = app.table('fleet', {
  fleetNo: text('fleet_no').primaryKey(),
  kind: text('kind').notNull(),
  /** IPAF PAL category the operator needs: 3a (static/scissor), 3b (boom). Null when not a MEWP. */
  ipafCategory: text('ipaf_category'),
  /** Next LOLER thorough examination: 6-monthly for MEWPs (lifting persons), 12-monthly for other lifting kit. */
  lolerDue: date('loler_due'),
  lolerIntervalMonths: integer('loler_interval_months'),
});

/**
 * The desk's step history (RunTrace): one row per tool call, written by the tool layer, so both
 * signal backends produce the same trail. `kind = evidence` rows are evidence a tool fetched.
 */
export const deskSteps = app.table(
  'desk_steps',
  {
    id: pk(),
    hireId: uuid('hire_id')
      .notNull()
      .references(() => hires.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    kind: text('kind', { enum: ['tool', 'evidence'] }).notNull().default('tool'),
    tool: text('tool').notNull(),
    text: text('text').notNull(),
    status: text('status'),
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
    createdAt: created(),
  },
  (t) => [index('desk_steps_hire_idx').on(t.hireId, t.createdAt)],
);

/**
 * Desk runs as the UI shows them: one row per (run, ownership generation). The generation is
 * Mastra's run-fencing generation (harness backend); a recovered run gets a new generation and
 * the old one is marked crashed (worker died) or fenced (superseded while still alive).
 */
export const deskRuns = app.table(
  'desk_runs',
  {
    id: pk(),
    hireId: uuid('hire_id')
      .notNull()
      .references(() => hires.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    /** Mastra's fencing generation (a large, increasing number); the UI shows its ordinal per run. */
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    backend: text('backend', { enum: ['harness', 'app'] }).notNull(),
    state: text('state', { enum: ['running', 'completed', 'crashed', 'fenced', 'failed'] }).notNull().default('running'),
    pid: integer('pid'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('desk_runs_run_gen_uq').on(t.runId, t.generation), index('desk_runs_hire_idx').on(t.hireId, t.startedAt)],
);

/** Scenario runner progress (simulator rail): one row per hero beat played since the last reset. */
export const scenarioBeats = app.table('scenario_beats', {
  n: integer('n').primaryKey(),
  status: text('status', { enum: ['playing', 'done', 'failed'] }).notNull(),
  detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

/** Agent process lifecycle for the UI: boot, crash armed, crash, reset. */
export const opsLog = app.table('ops_log', {
  id: pk(),
  kind: text('kind', { enum: ['boot', 'crash.armed', 'crash', 'reset', 'recovery'] }).notNull(),
  detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
  createdAt: created(),
});

export const approvalTiers = app.table('approval_tiers', {
  field: text('field').primaryKey(),
  tier: tier('tier').notNull(),
  description: text('description').notNull(),
});

export type Hire = typeof hires.$inferSelect;
export type HireLine = typeof hireLines.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type DbEvent = typeof events.$inferSelect;
export type Desk = typeof desks.$inferSelect;
export type SignalLogRow = typeof signalsLog.$inferSelect;
export type DeskStep = typeof deskSteps.$inferSelect;
export type DeskRun = typeof deskRuns.$inferSelect;
export type FleetRow = typeof fleet.$inferSelect;
export type ActionAttemptStatus = (typeof actionAttempts.$inferSelect)['status'];
