/**
 * Utilities for parsing [bracket] mentions from chat messages
 *
 * Mention types:
 * - Skills:  [skill:slug]
 * - Sources: [source:slug]
 * - Sessions: [session:id], quotes: [session:id:messageId]
 *
 * Bracket syntax allows mentions anywhere in text without word boundaries.
 */

import type { ContentBadge } from '@craft-agent/core'
import type { MentionItemType } from '@/components/ui/mention-menu'
import type { LoadedSkill, LoadedSource } from '../../shared/types'
import { AGENTS_PLUGIN_NAME } from '@craft-agent/shared/skills/types'
import { getSourceIconSync, getSkillIconSync } from './icon-cache'
import { getSessionTitle } from '@/utils/session'
import type { SessionMeta } from '@/atoms/sessions'

// Import and re-export parsing functions from shared (pure string operations, no renderer deps)
import { parseMentions, stripAllMentions, resolveSkillMentions, resolveSourceMentions, resolveSessionMentions, SESSION_MENTION_PATTERN, type ParsedMentions } from '@craft-agent/shared/mentions'
export { parseMentions, stripAllMentions, resolveSkillMentions, resolveSourceMentions, resolveSessionMentions, type ParsedMentions }

// ============================================================================
// Constants
// ============================================================================

// Workspace ID character class for regex: word chars, spaces (NOT newlines), hyphens, dots
// Using literal space instead of \s to avoid matching newlines which would break parsing
const WS_ID_CHARS = '[\\w .-]'

// ============================================================================
// Types
// ============================================================================

export interface MentionMatch {
  type: MentionItemType
  id: string
  /** Full match text including @ prefix */
  fullMatch: string
  /** Start index in the original text */
  startIndex: number
  /** Message ID for quote tokens ([session:id:messageId]) */
  messageId?: string
}

// ============================================================================
// Matching Functions (renderer-specific, use MentionItemType)
// ============================================================================

/**
 * Find all mention matches in text with their positions
 *
 * @param text - The message text to search
 * @param availableSkillSlugs - Valid skill slugs
 * @param availableSourceSlugs - Valid source slugs
 * @returns Array of mention matches with positions
 */
export function findMentionMatches(
  text: string,
  availableSkillSlugs: string[],
  availableSourceSlugs: string[]
): MentionMatch[] {
  const matches: MentionMatch[] = []

  // Match source mentions: [source:slug]
  const sourcePattern = /(\[source:([\w-]+)\])/g
  let match
  while ((match = sourcePattern.exec(text)) !== null) {
    const slug = match[2]
    if (availableSourceSlugs.includes(slug)) {
      matches.push({
        type: 'source',
        id: slug,
        fullMatch: match[1],
        startIndex: match.index,
      })
    }
  }

  // Match skill mentions: [skill:slug] or [skill:workspaceId:slug]
  // The pattern captures the full match and extracts the slug (last component)
  // Workspace IDs can contain spaces, hyphens, underscores, and dots
  const skillPattern = new RegExp(`(\\[skill:(?:${WS_ID_CHARS}+:)?([\\w-]+)\\])`, 'g')
  while ((match = skillPattern.exec(text)) !== null) {
    const slug = match[2]
    if (availableSkillSlugs.includes(slug)) {
      matches.push({
        type: 'skill',
        id: slug,
        fullMatch: match[1],
        startIndex: match.index,
      })
    }
  }

  // Match file mentions: [file:path]
  const filePattern = /(\[file:([^\]]+)\])/g
  while ((match = filePattern.exec(text)) !== null) {
    matches.push({
      type: 'file',
      id: match[2],
      fullMatch: match[1],
      startIndex: match.index,
    })
  }

  // Match folder mentions: [folder:path]
  const folderPattern = /(\[folder:([^\]]+)\])/g
  while ((match = folderPattern.exec(text)) !== null) {
    matches.push({
      type: 'folder',
      id: match[2],
      fullMatch: match[1],
      startIndex: match.index,
    })
  }

  // Match session mentions and quotes: [session:id] or [session:id:messageId]
  const sessionPattern = new RegExp(`(${SESSION_MENTION_PATTERN})`, 'g')
  while ((match = sessionPattern.exec(text)) !== null) {
    matches.push({
      type: match[3] ? 'quote' : 'session',
      id: match[2],
      fullMatch: match[1],
      startIndex: match.index,
      messageId: match[3],
    })
  }

  // Sort by position
  return matches.sort((a, b) => a.startIndex - b.startIndex)
}

/**
 * Remove a specific mention from text
 *
 * @param text - The message text
 * @param type - Type of mention to remove
 * @param id - ID of the mention (slug or path)
 * @returns Text with the mention removed
 */
