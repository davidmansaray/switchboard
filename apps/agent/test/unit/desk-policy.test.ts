import { describe, expect, it } from 'vitest';
import { cancelLineOf, decide, parseLoops, renderLoops, type Loop, type ToolCall } from '../../src/models/desk-policy';
import { parseInputs, type ToolOutcome } from '../../src/models/prompt';

/**
 * The scripted desk's pure parts: working-memory loops (read from the system prompt, written back
 * through updateWorkingMemory), the cancellation parser, and the approval plan when the hire moved
 * between the approval and the apply. No database: tool results are fabricated per call.
 */

const TOOLS = ['getHire', 'searchEvidence', 'getDraftChain', 'proposeDraft', 'applyPricing', 'cancelLine', 'issueCreditNote', 'queueEmail', 'updateWorkingMemory'];

/** Mastra puts working memory into the system prompt between these tags (with the template above it). */
const systemWith = (memory: string) =>
  [
    'You are Switchboard...',
    '<working_memory_template>',
    '# Desk working memory',
    '## Open loops',
    '- [open] template-example: must never be read as a loop',
    '</working_memory_template>',
    '',
    '<working_memory_data>',
    memory,
    '</working_memory_data>',
  ].join('\n');

describe('working-memory loops', () => {
  const loops: Loop[] = [
    { status: 'open', key: 'discount', text: 'Sam Fletcher (T1) asked for a discount: "Can you knock something off NH-5520?" Waiting on an approver.' },
    { status: 'closed', key: 'invoicing', text: 'PO HAL-PO-88213 + invoice address applied automatically (routine tier, logged, no approval).' },
    { status: 'decided', key: 'cancel-line-2', text: 'D-10: credit £1,548.00 — waiting on Gary: key: value pairs survive.' },
  ];

  it('renderLoops → parseLoops round-trips every loop exactly (status, hyphenated key, text with colons)', () => {
    expect(parseLoops(systemWith(renderLoops(loops)))).toEqual(loops);
  });

  it('reads only <working_memory_data>, never the template', () => {
    expect(parseLoops(systemWith('No working memory data available.'))).toEqual([]);
    expect(parseLoops('<working_memory_template>\n- [open] x: y\n</working_memory_template>')).toEqual([]);
  });

  it('an empty memory renders the template placeholder and parses back to no loops', () => {
    const empty = renderLoops([]);
    expect(empty).toContain('- (none)');
    expect(parseLoops(systemWith(empty))).toEqual([]);
  });

  it('the desk carries earlier loops forward when it writes a new one (upsert by key)', () => {
    // Beat 2 after beat 1: the open discount loop must survive the invoicing loop being written.
    const inputs = parseInputs(
      '<email kind="email.received" hire="NH-5520" thread="T2" evidence_id="ev-po">Our PO number for NH-5520 is HAL-PO-88213.</email>',
      0,
    );
    const system = systemWith(renderLoops([loops[0]!]));
    const calls = drive(inputs, (c) => {
      if (c.toolName === 'getHire') return { status: 'OK', result: { hire: hireV(3) } };
      if (c.toolName === 'applyRoutineUpdate') return { status: 'OK', result: { version: 4, fields: ['poNumber'], tier: 'auto' } };
      return { success: true };
    }, system);
    const mem = calls.find((c) => c.toolName === 'updateWorkingMemory');
    expect(mem).toBeDefined();
    const written = parseLoops(systemWith(String(mem!.input.memory)));
    expect(written.map((l) => `${l.status}:${l.key}`)).toEqual(['open:discount', 'closed:invoicing']);
    expect(written[0]).toEqual(loops[0]);
  });
});

