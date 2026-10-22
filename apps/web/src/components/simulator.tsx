'use client';

import { HERO_BEATS } from '@switchboard/core';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { RuntimeView, ScenarioView } from '@/lib/types';
import { Icon } from './icons';
import { useLive } from './live';
import { MechTag } from './overlay';

export type SimHire = {
  ref: string;
  version: number;
  deliveryDate: string;
  lines: Array<{ lineNo: number; description: string; fleetNo: string | null; status: string }>;
  threads: Array<{ label: string; email: string; name: string }>;
};

type Props = {
  scenario: ScenarioView;
  runtime: RuntimeView;
  hires: SimHire[];
  selected: string | null;
  /** The open discount draft on the hero desk (beats 5 and 6 are approved from the phone). */
  phoneDraft: string | null;
};

const SWAP = { lineNo: 2, model: 'Manitou MT 1840', description: '17m telehandler', spec: '4t lift capacity', fleetNo: 'TH17-05', weeklyRatePence: 86000 };
const isPhone = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;

/**
 * The scenario rail (in-product dev tooling): beat markers 1–9, "Next beat", Reset, and the signal
 * panel for free-form email / note / edit / status / sweep / crash. Every control goes through the
 * agent's real services: nothing here moves a card by itself.
 */
export function Simulator({ scenario, runtime, hires, selected, phoneDraft }: Props) {
  const { post, notify, setOverlay } = useLive();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [panel, setPanel] = useState(false);
  const [phone, setPhone] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const busy = scenario.busy || pending;
  const next = scenario.next ? HERO_BEATS[scenario.next - 1]! : null;
  const playing = scenario.beats.find((b) => b.status === 'playing');
  const failed = scenario.beats.find((b) => b.status === 'failed');

  useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 3500);
    return () => clearTimeout(t);
  }, [confirmReset]);

  const playNext = async () => {
    if (!next || busy) return;
    if ((next.n === 5 || next.n === 6) && phoneDraft) {
      // Gary approves from his phone: the beat is the tap in the mobile approval view.
      if (isPhone()) router.push(`/m/approve/${phoneDraft}`);
      else setPhone(phoneDraft);
      return;
    }
    setPending(true);
    if (next.n === 9) setOverlay(true);
    const r = await post('/api/sim', { action: 'beat', n: next.n });
    setPending(false);
    if (r.ok && next.n !== 9) notify(`Beat ${next.n}: ${next.title}`);
  };

  const reset = async () => {
    if (!confirmReset) return setConfirmReset(true);
    setConfirmReset(false);
    setPending(true);
    setOverlay(false);
    setPhone(null);
    const r = await post('/api/sim', { action: 'reset' });
    setPending(false);
    if (r.ok) notify('Back to the seeded morning: every desk re-seeded, the beat track cleared.');
  };

  const pips = HERO_BEATS.map((b) => {
    const row = scenario.beats.find((x) => x.n === b.n);
    const state = row?.status === 'playing' ? 'playing' : row?.status === 'done' ? 'done' : row?.status === 'failed' ? 'failed' : b.n === scenario.next ? 'next' : 'todo';
    return { ...b, state };
  });
  const doneCount = scenario.beats.filter((b) => b.status === 'done').length;

  const label = playing ? (
    <span className="sim__next-title">
      Playing beat <span className="sim__next-n">{playing.n}</span> · {HERO_BEATS[playing.n - 1]!.title}
    </span>
  ) : next ? (
    <>
      <Icon name={next.n === 5 || next.n === 6 ? 'phone' : 'next'} />
      <span className="sim__next-title">
        Next beat <span className="sim__next-n">{next.n}</span> · {next.title}
      </span>
    </>
  ) : (
    <span className="sim__next-title">All 9 beats played</span>
  );

  return (
    <div className="region simwrap" data-mech="app" id="sim-region" data-component="Simulator">
      <MechTag mech="app" />
      <div className="sim">
        <span className="sim__label">Simulator</span>
        <ol className="sim__beats" aria-label={`Beat ${doneCount} of 9`}>
          {pips.map((p) => (
            <li key={p.n} className="sim__beat" data-state={p.state} title={`${p.n} · ${p.title}${p.auto ? ' (lands during beat 3’s run)' : ''}: ${p.detail}`}>
              {p.n}
            </li>
          ))}
        </ol>
        <button className="btn sim__next" type="button" disabled={busy || !next} onClick={playNext} data-testid="sim-next" title={next?.detail}>
          {label}
        </button>
        <button className="btn btn--quiet" type="button" onClick={() => setPanel(!panel)} aria-expanded={panel} data-testid="sim-panel-toggle" title="Send a free-form signal, fire the sweep or crash the worker">
          <Icon name="signals" />
          <span>Signals</span>
        </button>
        <button className="btn btn--quiet" type="button" disabled={busy || !runtime.resetEnabled} onClick={reset} data-testid="sim-reset" title="Back to the seeded morning">
          <Icon name="reset" />
          <span>{confirmReset ? 'Confirm reset' : 'Reset'}</span>
        </button>
      </div>
      <div className="simpill">
        <span className="simpill__label" title={next?.detail}>
          {playing ? `Playing ${playing.n} · ${HERO_BEATS[playing.n - 1]!.title}` : next ? `${next.n}/9 · ${next.title}` : 'All 9 beats played'}
        </span>
        <button className="simpill__btn" type="button" disabled={busy || !next} onClick={playNext} title={next ? `Next beat ${next.n}: ${next.title}` : 'All 9 beats played'} data-testid="pill-next">
          Next
          <Icon name="next" />
        </button>
        <button className="simpill__btn simpill__btn--icon" type="button" onClick={() => setPanel(!panel)} aria-label="Send a signal" aria-expanded={panel}>
          <Icon name="signals" />
        </button>
        <button className="simpill__btn simpill__btn--icon" type="button" disabled={busy} onClick={reset} aria-label={confirmReset ? 'Confirm reset' : 'Reset'} data-confirm={confirmReset ? 'true' : undefined}>
          <Icon name="reset" />
        </button>
      </div>
      {failed ? (
        <p className="sim__failed" role="status">
          Beat {failed.n} did not finish: {failed.error}. Reset to start the story again.
        </p>
      ) : null}
      {panel ? <SignalPanel hires={hires} selected={selected} runtime={runtime} onClose={() => setPanel(false)} /> : null}
      {phone ? <PhoneSheet draftRef={phone} beat={next?.n ?? null} onClose={() => setPhone(null)} /> : null}
    </div>
  );
}

