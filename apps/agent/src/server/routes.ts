import { registerApiRoute } from '@mastra/core/server';
import { pingDb, schema as s } from '@switchboard/db';
import { z } from 'zod';
import type { Switchboard } from '../runtime';
import { ServiceError } from '../services';

type Ctx = Parameters<NonNullable<Parameters<typeof registerApiRoute>[1]['handler']>>[0];

/** Internal routes for the web app and the simulator. Bearer INTERNAL_API_TOKEN when set. */
export function buildRoutes(sb: () => Switchboard) {
  const guard = (c: Ctx) => {
    const token = sb().config.internalApiToken;
    return !token || c.req.header('authorization') === `Bearer ${token}`;
  };
  const handle =
    <T extends z.ZodType>(schema: T, fn: (body: z.infer<T>, c: Ctx) => Promise<unknown>) =>
    async (c: Ctx) => {
      if (!guard(c)) return c.json({ error: 'unauthorized' }, 401);
      const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
      try {
        return c.json((await fn(parsed.data, c)) ?? { ok: true });
      } catch (e) {
        if (e instanceof ServiceError) return c.json({ error: e.code, message: e.message }, e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 409);
        throw e;
      }
    };

  return [
    registerApiRoute('/status', {
      method: 'GET',
      requiresAuth: false,
      handler: async (c) => {
        const db = await pingDb().then(() => 'ok').catch((e: unknown) => String(e));
        return c.json({ service: 'agent', ok: db === 'ok', db, backend: sb().config.signalBackend, llmMode: sb().config.llmMode }, db === 'ok' ? 200 : 503);
      },
    }),
    registerApiRoute('/internal/emails', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(z.object({ hireRef: z.string(), threadLabel: z.string(), from: z.string(), subject: z.string(), body: z.string(), messageId: z.string().optional() }), (b) => sb().services.ingestEmail(b)),
    }),
    registerApiRoute('/internal/notes', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(z.object({ hireRef: z.string(), authorId: z.string(), body: z.string() }), (b) => sb().services.addNote(b)),
    }),
    registerApiRoute('/internal/hires/edit', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(
        z.object({
          hireRef: z.string(),
          staffId: z.string(),
          changes: z.object({ deliveryDate: z.string().optional(), deliverySlot: z.string().optional(), durationDays: z.number().int().optional() }).default({}),
          lines: z.array(z.object({ lineNo: z.number().int(), model: z.string().optional(), description: z.string().optional(), spec: z.string().optional(), fleetNo: z.string().optional(), weeklyRatePence: z.number().int().optional() })).optional(),
        }),
        (b) => sb().services.editHire(b),
      ),
    }),
    registerApiRoute('/internal/lines/status', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(z.object({ hireRef: z.string(), staffId: z.string(), lineNo: z.number().int(), status: z.enum(['booked', 'on_hire', 'cancelled']) }), (b) => sb().services.setLineStatus(b)),
    }),
    registerApiRoute('/internal/approvals', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(
        z.object({ draftRef: z.string(), staffId: z.string(), decision: z.enum(['approved', 'rejected']), note: z.string().optional(), channel: z.enum(['web', 'mobile']).optional() }),
        async (b) => {
          const app = sb();
          // On the hero desk at beat 5/6 the approval is that beat (beat 6 includes the worker crash).
          const beat = await app.scenario.beatForApproval(b.draftRef, b.decision);
          if (beat) {
            await app.services.assertApprover(b.staffId);
            return { ...(await app.scenario.play(beat, { staffId: b.staffId, channel: b.channel })), via: 'scenario' };
          }
          return app.services.decideApproval(b);
        },
      ),
    }),
    registerApiRoute('/internal/sweeps/fire', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(z.object({ hireRef: z.string() }), async (b) => {
        const app = sb();
        const beat = await app.scenario.beatForSweep(b.hireRef);
        if (beat) return { ...(await app.scenario.play(beat)), via: 'scenario' };
        return app.services.fireSweep(b.hireRef);
      }),
    }),
    registerApiRoute('/internal/crash', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(z.object({ tool: z.string().default('*'), now: z.boolean().default(false) }), async (b) => {
        const app = sb();
        if (!app.config.allowCrashEndpoint) throw new ServiceError('FORBIDDEN', 'the crash control is disabled on this deployment');
        if (b.now) {
          await app.db.db.insert(s.opsLog).values({ kind: 'crash', detail: { tool: null, pid: process.pid, leaseMs: 30_000, by: 'simulator' } });
          setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);
        } else {
          app.crash.arm(b.tool);
          await app.db.db.insert(s.opsLog).values({ kind: 'crash.armed', detail: { tool: b.tool, pid: process.pid, by: 'simulator' } });
        }
        return { armed: b.now ? 'now' : b.tool };
      }),
    }),
    registerApiRoute('/internal/crash/disarm', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(z.object({}), async () => {
        sb().crash.disarm();
        return { armed: null };
      }),
    }),
    registerApiRoute('/internal/runtime', {
      method: 'GET',
      requiresAuth: false,
      handler: async (c) => {
        if (!guard(c)) return c.json({ error: 'unauthorized' }, 401);
        const app = sb();
        return c.json({
          pid: process.pid,
          backend: app.config.signalBackend,
          llmMode: app.config.llmMode,
          crashEnabled: app.config.allowCrashEndpoint,
          resetEnabled: app.config.allowScenarioReset,
          crashArmed: app.crash.armed,
          scenario: await app.scenario.state(),
        });
      },
    }),
    registerApiRoute('/internal/scenario/beat', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(z.object({ n: z.number().int().min(1).max(9) }), (b) => sb().scenario.play(b.n)),
    }),
    registerApiRoute('/internal/scenario/reset', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(z.object({}), () => sb().scenario.reset()),
    }),
  ];
}
