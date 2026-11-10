// OpenAI-style adapters (PRD §7.1, §7.2):
// - `responses`: the Responses API, for OpenAI and xAI. Always store:false; when
//   reasoning is on, include ['reasoning.encrypted_content']; OpenAI gets the
//   per-install safety_identifier. Errors can arrive inside the 200 stream as
//   `response.failed` or `error`. A reasoning item (silent without summaries)
//   is reported as {type:'thinking', active} for the wrapper's timers (§7.5).
// - `chat`: Chat Completions, for Gemini (Google's OpenAI compatibility layer),
//   Other (any OpenAI-compatible service at the player's address: OpenRouter,
//   Groq, Together, Ollama, LM Studio, …) and xAI's fallback, which the wrapper
//   hands the manifest's effortAlt map, top-level reasoning_effort, and
//   defaultRequestOptionsAlt. stream_options.include_usage is sent (a service
//   that always includes usage ignores it). Some services (OpenRouter) answer
//   200 with an error: mid-stream as a chunk with `error` and finish_reason
//   'error', or without streaming as a body holding only `error`. A service
//   that reports its exact cost (usage.cost) is taken at its word.
// Either way, a failure that comes with (or after) a usage count reports it,
// {partial: true}, before the error (§9.2): a failed response's usage, an error
// chunk's, or the last chunk's before a cut stream.
import { readSSE } from '../sse.mjs';
import { requestBody, effortFragment, joinUrl, parseJSON, systemText, num } from '../util.mjs';

function target(manifest, path, authHeaders, body) {
  return {
    url: joinUrl(manifest.baseUrl, path),
    method: 'POST',
    headers: { ...manifest.headers, ...authHeaders, 'content-type': 'application/json', accept: 'text/event-stream' },
    body,
  };
}

const isJSON = (res) => /\bjson\b/i.test(res.headers?.get?.('content-type') || '');

async function readAll(body, limit = 1 << 20) {
  let text = '';
  const dec = new TextDecoder();
  if (!body) return text;
  for await (const chunk of body) {
    text += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    if (text.length > limit) break;
  }
  return text + dec.decode();
}

// ---- Responses API -------------------------------------------------------------

export function responsesRequest(manifest, req, { authHeaders = {}, requestOptions = null, path } = {}) {
  const input = [];
  const sys = systemText(req.system);
  if (sys) input.push({ role: 'system', content: sys });
  for (const m of req.messages || []) input.push({ role: m.role, content: String(m.content ?? '') });
  const core = { model: req.model, input, max_output_tokens: req.maxTokens ?? manifest.limits.maxOutputTokens };
  const body = requestBody(manifest.defaultRequestOptions, effortFragment(manifest, req.model, req.effort), requestOptions, core);
  body.input = input;
  body.stream = true;
  body.store = false; // PRD §7.2: always, for OpenAI and xAI
  const effort = body.reasoning?.effort;
  if (effort && effort !== 'none') {
    const include = Array.isArray(body.include) ? body.include : [];
    body.include = include.includes('reasoning.encrypted_content') ? include : [...include, 'reasoning.encrypted_content'];
  }
  if (manifest.safetyIdentifier && req.safetyId) body.safety_identifier = String(req.safetyId);
  else delete body.safety_identifier;
  // A chat's cache key (manifest cacheKey: the ChatGPT plan's Codex backend reuses a chat's prompt
  // only when its requests name the same session): a header and the body's prompt_cache_key.
  const ck = manifest.cacheKey && typeof req.cacheKey === 'string' && req.cacheKey ? req.cacheKey : null;
  if (ck) body.prompt_cache_key = ck;
  else delete body.prompt_cache_key;
  const t = target(manifest, path || manifest.paths.chat, authHeaders, body);
  if (ck) t.headers[manifest.cacheKey.header] = ck;
  return t;
}

export function responsesUsage(u = {}) {
  const cached = num(u.input_tokens_details?.cached_tokens);
  const written = num(u.input_tokens_details?.cache_write_tokens);
  return {
    input: Math.max(0, num(u.input_tokens) - cached - written),
    output: num(u.output_tokens),
    cacheRead: cached,
    cacheWrite: written,
    reasoning: num(u.output_tokens_details?.reasoning_tokens),
    exact: false,
  };
}

