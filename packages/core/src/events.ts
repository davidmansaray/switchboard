import { z } from 'zod';

export const EVENT_TYPES = [
  'email.received',
  'note.created',
  'hire.updated',
  'status.changed',
  'approval.decided',
  'schedule.fired',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const eventSource = z.enum(['customer', 'staff', 'agent', 'system', 'schedule']);
export type EventSource = z.infer<typeof eventSource>;

export const emailReceivedPayload = z.object({
  emailId: z.string(),
  threadLabel: z.string(),
  from: z.string(),
  subject: z.string(),
  body: z.string(),
});
export const noteCreatedPayload = z.object({
  noteId: z.string(),
  author: z.string(),
  body: z.string(),
  mentions: z.array(z.string()),
});
export const hireUpdatedPayload = z.object({
  fromVersion: z.number().int(),
  toVersion: z.number().int(),
  fields: z.array(z.string()),
  summary: z.string(),
});
export const statusChangedPayload = z.object({
  lineNo: z.number().int().optional(),
  from: z.string(),
  to: z.string(),
  toVersion: z.number().int(),
});
export const approvalDecidedPayload = z.object({
  approvalId: z.string(),
  draftRef: z.string(),
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string(),
  basedOnVersion: z.number().int(),
  hireVersion: z.number().int(),
});
export const scheduleFiredPayload = z.object({ scheduleId: z.string(), name: z.string() });

export const MENTION = '@assistant';
export const hasAssistantMention = (body: string, mentions: readonly string[] = []) =>
  mentions.includes('assistant') || body.toLowerCase().includes(MENTION);
