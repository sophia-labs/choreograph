# Sophia kernel runtime

This package is the sole Python `rlm` implementation mounted into a hosted
Sophia kernel. Choreograph owns its host protocol and runtime closure. Prime's
standalone Python package is neither bundled nor used as a fallback.

The public child lifecycle keeps run outcome and registry closure independent:
`run_state` is `queued | claimed | cancelling | completed | failed | cancelled`, while a
retained registry entry has `session_state` `open | closing | faulted`.
`delete_subagent` selects only the immutable `acr_<24 lowercase hex>` child run
identifier and returns a distinct receipt with `session_state` `closed`.
