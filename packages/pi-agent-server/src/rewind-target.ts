/**
 * Edit-and-resend target in the Pi session tree when no kept assistant turn exists, i.e. the first
 * message itself was edited.
 *
 * Not "the entry without a parent": a new session opens with model / thinking-level entries, so the
 * first user message has a parent. `navigateTree` to a user entry moves the leaf to that parent,
 * which keeps the settings entries and drops the whole conversation. `null` = nothing to rewind.
 */
export function firstUserEntryId(
  branch: ReadonlyArray<{ id: string; type: string; message?: { role?: string } }>,
): string | null {
  return branch.find((e) => e.type === 'message' && e.message?.role === 'user')?.id ?? null;
}
