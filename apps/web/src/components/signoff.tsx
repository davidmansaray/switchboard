'use client';

import Link from 'next/link';
import { useState } from 'react';
import { gbp } from '@/lib/format';
import type { DraftView } from '@/lib/types';
import { DRAFT_STATUS } from '@/lib/vocab';
import { Icon } from './icons';
import { useLive } from './live';

export function Money({ pence }: { pence: number | null }) {
  if (pence === null) return null;
  return (
    <>
      <span className="mono">{gbp(Math.abs(pence))}</span>
      {pence < 0 ? ' credit' : ' before VAT'}
    </>
  );
}

/** "Written against v4 · hire is v5" and the reason. Versions always from data. */
export function StaleStrip({ d }: { d: Pick<DraftView, 'basedOnVersion' | 'hireVersion' | 'staleReason' | 'staleBy'> }) {
  return (
    <p className="stalestrip" data-component="StaleStrip">
      <span>
        Written against <b className="mono">v{d.basedOnVersion}</b> · hire is <b className="mono">v{d.hireVersion}</b>
      </span>
      {d.staleBy || d.staleReason ? <span className="stalestrip__why">{d.staleBy ?? d.staleReason}</span> : null}
    </p>
  );
}

/** Approve (the only filled ink button) / Approve anyway on a stale draft, and Reject. */
export function DecideButtons({ d, canApprove, channel = 'web', compact = false, onDone }: { d: DraftView; canApprove: boolean; channel?: 'web' | 'mobile'; compact?: boolean; onDone?: (decision: string) => void }) {
  const { post, notify } = useLive();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(decision);
    const r = await post('/api/approvals', { draftRef: d.ref, decision, channel });
    setBusy(null);
    if (r.ok) {
      notify(
        decision === 'rejected'
          ? `${d.ref} rejected. Sent to the ${d.hireRef} desk as a signal.`
          : `${d.ref} approved${d.status === 'stale' ? ' (stale: the desk will regenerate it)' : ''}. Sent to the ${d.hireRef} desk as a signal.`,
      );
      onDone?.(decision);
    }
  };
  if (!canApprove)
    return (
      <span className="dcard__note" title="Only approvers can decide drafts">
        Approver sign-off needed
      </span>
    );
  return (
    <>
      <button className="btn btn--primary" type="button" disabled={Boolean(busy)} onClick={() => decide('approved')} data-testid={`approve-${d.ref}`}>
        <Icon name="approve" />
        {busy === 'approved' ? 'Sending…' : d.status === 'stale' ? 'Approve anyway' : 'Approve'}
      </button>
      {compact ? null : (
        <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => decide('rejected')} data-testid={`reject-${d.ref}`}>
          Reject
        </button>
      )}
    </>
  );
}

/** One waiting draft in the sign-off slot; a stale one gets the folded corner. */
export function DraftCard({ d, canApprove, onOpenDesk, selected, href }: { d: DraftView; canApprove: boolean; onOpenDesk?: (ref: string) => void; selected?: boolean; href?: string }) {
  return (
    <article className="dcard" data-component="DraftCard" data-draft-status={d.status} data-selected={selected ? 'true' : undefined} data-testid={`draft-${d.ref}`}>
      <div className="dcard__head">
        <span className="dcard__id">{d.ref}</span>
        <span className="dcard__hire">
          {d.hireRef} · v{d.basedOnVersion}
        </span>
        <span className="dcard__st">{DRAFT_STATUS[d.status]}</span>
      </div>
      {d.status === 'stale' ? <span className="dcard__fold" aria-hidden="true" /> : null}
      <div className="dcard__body">
        <p className="dcard__title">{href ? <Link href={href}>{d.title}</Link> : d.title}</p>
        <p className="dcard__to">
          {d.to ? <>To {d.to}</> : d.customer}
          {d.totalPence !== null ? (
            <>
              {' · '}
              <Money pence={d.totalPence} />
            </>
          ) : null}
        </p>
        {d.status === 'stale' ? <StaleStrip d={d} /> : null}
        <div className="dcard__actions">
          {d.status === 'pending' || d.status === 'stale' ? <DecideButtons d={d} canApprove={canApprove} compact /> : null}
          {onOpenDesk ? (
            <button className="btn" type="button" onClick={() => onOpenDesk(d.hireRef)}>
              Open desk
            </button>
          ) : (
            <Link className="btn" href={`/hires/${d.hireRef}`}>
              Open desk
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}
