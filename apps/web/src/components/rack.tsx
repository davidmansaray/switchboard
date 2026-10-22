'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fmtTime } from '@/lib/format';
import type { DeskStatus, DeskView, SignalView } from '@/lib/types';
import { COLUMNS, DESK_STATUS } from '@/lib/vocab';
import { SOURCE } from './icons';

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const tok = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ms = (name: string) => parseFloat(tok(name)) || 0;

/** The slot drop: lift 120 ms → travel 420 ms (FLIP) → 2 px settle 90 ms. Reduced motion: a crossfade. */
function slotDrop(el: HTMLElement, dx: number, dy: number) {
  el.getAnimations().forEach((a) => a.cancel());
  if (reduced()) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') || 150, easing: 'linear' });
    return;
  }
  const lift = ms('--dur-lift');
  const travel = ms('--dur-travel');
  const settle = ms('--dur-settle');
  const total = lift + travel + settle;
  const ly = parseFloat(tok('--lift-y'));
  const sy = parseFloat(tok('--settle-y'));
  const rest = tok('--rest-filter');
  const up = tok('--lift-filter');
  const ease = tok('--ez-slot');
  el.classList.add('is-moving');
  const anim = el.animate(
    [
      { offset: 0, transform: `translate(${dx}px,${dy}px)`, filter: rest, easing: 'ease-out' },
      { offset: lift / total, transform: `translate(${dx}px,${dy + ly}px)`, filter: up, easing: ease },
      { offset: (lift + travel) / total, transform: `translate(0px,${ly}px)`, filter: up, easing: 'ease-in' },
      { offset: (lift + travel + settle * 0.55) / total, transform: `translate(0px,${sy}px)`, filter: rest, easing: 'ease-out' },
      { offset: 1, transform: 'translate(0px,0px)', filter: rest },
    ],
    { duration: total },
  );
  anim.onfinish = anim.oncancel = () => el.classList.remove('is-moving');
}

function slide(el: HTMLElement, dx: number, dy: number) {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  el.getAnimations().forEach((a) => a.cancel());
  el.classList.remove('is-moving');
  if (reduced()) return;
  el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: ms('--dur-travel'), easing: tok('--ez-slot') });
}

function StatusLabel(s: DeskStatus) {
  return DESK_STATUS[s]?.label ?? s;
}

/** Queued signals peek out of the top of the card as thin yellow card edges. */
function CardPocket({ signals, fresh, leaving }: { signals: SignalView[]; fresh: Set<string>; leaving: string[] }) {
  if (!signals.length && !leaving.length) return null;
  const label = `${signals.length} queued signal${signals.length === 1 ? '' : 's'} waiting for this run to finish`;
  return (
    <div className="pocket" data-component="CardPocket" aria-hidden={signals.length ? undefined : true}>
      <div className="pocket__edges">
        {signals.slice(0, 3).map((s, i) => (
          <span key={s.id} className={`pocket__edge${fresh.has(s.id) ? ' pocket__edge--rise' : ''}`} style={{ ['--i' as string]: i }} />
        ))}
        {leaving.map((id, i) => (
          <span key={`l-${id}`} className="pocket__edge pocket__edge--leaving" style={{ ['--i' as string]: i }} />
        ))}
      </div>
      {signals.length ? (
        <>
          <button className="pocket__btn" type="button" aria-label={label} />
          <div className="pocket__tip" role="tooltip">
            <b>{label}</b>
            {signals.map((s) => (
              <span key={s.id} className="pocket__tipline">
                <b>
                  {SOURCE[s.source]?.label ?? s.source} · {s.actor}
                  {s.waitsFor ? ` · waits for ${s.waitsFor}` : ''}
                </b>
                {s.summary}
              </span>
            ))}
          </div>
          {signals.length > 1 ? <span className="pocket__count">{signals.length}</span> : null}
        </>
      ) : null}
    </div>
  );
}

function DeskCard({ desk, selected, onOpen, fresh, leaving }: { desk: DeskView; selected: boolean; onOpen: (ref: string) => void; fresh: Set<string>; leaving: string[] }) {
  const st = desk.status;
  const label = StatusLabel(st);
  const ls = desk.lastSignal;
  const working = st === 'running' || st === 'queued';
  return (
    <article className="tcard" data-component="DeskCard" data-hire={desk.ref} data-status={st} data-selected={selected ? 'true' : 'false'} data-testid={`desk-${desk.ref}`}>
      <CardPocket signals={desk.queued} fresh={fresh} leaving={leaving} />
      <div className="tcard__head">
        <button className="tcard__open" type="button" onClick={() => onOpen(desk.ref)} aria-label={`Open desk ${desk.ref}, ${desk.customer}, ${label}`} aria-current={selected ? 'true' : undefined}>
          {desk.ref}
        </button>
        {st === 'awaiting_approval' && desk.awaiting.length ? (
          <span className="tcard__draft" title="In the sign-off slot">
            · {desk.awaiting.join(', ')}
          </span>
        ) : null}
        <span className="tcard__ver" title="Hire version">
          v{desk.version}
        </span>
      </div>
      <div className="tcard__body">
        <span className="sr-only">{label}</span>
        <p className="tcard__cust">{desk.customer}</p>
        <p className="tcard__site">{desk.site}</p>
        <ul className="tcard__machines" aria-label="Machines">
          {desk.lines.map((l) => (
            <li key={l.lineNo} className="tcard__machine" data-line-status={l.status}>
              <span className="mono">{l.fleetNo}</span>
              <span className="tcard__machine-desc" title={l.description}>
                {l.short}
              </span>
            </li>
          ))}
        </ul>
        {st === 'recovering' ? (
          <p className="tcard__step">
            <b>Run lost: recovering.</b> <Lease until={desk.leaseEndsAt} /> {desk.step ? <span className="mono">{desk.step}</span> : null}
          </p>
        ) : working ? (
          <p className="tcard__step">
            <span className="tcard__working" aria-hidden="true" />
            <b>Working:</b> <span className="mono">{desk.step ?? 'starting run'}</span>
          </p>
        ) : null}
        <p className="tcard__last" title="Last signal">
          {ls ? (
            <>
              <time>{fmtTime(ls.at)}</time> {SOURCE[ls.source]?.label ?? ls.source} · {ls.actor} · {ls.summary}
            </>
          ) : (
            'No signals yet'
          )}
        </p>
      </div>
    </article>
  );
}

