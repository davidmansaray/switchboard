'use client';

import { useRouter } from 'next/navigation';
import type { Staff } from '@/lib/types';
import { Icon, THead } from './icons';
import { useLive } from './live';

const CAN: Record<string, string> = {
  approver: 'Decides drafts in the sign-off slot (price, dates, cancellations, customer emails). Can also edit hires and send notes.',
  staff: 'Edits hires directly and sends notes; drafts wait in the sign-off slot for an approver.',
};

export function SignIn({ staff, me }: { staff: Staff[]; me: Staff }) {
  const { post, notify } = useLive();
  const router = useRouter();
  const pick = async (s: Staff) => {
    const r = await post('/api/session', { staffId: s.id });
    if (r.ok) {
      notify(`Signed in as ${s.name}`);
      router.push('/');
      router.refresh();
    }
  };
  return (
    <main className="page page--signin">
      <ul className="signin">
        {staff.map((s) => (
          <li key={s.id}>
            <button type="button" className="signin__card" data-current={s.id === me.id ? 'true' : undefined} onClick={() => pick(s)} data-testid={`signin-${s.id}`}>
              <span className="signin__head" data-role={s.role}>
                {s.role === 'approver' ? <Icon name="approve" className="signin__glyph" /> : <THead className="signin__glyph icon--fill" />}
                <span className="smallcaps">{s.role === 'approver' ? 'Can sign off' : 'Hire desk'}</span>
                {s.id === me.id ? <span className="signin__now">on the desk</span> : null}
              </span>
              <span className="signin__body">
                <b>{s.name}</b>
                <span className="signin__title">{s.title}</span>
                <span className="signin__can">{CAN[s.role]}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="signin__note">
        Pick who you are. The server checks the role, not the browser. Approval tiers: PO number, invoice address and site contact are applied by the desk on its own and logged;
        price, dates, cancellations and every customer email wait in the sign-off slot for someone who can sign off.
      </p>
    </main>
  );
}