describe('cancelLineOf', () => {
  const lines = [
    { lineNo: 1, kind: 'boom', model: 'JLG 600AJ', description: '19m articulated boom lift', status: 'booked' as const, weeklyRatePence: 118000, quantity: 1, fleetNo: 'AB19-07' },
    { lineNo: 2, kind: 'telehandler', model: 'Manitou MT 1840', description: '17m telehandler', status: 'booked' as const, weeklyRatePence: 86000, quantity: 1, fleetNo: 'TH17-05' },
  ];
  const h = { lines };
  const prose = (text: string) => cancelLineOf({ input: { attrs: {} } }, h, text.toLowerCase())?.lineNo;

  it('beat 8: "cancel the telehandler, keep the boom" is line 2, not the boom it also mentions', () => {
    expect(prose("Gary – change of plan on Riverside, please cancel the telehandler, keep the boom. Sorry for the faff.")).toBe(2);
  });

  it('reads the clause after "cancel" and drops anything after "keep" or "but"', () => {
    expect(prose('Keep the telehandler, cancel the boom please')).toBe(1);
    expect(prose('Please cancel the boom lift but keep the telehandler')).toBe(1);
    // Without the keep/but cut the clause would name the boom too, and the boom is line 1.
    expect(prose('Please cancel the telehandler but keep the boom')).toBe(2);
    expect(prose('Cancel the telehandler and keep the boom lift')).toBe(2);
    expect(prose('Can we cancel the boom? Keep the telehandler on.')).toBe(1);
    expect(prose('Cancelling TH17-05 for now')).toBe(2);
    expect(prose('cancel the 17m telehandler')).toBe(2);
  });

  it('falls back to the one named line that is not kept, and finds nothing when nothing is named', () => {
    expect(prose('Cancellation of the telehandler please, keep the boom')).toBe(2);
    expect(prose('Cancel it, keep the boom')).toBeUndefined();
    expect(prose("Don't cancel anything yet")).toBeUndefined();
  });

  it('a staff status change names the line explicitly, whatever the prose says', () => {
    expect(cancelLineOf({ input: { attrs: { line: '1' } } }, h, 'jo barrett set line 1 (jlg 600aj) booked → cancelled directly. keep the telehandler')?.lineNo).toBe(1);
    expect(cancelLineOf({ input: { attrs: { line: '9' } } }, h, 'cancel the telehandler')).toBeUndefined();
  });
});

