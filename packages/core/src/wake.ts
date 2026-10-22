import type { EventType } from './events';

/**
 * Wake-up rules: how each app event reaches the desk. The adapter turns a plan
 * into a Mastra call (harness backend) or a queued item (app backend).
 *
 * | Trigger                         | Mechanism       | Behaviour                                 |
 * | inbound email, @mention note    | sendMessage     | starts a run if idle, injected if running |
 * | staff field edit (debounced)    | queueMessage    | never interrupts; processed next          |
 * | approval decided, status change | queueSignal     | system context; waits its turn            |
 * | daily sweep                     | schedule        | ifActive persist, ifIdle wake             |
 */
export type SignalKind = 'message' | 'queued-message' | 'signal' | 'queued-signal' | 'schedule';

export type WakePlan =
  | { deliver: true; kind: SignalKind; tag: string; ifActive: 'deliver' | 'persist'; ifIdle: 'wake' | 'persist'; debounceMs?: number }
  | { deliver: false; reason: string };

export const FIELD_EDIT_DEBOUNCE_MS = 1500;

export function planWake(event: { type: EventType | string; source: string; payload: Record<string, unknown> }): WakePlan {
  // The desk's own writes come back as events; never wake on them (no feedback loops).
  if (event.source === 'agent') return { deliver: false, reason: 'agent-authored event' };
  switch (event.type) {
    case 'email.received':
      return { deliver: true, kind: 'message', tag: 'email', ifActive: 'deliver', ifIdle: 'wake' };
    case 'note.created': {
      const mentions = (event.payload.mentions as string[] | undefined) ?? [];
      const body = String(event.payload.body ?? '');
      if (!mentions.includes('assistant') && !body.toLowerCase().includes('@assistant')) {
        // Plain internal notes are context, not instructions: store without waking.
        return { deliver: true, kind: 'signal', tag: 'note', ifActive: 'persist', ifIdle: 'persist' };
      }
      return { deliver: true, kind: 'message', tag: 'note', ifActive: 'deliver', ifIdle: 'wake' };
    }
    case 'hire.updated':
      return {
        deliver: true,
        kind: 'queued-message',
        tag: 'field_edit',
        ifActive: 'deliver',
        ifIdle: 'wake',
        debounceMs: FIELD_EDIT_DEBOUNCE_MS,
      };
    case 'status.changed':
    case 'approval.decided':
      return { deliver: true, kind: 'queued-signal', tag: event.type === 'approval.decided' ? 'approval' : 'status_change', ifActive: 'deliver', ifIdle: 'wake' };
    case 'schedule.fired':
      return { deliver: true, kind: 'schedule', tag: 'schedule', ifActive: 'persist', ifIdle: 'wake' };
    default:
      return { deliver: false, reason: `no wake rule for ${event.type}` };
  }
}

/**
 * Debounce for staff field edits: edits to the same hire inside the window
 * collapse into one signal that carries the overall version range and the union
 * of changed fields.
 */
export type PendingEdit = { hireId: string; fromVersion: number; toVersion: number; fields: string[]; summaries: string[]; eventIds: string[] };

export function mergeEdits(pending: PendingEdit | undefined, next: PendingEdit): PendingEdit {
  if (!pending) return next;
  if (pending.hireId !== next.hireId) throw new Error('mergeEdits across hires');
  return {
    hireId: pending.hireId,
    fromVersion: Math.min(pending.fromVersion, next.fromVersion),
    toVersion: Math.max(pending.toVersion, next.toVersion),
    fields: [...new Set([...pending.fields, ...next.fields])],
    summaries: [...pending.summaries, ...next.summaries],
    eventIds: [...pending.eventIds, ...next.eventIds],
  };
}
