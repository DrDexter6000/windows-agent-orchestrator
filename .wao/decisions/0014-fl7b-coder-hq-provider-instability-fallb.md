# 0014: FL7b coder_hq provider instability fallback
status: accepted
date: 2026-06-28

## Context
WP-GUI-FL7b public-link auth

## Decision
coder_hq run_20260628190652088ihx48q repeated the provider-like silent exit pattern: read/probe events only, no result event, no metrics tokens, process exited 1 after a long silent interval. Per owner guidance, treat as provider instability, not tool-command failure. Fall back to bounded coder_low leaf tasks for implementation.

## Consequences
(待补)
