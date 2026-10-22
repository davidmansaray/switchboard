import { AppShell } from '@/components/shell';
import { ControlRoom } from '@/components/control-room';
import { Simulator } from '@/components/simulator';
import { getBoard, getSimHires } from '@/lib/data';
import { currentStaff } from '@/lib/session';
import { plural } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ControlRoomPage({ searchParams }: { searchParams: Promise<{ desk?: string }> }) {
  const sp = await searchParams;
  const desk = sp.desk === 'none' ? null : (sp.desk ?? 'NH-5520');
  const [board, me, simHires] = await Promise.all([getBoard({ desk }), currentStaff(), getSimHires()]);
  const working = board.desks.filter((d) => d.status === 'running' || d.status === 'queued' || d.status === 'recovering').length;
  const phoneDraft = board.waiting.find((d) => d.hireRef === 'NH-5520' && d.intent === 'discount')?.ref ?? null;
  return (
    <AppShell
      title="Control Room"
      meta={`${plural(board.desks.length, 'desk')} on the rack · ${working} working · ${board.waiting.length} in the sign-off slot`}
      tools={<Simulator scenario={board.scenario} runtime={board.runtime} hires={simHires} selected={board.detail?.desk.ref ?? null} phoneDraft={phoneDraft} />}
    >
      <ControlRoom board={board} me={me} />
    </AppShell>
  );
}
