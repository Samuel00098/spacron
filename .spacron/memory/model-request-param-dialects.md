# Model request parameter dialects

All three AI request shapes live in one function: `run_completion` in
`src-tauri/src/commands/secrets.rs`. Every AI feature that asks a model for text
goes through it — prompt refinement, the orchestrator brain, commit messages —
so a request-shape bug there breaks all of them at once.

## The provider lists are live, so model ids can't be special-cased

`settings.ts` still carries a small curated `models` array per provider, but
`currentAiModel` trusts whatever id is remembered, and the catalogues are
fetched live from each provider (`*_MODELS_URL`). Anything the user's key
unlocks can end up in a request, including models released after the build.

That is why the OpenAI-compatible branch **negotiates** its parameters instead
of matching model ids:

- `ChatParamShape` = which token field (`max_tokens` vs `max_completion_tokens`)
  and whether `temperature` is sent at all.
- On a 400/422, `adapt_chat_shape` reads the provider's own complaint
  (`error.param` when present, message text otherwise) and returns the adjusted
  shape; `None` means "not renegotiable" (bad key, unknown model, quota) and the
  error goes straight to the user.
- Up to 3 attempts, then the working shape is cached per provider+base_url+model
  for the rest of the run.

The trigger was OpenAI's reasoning models: they reject `max_tokens` ("Use
`max_completion_tokens` instead") **and** reject any explicit `temperature`.
Fixing only the first gets you a second 400 about the second.

## Reasoning models bill thinking against the output ceiling

`max_completion_tokens` (OpenAI) and `maxOutputTokens` (Gemini 2.5+) also pay
for hidden thinking tokens, so the old 512/1024 budgets came back **empty** with
`finish_reason: length` / `finishReason: MAX_TOKENS` — a 200 that looks like the
model had nothing to say. `with_reasoning_headroom` raises those ceilings; it is
a cap, not a spend, so a brief model is billed for what it used. When the reply
is still empty and the finish reason says the limit was hit, the user gets
`TOKEN_LIMIT_MESSAGE` rather than the generic "empty response".

Anthropic keeps `max_tokens` at the requested size — it bills only the reply,
because we never send a `thinking` block.

## Nothing errors on OpenRouter or a local server

Both accept `max_tokens` for **every** model, so the negotiation above never
fires — they just return a stunted answer. OpenRouter's default model here is
`google/gemini-2.5-flash`, a thinking model, so this was the most common way to
hit it. The loop therefore also learns from a *successful* reply:

- `spent_reasoning_tokens` — `usage.completion_tokens_details.reasoning_tokens`,
  or a thinking field on the message. Each server names that differently:
  `reasoning` (OpenRouter), `reasoning_content` (llama.cpp, LM Studio, vLLM,
  DeepSeek), `thinking` (Ollama). All three are in `REASONING_FIELDS`.
- `strip_inline_reasoning` — a raw GGUF writes its scratchpad inline as
  `<think>…</think>`; Ollama and LM Studio only lift that out when the model's
  template declares it. Unstripped, the monologue *was* the commit message. An
  unterminated opener means the reply was cut off mid-thought, so nothing
  survives — which is itself the starvation signal a bare local server never
  reports any other way.
- Either signal sets `reasoning_headroom` on the cached shape and retries once
  if the reply was starved.

`embedded_error_message` also covers gateways that answer 200 with an `error`
object instead of choices (OpenRouter does this for upstream failures).

## Reply extraction is not index 0

`extract_google_text` and `extract_anthropic_text` join every text part/block and
skip `thought: true` parts and non-`text` blocks. Both used to read element 0,
which returns a thought or a fragment on thinking models.

## xAI chat used to go to OpenRouter

The URL match ended in `_ => OPENROUTER_URL`, so a Grok chat request was posted
to openrouter.ai carrying the user's `xai-...` key. There is now an explicit
`"xai" => XAI_URL` arm. If you add a provider to `KNOWN_PROVIDERS`, add its chat
URL arm too — the catch-all silently misroutes and leaks the key otherwise.
