# Conversation and Activity Screens

- Separate authored messages, system events, and audit activity visually and
  semantically.
- Keep sender/source, time, delivery/state, and attachments readable.
- Load older history incrementally; the first fetch is bounded.
- The compose action is bottom-reachable and preserves draft text after failed
  send.
- Check service results before clearing the composer.
- Empty states distinguish no conversation from a filtered/no-access result.
- New-message indicators and auto-scroll must not steal focus from users
  reading older content.
- Use accessible names for attachment, send, retry, and overflow controls.
