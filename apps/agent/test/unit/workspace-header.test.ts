import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveModel, resolveDeskModel, WORKSPACE_HEADER } from '../../src/models';

/**
 * ANTHROPIC_WORKSPACE_ID: a key that is not workspace-scoped needs `anthropic-workspace-id` on every
 * request. Checked at the wire: fetch is stubbed, so nothing leaves the machine and no real key is used.
 */
describe('Anthropic workspace header', () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  });

  async function headersSent(model: { doStream: (o: never) => Promise<unknown> }) {
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
    let sent: Headers | undefined;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'stubbed' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never).catch(() => {});
    return sent;
  }

  it('adds the header to every Anthropic request when ANTHROPIC_WORKSPACE_ID is set', async () => {
    const sent = await headersSent(liveModel('anthropic/claude-sonnet-5-5', { workspaceId: 'wrkspc_test_123' }) as never);
    expect(sent?.get(WORKSPACE_HEADER)).toBe('wrkspc_test_123');
    expect(sent?.get('x-api-key')).toBe('test-key-not-real');
  });

  it('sends no workspace header when it is not set', async () => {
    const sent = await headersSent(liveModel('anthropic/claude-sonnet-5-5') as never);
    expect(sent).toBeDefined();
    expect(sent?.get(WORKSPACE_HEADER)).toBeNull();
  });

  it('live mode builds the header-carrying provider only when a workspace id is configured', () => {
    expect(resolveDeskModel({ mode: 'live', agentModel: 'anthropic/claude-sonnet-5-5' })).toBe('anthropic/claude-sonnet-5-5');
    const m = resolveDeskModel({ mode: 'live', agentModel: 'anthropic/claude-sonnet-5-5', workspaceId: 'wrkspc_x' }) as { modelId?: string; provider?: string };
    expect(m.provider).toBe('anthropic');
  });

  it('the model resolveDeskModel builds for live mode really sends the header (not just the right provider name)', async () => {
    const m = resolveDeskModel({ mode: 'live', agentModel: 'anthropic/claude-sonnet-5-5', workspaceId: 'wrkspc_live' });
    expect((await headersSent(m as never))?.get(WORKSPACE_HEADER)).toBe('wrkspc_live');
  });

  it('record mode wraps the live model with the header too (recording a live run uses the same key setup)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-ws-'));
    try {
      const m = resolveDeskModel({ mode: 'record', agentModel: 'anthropic/claude-sonnet-5-5', workspaceId: 'wrkspc_rec', recordingsDir: dir });
      expect((await headersSent(m as never))?.get(WORKSPACE_HEADER)).toBe('wrkspc_rec');
      expect(readdirSync(dir)).toEqual([]); // a failed call is not recorded
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
