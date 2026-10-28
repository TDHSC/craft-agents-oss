import * as React from 'react'
import type { Message } from '@craft-agent/core'
import type { FileAttachment } from '../../../../shared/types'
import type { RichTextInputHandle } from '@/components/ui/rich-text-input'
import { hasOpenOverlay } from '@/lib/overlay-detection'
import { FreeFormInput, type FreeFormInputProps } from '../input/FreeFormInput'
import { shouldCancelInlineEdit } from './inline-edit-guards'

/**
 * The composer settings the inline editor shares with the session's bottom composer.
 *
 * `sessionId` is left out on purpose: with it, this composer would also run the session's
 * pending-plan dispatcher and take session-targeted insert/paste/focus/submit events meant for
 * the bottom composer.
 */
export type InlinePromptEditorInputProps = Pick<
  FreeFormInputProps,
  | 'currentModel'
  | 'onModelChange'
  | 'thinkingLevel'
  | 'onThinkingLevelChange'
  | 'sources'
  | 'enabledSourceSlugs'
  | 'onSourcesChange'
  | 'skills'
  | 'workspaceId'
  | 'workingDirectory'
  | 'currentConnection'
  | 'onConnectionChange'
  | 'disableSend'
>

interface InlinePromptEditorProps {
  /** The sent user message being edited */
  message: Message
  /** Settings and pickers shared with the bottom composer */
  inputProps: InlinePromptEditorInputProps
  /** Leave edit mode without sending (Esc, click outside) */
  onCancel: () => void
  /** Send the edited content in place of the original message */
  onSubmit: (messageId: string, text: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void
}

/** Stored attachments back to sendable ones; files that moved or vanished are dropped. */
async function hydrateAttachments(message: Message): Promise<FileAttachment[]> {
  const stored = message.attachments ?? []
  const results = await Promise.all(
    stored.map(async (attachment) => {
      try {
        return await window.electronAPI.readUserAttachment(attachment.storedPath)
      } catch (error) {
        console.warn('[InlinePromptEditor] Failed to restore attachment, dropping:', attachment.storedPath, error)
        return null
      }
    }),
  )
  return results.filter((a): a is FileAttachment => a !== null)
}

/**
 * Edit-and-resend composer: a user bubble expanded in place into the same composer as the bottom
 * input (model picker, attachments, @mentions, send button). Nothing is sent until the user
 * submits, so a running turn is not touched while editing; Esc or a click outside puts the bubble
 * back unchanged.
 *
 * `isProcessing` stays false on purpose: even with a turn streaming below, the composer's
 * primary action is Send (↑), never Stop.
 */
export function InlinePromptEditor({ message, inputProps, onCancel, onSubmit }: InlinePromptEditorProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<RichTextInputHandle>(null)
  const [attachments, setAttachments] = React.useState<FileAttachment[] | null>(
    message.attachments?.length ? null : [],
  )

  React.useEffect(() => {
    if (attachments !== null) return
    let cancelled = false
    void hydrateAttachments(message).then((restored) => {
      if (!cancelled) setAttachments(restored)
    })
    return () => { cancelled = true }
  }, [message, attachments])

  // Put the caret at the end of the restored text once the composer is mounted.
  React.useEffect(() => {
    if (attachments === null) return
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      const end = input.value.length
      input.setSelectionRange(end, end)
    })
    return () => cancelAnimationFrame(frame)
  }, [attachments === null])

  // Click outside leaves edit mode. Menus and dialogs opened from the composer render in portals
  // outside this element, so clicks while one is open belong to that overlay.
  React.useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (shouldCancelInlineEdit({
        insideEditor: !!rootRef.current?.contains(event.target as Node | null),
        overlayOpen: hasOpenOverlay(),
      })) onCancel()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [onCancel])

  // Bubble phase on purpose: the composer's own menus (@mention, slash, labels) close on Esc and
  // mark the event handled first, so Esc only leaves edit mode when nothing else wanted it.
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    if (hasOpenOverlay()) return
    event.stopPropagation()
    onCancel()
  }

  if (attachments === null) {
    // Attachments are being restored from disk; hold the composer's place so the transcript does not jump.
    return <div className="min-h-[76px] w-full rounded-xl bg-raised shadow-elev-2" aria-busy="true" />
  }

  return (
    <div ref={rootRef} className="w-full min-w-0" onKeyDown={handleKeyDown} data-inline-prompt-editor>
      <FreeFormInput
        {...inputProps}
        inlineEditor
        inputRef={inputRef}
        isProcessing={false}
        inputValue={message.content}
        attachmentsValue={attachments}
        placeholder=""
        onSubmit={(text, sentAttachments, skillSlugs) => onSubmit(message.id, text, sentAttachments, skillSlugs)}
      />
    </div>
  )
}
