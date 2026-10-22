'use client';

import Link from 'next/link';
import { fmtTime } from '@/lib/format';
import type { DraftView } from '@/lib/types';
import { DRAFT_STATUS, intentLabel } from '@/lib/vocab';
import { DraftChain } from './desk';
import { Icon } from './icons';
import { MechTag } from './overlay';
import { EmptySlot } from './rack';
import { DraftCard, Money } from './signoff';

/**
 * A full-height sign-off slot: waiting drafts (stale first, grouped by hire) on the left, the
 * selected draft's chain and diff in the middle, and what was filed today on the right.
 */
export function ApprovalQueue({ waiting, filed, all, selectedRef, canApprove }: { waiting: DraftView[]; filed: DraftView[]; all: DraftView[]; selectedRef: string | null; canApprove: boolean }) {
  const sel = all.find((d) => d.ref === selectedRef) ?? null;
  const chain = sel ? all.filter((d) => d.hireRef === sel.hireRef && d.intent === sel.intent) : [];
  return (
    <main className="page page--approvals" data-testid="approvals">
      <section className="aq__slot region" data-mech="app" aria-label="Sign-off slot">
        <MechTag mech="app" />
        <div className="rack__col aq__col" data-status="awaiting_approval">
          <div className="rack__colhead">
            <h2 className="rack__colname">Sign-off slot</h2>
            <span className="rack__count">{waiting.length}</span>
          </div>
          <div className="rack__colstem" aria-hidden="true" />
        </div>
        <div className="aq__list">
          {waiting.length ? (
            waiting.map((d) => <DraftCard key={d.ref} d={d} canApprove={canApprove} selected={d.ref === selectedRef} href={`/approvals?d=${d.ref}`} />)
          ) : (
            <EmptySlot text="Sign-off slot is clear" />
          )}
        </div>
      </section>

      <section className="aq__detail region" data-mech="tool" aria-label="Selected draft">
        <MechTag mech="tool" />
        {sel ? (
          <>
            <div className="desk__h aq__h">
              <h3>
                {intentLabel(sel.intent)}
                <span className="aq__sep"> · </span> <span className="mono">{sel.hireRef}</span>
              </h3>
              <span className="aq__links">
                <Link className="btn" href={`/hires/${sel.hireRef}`}>
                  <Icon name="hires" />
                  Open desk
                </Link>
                <Link className="btn" href={`/m/approve/${sel.ref}`}>
                  <Icon name="phone" />
                  Phone view
                </Link>
              </span>
            </div>
            <DraftChain drafts={chain} canApprove={canApprove} showReply replyOpen />
          </>
        ) : (
          <EmptySlot text="Pick a draft to see its chain and diff" />
        )}
      </section>

      <section className="aq__filed region" data-mech="app" aria-label="Filed today">
        <MechTag mech="app" />
        <div className="rack__col aq__col" data-status="idle">
          <div className="rack__colhead aq__filedhead">
            <h2 className="rack__colname">Filed today</h2>
            <span className="rack__count">{filed.length}</span>
          </div>
          <div className="rack__colstem" aria-hidden="true" />
        </div>
        <ol className="aq__filedlist">
          {filed.length ? (
            filed.map((d) => (
              <li key={d.ref} className="dcard dcard--filed" data-draft-status={d.status}>
                <Link className="dcard__head" href={`/approvals?d=${d.ref}`}>
                  <span className="dcard__id">{d.ref}</span>
                  <span className="dcard__hire">{d.hireRef}</span>
                  <span className="dcard__st">{DRAFT_STATUS[d.status]}</span>
                </Link>
                <div className="dcard__body">
                  <p className="dcard__title">{d.title}</p>
                  <p className="dcard__to">
                    {d.decisions.at(-1) ? `${d.decisions.at(-1)!.decision === 'approved' ? 'Approved' : 'Rejected'} by ${d.decisions.at(-1)!.by} · ${fmtTime(d.decisions.at(-1)!.at)}` : ''}
                    {d.totalPence !== null ? (
                      <>
                        {' · '}
                        <Money pence={d.totalPence} />
                      </>
                    ) : null}
                  </p>
                </div>
              </li>
            ))
          ) : (
            <EmptySlot text="Nothing filed yet today" />
          )}
        </ol>
      </section>
    </main>
  );
}
