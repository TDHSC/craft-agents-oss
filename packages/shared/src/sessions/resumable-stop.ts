/**
 * The one rule for "this session stopped abnormally and can be continued".
 *
 * The composer's ▶ button, the error card's Retry, `SessionManager.continueTurn`
 * and both auto-continue paths all ask `getResumableStop`; none of them
 * re-derives it. Pure and renderer-safe: it is a separate module because the
 * `./sessions` barrel imports Node `fs`.
 */

/**
 * Error codes where sending "Continue" can succeed. Auth, billing, invalid-model
 * and invalid-request errors are left out: continuing would fail the same way.
 */
export const RESUMABLE_ERROR_CODES: readonly string[] = [
  'rate_limited',
  'service_error',
  'service_unavailable',
  'provider_error',
  'network_error',
  'proxy_error',
];

export type ResumableStopReason =
  /** A typed error from the provider or network. */
  | 'error'
  /** A reply cut off at the output limit (`output_truncated`). */
  | 'truncated'
  /** The user pressed Stop. */
  | 'stopped'
  /** The turn never finished (app exit): the last message is the user's or a tool's. */
  | 'cut_off';

export interface ResumableStop {
  reason: ResumableStopReason;
  /** Set for `error` and `truncated`. */
  errorCode?: string;
  /** Set for a rate-limit error whose reset time could be parsed (epoch ms). */
  errorResetAt?: number;
}

/** The fields this rule reads; both `Message` and a stored message satisfy it. */
export interface ResumableStopMessage {
  role: string;
  errorCode?: string;
  errorResetAt?: number;
  statusType?: string;
  hidden?: boolean;
}

/** What the session is waiting on, judged from its last visible message; `null` when nothing can be continued. */
export function getResumableStop(messages: readonly ResumableStopMessage[]): ResumableStop | null {
  const last = messages.findLast(m => !m.hidden);
  if (!last) return null;

  switch (last.role) {
    case 'error':
      if (last.errorCode === 'output_truncated') {
        return { reason: 'truncated', errorCode: last.errorCode };
      }
      if (last.errorCode && RESUMABLE_ERROR_CODES.includes(last.errorCode)) {
        return {
          reason: 'error',
          errorCode: last.errorCode,
          ...(last.errorResetAt !== undefined ? { errorResetAt: last.errorResetAt } : {}),
        };
      }
      return null;
    case 'info':
      return last.statusType === 'interrupted' ? { reason: 'stopped' } : null;
    case 'user':
    case 'tool':
      return { reason: 'cut_off' };
    default:
      return null;
  }
}
