import { schema as s } from '@switchboard/db';
import { eq } from 'drizzle-orm';
import type { Switchboard } from '../../src/runtime';
import { beats } from '../../src/scenario/beats';

/** Play hero beats 1..n in order, each to quiescence (beat 4 fires while beat 3's run is still going). */
export async function playBeats(sb: Switchboard, hireId: string, upTo: number) {
  const b = beats(sb.services);
  for (let n = 1; n <= upTo; n++) {
    if (n === 4) {
      for (let i = 0; i < 300; i++) {
        const [d] = await sb.db.db.select().from(s.drafts).where(eq(s.drafts.ref, 'D-7'));
        if (d) break;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    await b[n as 1]();
    if (n !== 3) await sb.router.idle(hireId);
  }
}
