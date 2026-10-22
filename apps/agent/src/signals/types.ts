import type { SignalKind } from '@switchboard/core';
import type { schema as s } from '@switchboard/db';
import type { RenderedSignal } from './render';

export type Outcome = s.SignalLogRow['outcome'];

export type DeliveryTarget = { hireId: string; hireRef: string; desk: s.Desk };

export type Delivery = {
  target: DeliveryTarget;
  kind: SignalKind;
  ifActive: 'deliver' | 'persist';
  ifIdle: 'wake' | 'persist';
  signal: RenderedSignal;
  eventIds: string[];
};

export type DeliveryResult = { outcome: Outcome; runId?: string; action: string; waitsForRunId?: string };

/**
 * A signal backend: the only code that knows how input reaches a desk.
 * `harness` = Mastra signals/schedules/durable agents; `app` = app-owned loop.
 */
export interface SignalBackend {
  readonly name: 'harness' | 'app';
  start(): Promise<void>;
  deliver(d: Delivery): Promise<DeliveryResult>;
  /** Make sure the desk's daily sweep exists. Returns its id. */
  ensureSweep(target: DeliveryTarget): Promise<string>;
  /** Fire the sweep now (the "fire schedule" button and cron both end up here or in the scheduler). */
  fireSweep(target: DeliveryTarget): Promise<{ scheduleId: string }>;
  /** True when the desk has no active run and nothing queued. */
  isIdle(hireId: string): boolean;
  /** Scenario reset: forget in-memory per-desk state (the database was re-seeded underneath). */
  resetState(): void;
  stop(): Promise<void>;
}