export async function* responsesParse(res, ctx) {
  let refused = false;
  for await (const ev of readSSE(res.body)) {
    if (ev.data === '[DONE]') continue;
    const data = parseJSON(ev.data);
    if (!data || typeof data !== 'object') continue;
    const type = data.type || ev.event;
    if (type === 'response.output_text.delta') {
      if (data.delta) yield { type: 'text', delta: String(data.delta) };
    } else if (type === 'response.refusal.delta' || type === 'response.refusal.done') {
      refused = true;
      yield { type: 'progress' };
    } else if (type === 'response.completed') {
      yield { type: 'usage', usage: responsesUsage(data.response?.usage) };
      yield { type: 'done', finish: refused ? 'refusal' : 'stop' };
      return;
    } else if (type === 'response.incomplete') {
      const reason = data.response?.incomplete_details?.reason;
      yield { type: 'usage', usage: responsesUsage(data.response?.usage) };
      yield { type: 'done', finish: reason === 'content_filter' ? 'content_filter' : refused ? 'refusal' : 'length' };
      return;
    } else if (type === 'response.failed' || type === 'error') {
      // A failed response can still name what it used: reported before the error, marked partial.
      if (data.response?.usage) yield { type: 'usage', usage: { ...responsesUsage(data.response.usage), partial: true } };
      yield { type: 'error', error: ctx.fail(data) };
      return;
    } else if ((type === 'response.output_item.added' || type === 'response.output_item.done') && data.item?.type === 'reasoning') {
      yield { type: 'thinking', active: type === 'response.output_item.added' };
    } else if (typeof type === 'string' && type.endsWith('.delta')) {
      yield { type: 'progress' }; // reasoning text or summary: tokens, just not reply text
    }
  }
  yield { type: 'error', error: ctx.truncated() };
}

// ---- Chat Completions ------------------------------------------------------------

export function chatRequest(manifest, req, { authHeaders = {}, requestOptions = null, path } = {}) {
  const messages = [];
  const sys = systemText(req.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of req.messages || []) messages.push({ role: m.role, content: String(m.content ?? '') });
  const core = { model: req.model, messages, max_tokens: req.maxTokens ?? manifest.limits.maxOutputTokens };
  // What the player's server said this model takes (Other: provider.thinking, backend), under the player's own options.
  const options = req.serverOptions ? { ...req.serverOptions, ...(requestOptions || {}) } : requestOptions;
  const body = requestBody(manifest.defaultRequestOptions, effortFragment(manifest, req.model, req.effort), options, core);
  body.messages = messages;
  body.stream = true;
  body.stream_options = { ...(body.stream_options || {}), include_usage: true };
  return target(manifest, path || manifest.paths.chat, authHeaders, body);
}

export function chatUsage(u = {}) {
  const cached = num(u.prompt_tokens_details?.cached_tokens);
  const written = num(u.prompt_tokens_details?.cache_write_tokens);
  const out = {
    input: Math.max(0, num(u.prompt_tokens) - cached - written),
    output: num(u.completion_tokens),
    cacheRead: cached,
    cacheWrite: written,
    reasoning: num(u.completion_tokens_details?.reasoning_tokens),
    exact: false,
  };
  if (typeof u.cost === 'number' && Number.isFinite(u.cost)) { out.costUsd = u.cost; out.exact = true; }
  return out;
}

const CHAT_FINISH = { stop: 'stop', tool_calls: 'stop', function_call: 'stop', length: 'length', content_filter: 'content_filter' };
// The output ceiling is 'length' (OpenAI's word, Google's compatibility layer's for Gemini's
// MAX_TOKENS, xAI's); a gateway that passes Gemini's own reason on says max_tokens, in any case.
const chatFinish = f => (typeof f === 'string' && /^(?:length|max_tokens)$/i.test(f) ? 'length' : CHAT_FINISH[f] ?? 'stop');

