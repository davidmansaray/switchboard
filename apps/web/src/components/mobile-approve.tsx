'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '@/lib/format';
import type { DraftView, Staff } from '@/lib/types';
import { DRAFT_STATUS, intentLabel } from '@/lib/vocab';
import { FieldDiffStacked } from './desk';
import { Icon, THead } from './icons';
import { useLive } from './live';
import { Money, StaleStrip } from './signoff';

/**
 * The mobile approval view (/m/approve/[ref]): the draft's T-card head at full width, the stale strip,
 * who it goes to and what it costs, the diff as stacked rows, the evidence, and the thumb zone.
 * On approve the card drops into the Filed slot and the page says what happened next.
 */
export function MobileApprove({ draft: d, newer, me, framed }: { draft: DraftView; newer: DraftView | null; me: Staff; framed: boolean }) {
  const { post } = useLive();
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState<{ decision: string; at: string } | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const decided = d.decisions.at(-1);
  const open = d.status === 'pending' || d.status === 'stale';
  const canApprove = me.role === 'approver';

  useEffect(() => {
    if (!sent || !cardRef.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    cardRef.current.animate(
      [
        { transform: 'translateY(0)', offset: 0 },
        { transform: 'translateY(-6px)', offset: 0.2 },
        { transform: 'translateY(14px)', offset: 0.85 },
        { transform: 'translateY(12px)', offset: 1 },
      ],
      { duration: 630, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
    );
  }, [sent]);

  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(decision);
    const r = await post('/api/approvals', { draftRef: d.ref, decision, channel: 'mobile' });
    setBusy(null);
    if (r.ok) setSent({ decision, at: new Date().toISOString() });
  };

  const changes = d.status === 'stale' ? d.staleChanges : d.changes;
  const caption = d.status === 'stale' ? `Changed since v${d.basedOnVersion}` : d.supersedesRef ? `Changed from ${d.supersedesRef}` : '';
  const showFiled = Boolean(sent) || !open;

  return (
    <main className="mobile" data-framed={framed ? 'true' : undefined} data-testid="mobile-approve">
      <header className="mobile__bar">
        <span className="mobile__mark" aria-hidden="true">
          <Icon name="mark" />
        </span>
        <span className="mobile__word">Switchboard</span>
        <span className="mobile__who">{me.name}</span>
      </header>
      <article ref={cardRef} className="mcard" data-draft-status={d.status} data-component="MobileDraft">
        <div className="mcard__head">
          <span className="dcard__id">{d.ref}</span>
          <span className="dcard__hire">
            {d.hireRef} · v{d.hireVersion}
          </span>
          <span className="dcard__st">{DRAFT_STATUS[d.status]}</span>
        </div>
        {d.status === 'stale' ? <span className="dcard__fold" aria-hidden="true" /> : null}
        <div className="mcard__body">
          {d.status === 'stale' ? <StaleStrip d={d} /> : null}
          <p className="mcard__kind">{intentLabel(d.intent)}</p>
          <p className="mcard__to">{d.to ? `To ${d.to}` : d.customer}</p>
          <h1 className="mcard__title">{d.title}</h1>
          {d.totalPence !== null ? (
            <p className="mcard__total">
              <Money pence={d.totalPence} />
            </p>
          ) : null}
          {d.summary ? <p className="mcard__summary">{d.summary}</p> : null}
          {caption ? <FieldDiffStacked changes={changes} caption={caption} /> : null}
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
          {d.reply ? (
            <details className="evidence" open={open ? true : undefined}>
              <summary>
                <THead className="evidence__chev icon--fill" />
                The reply {d.to?.split(' ')[0] ?? 'the customer'} would get
              </summary>
              <pre className="replybody">{d.reply.body}</pre>
            </details>
          ) : null}
        </div>
      </article>

      {showFiled ? (
        <section className="mfiled" aria-live="polite" data-testid="mobile-filed">
          <div className="mfiled__slot" aria-hidden="true" />
          <p className="mfiled__line">
            <Icon name="sent" />
            {sent ? (
              <span>
                {sent.decision === 'approved' ? 'Approved' : 'Rejected'}. Sent to the <b className="mono">{d.hireRef}</b> desk as a signal · {fmtTime(sent.at)}
              </span>
            ) : decided ? (
              <span>
                {decided.decision === 'approved' ? 'Approved' : 'Rejected'} by {decided.by}
                {decided.channel === 'mobile' ? ' on mobile' : ''} · {fmtTime(decided.at)} · now {DRAFT_STATUS[d.status].toLowerCase()}
              </span>
            ) : (
              <span>{DRAFT_STATUS[d.status]}</span>
            )}
          </p>
          {sent && d.status === 'stale' && !newer ? <p className="mfiled__wait">The desk is regenerating it against v{d.hireVersion}…</p> : null}
          {newer ? (
            <Link className="btn btn--primary mfiled__next" href={`/m/approve/${newer.ref}${framed ? '?frame=1' : ''}`} data-testid="mobile-newer">
              New draft {newer.ref} waiting
              <Icon name="next" />
            </Link>
          ) : null}
        </section>
      ) : null}

      {open && !sent ? (
        <footer className="thumb">
          {canApprove ? (
            <>
              <button className="btn btn--primary thumb__approve" type="button" disabled={Boolean(busy)} onClick={() => decide('approved')} data-testid="mobile-approve-btn">
                <Icon name="approve" />
                {busy === 'approved' ? 'Sending…' : d.status === 'stale' ? 'Approve anyway' : 'Approve'}
              </button>
              <button className="btn thumb__reject" type="button" disabled={Boolean(busy)} onClick={() => decide('rejected')}>
                Reject
              </button>
            </>
          ) : (
            <p className="thumb__note">Signed in as {me.name}: only an approver can decide this draft.</p>
          )}
          <Link className="thumb__desk" href={`/hires/${d.hireRef}`} target={framed ? '_top' : undefined}>
            Open desk
          </Link>
        </footer>
      ) : (
        <footer className="thumb thumb--done">
          <Link className="thumb__desk" href={`/hires/${d.hireRef}`} target={framed ? '_top' : undefined}>
            Open desk
          </Link>
        </footer>
      )}
    </main>
  );
}
