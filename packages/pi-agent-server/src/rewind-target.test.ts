import { describe, expect, it } from 'bun:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { firstUserEntryId } from './rewind-target.ts';

describe('firstUserEntryId', () => {
  it('finds the first user message behind the settings entries a new session opens with', () => {
    // What createAgentSession() writes for a new session before the first prompt.
    const sm = SessionManager.inMemory('/tmp');
    sm.appendModelChange('anthropic', 'claude-test');
    sm.appendThinkingLevelChange('medium');
    const first = sm.appendMessage({ role: 'user', content: 'first', timestamp: 1 } as never);
    sm.appendMessage({ role: 'user', content: 'second', timestamp: 2 } as never);

    expect(firstUserEntryId(sm.getBranch())).toBe(first);
    // The old lookup ("user entry without a parent") found nothing here.
    expect(sm.getEntry(first)?.parentId).not.toBeNull();
  });

  it('follows the active branch, not an abandoned one', () => {
    const sm = SessionManager.inMemory('/tmp');
    sm.appendThinkingLevelChange('medium');
    const settings = sm.getLeafId()!;
    sm.appendMessage({ role: 'user', content: 'old', timestamp: 1 } as never);
    sm.branch(settings);
    const edited = sm.appendMessage({ role: 'user', content: 'edited', timestamp: 2 } as never);

    expect(firstUserEntryId(sm.getBranch())).toBe(edited);
  });

  it('returns null when the branch holds no conversation yet', () => {
    const sm = SessionManager.inMemory('/tmp');
    sm.appendThinkingLevelChange('medium');
    expect(firstUserEntryId(sm.getBranch())).toBeNull();
  });
});
