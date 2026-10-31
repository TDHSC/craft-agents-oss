import { describe, it, expect } from 'bun:test';
import { handleGetSessionMessages } from './get-session-messages.ts';
import type { SessionToolContext, SessionTranscript, SessionTranscriptMessage } from '../context.ts';

const textOf = (res: { content: Array<{ text?: string }> }) => res.content.map(c => c.text ?? '').join('\n');

const user = (id: string, content: string): SessionTranscriptMessage => ({ id, role: 'user', content });
const assistant = (id: string, content: string, extra?: Partial<SessionTranscriptMessage>): SessionTranscriptMessage => ({ id, role: 'assistant', content, ...extra });
const tool = (id: string, toolName: string, toolIntent?: string, toolResult?: string): SessionTranscriptMessage => ({ id, role: 'tool', content: '', toolName, toolIntent, toolResult });

// u1 a1 · u2 [t1] a2 · u3 a3 · u4 a4 (u1..a4 = 8 counted messages)
const MESSAGES: SessionTranscriptMessage[] = [
  user('u1', 'first question'), assistant('a1', 'first answer'),
  user('u2', 'second question'), tool('t1', 'Bash', 'run the tests', 'ok\n12 passed'), assistant('a2', 'second answer'),
  user('u3', 'third question'), assistant('a3', 'third answer'),
  user('u4', 'fourth question'), assistant('a4', 'fourth answer'),
];

function createCtx(transcript: Partial<SessionTranscript> | null, opts?: { omit?: boolean }) {
  const calls: string[] = [];
  const ctx = {
    sessionId: 'self-1',
    getSessionMessages: opts?.omit ? undefined : async (id: string) => {
      calls.push(id);
      return transcript ? { id, name: 'Planning', status: 'in_progress', isProcessing: false, messages: MESSAGES, ...transcript } : null;
    },
  } as unknown as SessionToolContext;
  return { ctx, calls };
}

