import type { SessionToolContext, SessionTranscriptMessage } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface GetSessionMessagesArgs {
  sessionId?: string;
  fromMessageId?: string;
  beforeMessageId?: string;
  afterFork?: boolean;
  limit?: number;
  includeToolResults?: boolean;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const MAX_TOOL_RESULT_CHARS = 2000;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function toolLines(entry: SessionTranscriptMessage, includeResults: boolean): string[] {
  const intent = entry.toolIntent ? oneLine(entry.toolIntent) : '';
  const lines = [`  → ${entry.toolName ?? 'tool'}${intent ? `: ${intent}` : ''}`];
  if (includeResults && entry.toolResult) {
    const result = entry.toolResult.length > MAX_TOOL_RESULT_CHARS
      ? `${entry.toolResult.slice(0, MAX_TOOL_RESULT_CHARS)}… (truncated)`
      : entry.toolResult;
    lines.push(...result.split('\n').map(line => `    ${line}`));
  }
  return lines;
}

export async function handleGetSessionMessages(
  ctx: SessionToolContext,
  args: GetSessionMessagesArgs
): Promise<ToolResult> {
  if (!ctx.getSessionMessages) {
    return errorResponse('get_session_messages is not available in this context.');
  }

  const anchors = [args.fromMessageId, args.beforeMessageId, args.afterFork ? 'afterFork' : undefined].filter(Boolean);
  if (anchors.length > 1) {
    return errorResponse('Pass at most one of fromMessageId, beforeMessageId and afterFork.');
  }

  const requested = Number.isFinite(args.limit) ? Math.floor(args.limit!) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
  const targetId = args.sessionId?.trim() || ctx.sessionId;

  try {
    const transcript = await ctx.getSessionMessages(targetId);
    if (!transcript) {
      return errorResponse(`Session not found in this workspace: ${targetId}`);
    }

    const { messages } = transcript;
    const last = messages.length - 1;
    // Only user/assistant entries count as messages; tool entries are summary lines between them.
    const counted: number[] = [];
    messages.forEach((m, i) => { if (m.role !== 'tool') counted.push(i); });

    const indexOfAnchor = (id: string): number => messages.findIndex(m => m.id === id);
    let start: number;
    let end = last;
    if (args.fromMessageId || args.afterFork) {
      if (args.afterFork) {
        if (transcript.forkIndex === undefined) {
          return errorResponse(`Session ${targetId} is not a forked session; afterFork does not apply.`);
        }
        start = transcript.forkIndex;
      } else {
        start = indexOfAnchor(args.fromMessageId!);
        if (start < 0) return errorResponse(`Message not found in session ${targetId}: ${args.fromMessageId}`);
      }
      const ahead = counted.filter(i => i >= start);
      if (ahead.length > limit) end = ahead[limit - 1]!;
    } else if (args.beforeMessageId) {
      const anchor = indexOfAnchor(args.beforeMessageId);
      if (anchor < 0) return errorResponse(`Message not found in session ${targetId}: ${args.beforeMessageId}`);
      end = anchor - 1;
      const behind = counted.filter(i => i < anchor);
      start = behind.length > limit ? behind[behind.length - limit]! : 0;
    } else {
      start = counted.length > limit ? counted[counted.length - limit]! : 0;
    }

    const out: string[] = [
      `Session "${transcript.name}" (${transcript.id}) · status: ${transcript.status} · ${transcript.isProcessing ? 'running' : 'idle'}`,
    ];
    if (transcript.forkIndex !== undefined) {
      const copied = counted.filter(i => i < transcript.forkIndex!).length;
      out.push(`Forked from another session: the first ${copied} of ${counted.length} messages were copied from the parent (pass afterFork: true to skip them).`);
    }
    if (messages.length === 0) {
      out.push('', 'No messages yet.');
      return successResponse(out.join('\n'));
    }

    const shown = counted.filter(i => i >= start && i <= end);
    const firstNumber = counted.filter(i => i < start).length + 1;
    out.push(shown.length > 0
      ? `Showing messages ${firstNumber}–${firstNumber + shown.length - 1} of ${counted.length}`
      : `Showing no messages of ${counted.length}`);

    // Tool entries print as summary lines in their real position; a run of them that ends in an
    // assistant reply sits under that reply's header.
    let tools: string[] = [];
    for (let i = start; i <= end; i++) {
      const entry = messages[i]!;
      if (entry.role === 'tool') {
        tools.push(...toolLines(entry, args.includeToolResults === true));
        continue;
      }
      out.push('');
      if (entry.role === 'user') {
        if (tools.length) { out.push(...tools); tools = []; }
        out.push(`[User · ${entry.id}]`);
      } else {
        out.push(`[Assistant · ${entry.id}]${entry.isStreaming ? ' · still generating' : ''}`);
        if (tools.length) { out.push(...tools); tools = []; }
      }
      if (entry.content) out.push(entry.content);
    }
    if (tools.length) out.push('', ...tools);

    const cursors: string[] = [];
    if (start > 0 && start <= last) cursors.push(`Earlier: beforeMessageId="${messages[start]!.id}"`);
    if (end < last) cursors.push(`Later: fromMessageId="${messages[end + 1]!.id}"`);
    if (cursors.length) out.push('', ...cursors);

    return successResponse(out.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to get session messages: ${message}`);
  }
}
