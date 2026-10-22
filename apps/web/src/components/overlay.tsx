'use client';

import { useState, type ReactNode } from 'react';
import { MECH, type Mech } from '@/lib/vocab';
import { Icon, THead } from './icons';
import { useLive } from './live';

/** Dark mono tag naming the facility behind a region. Visible only with the overlay on (CSS). */
export function MechTag({ mech }: { mech: Mech }) {
  const m = MECH[mech];
  return (
    <div className="mechtag" data-owner={m.owner} title={m.note}>
      <span className="mechtag__head">
        {m.owner === 'mastra' ? (
          <THead className="" />
        ) : (
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        )}
        {m.label}
      </span>
      <span className="mechtag__api">{m.api}</span>
    </div>
  );
}

export function MechRegion({ mech, className = '', children, as: As = 'section', ...rest }: { mech: Mech; className?: string; children: ReactNode; as?: 'section' | 'div' | 'aside' } & Record<string, unknown>) {
  return (
    <As className={`region ${className}`} data-mech={mech} {...rest}>
      <MechTag mech={mech} />
      {children}
    </As>
  );
}

const NOT_HARNESS: ReactNode[] = [
  <>
    Approvals that wait hours or days live in app tables (<code>drafts</code>, <code>approvals</code>), not in-stream tool approval: pending approvals and active runs in
    AgentController are not persisted across restarts.
  </>,
  <>Routine CRUD (PO number, invoice address, contacts) is plain app code with a version check. No agent run is needed to save a field.</>,
  <>
    Signals and durable agents are beta: versions are pinned, and every call goes through one adapter. <code>SIGNAL_BACKEND=harness|app</code> falls back to an
    app-owned event loop.
  </>,
  <>
    Exactly-once lives in the tools and the ledger (<code>expected_version</code>, <code>action_key</code>, the outbox idempotency key), not in orchestration: recovery
    re-runs the interrupted tool call.
  </>,
  <>
    Queued messages wait in the agent process’s memory. Switchboard keeps the source event in <code>app.events</code> until a run handles it, and re-sends it after a
    restart.
  </>,
];

export function OverlayInspector() {
  const { overlay, setOverlay } = useLive();
  const [tab, setTab] = useState<'mech' | 'not'>('mech');
  if (!overlay) return null;
  return (
    <aside className="inspector" data-component="OverlayInspector" aria-label="Architecture Overlay inspector" data-testid="overlay-inspector">
      <div className="inspector__bar">
        <span className="inspector__title">Architecture Overlay</span>
        <div className="inspector__tabs" role="tablist">
          <button className="inspector__tab" role="tab" type="button" aria-selected={tab === 'mech'} onClick={() => setTab('mech')}>
            Mechanisms
          </button>
          <button className="inspector__tab" role="tab" type="button" aria-selected={tab === 'not'} onClick={() => setTab('not')}>
            When not to use the harness
          </button>
        </div>
        <button className="inspector__close" type="button" aria-label="Turn off Architecture Overlay" onClick={() => setOverlay(false)}>
          <Icon name="close" />
        </button>
      </div>
      <div className="inspector__body" role="tabpanel">
        {tab === 'mech' ? (
          <ul>
            {(Object.keys(MECH) as Mech[]).map((k) => {
              const m = MECH[k];
              return (
                <li key={k} className="inspector__row">
                  <span className="inspector__owner" data-owner={m.owner}>
                    {m.owner === 'mastra' ? 'Mastra' : 'App code'}
                  </span>
                  <span className="inspector__label">{m.label}</span>
                  <code className="inspector__api">{m.api}</code>
                  <span className="inspector__note">{m.note}</span>
                  <span className="inspector__where">↳ {m.where}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <>
            <p className="notharness__lede">Where this build deliberately does not use the harness:</p>
            <ol className="notharness">
              {NOT_HARNESS.map((t, i) => (
                <li key={i}>
                  <span className="notharness__n">{String(i + 1).padStart(2, '0')}</span>
                  <span>{t}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </aside>
  );
}
