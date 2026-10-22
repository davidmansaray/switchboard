import type { WakePlan } from '@switchboard/core';
import type { schema as s } from '@switchboard/db';

export type RenderedSignal = { tag: string; contents: string; attributes: Record<string, string> };

/**
 * Turn an app event into the text + attributes the desk sees. Both backends use
 * this, so the model's input is identical whichever one is active.
 */
export function renderEvent(
  e: Pick<s.DbEvent, 'id' | 'type' | 'payload' | 'source' | 'actor'>,
  hireRef: string,
  plan: Extract<WakePlan, { deliver: true }>,
  extra: Record<string, string> = {},
): RenderedSignal {
  const p = e.payload as Record<string, unknown>;
  const attrs: Record<string, string> = { kind: e.type, hire: hireRef, event_id: e.id, source: e.source, ...extra };
  const str = (k: string) => (p[k] === undefined || p[k] === null ? undefined : String(p[k]));
  const put = (k: string, v: string | undefined) => {
    if (v !== undefined) attrs[k] = v;
  };
  let contents: string;
  switch (e.type) {
    case 'email.received':
      put('from', str('from'));
      put('from_name', str('fromName'));
      put('thread', str('threadLabel'));
      put('evidence_id', str('evidenceId'));
      contents = `Subject: ${str('subject')}\n\n${str('body')}`;
      break;
    case 'note.created':
      put('author', str('author'));
      put('evidence_id', str('evidenceId'));
      contents = String(p.body ?? '');
      break;
    case 'hire.updated':
      put('from_version', str('fromVersion'));
      put('to_version', str('toVersion'));
      put('fields', ((p.fields as string[]) ?? []).join(','));
      put('by', e.actor ?? undefined);
      contents = String(p.summary ?? 'Hire edited directly by staff.');
      break;
    case 'status.changed':
      put('line', str('lineNo'));
      put('from', str('from'));
      put('to', str('to'));
      put('to_version', str('toVersion'));
      put('by', e.actor ?? undefined);
      put('evidence_id', str('evidenceId'));
      contents = String(p.summary ?? `Status changed ${str('from')} → ${str('to')}.`);
      break;
    case 'approval.decided':
      put('draft', str('draftRef'));
      put('decision', str('decision'));
      put('decided_by', str('decidedBy'));
      put('approval_id', str('approvalId'));
      put('based_on', str('basedOnVersion'));
      put('hire_version', str('hireVersion'));
      contents = `${str('draftRef')} ${str('decision')} by ${str('decidedBy')}; hire is now v${str('hireVersion')} (draft based on v${str('basedOnVersion')}).`;
      break;
    case 'schedule.fired':
      contents = 'Daily pre-delivery sweep: check waiver, delivery readiness and anything waiting on us.';
      break;
    default:
      contents = JSON.stringify(p);
  }
  return { tag: plan.tag, contents, attributes: attrs };
}