export async function* chatParse(res, ctx) {
  // A 200 that isn't a stream: OpenRouter's error-only body, or a server that
  // ignored stream:true.
  if (isJSON(res)) {
    const obj = parseJSON(await readAll(res.body));
    if (!obj || typeof obj !== 'object') { yield { type: 'error', error: ctx.truncated() }; return; }
    if (obj.error) { yield { type: 'error', error: ctx.fail(obj) }; return; }
    const choice = obj.choices?.[0] || {};
    const text = choice.message?.content;
    if (text) yield { type: 'text', delta: String(text) };
    if (obj.usage) yield { type: 'usage', usage: chatUsage(obj.usage) };
    yield { type: 'done', finish: choice.message?.refusal ? 'refusal' : chatFinish(choice.finish_reason) };
    return;
  }
  let finish = null;
  let refused = false;
  let usage = null;
  let sawDone = false;
  for await (const ev of readSSE(res.body)) {
    if (ev.data === '[DONE]') { sawDone = true; break; }
    const data = parseJSON(ev.data);
    if (!data || typeof data !== 'object') continue;
    // An error mid-stream still reports the usage the provider sent so far (in the error chunk or an
    // earlier one), marked partial, before the error.
    const failed = function* () {
      const u = data.usage ?? usage;
      if (u) yield { type: 'usage', usage: { ...chatUsage(u), partial: true } };
      yield { type: 'error', error: ctx.fail(data) };
    };
    if (data.error) { yield* failed(); return; }
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice) {
      const d = choice.delta || {};
      if (d.content) yield { type: 'text', delta: String(d.content) };
      if (d.refusal) refused = true;
      // Reasoning (DeepSeek's and most gateways' reasoning_content, Ollama's and LM Studio's reasoning,
      // OpenRouter's reasoning_details) keeps the stream alive and says the model thought (an empty reply
      // that ran out of room then gets more, backend roomForRetry).
      const reasoned = !!(d.reasoning || d.reasoning_content || d.reasoning_details);
      if (reasoned || d.tool_calls || d.refusal) yield { type: 'progress', reasoning: reasoned };
      if (choice.finish_reason === 'error') { yield* failed(); return; }
      // DeepSeek's own stop when its inference system runs out of capacity mid-reply
      // (api-docs.deepseek.com, create-chat-completion): the service is busy, so the turn waits and
      // tries again; a cut reply is never published as whole, nor an empty one called "no reply".
      if (choice.finish_reason === 'insufficient_system_resource') {
        const u = data.usage ?? usage;
        if (u) yield { type: 'usage', usage: { ...chatUsage(u), partial: true } };
        yield { type: 'error', error: ctx.error({ kind: 'overloaded', code: choice.finish_reason }) };
        return;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (data.usage) usage = data.usage;
  }
  if (!sawDone && !finish) {
    if (usage) yield { type: 'usage', usage: { ...chatUsage(usage), partial: true } };
    yield { type: 'error', error: ctx.truncated() };
    return;
  }
  if (usage) yield { type: 'usage', usage: chatUsage(usage) };
  yield { type: 'done', finish: refused ? 'refusal' : chatFinish(finish) };
}

// Gemini's OpenAI-compatible list names its models "models/gemini-…"; requests take the bare id.
export function modelsPage(json) {
  // OpenAI-style {data: [{id}]}; the ChatGPT plan's Codex backend lists {models: [{slug, visibility}]},
  // its hidden ones (internal reviewers, reserves) left out.
  if (!Array.isArray(json?.data) && Array.isArray(json?.models)) {
    const ids = json.models.filter(m => m?.visibility !== 'hide').map(m => m?.slug).filter(x => typeof x === 'string');
    return { ids, next: null };
  }
  const ids = Array.isArray(json?.data) ? json.data.map(m => m?.id).filter(x => typeof x === 'string').map(id => id.replace(/^models\//, '')) : [];
  return { ids, next: null };
}

export const responses = { id: 'openai-responses', chatRequest: responsesRequest, parse: responsesParse, modelsPage };
export const chat = { id: 'openai-chat', chatRequest, parse: chatParse, modelsPage };
