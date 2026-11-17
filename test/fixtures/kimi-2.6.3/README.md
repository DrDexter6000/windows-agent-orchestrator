# kimi 2.6.3 server API captures (WAO batch 109)

Raw responses of a real kimi 2.6.3 `kimi web` serve, captured 2026-11-17 by a probe script (session create,
prompt submit with `permission_mode: "auto"`, `GET /api/v1/sessions/{id}/agents/main/turns`, `GET .../prompts`,
`GET /api/v1/sessions/{id}`, `prompts:steer`, `prompts/{id}:abort`). Each file is `{ http, json }`; the probe's
working directory is rewritten to `C:\wao-probe\cwd`. Turn sequence: t1 shell + file write, t2 resume in the
same session, t3 a running turn that a queued correction (t4) is steered into, t5 an aborted turn.
