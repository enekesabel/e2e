---
"e2e": patch
---

Replay finds a control next to a changing value, such as an `<output>` count, a `role="status"` message, a `role="timer"` clock, or a progress bar, after that value changes. When the value is all that tells identical controls apart, replay still matches on it.
