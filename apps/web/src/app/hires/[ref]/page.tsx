import { notFound } from 'next/navigation';
import { AppShell } from '@/components/shell';
import { FullDesk } from '@/components/full-desk';
import { getDeskDetail } from '@/lib/data';
import { currentStaff } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  return { title: `${ref} desk` };
}

/** The full-page hire desk: the desk's T-card head at full width over three columns. */
export default async function HireDeskPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const [detail, me] = await Promise.all([getDeskDetail(ref), currentStaff()]);
  if (!detail) notFound();
  return (
    <AppShell title={`${detail.desk.ref} desk`} meta={`${detail.desk.customer} · ${detail.desk.site}`}>
      <FullDesk detail={detail} canApprove={me.role === 'approver'} />
    </AppShell>
  );
}
