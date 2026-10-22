import type { LanguageModelV2Prompt } from '@ai-sdk/provider';

/** A signal or message as the desk sees it: `<tag k="v">contents</tag>`. */
export type DeskInput = { index: number; tag: string; attrs: Record<string, string>; contents: string; raw: string };
export type ToolOutcome = { toolCallId: string; toolName: string; output: unknown };

const TAG_RE = /<([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.-]*="[^"]*")*)\s*>([\s\S]*?)<\/\1>/g;
const ATTR_RE = /([A-Za-z_][\w.-]*)="([^"]*)"/g;

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parseInputs(text: string, startIndex: number): DeskInput[] {
  const out: DeskInput[] = [];
  for (const m of text.matchAll(TAG_RE)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? '').matchAll(ATTR_RE)) attrs[a[1]!] = unescape(a[2]!);
    out.push({ index: startIndex + out.length, tag: m[1]!, attrs, contents: unescape(m[3]!.trim()), raw: m[0] });
  }
  if (!out.length && text.trim()) out.push({ index: startIndex, tag: 'user', attrs: {}, contents: text.trim(), raw: text });
  return out;
}

/**
 * Split the prompt into the current turn: the inputs that arrived since the
 * desk last finished (an assistant message with text and no tool calls), and
 * the tool results produced since then.
 */
export function currentTurn(prompt: LanguageModelV2Prompt): { inputs: DeskInput[]; results: ToolOutcome[]; system: string } {
  let start = 0;
  prompt.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    const hasCall = m.content.some((p) => p.type === 'tool-call');
    const hasText = m.content.some((p) => p.type === 'text' && p.text.trim());
    if (hasText && !hasCall) start = i + 1;
  });
  const inputs: DeskInput[] = [];
  const results: ToolOutcome[] = [];
  const system = prompt
    .filter((m) => m.role === 'system')
    .map((m) => (m.role === 'system' ? m.content : ''))
    .join('\n');
  for (const m of prompt.slice(start)) {
    if (m.role === 'user') {
      const text = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
      inputs.push(...parseInputs(text, inputs.length));
    } else if (m.role === 'tool') {
      for (const p of m.content) {
        if (p.type !== 'tool-result') continue;
        const o = p.output;
        const value =
          o.type === 'json' || o.type === 'error-json'
            ? o.value
            : o.type === 'text' || o.type === 'error-text'
              ? safeJson(o.value)
              : o;
        results.push({ toolCallId: p.toolCallId, toolName: p.toolName, output: value });
      }
    }
  }
  return { inputs, results, system };
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
};
