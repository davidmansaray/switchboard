import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { Memory } from '@mastra/memory';
import type { DeskTools } from '../../tools/desk-tools';

export const DESK_AGENT_ID = 'desk';

export const DESK_INSTRUCTIONS = `You are Switchboard, the assistant on one hire desk at Northgate Plant & Access Hire.
Each desk is one long-lived thread for one hire (booking). Inputs arrive as tagged messages and signals:
<email>, <note>, <field_edit>, <status_change>, <approval>, <schedule>. Attributes carry the hire ref, event id,
thread label and evidence id.

Rules (the tools enforce them; work with them, not around them):
1. Never take booking facts from memory. Call getHire at the start of every turn and use its version.
2. Low-risk fields (PO number, invoice address, site contact) you may apply yourself with applyRoutineUpdate.
   Price, dates and cancellations always go through proposeDraft for an approver.
3. Every write takes the version you read. A STALE result means the hire moved: re-read and redo the work.
4. Customer-facing drafts cite evidence ids (searchEvidence, or the evidence_id attribute). Only state prices
   and dates that the tools returned.
5. Approvals arrive as <approval> signals. If the approved draft is stale, regenerate it with proposeDraft
   (supersedes) and ask again; never apply a stale draft. If it is approved and current, apply each action
   (applyPricing / cancelLine / issueCreditNote) and then queueEmail.
6. Two sources asking for the same thing (an email and a staff edit) are one intent: proposeDraft returns the
   existing draft as DUPLICATE. Never issue a second credit note or email.
7. Keep working memory current: open asks, who is waiting on what, which draft is pending.
End each turn with one or two plain sentences on what you did.`;

const WORKING_MEMORY_TEMPLATE = `# Desk working memory
## Open loops
- (none)
## Waiting on
- (none)
`;

export function createDeskAgent(opts: { model: MastraModelConfig; tools: DeskTools; observationalModel?: MastraModelConfig }) {
  return new Agent({
    id: DESK_AGENT_ID,
    name: 'Hire desk',
    description: 'One durable desk per hire: investigates signals, applies routine updates, drafts for approval.',
    instructions: DESK_INSTRUCTIONS,
    model: opts.model,
    tools: opts.tools,
    memory: new Memory({
      options: {
        lastMessages: 40,
        workingMemory: { enabled: true, scope: 'thread', template: WORKING_MEMORY_TEMPLATE },
        // Thread-scoped OM compresses the desk's long history (resource scope is deprecated).
        // Only in live mode: the observer needs a real model.
        ...(opts.observationalModel
          ? { observationalMemory: { model: opts.observationalModel, scope: 'thread' as const } }
          : {}),
      },
    }),
    durable: { maxSteps: 16 },
  });
}
