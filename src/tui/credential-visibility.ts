export type CredentialKeyEvent = { name?: string; eventType: 'press' | 'repeat' | 'release' };

/**
 * Terminal key-up packets are not reliable enough to drive hold state directly:
 * some protocols emit an unnamed release between repeated `v` packets. Keep the
 * current state through release packets and let the caller's short repeat
 * deadline close visibility after repeats stop.
 */
export function nextCredentialVisibility(
  current: boolean,
  event: CredentialKeyEvent,
  eligible: boolean,
): boolean {
  if (!eligible) return false;
  if (event.eventType === 'release') return current;
  return event.name?.toLowerCase() === 'v' ? true : current;
}
