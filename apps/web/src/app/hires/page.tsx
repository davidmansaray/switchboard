import Link from 'next/link';
import { AppShell } from '@/components/shell';
import { THead } from '@/components/icons';
import { getHireRegister } from '@/lib/data';
import { fmtDate, gbp, plural } from '@/lib/format';
import { DESK_STATUS } from '@/lib/vocab';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Hires' };

/** The hire register: every booking with its desk, one row each, in the rack's state colours. */
export default async function HiresPage() {
  const rows = await getHireRegister();
  return (
    <AppShell title="Hires" meta={`${plural(rows.length, 'hire')} · one desk each`}>
      <main className="page page--register">
        <ol className="register" data-component="HireRegister">
          {rows.map(({ desk, deliveryDate, offHireDate, po, totalPence }) => (
            <li key={desk.ref} className="reg" data-status={desk.status}>
              <Link className="reg__head" href={`/hires/${desk.ref}`} data-testid={`hire-${desk.ref}`}>
                <span className="reg__ref">{desk.ref}</span>
                <span className="reg__ver">v{desk.version}</span>
              </Link>
              <div className="reg__body">
                <div className="reg__who">
                  <p className="reg__cust">{desk.customer}</p>
                  <p className="reg__site">
                    {desk.site}
                    {desk.siteArea ? `, ${desk.siteArea}` : ''}
                  </p>
                </div>
                <ul className="reg__kit" aria-label="Machines">
                  {desk.lines.map((l) => (
                    <li key={l.lineNo} data-line-status={l.status}>
                      <span className="mono">{l.fleetNo}</span> {l.short}
                    </li>
                  ))}
                </ul>
                <dl className="reg__facts">
                  <div>
                    <dt>On hire</dt>
                    <dd>
                      {fmtDate(deliveryDate)} → {fmtDate(offHireDate)}
                    </dd>
                  </div>
                  <div>
                    <dt>Hire price</dt>
                    <dd className="mono">{gbp(totalPence)}</dd>
                  </div>
                  <div>
                    <dt>PO</dt>
                    <dd className={po ? 'mono' : 'reg__missing'}>{po ?? 'not in yet'}</dd>
                  </div>
                </dl>
                <p className="reg__state">
                  <span className="statusword" data-status={desk.status}>
                    <THead />
                    <span>{DESK_STATUS[desk.status].label}</span>
                  </span>
                  {desk.awaiting.length ? <span className="reg__drafts">{desk.awaiting.join(', ')} waiting</span> : null}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </main>
    </AppShell>
  );
}
