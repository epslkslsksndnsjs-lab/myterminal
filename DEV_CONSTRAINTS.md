# Development Constraints

## Workspace boundary

All tool operations are restricted to the user-selected workspace. The workspace is a real read/write security boundary.

## Security

- Connection credentials live in the operating-system user configuration directory
- Only session-token hashes are persisted
- Sensitive fields are redacted from persisted audit logs
- Bind address should remain on `127.0.0.1` in production use

## Session model

- A root session creates work contexts; it may delegate to direct child sessions
- Children cannot create grandchildren
- Completed sessions are immutable
- Continuation is done through `session_register(continuesSessionId)`, not `session_inherit`
