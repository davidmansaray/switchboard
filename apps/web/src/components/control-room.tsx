'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { BoardView, Staff } from '@/lib/types';
import { DeskDrawer } from './desk';
import { Icon } from './icons';
import { MechTag } from './overlay';
import { EmptySlot, Rack } from './rack';
import { SignalStream } from './signals';
import { DraftCard } from './signoff';

/**
 * The Control Room: the rack of T-card desks, the selected desk's drawer, and the side column with
 * the sign-off slot and the live signal stream. Server-rendered from the tables; live via SSE.
 */
export function ControlRoom({ board, me }: { board: BoardView; me: Staff }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(board.detail?.desk.ref ?? null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setSelected(board.detail?.desk.ref ?? null);
  }, [board.detail?.desk.ref]);

  const open = (ref: string) => {
    setSelected(ref);
    setSheetOpen(false);
    router.replace(`/?desk=${ref}`, { scroll: false });
    if (window.matchMedia('(max-width: 900px)').matches) {
      setTimeout(() => drawerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
    }
  };
  const close = () => {
    setSelected(null);
    router.replace('/?desk=none', { scroll: false });
  };

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && sheetOpen && setSheetOpen(false);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [sheetOpen]);

  const canApprove = me.role === 'approver';
  const n = board.waiting.length;
  const detail = selected && board.detail?.desk.ref === selected ? board.detail : null;

  return (
    <main className="room" data-drawer={detail ? 'open' : 'closed'} id="room">
      <section className="rack region" data-component="Rack" data-mech="durable" aria-label="Desk rack">
        <MechTag mech="durable" />
        <Rack desks={board.desks} selected={selected} onOpen={open} />
      </section>

      <aside className="drawer" aria-label="Desk detail" ref={drawerRef}>
        <div className="drawer__scroll">{detail ? <DeskDrawer detail={detail} onClose={close} canApprove={canApprove} fullHref={`/hires/${detail.desk.ref}`} /> : null}</div>
      </aside>

      <aside className="side" aria-label="Sign-off slot and signals">
        <section className="side__sec signoff region" data-mech="app" data-open={sheetOpen ? 'true' : 'false'} aria-label="Sign-off slot" data-testid="signoff">
          <MechTag mech="app" />
          <button className="signoff__handle" type="button" aria-expanded={sheetOpen} onClick={() => setSheetOpen(!sheetOpen)}>
            <span className="signoff__grip" aria-hidden="true" />
            <span className="rack__swatch" data-status="awaiting_approval" aria-hidden="true" />
            <span className="signoff__handle-text">{n === 0 ? 'Sign-off slot is clear' : `${n} in the sign-off slot`}</span>
            <Icon name="chev" className="signoff__handle-chev" />
          </button>
          <div className="sechead" data-component="SignoffSlot">
            <h2>Sign-off slot</h2>
            <span className="sechead__meta signoff__count">
              {n ? (
                <>
                  <b>{n}</b> waiting on {canApprove ? 'you' : 'an approver'}
                </>
              ) : (
                'clear'
              )}
            </span>
          </div>
          <div className="signoff__slot" aria-hidden="true" />
          <div className="signoff__list">
            {n ? board.waiting.map((d) => <DraftCard key={d.ref} d={d} canApprove={canApprove} onOpenDesk={open} />) : <EmptySlot text="Nothing waiting on you" />}
          </div>
        </section>
        <section className="side__sec stream region" data-mech="signal" aria-label="Signals" data-testid="stream">
          <MechTag mech="signal" />
          <div className="sechead">
            <h2>Signals</h2>
            <span className="sechead__meta">{board.signalsToday} today · newest first</span>
          </div>
          <SignalStream signals={board.signals} onOpen={open} />
        </section>
      </aside>
    </main>
  );
}
