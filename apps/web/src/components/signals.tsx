'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { fmtTime } from '@/lib/format';
import type { SignalView } from '@/lib/types';
import { Icon, SOURCE } from './icons';

const DELIVERY_WORD: Record<string, string> = {
  delivered: 'delivered',
  queued: 'queued',
  persisted: 'persisted',
  discarded: 'discarded',
  blocked: 'blocked',
  failed: 'failed',
};

/** One signal: time · source · actor · hire, the sentence, and the Mastra call with its delivery outcome. */
export function SignalRow({ s, fresh, onOpen, showHire = true }: { s: SignalView; fresh?: boolean; onOpen?: (ref: string) => void; showHire?: boolean }) {
  const src = SOURCE[s.source] ?? { label: s.source, icon: 'signals' as const };
  const delivery = s.delivery === 'queued' && s.pickedUp ? 'delivered' : s.delivery;
  return (
    <li
      className={`sig${fresh ? ' sig--enter' : ''}`}
      data-component="SignalRow"
      data-delivery={delivery}
      data-type={s.type}
      data-source={s.source}
      data-merged={s.mergedInto ? 'true' : undefined}
      title={`${s.short} · ${s.type}${s.runId ? ` · run ${s.runId}` : ''}`}
      data-testid="signal-row"
    >
      <time className="sig__time">{fmtTime(s.at)}</time>
      <div className="sig__main">
        <div className="sig__src">
          <Icon name={src.icon} />
          <span className="sig__srcname">{src.label}</span>
          {s.thread ? (
            <span className="tag" title="Email thread">
              {s.thread}
            </span>
          ) : null}
          <span className="sig__actor">{s.actor}</span>
          {showHire ? (
            onOpen ? (
              <button className="sig__hire" type="button" onClick={() => onOpen(s.hireRef)}>
                {s.hireRef}
              </button>
            ) : (
              <Link className="sig__hire" href={`/hires/${s.hireRef}`}>
                {s.hireRef}
              </Link>
            )
          ) : null}
        </div>
        <p className="sig__summary">{s.summary}</p>
        <p className="sig__mastra">
          {s.type} ·{' '}
          {s.delivery === 'queued' && s.pickedUp ? (
            <>
              queued → <span className="sig__deliv">delivered</span>
            </>
          ) : (
            <span className="sig__deliv">{DELIVERY_WORD[s.delivery] ?? s.delivery}</span>
          )}
          {s.delivery === 'queued' && s.waitsFor && !s.pickedUp ? ` · waits for ${s.waitsFor}` : ''}
          {s.mergedInto ? <span className="sig__merged"> · merged into {s.mergedInto}: one intent, one action key</span> : null}
        </p>
      </div>
    </li>
  );
}

/** Newest first; a row that arrives while the page is open slides into its slot. */
export function SignalStream({ signals, onOpen, showHire = true, empty = 'No signals yet today' }: { signals: SignalView[]; onOpen?: (ref: string) => void; showHire?: boolean; empty?: string }) {
  const seen = useRef<Set<string> | null>(null);
  const first = seen.current === null;
  const fresh = new Set(first ? [] : signals.filter((s) => !seen.current!.has(s.id)).map((s) => s.id));
  useEffect(() => {
    seen.current = new Set(signals.map((s) => s.id));
  }, [signals]);
  if (!signals.length)
    return (
      <div className="emptyslot">
        <span className="emptyslot__slot" aria-hidden="true" />
        <span>{empty}</span>
      </div>
    );
  return (
    <ol className="stream__list" aria-live="polite" aria-relevant="additions">
      {signals.map((s) => (
        <SignalRow key={s.id} s={s} fresh={fresh.has(s.id)} onOpen={onOpen} showHire={showHire} />
      ))}
    </ol>
  );
}
