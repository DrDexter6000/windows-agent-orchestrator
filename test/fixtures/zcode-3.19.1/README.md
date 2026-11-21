# ZCode 3.19.1 session/messages capture (WAO batch 130)

`narration-turn-messages.json` is trimmed from a real `session/messages` result of one WAO glm-pro run on ZCode 3.19.1
(bundled CLI 0.18.0), read back on 2026-11-21 through `session/resume` in a fresh app-server. Kept: the turn's anchor
user message (its prompt text replaced), eight assistant steps from the start of the turn and the last three steps;
`info` keeps role, messageId, parentMessageId and sessionId; tool parts keep their type, ids, tool name and status only.

Shape facts from the whole capture (99 messages, 75 assistant): every assistant message is one step
(`step-start`, optional `reasoning`, at most one `text` part, any number of `tool` parts, `step-finish`); no
assistant message had more than one text part. Narration between tool calls is the text part of a step that also
calls tools; the final answer is the text part of the last step, which calls no tool.