/** "lease frees in 18 s": the dead worker's run lease, after which recovery takes the run over. */
export function Lease({ until }: { until: string | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until || now === null) return null;
  const left = Math.ceil((Date.parse(until) - now) / 1000);
  return <span className="lease">{left > 0 ? `lease frees in ${left}s` : 'taking the run over'}</span>;
}

function EmptySlot({ text }: { text: string }) {
  return (
    <div className="emptyslot" data-component="EmptySlot">
      <span className="emptyslot__slot" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

export { EmptySlot };

/**
 * The rack: four state columns. Cards are keyed by hire ref; when a desk's state moves it to another
 * column the card lifts, travels and drops (FLIP); within a column it slides.
 */
export function Rack({ desks, selected, onOpen }: { desks: DeskView[]; selected: string | null; onOpen: (ref: string) => void }) {
  const colsRef = useRef<HTMLDivElement>(null);
  const prev = useRef(new Map<string, { x: number; y: number; col: string }>());
  const pockets = useRef(new Map<string, string[]>());
  const booted = useRef(false);
  const [leaving, setLeaving] = useState<Record<string, string[]>>({});

  const byCol = COLUMNS.map((c) => ({ col: c, desks: desks.filter((d) => c.statuses.includes(d.status)) }));

  // Pocket edges that just rose (fresh) or were delivered (sink out).
  const fresh = new Map<string, Set<string>>();
  for (const d of desks) {
    const before = pockets.current.get(d.ref) ?? [];
    fresh.set(d.ref, new Set(booted.current ? d.queued.map((s) => s.id).filter((id) => !before.includes(id)) : []));
  }

  useEffect(() => {
    const out: Record<string, string[]> = {};
    for (const d of desks) {
      const before = pockets.current.get(d.ref) ?? [];
      const now = d.queued.map((s) => s.id);
      const gone = before.filter((id) => !now.includes(id));
      if (gone.length && booted.current) out[d.ref] = gone;
      pockets.current.set(d.ref, now);
    }
    if (Object.keys(out).length) {
      setLeaving(out);
      const t = setTimeout(() => setLeaving({}), 400);
      return () => clearTimeout(t);
    }
  }, [desks]);

  useLayoutEffect(() => {
    const root = colsRef.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number; col: string }>();
    root.querySelectorAll<HTMLElement>('.tcard').forEach((el) => {
      const r = el.getBoundingClientRect();
      const col = el.closest<HTMLElement>('.rack__col')?.dataset.col ?? '';
      const pos = { x: r.left - base.left + root.scrollLeft, y: r.top - base.top + root.scrollTop, col };
      const ref = el.dataset.hire!;
      const was = prev.current.get(ref);
      if (was && booted.current) {
        const dx = was.x - pos.x;
        const dy = was.y - pos.y;
        if (was.col !== col) {
          slotDrop(el, dx, dy);
          if (ref === selected && window.matchMedia('(max-width: 900px)').matches) {
            const colEl = el.closest<HTMLElement>('.rack__col');
            if (colEl) root.scrollTo({ left: colEl.offsetLeft - root.offsetLeft - 16, behavior: reduced() ? 'auto' : 'smooth' });
          }
        } else slide(el, dx, dy);
      }
      next.set(ref, pos);
    });
    prev.current = next;
    if (!booted.current) {
      booted.current = true;
      // Phone: the rack scrolls sideways; start on the first column that holds a desk.
      if (window.matchMedia('(max-width: 900px)').matches) {
        const first = root.querySelector<HTMLElement>('.rack__col[data-empty="false"]');
        if (first) root.scrollLeft = first.offsetLeft - root.offsetLeft - 16;
      }
    }
  });

  return (
    <div className="rack__scroll">
      <div className="rack__cols" ref={colsRef}>
        {byCol.map(({ col, desks: list }) => (
          <div key={col.id} className="rack__col" data-component="RackColumn" data-col={col.id} data-status={col.id} data-empty={list.length ? 'false' : 'true'}>
            <div data-component="RackColumnHead">
              <div className="rack__colhead">
                <h2 className="rack__colname">{col.label}</h2>
                <span className="rack__count" aria-label={`${col.label}: ${list.length} desks`}>
                  {list.length}
                </span>
              </div>
              <div className="rack__colstem" aria-hidden="true" />
              {list.length ? null : (
                <p className="rack__spine" aria-hidden="true">
                  {col.label}
                </p>
              )}
            </div>
            <div className="rack__slots">
              {list.map((d) => (
                <DeskCard key={d.ref} desk={d} selected={selected === d.ref} onOpen={onOpen} fresh={fresh.get(d.ref) ?? new Set()} leaving={leaving[d.ref] ?? []} />
              ))}
            </div>
            <div className="rack__empty">{list.length ? null : <EmptySlot text={col.empty} />}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
