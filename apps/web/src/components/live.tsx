'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Live updates: one EventSource on /api/stream (Postgres NOTIFY behind it). Any change schedules a
 * router.refresh() so every server-rendered view re-reads the tables; client state (open drawer,
 * form drafts, FLIP positions) survives the refresh. Refreshes are coalesced (150 ms, at most one
 * in flight) so a burst of tool steps becomes a few renders, not dozens.
 */
type Notice = { id: number; text: string; tone: 'info' | 'error' };
type LiveCtx = {
  connected: boolean;
  notify: (text: string, tone?: Notice['tone']) => void;
  post: (url: string, body: unknown) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
  refresh: () => void;
  overlay: boolean;
  setOverlay: (on: boolean) => void;
};

const Ctx = createContext<LiveCtx | null>(null);

export function useLive(): LiveCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useLive outside LiveProvider');
  return c;
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [overlay, setOverlayState] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstAt = useRef(0);
  const nextId = useRef(1);

  const refresh = useCallback(() => {
    const now = Date.now();
    if (!firstAt.current) firstAt.current = now;
    if (timer.current) clearTimeout(timer.current);
    // Trailing debounce, but never hold a refresh back for more than 600 ms during a busy run.
    const wait = now - firstAt.current > 600 ? 0 : 150;
    timer.current = setTimeout(() => {
      firstAt.current = 0;
      timer.current = null;
      router.refresh();
    }, wait);
  }, [router]);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const open = () => {
      es = new EventSource('/api/stream');
      es.addEventListener('ready', () => {
        setConnected(true);
        refresh();
      });
      es.addEventListener('change', refresh);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) retry = setTimeout(open, 2000);
      };
    };
    open();
    // A recovering desk's lease countdown and "worker down" banners also need a periodic look.
    const tick = setInterval(refresh, 10_000);
    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
      clearInterval(tick);
    };
  }, [refresh]);

  const notify = useCallback((text: string, tone: Notice['tone'] = 'info') => {
    const id = nextId.current++;
    setNotices((n) => [...n.slice(-2), { id, text, tone }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4200);
  }, []);

  const post = useCallback(
    async (url: string, body: unknown) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
      const data = ((await res?.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      if (!res || !res.ok) notify(String(data.error ?? 'The request did not go through'), 'error');
      refresh();
      return { ok: Boolean(res?.ok), data };
    },
    [notify, refresh],
  );

  const setOverlay = useCallback((on: boolean) => {
    setOverlayState(on);
    document.body.dataset.overlay = on ? 'on' : 'off';
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.body.dataset.overlay === 'on') setOverlay(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setOverlay]);

  const value = useMemo(() => ({ connected, notify, post, refresh, overlay, setOverlay }), [connected, notify, post, refresh, overlay, setOverlay]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <ol className="notices" aria-live="polite">
        {notices.map((n) => (
          <li key={n.id} className="notice" data-tone={n.tone}>
            <span className="notice__head">{n.tone === 'error' ? 'Not sent' : 'Switchboard'}</span>
            <span className="notice__body">{n.text}</span>
          </li>
        ))}
      </ol>
    </Ctx.Provider>
  );
}
