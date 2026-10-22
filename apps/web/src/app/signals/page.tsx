import { AppShell } from '@/components/shell';
import { SignalsBoard } from '@/components/signals-board';
import { getSignalsPage } from '@/lib/data';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Signals' };

export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ hire?: string }> }) {
  const [{ signals, hires, midnight }, sp] = await Promise.all([getSignalsPage(), searchParams]);
  const today = signals.filter((s) => s.at >= midnight && s.type !== 'evidence').length;
  return (
    <AppShell title="Signals" meta={`${today} today · every wake-up through one adapter`}>
      <SignalsBoard signals={signals} hires={hires} midnight={midnight} initialHire={sp.hire ?? null} />
    </AppShell>
  );
}
