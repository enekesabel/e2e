---
"e2e": patch
---

A control's row, list item, or region is no longer keyed by a live value such as an `<output>`, a `role="status"` count, or a timer, so a step that taps a counter's button replays whatever the count reads. A recording keyed by such a value stops replaying until it is recorded again.