type Tab = 'email' | 'note' | 'edit' | 'status' | 'sweep' | 'crash';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'email', label: 'Email' },
  { id: 'note', label: 'Note' },
  { id: 'edit', label: 'Edit' },
  { id: 'status', label: 'Status' },
  { id: 'sweep', label: '07:00 sweep' },
  { id: 'crash', label: 'Crash worker' },
];

function SignalPanel({ hires, selected, runtime, onClose }: { hires: SimHire[]; selected: string | null; runtime: RuntimeView; onClose: () => void }) {
  const { post, notify } = useLive();
  const [tab, setTab] = useState<Tab>('email');
  const [ref, setRef] = useState(selected ?? hires[0]?.ref ?? 'NH-5520');
  const hire = hires.find((h) => h.ref === ref) ?? hires[0];
  const [thread, setThread] = useState(hire?.threads[0]?.label ?? 'T1');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [mention, setMention] = useState(true);
  const [date, setDate] = useState(hire?.deliveryDate ?? '');
  const [swap, setSwap] = useState(false);
  const [lineNo, setLineNo] = useState(hire?.lines[0]?.lineNo ?? 1);
  const [lineStatus, setLineStatus] = useState<'booked' | 'on_hire' | 'cancelled'>('cancelled');
  const [sending, setSending] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hire) return;
    setThread(hire.threads[0]?.label ?? 'T1');
    setDate(hire.deliveryDate);
    setLineNo(hire.lines[0]?.lineNo ?? 1);
    setSubject(`Re: ${hire.ref}`);
    setBody(hire.threads.length ? `Hi Gary,\n\nQuick one on ${hire.ref}: can the driver call 30 minutes before arrival?\n\nThanks` : '');
  }, [hire]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  if (!hire) return null;
  const th = hire.threads.find((t) => t.label === thread) ?? hire.threads[0];
  const send = async (payload: Record<string, unknown>, done: string) => {
    setSending(true);
    const r = await post('/api/sim', payload);
    setSending(false);
    if (r.ok) notify(done);
  };

  return (
    <div className="simpanel" ref={panelRef} role="dialog" aria-label="Send a signal" data-testid="sim-panel">
      <div className="simpanel__bar">
        <label className="simpanel__hire">
          <span>Desk</span>
          <select value={ref} onChange={(e) => setRef(e.target.value)} data-testid="sim-hire">
            {hires.map((h) => (
              <option key={h.ref} value={h.ref}>
                {h.ref}
              </option>
            ))}
          </select>
        </label>
        <div className="simpanel__tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="simpanel__tab" data-tab={t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <button className="btn btn--quiet btn--icon" type="button" onClick={onClose} aria-label="Close the signal panel">
          <Icon name="close" />
        </button>
      </div>
      <div className="simpanel__body" role="tabpanel">
        {tab === 'email' ? (
          th ? (
            <form
              className="simform"
              onSubmit={(e) => {
                e.preventDefault();
                void send({ action: 'email', hireRef: hire.ref, threadLabel: th.label, from: th.email, subject, body }, `Email on ${th.label} sent to the ${hire.ref} desk (sendMessage).`);
              }}
            >
              <label>
                <span>Thread</span>
                <select value={th.label} onChange={(e) => setThread(e.target.value)}>
                  {hire.threads.map((t) => (
                    <option key={t.label} value={t.label}>
                      {t.label} · {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Subject</span>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={200} />
              </label>
              <label className="simform__wide">
                <span>Body</span>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} required maxLength={4000} />
              </label>
              <p className="simform__api">sendMessage · starts a run if idle, joins it if running</p>
              <button className="btn btn--primary" type="submit" disabled={sending}>
                <Icon name="email" />
                Send email
              </button>
            </form>
          ) : (
            <p className="simform__note">No email thread on {hire.ref} yet. Emails arrive on a hire’s threads (NH-5520 has T1 and T2).</p>
          )
        ) : null}
        {tab === 'note' ? (
          <form
            className="simform"
            onSubmit={(e) => {
              e.preventDefault();
              const text = mention && !/@assistant/i.test(body) ? `@assistant ${body}` : body;
              void send({ action: 'note', hireRef: hire.ref, body: text }, mention ? `Note sent: it wakes the ${hire.ref} desk.` : `Note stored on the ${hire.ref} thread without waking it (persist).`);
            }}
          >
            <label className="simform__wide">
              <span>Internal note</span>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} required maxLength={2000} placeholder="Customer called: site gate opens at 07:30." />
            </label>
            <label className="simform__check">
              <input type="checkbox" checked={mention} onChange={(e) => setMention(e.target.checked)} />
              <span>@assistant: wake the desk (otherwise the note is persisted as context)</span>
            </label>
            <p className="simform__api">{mention ? 'sendMessage · wake' : 'sendSignal · ifIdle: persist · ifActive: persist'}</p>
            <button className="btn btn--primary" type="submit" disabled={sending}>
              <Icon name="note" />
              Add note
            </button>
          </form>
        ) : null}
        {tab === 'edit' ? (
          <form
            className="simform"
            onSubmit={(e) => {
              e.preventDefault();
              void send(
                { action: 'edit', hireRef: hire.ref, deliveryDate: date !== hire.deliveryDate ? date : undefined, swap: swap ? SWAP : undefined },
                `Staff edit saved on ${hire.ref}: a new version, queued for the desk after the debounce window.`,
              );
            }}
          >
            <label>
              <span>Delivery date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            {hire.ref === 'NH-5520' ? (
              <label className="simform__check">
                <input type="checkbox" checked={swap} onChange={(e) => setSwap(e.target.checked)} />
                <span>Swap line 2 to TH17-05 17m telehandler (£860/wk)</span>
              </label>
            ) : null}
            <p className="simform__api">app debounce (1.5 s) → queueMessage · never interrupts a run</p>
            <button className="btn btn--primary" type="submit" disabled={sending || (date === hire.deliveryDate && !swap)}>
              <Icon name="edit" />
              Save edit
            </button>
          </form>
        ) : null}
        {tab === 'status' ? (
          <form
            className="simform"
            onSubmit={(e) => {
              e.preventDefault();
              void send({ action: 'status', hireRef: hire.ref, lineNo, status: lineStatus }, `Line ${lineNo} on ${hire.ref} set to ${lineStatus.replace('_', ' ')} (queueSignal).`);
            }}
          >
            <label>
              <span>Line</span>
              <select value={lineNo} onChange={(e) => setLineNo(Number(e.target.value))}>
                {hire.lines.map((l) => (
                  <option key={l.lineNo} value={l.lineNo}>
                    {l.lineNo} · {l.fleetNo} {l.description} ({l.status.replace('_', ' ')})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select value={lineStatus} onChange={(e) => setLineStatus(e.target.value as typeof lineStatus)}>
                <option value="booked">Booked</option>
                <option value="on_hire">On hire</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <p className="simform__api">queueSignal · system context: line, from, to, new version</p>
            <button className="btn btn--primary" type="submit" disabled={sending}>
              <Icon name="flag" />
              Set status
            </button>
          </form>
        ) : null}
        {tab === 'sweep' ? (
          <div className="simform">
            <p className="simform__note">
              The daily 07:00 pre-delivery sweep is a Mastra schedule bound to the {hire.ref} desk thread. Firing it now calls <code>schedules.run()</code>: it wakes an
              idle desk and is persisted on a busy one.
            </p>
            <button className="btn btn--primary" type="button" disabled={sending} onClick={() => send({ action: 'sweep', hireRef: hire.ref }, `07:00 sweep fired on ${hire.ref}.`)} data-testid="sim-sweep">
              <Icon name="clock" />
              Fire 07:00 sweep
            </button>
          </div>
        ) : null}
        {tab === 'crash' ? (
          <div className="simform">
            {runtime.crashEnabled ? (
              <>
                <p className="simform__note">
                  Really kills the agent process (SIGKILL). The supervisor restarts it; a durable run that was mid-step resumes once the dead worker’s 30 s lease lapses,
                  re-runs the interrupted tool call, and the ledger skips anything already written.
                </p>
                {runtime.crashArmed ? (
                  <p className="simform__armed">
                    Armed: the worker dies right after its next ledgered write.{' '}
                    <button className="btn btn--quiet" type="button" onClick={() => send({ action: 'crash', mode: 'disarm' }, 'Crash disarmed.')}>
                      Disarm
                    </button>
                  </p>
                ) : null}
                <div className="simform__row">
                  <button className="btn" type="button" disabled={sending || Boolean(runtime.crashArmed)} onClick={() => send({ action: 'crash', mode: 'arm' }, 'Armed: the worker dies after its next ledgered write.')}>
                    <Icon name="crash" />
                    Crash after the next write
                  </button>
                  <button className="btn btn--primary" type="button" disabled={sending || runtime.workerDown} onClick={() => send({ action: 'crash', mode: 'now' }, 'Worker killed. Watch the desk recover.')} data-testid="sim-crash-now">
                    <Icon name="crash" />
                    Kill the worker now
                  </button>
                </div>
              </>
            ) : (
              <p className="simform__note">The crash control is switched off on this deployment (ALLOW_CRASH_ENDPOINT). Beat 6 still runs the apply, without the kill.</p>
            )}
          </div>
        ) : null}
      </div>
      <p className="simpanel__foot">
        <span className="mono">SIGNAL_BACKEND={runtime.backend ?? '…'}</span> · <span className="mono">LLM_MODE={runtime.llmMode ?? '…'}</span>
        {runtime.llmMode === 'scripted' ? ' · offline desk model, no API key' : runtime.llmMode === 'replay' ? ' · recorded responses' : ''}
      </p>
    </div>
  );
}

/** The mobile approval route inside a plain 390×844 frame, for the desktop demo of beats 5 and 6. */
function PhoneSheet({ draftRef, beat, onClose }: { draftRef: string; beat: number | null; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () => setScale(Math.min(1, (window.innerHeight - 130) / 844));
    fit();
    window.addEventListener('resize', fit);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('resize', fit);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  return (
    <div className="phonesheet" role="dialog" aria-label={`Gary’s phone: approve ${draftRef}`} data-testid="phone-sheet">
      <div className="phonesheet__bar">
        <span>
          <Icon name="phone" /> Gary’s phone{beat ? ` · beat ${beat}` : ''}
        </span>
        <button className="btn btn--quiet btn--icon" type="button" onClick={onClose} aria-label="Close the phone">
          <Icon name="close" />
        </button>
      </div>
      <div className="phonesheet__stage" style={{ height: 844 * scale + 2 }}>
        <div className="phoneframe" style={{ transform: `scale(${scale})` }}>
          <iframe title={`Mobile approval ${draftRef}`} src={`/m/approve/${draftRef}?frame=1`} width={390} height={844} />
        </div>
      </div>
    </div>
  );
}
