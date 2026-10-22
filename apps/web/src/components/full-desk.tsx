'use client';

import type { DeskDetail } from '@/lib/types';
import { DESK_STATUS } from '@/lib/vocab';
import { DeskPhotos, DraftChain, HireLines, Ledger, NowLine, OpenLoops, RunTrace, ScheduleLine } from './desk';
import { MechTag } from './overlay';
import { SignalStream } from './signals';

/**
 * Full-page desk (/hires/[ref]): left, the desk's trace and its own signals; centre, the draft
 * chain; right, working memory, the hire and the action ledger. Same components as the drawer.
 */
export function FullDesk({ detail, canApprove }: { detail: DeskDetail; canApprove: boolean }) {
  const d = detail.desk;
  const waiting = detail.drafts.filter((x) => x.status === 'pending' || x.status === 'stale').length;
  return (
    <main className="page page--desk" data-status={d.status} data-testid="full-desk">
      <header className="fdesk__head region" data-mech="durable">
        <MechTag mech="durable" />
        <div className="fdesk__tab">
          <span className="desk__no">{d.ref}</span>
          <span className="desk__tabstate">{DESK_STATUS[d.status].label}</span>
          <span className="fdesk__cust">
            {d.customer} · {d.site}
            {d.siteArea ? `, ${d.siteArea}` : ''}
          </span>
          <span className="desk__ver" title="Hire version">
            v{d.version}
          </span>
        </div>
        <div className="fdesk__now">
          <NowLine detail={detail} />
        </div>
      </header>
      <div className="fdesk__cols">
        <div className="fdesk__col">
          <section className="fdesk__sec region" data-mech="durable">
            <MechTag mech="durable" />
            <RunTrace detail={detail} alwaysOpen />
          </section>
          <section className="fdesk__sec region" data-mech="signal">
            <MechTag mech="signal" />
            <div className="desk__h">
              <h3>Signals on this desk</h3>
              <span className="desk__h-meta">newest first</span>
            </div>
            <SignalStream signals={detail.signals} showHire={false} empty="No signals on this desk yet" />
          </section>
        </div>
        <div className="fdesk__col fdesk__col--main">
          <section className="fdesk__sec region" data-mech="app">
            <MechTag mech="app" />
            <div className="rack__col fdesk__colhead" data-status={waiting ? 'awaiting_approval' : 'idle'}>
              <div className="rack__colhead">
                <h3 className="rack__colname">Draft chain</h3>
                <span className="rack__count" aria-label={`${waiting} waiting for sign-off`}>
                  {waiting ? `${waiting} waiting` : detail.drafts.length}
                </span>
              </div>
              <div className="rack__colstem" aria-hidden="true" />
            </div>
            <DraftChain drafts={detail.drafts} canApprove={canApprove} showReply />
          </section>
        </div>
        <div className="fdesk__col">
          <section className="fdesk__sec region" data-mech="memory">
            <MechTag mech="memory" />
            <div className="desk__h">
              <h3>Working memory</h3>
              <span className="desk__h-meta">open loops</span>
            </div>
            <OpenLoops loops={detail.loops} />
          </section>
          <section className="fdesk__sec region" data-mech="app">
            <MechTag mech="app" />
            <div className="desk__h">
              <h3>Hire</h3>
              <span className="desk__h-meta">
                <span className="mono">v{d.version}</span> · every write bumps the version
              </span>
            </div>
            <DeskPhotos detail={detail} />
            <HireLines detail={detail} />
          </section>
          <section className="fdesk__sec region" data-mech="tool">
            <MechTag mech="tool" />
            <div className="desk__h">
              <h3>Action ledger</h3>
            </div>
            <Ledger detail={detail} />
          </section>
          <section className="fdesk__sec region" data-mech="schedule">
            <MechTag mech="schedule" />
            <div className="desk__h">
              <h3>Schedule</h3>
            </div>
            <ScheduleLine detail={detail} />
          </section>
        </div>
      </div>
    </main>
  );
}