describe('handleGetSessionMessages', () => {
  it('errors when the callback is unavailable', async () => {
    const res = await handleGetSessionMessages(createCtx(null, { omit: true }).ctx, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('not available');
  });

  it('reads the own session when sessionId is omitted', async () => {
    const { ctx, calls } = createCtx({});
    await handleGetSessionMessages(ctx, {});
    expect(calls).toEqual(['self-1']);
  });

  it('errors for a missing or foreign session', async () => {
    const res = await handleGetSessionMessages(createCtx(null).ctx, { sessionId: 'nope' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Session not found in this workspace: nope');
  });

  it('rejects more than one of fromMessageId / beforeMessageId / afterFork', async () => {
    const { ctx } = createCtx({ forkIndex: 2 });
    expect((await handleGetSessionMessages(ctx, { fromMessageId: 'u1', beforeMessageId: 'u3' })).isError).toBe(true);
    expect((await handleGetSessionMessages(ctx, { fromMessageId: 'u1', afterFork: true })).isError).toBe(true);
  });

  it('errors on an unknown anchor id and on afterFork without a fork', async () => {
    const { ctx } = createCtx({});
    const unknown = await handleGetSessionMessages(ctx, { fromMessageId: 'zzz' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('zzz');
    expect((await handleGetSessionMessages(ctx, { beforeMessageId: 'zzz' })).isError).toBe(true);
    const noFork = await handleGetSessionMessages(ctx, { afterFork: true });
    expect(noFork.isError).toBe(true);
    expect(textOf(noFork)).toContain('not a forked session');
  });

  it('shows the latest 5 messages by default with an Earlier cursor', async () => {
    const text = textOf(await handleGetSessionMessages(createCtx({}).ctx, {}));
    expect(text).toContain('Session "Planning" (self-1) · status: in_progress · idle');
    expect(text).toContain('Showing messages 4–8 of 8');
    expect(text).toContain('[Assistant · a2]');
    expect(text).not.toContain('[User · u2]');
    expect(text).toContain('Earlier: beforeMessageId="a2"');
    expect(text).not.toContain('Later:');
  });

  it('prints tool entries as one-line summaries without counting them', async () => {
    const text = textOf(await handleGetSessionMessages(createCtx({}).ctx, { limit: 8 }));
    expect(text).toContain('Showing messages 1–8 of 8');
    expect(text).toContain('  → Bash: run the tests');
    expect(text).not.toContain('12 passed');
    expect(text.indexOf('[User · u2]')).toBeLessThan(text.indexOf('→ Bash'));
    expect(text.indexOf('[Assistant · a2]')).toBeLessThan(text.indexOf('→ Bash'));
    expect(text.indexOf('→ Bash')).toBeLessThan(text.indexOf('second answer'));
    expect(text).not.toContain('Earlier:');
  });

  it('includes truncated tool results on request', async () => {
    const long = tool('t9', 'Read', 'read big file', 'x'.repeat(5000));
    const { ctx } = createCtx({ messages: [user('u1', 'q'), long, assistant('a1', 'done')] });
    const withResult = textOf(await handleGetSessionMessages(ctx, { includeToolResults: true }));
    expect(withResult).toContain('… (truncated)');
    expect(withResult.length).toBeLessThan(2600);
    expect(textOf(await handleGetSessionMessages(ctx, {}))).not.toContain('xxxx');
    const small = createCtx({}).ctx;
    expect(textOf(await handleGetSessionMessages(small, { limit: 8, includeToolResults: true }))).toContain('    12 passed');
  });

  it('pages forward from fromMessageId without skipping entries', async () => {
    const { ctx } = createCtx({});
    const first = textOf(await handleGetSessionMessages(ctx, { fromMessageId: 'u2', limit: 2 }));
    expect(first).toContain('Showing messages 3–4 of 8');
    expect(first).toContain('→ Bash');
    expect(first).toContain('[Assistant · a2]');
    expect(first).not.toContain('[User · u3]');
    expect(first).toContain('Earlier: beforeMessageId="u2"');
    expect(first).toContain('Later: fromMessageId="u3"');

    const second = textOf(await handleGetSessionMessages(ctx, { fromMessageId: 'u3', limit: 2 }));
    expect(second).toContain('Showing messages 5–6 of 8');
    expect(second).toContain('Later: fromMessageId="u4"');
  });

  it('pages backward from beforeMessageId', async () => {
    const text = textOf(await handleGetSessionMessages(createCtx({}).ctx, { beforeMessageId: 'u3', limit: 2 }));
    expect(text).toContain('Showing messages 3–4 of 8');
    expect(text).not.toContain('[Assistant · a1]');
    expect(text).toContain('[User · u2]');
    expect(text).toContain('→ Bash');
    expect(text).toContain('[Assistant · a2]');
    expect(text).not.toContain('[User · u3]');
    expect(text).toContain('Earlier: beforeMessageId="u2"');
    expect(text).toContain('Later: fromMessageId="u3"');
  });

  it('clamps the limit', async () => {
    const { ctx } = createCtx({});
    expect(textOf(await handleGetSessionMessages(ctx, { limit: 0 }))).toContain('Showing messages 8–8 of 8');
    expect(textOf(await handleGetSessionMessages(ctx, { limit: 999 }))).toContain('Showing messages 1–8 of 8');
  });

  it('skips the copied part with afterFork and says how much was copied', async () => {
    const { ctx } = createCtx({ forkIndex: 5 }); // u1 a1 u2 t1 a2 were copied
    const text = textOf(await handleGetSessionMessages(ctx, { afterFork: true, limit: 2 }));
    expect(text).toContain('Forked from another session: the first 4 of 8 messages were copied from the parent (pass afterFork: true to skip them).');
    expect(text).toContain('Showing messages 5–6 of 8');
    expect(text).toContain('[User · u3]');
    expect(text).not.toContain('[Assistant · a2]');
    expect(text).toContain('Earlier: beforeMessageId="u3"');
    expect(text).toContain('Later: fromMessageId="u4"');
  });

  it('marks a running session and a streaming reply, keeping trailing tool lines', async () => {
    const { ctx } = createCtx({
      isProcessing: true,
      messages: [user('u1', 'go'), assistant('a1', 'partial', { isStreaming: true }), tool('t2', 'Grep', 'find usages')],
    });
    const text = textOf(await handleGetSessionMessages(ctx, {}));
    expect(text).toContain('· running');
    expect(text).toContain('[Assistant · a1] · still generating');
    expect(text.trimEnd().endsWith('→ Grep: find usages')).toBe(true);
  });

  it('handles an empty transcript', async () => {
    const text = textOf(await handleGetSessionMessages(createCtx({ messages: [] }).ctx, {}));
    expect(text).toContain('No messages yet.');
  });
});
