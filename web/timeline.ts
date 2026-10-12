// Parses tailed JSONL session logs into timeline events split into inference and tool calls.
export type TimelineEvent = {
  id: string;
  kind: 'inference' | 'tool';
  at: number | null;
  endAt: number | null;
  title: string;
  summary: string;
  detail: string;
  meta: string[];
  error: boolean;
};

type Entry = Record<string, any>;

function timestampOf(entry: Entry, message?: Entry): number | null {
  if (typeof entry.timestamp === 'string') {
    const parsed = Date.parse(entry.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof message?.timestamp === 'number') return message.timestamp;
  return null;
}

function textParts(message: Entry, type: string): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((part: Entry) => part?.type === type && typeof part[type === 'thinking' ? 'thinking' : 'text'] === 'string')
    .map((part: Entry) => String(part[type === 'thinking' ? 'thinking' : 'text']));
}

function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? flat.slice(0, length - 1) + '…' : flat;
}

function inferenceEvent(entry: Entry, message: Entry, index: number): TimelineEvent {
  const thinking = textParts(message, 'thinking');
  const text = textParts(message, 'text');
  const toolNames = Array.isArray(message.content)
    ? (message.content as Entry[]).filter(part => part?.type === 'toolCall').map(part => String(part.name ?? 'tool')) : [];
  const fallback = toolNames.length ? `Called ${toolNames.join(', ')}` : 'No text output';
  const usage = typeof message.usage === 'object' && message.usage ? message.usage : {};
  const meta: string[] = [];
  if (message.stopReason) meta.push(`stop: ${message.stopReason}`);
  if (typeof usage.input === 'number' || typeof usage.output === 'number') meta.push(`tokens in ${usage.input ?? 0} · out ${usage.output ?? 0}`);
  const detail = [...thinking.map(t => `THINKING\n${t}`), ...text].join('\n\n');
  return {
    id: String(entry.id ?? `inference-${index}`),
    kind: 'inference',
    at: timestampOf(entry, message),
    endAt: null,
    title: typeof message.model === 'string' ? message.model : 'assistant turn',
    summary: clip(text[0] ?? thinking[0] ?? '', 140) || fallback,
    detail: detail || fallback,
    meta,
    error: message.stopReason === 'error'
  };
}

function argumentSummary(name: string, args: Entry): string {
  if (typeof args?.command === 'string') return clip(args.command, 120);
  if (typeof args?.path === 'string') return clip(args.path, 120);
  try { return clip(JSON.stringify(args ?? {}), 120); } catch { return name; }
}

export function parseTimeline(raw: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const tools = new Map<string, TimelineEvent>();
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    // A tail chunk can split JSON anywhere; the final fragment parses on a later append.
    let entry: Entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'message' || typeof entry.message !== 'object' || !entry.message) continue;
    const message = entry.message as Entry;
    if (message.role === 'assistant') {
      events.push(inferenceEvent(entry, message, index));
      if (Array.isArray(message.content)) {
        for (const part of message.content as Entry[]) {
          if (part?.type !== 'toolCall') continue;
          const name = typeof part.name === 'string' ? part.name : 'tool';
          const at = timestampOf(entry, message);
          const event: TimelineEvent = {
            id: String(part.id ?? `tool-${index}-${events.length}`),
            kind: 'tool',
            at,
            endAt: null,
            title: name,
            summary: argumentSummary(name, typeof part.arguments === 'object' ? part.arguments : {}),
            detail: `ARGUMENTS\n${JSON.stringify(part.arguments ?? {}, null, 2)}`,
            meta: [],
            error: false
          };
          tools.set(event.id, event);
          events.push(event);
        }
      }
    } else if (message.role === 'toolResult') {
      const event = tools.get(String(message.toolCallId));
      if (!event) continue;
      const resultText = textParts(message, 'text').join('\n\n');
      event.detail += `\n\nRESULT\n${resultText || 'No output'}`;
      event.error = message.isError === true;
      const finishedAt = timestampOf(entry, message);
      if (event.at != null && finishedAt != null && finishedAt >= event.at) {
        event.endAt = finishedAt;
        event.meta.push(`${((finishedAt - event.at) / 1000).toFixed(1)}s`);
      }
      if (event.error) event.meta.push('error');
    }
  }
  return events;
}
