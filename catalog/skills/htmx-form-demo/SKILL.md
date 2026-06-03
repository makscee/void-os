---
name: htmx-form-demo
description: VOS-211 demo — emits an htmx form that posts back as a chat turn and re-renders.
output_target: body.html
interactive: true
---
Write `body.html` as a complete standalone document containing exactly this form (the `{{VOS_UUID}}` token is substituted by void-os at serve time):
`<form hx-post="/s/{{VOS_UUID}}/act" hx-target="#status" hx-swap="innerHTML"><button name="choice" value="ship">Ship</button><button name="choice" value="hold">Hold</button></form><div id="status"></div>`
When a `choice:` submission arrives in your input, rewrite `body.html` to a complete standalone document stating the chosen value (e.g. "chosen: ship"), again including the same form so the loop can continue.
