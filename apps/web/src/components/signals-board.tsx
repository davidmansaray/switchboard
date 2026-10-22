'use client';

import { useMemo, useState } from 'react';
import { fmtTime } from '@/lib/format';
import type { SignalView } from '@/lib/types';
import { Icon, SOURCE, THead } from './icons';
import { MechTag } from './overlay';
import { SignalStream } from './signals';

type Filters = { source: string | null; type: string | null; delivery: string | null; hire: string | null };

const TYPES = ['message', 'queued-message', 'signal', 'queued-signal', 'schedule', 'evidence'];
const DELIVERIES = ['delivered', 'queued', 'persisted', 'discarded', 'blocked', 'failed'];

function Rail({ label, value, options, onPick, word = (x: string) => x, mono = false }: { label: string; value: string | null; options: Array<{ v: string; n: number }>; onPick: (v: string | null) => void; word?: (x: string) => string; mono?: boolean }) {
  const total = options.reduce((a, o) => a + o.n, 0);
  return (
    <fieldset className="frail">
      <legend className={mono ? 'frail__legend--mono' : undefined}>{label}</legend>
      <button type="button" className="frail__opt" aria-pressed={value === null} onClick={() => onPick(null)}>
        All <span className="mono">{total}</span>
      </button>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          className={`frail__opt${mono ? ' mono-opt' : ''}`}
          aria-pressed={value === o.v}
          data-empty={!o.n && value !== o.v ? 'true' : undefined}
          aria-disabled={!o.n && value !== o.v}
          onClick={() => (o.n || value === o.v ? onPick(value === o.v ? null : o.v) : undefined)}
        >
          {value === o.v ? <THead className="frail__mark icon--fill" /> : null}
          {word(o.v)} <span className="mono">{o.n}</span>
        </button>
      ))}
    </fieldset>
  );
}

/** The day strip: one tick per signal on today's rail, yellow while it waits in a pocket. Not a chart. */
function DayStrip({ signals, midnight }: { signals: SignalView[]; midnight: string }) {
  const start = Date.parse(midnight);
  const span = 24 * 3_600_000;
  const today = signals.filter((s) => Date.parse(s.at) >= start && s.type !== 'evidence').reverse();
  const hours = [0, 6, 12, 18, 24];
  // Signals in the same few minutes would sit on one pixel: spread them along the rail like cards in a slot.
  const placed: number[] = [];
  const pos = today.map((s) => {
    let x = ((Date.parse(s.at) - start) / span) * 100;
    while (placed.some((p) => Math.abs(p - x) < 0.45)) x += 0.45;
    placed.push(x);
    return Math.min(x, 99.6);
  });
  return (
    <div className="daystrip" data-component="DayStrip" aria-label={`${today.length} signals today`}>
      <div className="daystrip__rail">
        <span className="daystrip__sweep" style={{ left: `${(7 / 24) * 100}%` }} title="07:00 pre-delivery sweep (mastra.schedules, daily on every desk)">
          07:00 sweep
        </span>
        {today.map((s, i) => (
          <span
            key={s.id}
            className="daystrip__tick"
            data-delivery={s.delivery === 'queued' && s.pickedUp ? 'delivered' : s.delivery}
            data-queued={s.delivery === 'queued' ? 'true' : undefined}
            style={{ left: `${pos[i]}%` }}
            title={`${fmtTime(s.at)} · ${SOURCE[s.source]?.label ?? s.source} · ${s.hireRef}`}
          />
        ))}
      </div>
      <div className="daystrip__hours" aria-hidden="true">
        {hours.map((h) => (
          <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
            {String(h % 24).padStart(2, '0')}:00
          </span>
        ))}
      </div>
    </div>
  );
}

export function SignalsBoard({ signals, hires, midnight, initialHire }: { signals: SignalView[]; hires: string[]; midnight: string; initialHire: string | null }) {
  const [f, setF] = useState<Filters>({ source: null, type: null, delivery: null, hire: initialHire });
  const [open, setOpen] = useState(false);
  const count = (key: keyof Filters, v: string) => signals.filter((s) => (key === 'delivery' ? (s.delivery === 'queued' && s.pickedUp ? 'delivered' : s.delivery) : (s as unknown as Record<string, string>)[key === 'hire' ? 'hireRef' : key]) === v).length;
  const shown = useMemo(
    () =>
      signals.filter(
        (s) =>
          (!f.source || s.source === f.source) &&
          (!f.type || s.type === f.type) &&
          (!f.delivery || (s.delivery === 'queued' && s.pickedUp ? 'delivered' : s.delivery) === f.delivery || (f.delivery === 'queued' && s.delivery === 'queued')) &&
          (!f.hire || s.hireRef === f.hire),
      ),
    [signals, f],
  );
  const merged = shown.filter((s) => s.mergedInto);
  const on = Object.values(f).filter(Boolean).length;
  return (
    <main className="page page--signals">
      <aside className="sigfilters" aria-label="Filter signals" data-open={open ? 'true' : 'false'}>
        <button type="button" className="btn sigfilters__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          Filters{on ? ` · ${on} on` : ''}
          <Icon name="chev" className="sigfilters__chev" />
        </button>
        <div className="sigfilters__groups">
          <Rail label="Source" value={f.source} onPick={(v) => setF({ ...f, source: v })} options={Object.keys(SOURCE).map((v) => ({ v, n: count('source', v) }))} word={(x) => SOURCE[x]?.label ?? x} />
          <Rail label="Mastra API" mono value={f.type} onPick={(v) => setF({ ...f, type: v })} options={TYPES.map((v) => ({ v, n: count('type', v) }))} />
          <Rail label="Delivery" value={f.delivery} onPick={(v) => setF({ ...f, delivery: v })} options={DELIVERIES.map((v) => ({ v, n: count('delivery', v) }))} />
          <Rail label="Hire" mono value={f.hire} onPick={(v) => setF({ ...f, hire: v })} options={hires.map((v) => ({ v, n: count('hire', v) }))} />
        </div>
      </aside>
      <section className="sigmain region" data-mech="signal">
        <MechTag mech="signal" />
        <DayStrip signals={signals} midnight={midnight} />
        {merged.length ? (
          <p className="mergenote">
            <span className="mergenote__bracket" aria-hidden="true" />
            {merged.length === 1 ? 'One signal' : `${merged.length} signals`} merged into an earlier one: one intent, one action key, one credit note.
          </p>
        ) : null}
        <SignalStream signals={shown} empty="No signals match these filters" />
      </section>
    </main>
  );
}
