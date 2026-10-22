'use client';

import Image from 'next/image';
import { useEffect, useState, type ReactNode } from 'react';
import { fmtDate, fmtDateLong, fmtTime, gbp, gbp0, plural } from '@/lib/format';
import type { DeskDetail, DraftView, FieldChange, LoopView } from '@/lib/types';
import { DESK_STATUS, DRAFT_STATUS, LEDGER_LABEL, LINE_STATUS, LOOP_LABEL, RUN_LABEL } from '@/lib/vocab';
import { Icon, THead } from './icons';
import { MechTag } from './overlay';
import { EmptySlot, Lease } from './rack';
import { DecideButtons, Money, StaleStrip } from './signoff';

const PHOTOS: Record<string, Record<string, { src: string; alt: string }>> = {
  'NH-5520': {
    boom: { src: '/machines/boom-ab19.webp', alt: 'White-and-graphite articulated boom lift, boom stowed, on a pale grey studio backdrop' },
    telehandler: { src: '/machines/telehandler-th17.webp', alt: 'White-and-graphite telehandler, boom lowered, on a pale grey studio backdrop' },
  },
};

const ukDay = (t: string) => t.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /, '$1 ');

export function FieldDiff({ changes, fromLabel, toLabel, caption }: { changes: FieldChange[]; fromLabel: string; toLabel: string; caption: string }) {
  if (!changes.length) return null;
  return (
    <table className="diff" data-component="FieldDiff">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">{fromLabel}</th>
          <th scope="col">{toLabel}</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={c.field}>
            <th scope="row">{c.field}</th>
            <td className="diff__from">
              <del>{ukDay(c.from)}</del>
            </td>
            <td className="diff__to">
              <ins>{ukDay(c.to)}</ins>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Stacked rows for phone widths: field, old struck on one line, new on the next. */
export function FieldDiffStacked({ changes, caption }: { changes: FieldChange[]; caption: string }) {
  if (!changes.length) return null;
  return (
    <div className="sdiff" data-component="FieldDiff">
      <p className="sdiff__cap">{caption}</p>
      <dl>
        {changes.map((c) => (
          <div key={c.field} className="sdiff__row">
            <dt>{c.field}</dt>
            <dd className="sdiff__from">
              <del>{ukDay(c.from)}</del>
            </dd>
            <dd className="sdiff__to">
              <ins>{ukDay(c.to)}</ins>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Drafts for one hire grouped into chains (D-7 → D-8): the live draft on top, superseded ones struck beneath. */
export function chainsOf(drafts: DraftView[]): DraftView[][] {
  const byRef = new Map(drafts.map((d) => [d.ref, d]));
  const roots = drafts.filter((d) => !d.supersedesRef || !byRef.has(d.supersedesRef));
  return roots
    .map((r) => {
      const chain = [r];
      let cur = r;
      while (cur.supersededByRef && byRef.has(cur.supersededByRef)) {
        cur = byRef.get(cur.supersededByRef)!;
        chain.push(cur);
      }
      return chain;
    })
    .sort((a, b) => b[b.length - 1]!.createdAt.localeCompare(a[a.length - 1]!.createdAt));
}

export function DraftChain({ drafts, canApprove, showReply = false, replyOpen = false }: { drafts: DraftView[]; canApprove?: boolean; showReply?: boolean; replyOpen?: boolean }) {
  const chains = chainsOf(drafts);
  if (!chains.length) return <EmptySlot text="No drafts on this desk yet" />;
  return (
    <>
      {chains.map((chain) => (
        <div className="chain" data-component="DraftChain" key={chain[0]!.ref}>
          {chain.length > 1 ? (
            <p className="chain__path">
              {chain.map((d, i) => (
                <span key={d.ref}>
                  {i ? (
                    <span className="chain__arrow" aria-label="superseded by">
                      {' '}
                      →{' '}
                    </span>
                  ) : null}
                  {d.ref}
                </span>
              ))}
            </p>
          ) : null}
          <ol className="chain__stack">
            {chain
              .slice()
              .reverse()
              .map((d) => (
                <li key={d.ref} className="dlink" data-draft-status={d.status} data-testid={`chain-${d.ref}`}>
                  <div className="dlink__tab">
                    <span className="dlink__id">{d.ref}</span>
                    <span className="dlink__st">{DRAFT_STATUS[d.status]}</span>
                    <span className="dlink__based">based on v{d.basedOnVersion}</span>
                  </div>
                  <div className="dlink__body">
                    <p className="dlink__title">{d.title}</p>
                    {d.summary ? <p className="dlink__sub">{d.summary}</p> : null}
                    {d.totalPence !== null ? (
                      <span className="dlink__total">
                        <Money pence={d.totalPence} />
                      </span>
                    ) : null}
                    {d.status === 'stale' ? (
                      <>
                        <StaleStrip d={d} />
                        <FieldDiff changes={d.staleChanges} fromLabel={`Draft v${d.basedOnVersion}`} toLabel={`Hire v${d.hireVersion}`} caption={`Changed since v${d.basedOnVersion}`} />
                      </>
                    ) : null}
                    {d.supersedesRef && d.changes.length ? (
                      <FieldDiff
                        changes={d.changes}
                        fromLabel={`${d.supersedesRef}${chain.find((x) => x.ref === d.supersedesRef) ? ` · v${chain.find((x) => x.ref === d.supersedesRef)!.basedOnVersion}` : ''}`}
                        toLabel={`${d.ref} · v${d.basedOnVersion}`}
                        caption={`Diff ${d.supersedesRef} → ${d.ref}`}
                      />
                    ) : null}
                    {d.status === 'superseded' && d.supersededByRef ? (
                      <span className="dlink__sub">
                        Superseded by <span className="mono">{d.supersededByRef}</span>
                      </span>
                    ) : null}
                    {d.decisions.length ? (
                      <p className="dlink__decisions">
                        {d.decisions.map((x) => (
                          <span key={x.at}>
                            {x.decision === 'approved' ? 'Approved' : 'Rejected'} by {x.by}
                            {x.channel === 'mobile' ? ' (mobile)' : ''} · {fmtTime(x.at)} · hire v{x.hireVersion}
                          </span>
                        ))}
                      </p>
                    ) : null}
                    {d.evidence.length ? (
                      <details className="evidence">
                        <summary>
                          <THead className="evidence__chev icon--fill" />
                          Evidence · {d.evidence.length}
                        </summary>
                        <ul>
                          {d.evidence.map((e) => (
                            <li key={e.id}>
                              <Icon name={e.sourceType === 'transcript' ? 'call' : e.sourceType === 'note' ? 'note' : e.sourceType === 'document' ? 'doc' : 'email'} />
                              <span>{e.label}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {showReply && d.reply ? (
                      <details className="evidence" open={replyOpen && (d.status === 'pending' || d.status === 'stale') ? true : undefined}>
                        <summary>
                          <THead className="evidence__chev icon--fill" />
                          Reply to the customer
                        </summary>
                        <pre className="replybody">{d.reply.body}</pre>
                      </details>
                    ) : null}
                    {canApprove !== undefined && (d.status === 'pending' || d.status === 'stale') ? (
                      <div className="dcard__actions">
                        <DecideButtons d={d} canApprove={canApprove} />
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
          </ol>
        </div>
      ))}
    </>
  );
}

export function OpenLoops({ loops }: { loops: LoopView[] }) {
  if (!loops.length) return <EmptySlot text="No open loops" />;
  return (
    <ul className="loops" data-component="OpenLoops">
      {loops
        .slice()
        .reverse()
        .map((l) => (
          <li key={l.key} className="loop" data-loop={l.status}>
            <span className="loop__st chip">{LOOP_LABEL[l.status]}</span>
            <p className="loop__text">{l.text}</p>
            <p className="loop__meta">{l.key}</p>
          </li>
        ))}
    </ul>
  );
}

export function HireLines({ detail }: { detail: DeskDetail }) {
  const f = detail.facts;
  const lines = detail.desk.lines;
  const fact = (k: string, v: ReactNode, warn = false) => (
    <div className={`facts__pair${warn ? ' facts__warn' : ''}`} key={k}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
  return (
    <div data-component="HireLines">
      <ul className="lines">
        {lines.map((l) => (
          <li key={l.lineNo} className="line" data-line-status={l.status}>
            <div className="line__top">
              <span className="mono line__fleet">{l.fleetNo}</span>
              <span className="line__desc">{l.description}</span>
              <span className="line__rate">{gbp0(l.weeklyRatePence)}/wk</span>
            </div>
            <p className="line__spec">
              {l.spec}
              {l.ipaf ? ` · IPAF ${l.ipaf} operator` : ''}
              {l.lolerDue ? ` · LOLER exam due ${fmtDateLong(l.lolerDue)}` : ''} · <span className="line__st">{LINE_STATUS[l.status]}</span>
            </p>
          </li>
        ))}
      </ul>
      <dl className="facts">
        {fact('Delivery', `${fmtDate(f.deliveryDate)} · ${f.deliverySlot}`)}
        {fact('Off-hire', `${fmtDate(f.offHireDate)} · ${f.weeks} wks`)}
        {fact(
          'Hire charges',
          <>
            <span className="mono">{gbp(f.netPence)}</span>
            {f.discountPct ? <span className="facts__sub"> after {f.discountPct}% off</span> : null}
          </>,
        )}
        {fact('Transport', <span className="mono">{gbp(f.transportPence)}</span>)}
        {fact(
          'Damage waiver',
          f.damageWaiver ? (
            <>
              {f.waiverRatePct}% · <span className="mono">{gbp(f.waiverPence)}</span> · {f.waiverSigned ? 'signed' : 'not signed'}
            </>
          ) : (
            'not taken'
          ),
          f.damageWaiver && !f.waiverSigned,
        )}
        {fact('PO', f.poNumber ? <span className="mono">{f.poNumber}</span> : 'not received')}
        {f.invoiceAddress ? fact('Invoice to', f.invoiceAddress) : null}
        {fact('Hire price', <span className="mono">{gbp(f.subtotalPence)}</span>)}
      </dl>
    </div>
  );
}

export function Ledger({ detail }: { detail: DeskDetail }) {
  const n = detail.emails.length;
  return (
    <div data-component="Ledger">
      {detail.ledger.length ? (
        <ol className="ledger">
          {detail.ledger.map((e) => (
            <li key={e.id} className="ledger__row" data-ledger={e.status}>
              <span className="ledger__tool">{e.tool}</span>
              <span className="chip" data-ledger={e.status}>
                {LEDGER_LABEL[e.status] ?? e.status}
              </span>
              <span className="ledger__key">
                {e.actionKey}
                {e.run ? ` · ${e.run}` : ''} · {fmtTime(e.at)}
              </span>
              {e.note ? <span className="ledger__note">{e.note}</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <EmptySlot text="No actions recorded yet" />
      )}
      <div className="emails" data-component="EmailsSent" data-testid="emails-sent">
        <p className="emails__count">
          <Icon name="sent" />
          {n === 1 ? '1 email sent' : `${n} emails sent`}
          {detail.creditNotes.length ? ` · ${plural(detail.creditNotes.length, 'credit note')}` : ''}
        </p>
        {detail.emails.map((m) => (
          <p key={m.id} className="emails__item">
            {m.subject} · to {m.to}
            {m.thread ? ` (${m.thread})` : ''}
            <br />
            <span className="mono">idempotency_key {m.idempotencyKey}</span>
          </p>
        ))}
        {detail.creditNotes.map((c) => (
          <p key={c.ref} className="emails__item">
            <span className="mono">{c.ref}</span> · <span className="mono">{gbp(c.amountPence)}</span> · {c.reason}
          </p>
        ))}
      </div>
    </div>
  );
}

const TRACE_KEY = 'sb-trace-open';

export function RunTrace({ detail, alwaysOpen = false }: { detail: DeskDetail; alwaysOpen?: boolean }) {
  const [open, setOpen] = useState(alwaysOpen);
  useEffect(() => {
    if (alwaysOpen) return;
    try {
      setOpen(localStorage.getItem(TRACE_KEY) === '1');
    } catch {
      /* storage unavailable */
    }
  }, [alwaysOpen]);
  const toggle = (o: boolean) => {
    setOpen(o);
    try {
      localStorage.setItem(TRACE_KEY, o ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };
  // Chronological, so a crashed fence 1 reads before the recovered fence 2.
  const runs = detail.runs.slice(-5);
  const body = (
    <div data-component="RunTrace">
      {detail.steps.length ? (
        <ol className="trace">
          {detail.steps.map((s) => (
            <li key={s.id} className="trace__step" data-status={s.status ?? undefined}>
              <THead className="trace__mark icon--fill" />
              <time className="trace__time">{fmtTime(s.at)}</time>
              <span className="trace__text">
                {s.text}
                {s.status === 'running' && detail.desk.status === 'recovering' ? ' · interrupted' : ''}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <EmptySlot text="No tool steps yet" />
      )}
      {runs.length ? (
        <div className="runs">
          {runs.map((r) => (
            <span key={`${r.runId}-${r.fence}`} className="chip chip--mono" data-run={r.state} title={`${r.runId} · ${r.backend} backend · started ${fmtTime(r.startedAt)}`}>
              {r.short} · fence {r.fence} · {RUN_LABEL[r.state]}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
  const meta = (
    <span className="desk__h-meta">
      {detail.desk.activeRun ? <span className="mono">{detail.desk.activeRun}</span> : 'no active run'} · {plural(detail.runs.length, 'run')}
    </span>
  );
  if (alwaysOpen)
    return (
      <>
        <div className="desk__h">
          <h3>Trace</h3>
          {meta}
        </div>
        {body}
      </>
    );
  return (
    <details className="desk__trace" open={open} onToggle={(e) => toggle((e.target as HTMLDetailsElement).open)}>
      <summary className="desk__h desk__summary">
        <h3>Trace</h3>
        {meta}
      </summary>
      {body}
    </details>
  );
}

export function ScheduleLine({ detail }: { detail: DeskDetail }) {
  const sc = detail.schedule;
  return (
    <p className="sched" data-component="ScheduleLine">
      <Icon name="clock" />
      <span>
        <b>{sc.label}</b>, daily on this thread. Next: {sc.next}
        <br />
        <span className="sched__api">
          ifActive: {sc.ifActive} · ifIdle: {sc.ifIdle}
          {sc.id ? ` · ${sc.id}` : ''}
        </span>
      </span>
    </p>
  );
}

export function NowLine({ detail, approverName = 'Gary' }: { detail: DeskDetail; approverName?: string }) {
  const d = detail.desk;
  if (d.status === 'recovering')
    return (
      <p className="desk__now">
        <b>Run lost: recovering.</b> <Lease until={d.leaseEndsAt} /> {d.step ? <span className="mono">{d.step}</span> : null}
      </p>
    );
  if (d.status === 'running' || d.status === 'queued')
    return (
      <p className="desk__now">
        <b>Working:</b> <span className="mono">{d.step ?? 'starting run'}</span>
        {d.queued.length ? ` · ${d.queued.length} queued in the pocket` : ''}
      </p>
    );
  if (d.status === 'awaiting_approval')
    return (
      <p className="desk__now">
        <b>Waiting on {approverName}:</b> <span className="mono">{d.awaiting.join(', ')}</span> in the sign-off slot
      </p>
    );
  return <p className="desk__now">Idle. The next signal wakes this desk.</p>;
}

export function DeskPhotos({ detail }: { detail: DeskDetail }) {
  const photos = PHOTOS[detail.desk.ref];
  if (!photos) return null;
  const figs = detail.desk.lines.filter((l) => photos[l.kind]);
  if (!figs.length) return null;
  return (
    <div className="photos" data-component="DeskPhotos">
      {figs.map((l) => (
        <figure key={l.lineNo} className="photos__fig" data-line-status={l.status}>
          <Image src={photos[l.kind]!.src} alt={photos[l.kind]!.alt} width={360} height={270} unoptimized />
          <figcaption>
            <span className="photos__name">
              <span className="mono">{l.fleetNo}</span> {l.short}
            </span>
            {l.status === 'cancelled' ? <b>Cancelled</b> : null}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/** The desk detail: drawer on the Control Room, sections reused by the full-page desk. */
export function DeskDrawer({ detail, onClose, canApprove, fullHref }: { detail: DeskDetail; onClose?: () => void; canApprove: boolean; fullHref?: string }) {
  const d = detail.desk;
  return (
    <div className="desk" data-component="DeskDrawer" data-status={d.status} data-testid="desk-drawer">
      <header className="desk__head">
        <div className="desk__tab">
          <span className="desk__no">{d.ref}</span>
          <span className="desk__tabstate">{DESK_STATUS[d.status].label}</span>
          <span className="desk__ver" title="Hire version">
            v{d.version}
          </span>
          {fullHref ? (
            <a className="btn btn--quiet btn--icon desk__close" href={fullHref} aria-label="Open the full desk" title="Open the full desk">
              <Icon name="hires" />
            </a>
          ) : null}
          {onClose ? (
            <button className="btn btn--quiet btn--icon desk__close" type="button" onClick={onClose} aria-label="Close desk">
              <Icon name="close" />
            </button>
          ) : null}
        </div>
      </header>
      <div className="desk__id">
        <p className="desk__cust">{d.customer}</p>
        <p className="desk__site">
          {d.site}
          {d.siteArea ? `, ${d.siteArea}` : ''} · Desk thread · <span className="mono">{d.ref}</span>
        </p>
        <NowLine detail={detail} />
        <DeskPhotos detail={detail} />
      </div>
      <section className="desk__sec region" data-mech="app">
        <MechTag mech="app" />
        <div className="desk__h">
          <h3>Draft chain</h3>
          <span className="desk__h-meta">{plural(detail.drafts.length, 'draft')}</span>
        </div>
        <DraftChain drafts={detail.drafts} canApprove={canApprove} />
      </section>
      <section className="desk__sec region" data-mech="memory">
        <MechTag mech="memory" />
        <div className="desk__h">
          <h3>Working memory</h3>
          <span className="desk__h-meta">open loops</span>
        </div>
        <OpenLoops loops={detail.loops} />
      </section>
      <section className="desk__sec region" data-mech="app">
        <MechTag mech="app" />
        <div className="desk__h">
          <h3>Hire</h3>
          <span className="desk__h-meta">
            <span className="mono">v{d.version}</span> · every write bumps the version
          </span>
        </div>
        <HireLines detail={detail} />
      </section>
      <section className="desk__sec region" data-mech="tool">
        <MechTag mech="tool" />
        <div className="desk__h">
          <h3>Action ledger</h3>
          <span className="desk__h-meta">{plural(detail.ledger.length, 'entry', 'entries')}</span>
        </div>
        <Ledger detail={detail} />
      </section>
      <section className="desk__sec region" data-mech="durable">
        <MechTag mech="durable" />
        <RunTrace detail={detail} />
      </section>
      <section className="desk__sec region" data-mech="schedule">
        <MechTag mech="schedule" />
        <div className="desk__h">
          <h3>Schedule</h3>
        </div>
        <ScheduleLine detail={detail} />
      </section>
    </div>
  );
}
