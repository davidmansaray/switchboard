import { AppShell } from '@/components/shell';
import { SignIn } from '@/components/sign-in';
import { listStaff } from '@/lib/data';
import { currentStaff } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in as' };

export default async function SignInPage() {
  const [staff, me] = await Promise.all([listStaff(), currentStaff()]);
  return (
    <AppShell title="Sign in as" meta="Who’s on the hire desk">
      <SignIn staff={staff} me={me} />
    </AppShell>
  );
}
