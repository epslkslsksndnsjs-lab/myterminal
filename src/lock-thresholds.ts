// Issue #45 (ADR-0031, G9): single source of truth for the file-lock staleness
// threshold, shared by cluster.ts and instances.ts.
//
// Historical drift: cluster.ts used 5000ms while instances.ts used 30000ms, so the
// two locks judged the same lock age differently — a latent inconsistency. The
// manager (主理人) chose 30000ms at kickoff: it is the original ADR-0018 value and
// the more conservative choice (less likely to preempt a lock still held by a live
// process → safer against registry corruption).
export const LOCK_STALE_THRESHOLD_MS = 30_000;
