import type { ReactNode } from 'react';
import { getRuntime, listStaff } from '@/lib/data';
import { getDb, schema as s } from '@switchboard/db';
import { inArray, sql } from 'drizzle-orm';
import { currentStaff } from '@/lib/session';
import { Clock, NavRail, OverlayToggle, ThemeToggle, UserSwitch, WorkerBanner } from './chrome';
import { Icon } from './icons';
import { OverlayInspector } from './overlay';

/** The Yard Board shell: nav rail, top bar (wordmark, clock, overlay, theme, user) and the page's sub bar. */
export async function AppShell({ title, meta, tools, children, wide }: { title: string; meta?: ReactNode; tools?: ReactNode; children: ReactNode; wide?: boolean }) {
  const [me, staff, runtime, waitingRows] = await Promise.all([
    currentStaff(),
    listStaff(),
    getRuntime(),
    getDb().db.select({ n: sql<number>`count(*)::int` }).from(s.drafts).where(inArray(s.drafts.status, ['pending', 'stale'])),
  ]);
  const now = new Date().toISOString();
  return (
    <div className="app" data-component="AppShell" data-wide={wide ? 'true' : undefined}>
      <NavRail waiting={waitingRows[0]?.n ?? 0} />
      <header className="topbar" data-component="TopBar">
        <span className="topbar__mark" aria-hidden="true">
          <Icon name="mark" />
        </span>
        <div className="topbar__brand">
          <span className="topbar__word">Switchboard</span>
          <span className="topbar__endorse">Northgate Plant &amp; Access Hire</span>
        </div>
        <Clock serverNow={now} />
        <div className="topbar__spacer" />
        <div className="topbar__tools">
          <OverlayToggle />
          <ThemeToggle />
        </div>
        <UserSwitch me={me} staff={staff} />
      </header>
      <div className="subbar">
        <div className="subbar__title">
          <h1 className="subbar__h1">{title}</h1>
          <Clock serverNow={now} className="topbar__clock subbar__clock" />
          {meta ? <p className="subbar__meta">{meta}</p> : null}
        </div>
        <div className="subbar__spacer" />
        {tools}
      </div>
      <WorkerBanner down={runtime.workerDown} crashAt={runtime.lastCrashAt} />
      {children}
      <OverlayInspector />
    </div>
  );
}
