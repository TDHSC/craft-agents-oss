import { describe, expect, it } from 'bun:test'
import { EDIT_CLICK_IGNORE_SELECTOR, shouldStartEditFromClick } from '../edit-click'

const plain = { closest: () => null }
const inside = { closest: (selector: string) => (selector === EDIT_CLICK_IGNORE_SELECTOR ? {} : null) }

describe('shouldStartEditFromClick', () => {
  it('starts editing on a plain click in the bubble', () => {
    expect(shouldStartEditFromClick(plain, '')).toBe(true)
    expect(shouldStartEditFromClick(null, '')).toBe(true)
  })

  it('does not start editing while text is selected (drag-to-copy)', () => {
    expect(shouldStartEditFromClick(plain, 'some selected words')).toBe(false)
  })

  it('treats a whitespace-only selection as no selection', () => {
    expect(shouldStartEditFromClick(plain, '  \n ')).toBe(true)
  })

  it('leaves clicks on links, file badges and attachments to their own handlers', () => {
    expect(shouldStartEditFromClick(inside, '')).toBe(false)
  })

  it('covers the interactive elements the bubble renders', () => {
    for (const part of ['a', 'button', '[role="button"]', '[data-edit-ignore]']) {
      expect(EDIT_CLICK_IGNORE_SELECTOR).toContain(part)
    }
  })
})
