/**
 * The hero story as the simulator rail shows it. The agent's scenario runner plays these against
 * the real services; the web app renders the same titles. Beat 4 lands while beat 3's run is
 * still working (that is the race), so the runner plays it as part of beat 3.
 */
export type HeroBeat = { n: number; title: string; actor: string; mech: 'signal' | 'tool' | 'memory' | 'durable' | 'schedule' | 'app'; detail: string; auto?: boolean };

export const HERO_BEATS: readonly HeroBeat[] = [
  { n: 1, title: 'Sam asks for a discount', actor: 'Sam Fletcher', mech: 'signal', detail: 'Email on T1 wakes the idle NH-5520 desk. It records an open ask in working memory and drafts nothing.' },
  { n: 2, title: 'Leanne sends the PO', actor: 'Leanne Price', mech: 'tool', detail: 'Email on T2, same desk. PO and invoice address are routine-tier fields: applied and logged, no approval.' },
  { n: 3, title: 'Gary approves 10% in a note', actor: 'Gary Dunn', mech: 'memory', detail: 'An @assistant note plus the call transcript. The desk prepares pricing + reply as a draft, based on the current version.' },
  { n: 4, title: 'Jo moves delivery mid-run', actor: 'Jo Barrett', mech: 'signal', auto: true, detail: 'Lands while beat 3 is still running: the edit is queued, the run is not interrupted, the draft goes stale.' },
  { n: 5, title: 'Gary approves the stale draft', actor: 'Gary Dunn', mech: 'tool', detail: 'From his phone. The approval is a signal; the desk sees the hire moved and regenerates the draft.' },
  { n: 6, title: 'Worker crash during apply', actor: 'Gary Dunn', mech: 'durable', detail: 'Gary approves the new draft. The worker dies right after the pricing write; recovery re-runs the step and the ledger skips it. One email.' },
  { n: 7, title: '07:00 pre-delivery sweep', actor: 'Schedule', mech: 'schedule', detail: 'The daily schedule fires on the desk thread. No signed damage waiver on file: a chaser goes to the sign-off slot.' },
  { n: 8, title: 'Telehandler cancelled twice', actor: 'Sam Fletcher', mech: 'tool', detail: 'Sam emails "cancel the telehandler" and Jo sets the line to cancelled. One intent, one action key, one credit note.' },
  { n: 9, title: 'Inspect the architecture', actor: 'Switchboard', mech: 'app', detail: 'Turn on the Architecture Overlay: every region labelled with the Mastra facility or app code behind it.' },
] as const;
