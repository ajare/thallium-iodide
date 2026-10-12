const MAX_CHARACTERS = 128 * 1024;
const MAX_LINES = 1000;

function bounded(text: string): string {
  return text.slice(-MAX_CHARACTERS).split('\n').slice(-MAX_LINES).join('\n');
}
function pretty(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
}

// Keep raw input separate from rendered output: SSE chunks can split JSON anywhere.
export class TailOutput {
  private raw = '';
  constructor(private filename = '') {}
  clear(): void { this.raw = ''; }
  // The unformatted stream content, for views that parse instead of display (e.g. the JSONL timeline).
  rawText(): string { return this.raw; }
  append(chunk: string): string {
    this.raw = bounded(this.raw + chunk);
    const extension = this.filename.toLowerCase().split('.').pop();
    const formatted = extension === 'json' ? pretty(this.raw) : extension === 'jsonl'
      ? this.raw.split('\n').map(line => line.trim() ? pretty(line) : line).join('\n')
      : this.raw;
    return bounded(formatted);
  }
}
