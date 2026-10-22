import { describe, expect, it } from 'vitest';
import type { LanguageModelV2Prompt } from '@ai-sdk/provider';
import { decide } from '../../src/models/desk-policy';
import { currentTurn, parseInputs } from '../../src/models/prompt';
import { RecordReplayModel } from '../../src/models/recording';

const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });

describe('prompt parsing', () => {
  it('parses tagged signals with attributes', () => {
    const [i] = parseInputs('<email kind="email.received" hire="NH-5520" from="sam@x">Subject: hi\n\nbody &amp; more</email>', 0);
    expect(i).toMatchObject({ tag: 'email', attrs: { kind: 'email.received', hire: 'NH-5520', from: 'sam@x' }, contents: 'Subject: hi\n\nbody & more' });
  });
  it('the current turn starts after the last final assistant text', () => {
    const prompt: LanguageModelV2Prompt = [
      { role: 'system', content: 'sys' },
      user('<email kind="email.received" hire="NH-5520">old</email>'),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      user('<note kind="note.created" hire="NH-5520">@assistant 10% off</note>'),
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'x:read', toolName: 'getHire', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x:read', toolName: 'getHire', output: { type: 'json', value: { status: 'OK' } } }] },
    ];
    const t = currentTurn(prompt);
    expect(t.inputs.map((i) => i.tag)).toEqual(['note']);
    expect(t.results).toHaveLength(1);
  });
});

describe('scripted desk policy', () => {
  const tools = ['getHire', 'searchEvidence', 'getDraftChain', 'proposeDraft', 'updateWorkingMemory'];
  it('always reads the hire first (facts never from memory)', () => {
    const d = decide({ inputs: parseInputs('<email kind="email.received" hire="NH-5520">Can you knock something off?</email>', 0), results: [], toolNames: tools });
    expect('calls' in d && d.calls[0]!.toolName).toBe('getHire');
  });
  it('finishes with text once every input is handled', () => {
    expect(decide({ inputs: [], results: [], toolNames: tools })).toEqual({ text: 'Nothing to action.' });
  });
});

describe('record/replay keys', () => {
  it('ignore ids and timestamps so a re-run hits the same recording', () => {
    const a = RecordReplayModel.keyFor({ prompt: [user('<x event_id="11111111-1111-1111-1111-111111111111" at="2026-10-20T10:00:00.000Z">hi</x>')] } as never);
    const b = RecordReplayModel.keyFor({ prompt: [user('<x event_id="22222222-2222-2222-2222-222222222222" at="2026-10-21T11:00:00.000Z">hi</x>')] } as never);
    const c = RecordReplayModel.keyFor({ prompt: [user('<x>bye</x>')] } as never);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
