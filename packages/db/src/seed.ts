import { APPROVAL_TIERS, priceHire } from '@switchboard/core';
import { eq, sql } from 'drizzle-orm';
import { withActor, type Db } from './client';
import { indexEvidence } from './evidence';
import {
  CUSTOMERS,
  FLEET,
  HERO_HISTORY_EMAIL,
  HERO_REF,
  HERO_THREADS,
  HERO_TRANSCRIPT,
  HIRES,
  OTHER_DRAFTS,
  STAFF,
  waiverDoc,
} from './fixtures';
import * as s from './schema';

export const deskThreadId = (hireRef: string) => `desk:${hireRef}`;
export const customerResourceId = (customerId: string) => `customer:${customerId}`;

export type SeedResult = { heroHireId: string; hireIds: Record<string, string> };

/** Seed a freshly migrated database. Not idempotent: run through `reset`. */
export async function seed(db: Db): Promise<SeedResult> {
  return withActor(db, 'system:seed', async (tx) => {
    await tx.insert(s.staff).values(STAFF.map((x) => ({ ...x })));
    await tx.insert(s.fleet).values(FLEET.map((f) => ({ ...f }))).onConflictDoNothing();
    await tx
      .insert(s.approvalTiers)
      .values(Object.entries(APPROVAL_TIERS).map(([field, v]) => ({ field, tier: v.tier, description: v.description })));

    const customerIds: Record<string, string> = {};
    const contactIds: Record<string, string> = {};
    for (const c of CUSTOMERS) {
      const [row] = await tx.insert(s.customers).values({ name: c.name, accountRef: c.accountRef }).returning();
      customerIds[c.key] = row!.id;
      for (const ct of c.contacts) {
        const [cr] = await tx
          .insert(s.contacts)
          .values({ customerId: row!.id, name: ct.name, email: ct.email, role: ct.role, phone: ct.phone })
          .returning();
        contactIds[ct.key] = cr!.id;
      }
    }

    const hireIds: Record<string, string> = {};
    for (const h of HIRES) {
      const lines = h.lines.map((l, i) => ({ lineNo: i + 1, weeklyRatePence: l.weeklyRatePence, quantity: 1, status: l.status ?? ('booked' as const) }));
      const price = priceHire({ lines, durationDays: h.durationDays, discountPct: 0, damageWaiver: true, transportPence: h.transportPence });
      const [hire] = await tx
        .insert(s.hires)
        .values({
          ref: h.ref,
          customerId: customerIds[h.customer]!,
          site: h.site,
          siteArea: h.siteArea,
          transportPence: h.transportPence,
          deliveryDate: h.deliveryDate,
          durationDays: h.durationDays,
          status: h.ref === HERO_REF ? 'enquiry' : h.status,
          poNumber: h.poNumber ?? null,
          siteContactId: contactIds[h.siteContact]!,
          damageWaiver: h.ref !== HERO_REF,
          totalPence: price.subtotalPence,
          updatedBy: 'system:seed',
        })
        .returning();
      hireIds[h.ref] = hire!.id;
      await tx.insert(s.hireLines).values(
        h.lines.map((l, i) => ({
          hireId: hire!.id,
          lineNo: i + 1,
          kind: l.kind,
          model: l.model,
          description: l.description,
          spec: l.spec,
          fleetNo: l.fleetNo,
          weeklyRatePence: l.weeklyRatePence,
          status: l.status ?? 'booked',
        })),
      );
      const [desk] = await tx
        .insert(s.desks)
        .values({ hireId: hire!.id, mastraThreadId: deskThreadId(h.ref), resourceId: customerResourceId(customerIds[h.customer]!) })
        .returning();
      void desk;
      const w = waiverDoc(h.ref, h.waiverSigned);
      const [doc] = await tx
        .insert(s.documents)
        .values({ hireId: hire!.id, ...w, signedAt: w.signed ? new Date('2026-10-10T10:00:00Z') : null })
        .returning();
      await indexEvidence(tx, { hireId: hire!.id, sourceType: 'document', sourceId: doc!.id, content: `${w.title}\n${w.body}` });
    }
    // v1 snapshots were taken before the lines existed.
    await tx.execute(sql`update app.hire_versions set snapshot = app.hire_snapshot(hire_id) where version = 1`);
    return { hireIds, customerIds, contactIds };
  }).then(async ({ hireIds, contactIds }) => {
    const heroHireId = hireIds[HERO_REF]!;
    // Hero history: v1 enquiry → v2 confirmed (AM slot) → v3 damage waiver added. Beat 2's PO makes v4.
    await withActor(db, 'gary', (tx) => tx.update(s.hires).set({ status: 'confirmed', deliverySlot: 'AM' }).where(eq(s.hires.id, heroHireId)));
    await withActor(db, 'gary', (tx) => tx.update(s.hires).set({ damageWaiver: true }).where(eq(s.hires.id, heroHireId)));

    await withActor(db, 'system:seed', async (tx) => {
      const threadIds: Record<string, string> = {};
      for (const t of HERO_THREADS) {
        const [row] = await tx
          .insert(s.emailThreads)
          .values({ hireId: heroHireId, label: t.label, subject: t.subject, contactId: contactIds[t.contact]! })
          .returning();
        threadIds[t.label] = row!.id;
      }
      const e = HERO_HISTORY_EMAIL;
      const [email] = await tx
        .insert(s.emails)
        .values({
          threadId: threadIds[e.thread]!,
          hireId: heroHireId,
          messageId: e.messageId,
          direction: e.direction,
          fromAddr: e.from,
          toAddrs: ['sam.fletcher@haldenbuild.co.uk'],
          subject: e.subject,
          body: e.body,
          receivedAt: new Date('2026-10-14T15:12:00Z'),
        })
        .returning();
      await indexEvidence(tx, { hireId: heroHireId, sourceType: 'email', sourceId: email!.id, content: `${e.subject}\n${e.body}` });
      const t = HERO_TRANSCRIPT;
      const [tr] = await tx
        .insert(s.transcripts)
        .values({ hireId: heroHireId, title: t.title, participants: t.participants, body: t.body, occurredAt: new Date(t.occurredAt) })
        .returning();
      await indexEvidence(tx, { hireId: heroHireId, sourceType: 'transcript', sourceId: tr!.id, content: `${t.title}\n${t.body}` });

      for (const d of OTHER_DRAFTS) {
        const hid = hireIds[d.hire]!;
        const [h] = await tx.select({ version: s.hires.version }).from(s.hires).where(eq(s.hires.id, hid));
        await tx.insert(s.drafts).values({
          ref: d.ref,
          hireId: hid,
          kind: d.kind,
          title: d.title,
          payload: { summary: d.summary, intent: 'off-hire' },
          basedOnVersion: h!.version,
          status: d.status,
          actionKey: `seed:${d.hire}:${d.title}`,
        });
      }
      // Desks with a pending draft start in `awaiting_approval`.
      await tx.execute(sql`
        update app.desks d set run_state = 'awaiting_approval'
        where exists (select 1 from app.drafts x where x.hire_id = d.hire_id and x.status = 'pending')`);
    });
    return { heroHireId, hireIds };
  });
}