export function removeMention(text: string, type: MentionItemType, id: string): string {
  let pattern: RegExp

  switch (type) {
    case 'source':
      pattern = new RegExp(`\\[source:${escapeRegExp(id)}\\]`, 'g')
      break
    case 'file':
      pattern = new RegExp(`\\[file:${escapeRegExp(id)}\\]`, 'g')
      break
    case 'folder':
      pattern = new RegExp(`\\[folder:${escapeRegExp(id)}\\]`, 'g')
      break
    case 'session':
      pattern = new RegExp(`\\[session:${escapeRegExp(id)}\\]`, 'g')
      break
    case 'quote':
      pattern = new RegExp(`\\[session:${escapeRegExp(id)}:[\\w-]+\\]`, 'g')
      break
    case 'skill':
    default:
      // Match both [skill:slug] and [skill:workspaceId:slug]
      // Workspace IDs can contain spaces, hyphens, underscores, and dots
      pattern = new RegExp(`\\[skill:(?:${WS_ID_CHARS}+:)?${escapeRegExp(id)}\\]`, 'g')
      break
  }

  return text
    .replace(pattern, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Check if text contains any valid mentions
 */
export function hasMentions(
  text: string,
  availableSkillSlugs: string[],
  availableSourceSlugs: string[]
): boolean {
  const mentions = parseMentions(text, availableSkillSlugs, availableSourceSlugs)
  return mentions.skills.length > 0 || mentions.sources.length > 0 || mentions.files.length > 0 || mentions.folders.length > 0 || mentions.sessions.length > 0
}

// ============================================================================
// Legacy compatibility - parseSkillMentions
// ============================================================================

/**
 * Extract valid [skill:...] mentions from message text (legacy API)
 *
 * @deprecated Use parseMentions() instead
 */
export function parseSkillMentions(text: string, availableSlugs: string[]): string[] {
  return parseMentions(text, availableSlugs, []).skills
}

/**
 * Remove [bracket] mentions from message text (legacy API)
 *
 * @deprecated Use stripAllMentions() instead
 */
export function stripSkillMentions(text: string): string {
  return stripAllMentions(text)
}

// ============================================================================
// Badge Extraction
// ============================================================================

/**
 * Extract ContentBadge array from message text.
 * Used when sending messages to store badge metadata for display.
 *
 * Each badge is self-contained with label, icon (base64), and position.
 *
 * @param text - Message text with mentions
 * @param skills - Available skills (for label lookup)
 * @param sources - Available sources (for label lookup)
 * @param workspaceId - Workspace ID (for icon lookup)
 * @param sessions - Workspace sessions (for session title lookup)
 * @returns Array of ContentBadge objects
 */
export function extractBadges(
  text: string,
  skills: LoadedSkill[],
  sources: LoadedSource[],
  workspaceId: string,
  sessions: SessionMeta[] = []
): ContentBadge[] {
  const skillSlugs = skills.map(s => s.slug)
  const sourceSlugs = sources.map(s => s.config.slug)
  const matches = findMentionMatches(text, skillSlugs, sourceSlugs)

  // Build lookup maps to avoid linear scans per match
  const skillsBySlug = new Map(skills.map(s => [s.slug, s]))
  const sourcesBySlug = new Map(sources.map(s => [s.config.slug, s]))
  const sessionsById = new Map(sessions.map(s => [s.id, s]))

  return matches.map(match => {
    let label = match.id
    let iconDataUrl: string | undefined
    let filePath: string | undefined

    if (match.type === 'skill') {
      const skill = skillsBySlug.get(match.id)
      label = skill?.metadata.name || match.id

      // Get cached icon as data URL (preserves mime type for SVG, PNG, etc.)
      iconDataUrl = getSkillIconSync(workspaceId, match.id) ?? undefined
    } else if (match.type === 'source') {
      const source = sourcesBySlug.get(match.id)
      label = source?.config.name || match.id

      // Get cached icon as data URL (preserves mime type for SVG, PNG, etc.)
      iconDataUrl = getSourceIconSync(workspaceId, match.id) ?? undefined
    } else if (match.type === 'file') {
      // Show filename as label, full relative path stored for tooltip
      label = match.id.split('/').pop() || match.id
      filePath = match.id
    } else if (match.type === 'folder') {
      // Show folder name as label, full relative path stored for tooltip
      label = match.id.split('/').pop() || match.id
      filePath = match.id
    } else if (match.type === 'session' || match.type === 'quote') {
      // Title at send time (the stored badge doesn't follow later renames)
      const session = sessionsById.get(match.id)
      label = session ? getSessionTitle(session) : match.id
    }

    // For skills, create fully-qualified rawText (pluginName:slug) so the agent
    // receives the correct format for the SDK's Skill tool. Plugin name depends
    // on which tier the skill came from: workspace → workspaceId, project/global → AGENTS_PLUGIN_NAME
    let rawText = match.fullMatch
    if (match.type === 'skill') {
      const skill = skillsBySlug.get(match.id)
      const pluginName = skill?.source === 'workspace' ? workspaceId : AGENTS_PLUGIN_NAME
      rawText = `[skill:${pluginName}:${match.id}]`
    }

    return {
      type: match.type as ContentBadge['type'],
      label,
      rawText,
      iconDataUrl,
      filePath,
      start: match.startIndex,
      end: match.startIndex + match.fullMatch.length,
    }
  })
}

// ============================================================================
// Helpers
// ============================================================================

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
