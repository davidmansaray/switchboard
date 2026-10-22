/**
 * Action keys make every write safe to run more than once. They are derived from
 * the *intent*, never from the run, so a retried run, a recovered run and a second
 * source for the same intent (Sam's email + Jo's direct cancel) all collide.
 */
const norm = (s: string | number) => String(s).trim().toLowerCase().replace(/\s+/g, '-');

export function actionKey(...parts: Array<string | number>): string {
  if (parts.length === 0) throw new Error('actionKey needs at least one part');
  return parts.map(norm).join(':');
}

export const keys = {
  routineUpdate: (hireRef: string, field: string, value: string) => actionKey('routine', hireRef, field, value),
  applyDraft: (draftRef: string) => actionKey('apply', draftRef),
  emailForDraft: (draftRef: string) => actionKey('email', draftRef),
  /** Shared by every source that asks to cancel the same line. */
  cancelLine: (hireRef: string, lineNo: number) => actionKey('cancel-line', hireRef, lineNo),
  creditNote: (hireRef: string, lineNo: number) => actionKey('credit-note', hireRef, lineNo),
  proposal: (hireRef: string, intent: string, basedOnVersion: number) => actionKey('propose', hireRef, intent, `v${basedOnVersion}`),
  approval: (draftRef: string, decidedBy: string) => actionKey('approval', draftRef, decidedBy),
};
