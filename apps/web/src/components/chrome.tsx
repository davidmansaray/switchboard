'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { fmtDay, fmtTime } from '@/lib/format';
import type { Staff } from '@/lib/types';
import { Icon, THead } from './icons';
import { useLive } from './live';

const NAV = [
  { href: '/', label: 'Control Room', br: true, icon: 'rack' as const },
  { href: '/hires', label: 'Hires', icon: 'hires' as const },
  { href: '/approvals', label: 'Approvals', icon: 'approve' as const, count: true },
  { href: '/signals', label: 'Signals', icon: 'signals' as const },
];

export function NavRail({ waiting }: { waiting: number }) {
  const path = usePathname();
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  return (
    <nav className="navrail" data-component="NavRail" aria-label="Main">
      <Link className="navrail__mark" href="/" title="Switchboard · Control Room" aria-label="Switchboard, Control Room">
        <Icon name="mark" />
      </Link>
      <ul className="navrail__list">
        {NAV.map((n) => (
          <li key={n.href}>
            <Link className="navrail__item" href={n.href} aria-current={active(n.href) ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>
                {n.br ? (
                  <>
                    Control <br />
                    Room
                  </>
                ) : (
                  n.label
                )}
              </span>
              {n.count && waiting > 0 ? (
                <span className="navrail__count" aria-label={`${waiting} drafts waiting`}>
                  {waiting}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Europe/London wall clock, corrected to the server's time. */
export function Clock({ serverNow, className = 'topbar__clock' }: { serverNow: string; className?: string }) {
  const offset = useRef(Date.parse(serverNow) - Date.now());
  const [now, setNow] = useState(() => new Date(Date.parse(serverNow)));
  useEffect(() => {
    const t = setInterval(() => setNow(new Date(Date.now() + offset.current)), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className={className} title="Depot time (Europe/London)" data-component="Clock">
      <span className="topbar__clock-day">{fmtDay(now)}</span>
      <span className="topbar__clock-time" suppressHydrationWarning>
        {fmtTime(now)}
      </span>
    </div>
  );
}

export function OverlayToggle() {
  const { overlay, setOverlay } = useLive();
  return (
    <button
      className="btn toggle"
      type="button"
      aria-pressed={overlay}
      onClick={() => setOverlay(!overlay)}
      title="Architecture Overlay: label each region with the Mastra facility or app code behind it"
      data-testid="overlay-toggle"
    >
      <Icon name="inspect" />
      <span className="btn__text">Architecture</span>
    </button>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const read = () => {
      const a = document.documentElement.getAttribute('data-theme');
      setDark(a ? a === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
    };
    read();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', read);
    return () => mq.removeEventListener('change', read);
  }, []);
  const flip = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('sb-theme', next);
    } catch {
      /* storage unavailable */
    }
    setDark(!dark);
  };
  return (
    <button className="btn btn--icon" type="button" onClick={flip} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} data-testid="theme-toggle">
      <Icon name={dark ? 'sun' : 'moon'} />
    </button>
  );
}

/** The signed-in person (T-head glyph, no avatar disc) and the "sign in as" switch. */
export function UserSwitch({ me, staff }: { me: Staff; staff: Staff[] }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { post, notify } = useLive();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const pick = async (s: Staff) => {
    setOpen(false);
    const r = await post('/api/session', { staffId: s.id });
    if (r.ok) {
      notify(`Signed in as ${s.name}${s.role === 'approver' ? ' (approver)' : ''}`);
      router.refresh();
    }
  };
  return (
    <div className="topbar__user" ref={ref}>
      <button className="userbtn" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="user-switch">
        <THead className="topbar__glyph icon--fill" />
        <span className="topbar__who">
          <span className="topbar__name">{me.name}</span>
          <span className="topbar__role">
            {me.title}
            {me.role === 'approver' ? ', approver' : ''}
          </span>
        </span>
      </button>
      {open ? (
        <div className="usermenu" role="menu" aria-label="Sign in as">
          <p className="usermenu__h">Sign in as</p>
          {staff.map((s) => (
            <button key={s.id} type="button" role="menuitemradio" aria-checked={s.id === me.id} className="usermenu__item" onClick={() => pick(s)}>
              <THead className="usermenu__glyph icon--fill" data-approver={s.role === 'approver'} />
              <span>
                <b>{s.name}</b>
                <span className="usermenu__role">
                  {s.title}
                  {s.role === 'approver' ? ' · approver' : ''}
                </span>
              </span>
            </button>
          ))}
          <Link className="usermenu__more" href="/sign-in" onClick={() => setOpen(false)}>
            Who can approve what
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** Shown while the agent process is down (the crash control really kills it). */
export function WorkerBanner({ down, crashAt }: { down: boolean; crashAt: string | null }) {
  // Seconds are client-only (rendered after mount) so server and client HTML agree.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!down) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [down]);
  if (!down) return null;
  const secs = crashAt && now ? Math.max(0, Math.round((now - Date.parse(crashAt)) / 1000)) : 0;
  return (
    <p className="workerbanner" role="status" data-testid="worker-down">
      <Icon name="crash" />
      <b>Worker down {secs ? `${secs}s` : ''}</b>
      <span>The agent process was killed. It restarts on its own; durable runs resume when the dead worker’s 30 s lease lapses.</span>
    </p>
  );
}
