import { AppShell } from '@/components/shell';
import { ApprovalQueue } from '@/components/approval-queue';
import { getApprovalsPage } from '@/lib/data';
import { currentStaff } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Approvals' };

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ d?: string }> }) {
  const [{ waiting, filed, all }, me, sp] = await Promise.all([getApprovalsPage(), currentStaff(), searchParams]);
  const selected = all.find((d) => d.ref === sp.d) ?? waiting[0] ?? filed[0] ?? null;
  const stale = waiting.filter((d) => d.status === 'stale').length;
  return (
    <AppShell
      title="Approvals"
      meta={`${waiting.length} in the sign-off slot${stale ? ` · ${stale} stale` : ''} · ${filed.length} filed today${me.role === 'approver' ? '' : ` · signed in as ${me.name} (not an approver)`}`}
    >
      <ApprovalQueue waiting={waiting} filed={filed} all={all} selectedRef={selected?.ref ?? null} canApprove={me.role === 'approver'} />
    </AppShell>
  );
}