describe('approval of a draft the hire overtook before it was applied', () => {
  const D8 = {
    ref: 'D-8',
    kind: 'bundle',
    title: 'Pricing + reply to Sam (10% off), revised for v5',
    status: 'approved',
    basedOnVersion: 5,
    evidenceIds: ['ev-note', 'ev-call'],
    payload: {
      intent: 'discount',
      actions: [{ type: 'applyPricing', discountPct: 10 }],
      reply: { threadLabel: 'T1', to: ['sam.fletcher@haldenbuild.co.uk'], subject: 'Re: NH-5520', body: 'old body' },
    },
  };
  const approval = parseInputs(
    '<approval kind="approval.decided" hire="NH-5520" draft="D-8" decision="approved" based_on="5" hire_version="5">D-8 approved by gary; hire is now v5 (draft based on v5).</approval>',
    0,
  );

  it('applyPricing STALE → re-read the hire, regenerate against the new version (supersedes D-8), send nothing', () => {
    let reads = 0;
    const calls = drive(approval, (c) => {
      switch (c.toolName) {
        case 'getHire':
          reads++;
          return { status: 'OK', result: { hire: hireV(reads === 1 ? 5 : 6) } };
        case 'getDraftChain':
          return { status: 'OK', result: { hireVersion: 5, drafts: [D8] } };
        case 'applyPricing':
          return { status: 'STALE', expectedVersion: 5, currentVersion: 6, message: 'hire moved' };
        case 'proposeDraft':
          return { status: 'OK', result: { draft: { ref: 'D-9', basedOnVersion: 6, status: 'pending', supersedesRef: 'D-8' } } };
        default:
          return { success: true };
      }
    });
    expect(calls.map((c) => c.toolName)).toEqual(['getHire', 'getDraftChain', 'applyPricing', 'getHire', 'proposeDraft', 'updateWorkingMemory']);
    expect(calls[2]!.input).toMatchObject({ draftRef: 'D-8', expectedVersion: 5 });
    expect(calls[4]!.input).toMatchObject({
      intent: 'discount',
      basedOnVersion: 6,
      supersedes: 'D-8',
      actions: [{ type: 'applyPricing', discountPct: 10 }],
      evidenceIds: ['ev-note', 'ev-call'],
      title: 'Pricing + reply to Sam (10% off), revised for v6',
    });
    expect(String((calls[4]!.input.reply as { body: string }).body)).toContain('Note the updated delivery and kit below.');
    expect(String(calls[5]!.input.memory)).toMatch(/- \[decided\] discount: D-8 approved, but the hire moved after the approval\. Regenerated as D-9 for v6/);
    expect(calls.some((c) => c.toolName === 'queueEmail')).toBe(false);
    expect(lastText).toMatch(/D-8 was approved, but the hire moved before it could be applied; regenerated as D-9 against v6/);
  });

  it('control: the same approval with a current hire applies once and sends one email', () => {
    const calls = drive(approval, (c) => {
      switch (c.toolName) {
        case 'getHire':
          return { status: 'OK', result: { hire: hireV(5) } };
        case 'getDraftChain':
          return { status: 'OK', result: { hireVersion: 5, drafts: [D8] } };
        case 'applyPricing':
          return { status: 'OK', result: { version: 6, discountPct: 10, subtotalPence: 385200 } };
        case 'queueEmail':
          return { status: 'OK', result: { outboxId: 'ob-1', to: ['sam'] } };
        default:
          return { success: true };
      }
    });
    expect(calls.map((c) => c.toolName)).toEqual(['getHire', 'getDraftChain', 'applyPricing', 'queueEmail', 'updateWorkingMemory']);
    expect(String(calls[4]!.input.memory)).toMatch(/- \[closed\] discount: D-8 applied: pricing applied, hire now v6/);
    expect(lastText).toBe('Applied D-8 and sent exactly one email (outbox ob-1).');
  });
});

// ---------------------------------------------------------------------------

let lastText = '';

/** Run the scripted desk to the end of its turn, answering each tool call with `respond`. */
function drive(inputs: ReturnType<typeof parseInputs>, respond: (c: ToolCall) => unknown, system = ''): ToolCall[] {
  const results: ToolOutcome[] = [];
  const calls: ToolCall[] = [];
  for (let i = 0; i < 30; i++) {
    const d = decide({ inputs, results, toolNames: TOOLS, system });
    if ('text' in d) {
      lastText = d.text;
      return calls;
    }
    for (const c of d.calls) {
      calls.push(c);
      results.push({ toolCallId: c.toolCallId, toolName: c.toolName, output: respond(c) });
    }
  }
  throw new Error(`desk did not finish: ${calls.map((c) => c.toolName).join(', ')}`);
}

function hireV(version: number) {
  return {
    ref: 'NH-5520',
    version,
    deliveryDate: version >= 6 ? '2026-11-05' : '2026-11-04',
    deliverySlot: 'AM',
    durationDays: 14,
    discountPct: 0,
    damageWaiver: true,
    waiverRatePct: 12,
    transportPence: 18000,
    totalPence: 426000,
    poNumber: version >= 4 ? 'HAL-PO-88213' : null,
    lines: [
      { lineNo: 1, kind: 'boom', model: 'JLG 600AJ', description: '19m articulated boom lift', status: 'booked', weeklyRatePence: 118000, quantity: 1, fleetNo: 'AB19-07' },
      { lineNo: 2, kind: 'telehandler', model: 'Manitou MT 1840', description: '17m telehandler', status: 'booked', weeklyRatePence: 86000, quantity: 1, fleetNo: 'TH17-05' },
    ],
    siteContact: { name: 'Sam Fletcher', email: 'sam.fletcher@haldenbuild.co.uk' },
    threads: [{ label: 'T1', subject: 'NH-5520 Riverside Yard – boom + telehandler', contactEmail: 'sam.fletcher@haldenbuild.co.uk' }],
  };
}
