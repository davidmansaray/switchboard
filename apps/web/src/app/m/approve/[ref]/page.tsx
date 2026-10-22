import { notFound } from 'next/navigation';
import { MobileApprove } from '@/components/mobile-approve';
import { getDraft } from '@/lib/data';
import { currentStaff } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  return { title: `Approve ${ref}` };
}

/** One job: decide this draft, from a phone. */
export default async function MobileApprovePage({ params, searchParams }: { params: Promise<{ ref: string }>; searchParams: Promise<{ frame?: string }> }) {
  const [{ ref }, sp, me] = await Promise.all([params, searchParams, currentStaff()]);
  const data = await getDraft(ref);
  if (!data) notFound();
  return <MobileApprove draft={data.draft} newer={data.newer} me={me} framed={sp.frame === '1'} />;
}
