# kimi 2.7.2 server API captures (WAO batch 128, TD-362)

Raw responses of a real kimi 2.7.2 `kimi web` serve, captured 2026-11-20 by a probe script on the WAO kimi lane home
(the batch 109 probe plus session-detail snapshots at each stage, the session list, a background-task turn and a
throwaway `:delete`). Each file is `{ http, json }`; the probe's working directory is rewritten to `C:\wao-probe\cwd`.
Turn sequence: t1 shell + file write (one snapshot with the Write tool call still in flight), t2 resume, t3 a running
turn that a queued correction (t4) is steered into, t5 an aborted turn, t6 a turn that starts a background task.

What changed against 2.6.3 for WAO:
- `GET /api/v1/sessions/{id}` and the session list items carry `activity` (`idle` | `turn` | `background`) instead of
  `busy` / `main_turn_active`; also `pending_interaction` and, after a turn ends, `last_turn_outcome`.
  2.6.3 reported `busy: true, main_turn_active: false` while a background task ran after the turn ended
  (`../kimi-2.6.3/background-task-session-detail.json`), so `idle` = both false, `turn` = both true,
  `background` = busy only.
- `GET /api/v1/sessions/{id}/messages` is gone (HTTP 404, `messages-endpoint-404.json`).
- Unchanged in shape: session create, prompt submit, prompts list, turns, `prompts:steer` (the steered prompt still
  ends the running turn without an answer and opens the next turn as its opener), `prompts/{id}:abort` (again: 40402),
  `:delete` (again: 40401). Tool calls in flight show `status: "running"` and a `stage`.

## t7: a correction steered in while a shell tool call is executing (captured 2026-11-21, batch 129)

`t7-steer-midtool-*.json` hold one poll each as `{ turns, prompts, detail }` (each `{ http, json }`), except the
submit and steer responses. The first prompt runs `ping -n 20`; once its Bash call shows `status: "running"`,
`stage: "executing"`, a second prompt is queued and steered (`steered: true`). From then until the tool call ends
(about 19 s), the steered prompt is in neither the prompts list (`active` stays the first prompt, `queued` empty) nor
any turn (`-held`, `-held-late`). When the tool ends, the first turn ends `completed` without an answer and, in the
same poll, the next turn opens with the steered prompt as its opener (`-new-turn`); `-settled` is the idle end state.
2.6.3 ended the running turn at the steer instead, so the steered prompt showed up within a poll or two.

