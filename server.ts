// server.ts — Robust Deno proxy for Hugging Face Router (improved validation + logging)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing. Set HF_API_KEY env variable before starting the server.");
  Deno.exit(1);
}

const ROUTER_BASE = "https://router.huggingface.co/v1";
const CHAT_PATH = "/chat/completions"; // final URL -> `${ROUTER_BASE}${CHAT_PATH}`

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization",
};

function isString(x: any) { return typeof x === "string"; }
function safeJsonParse(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}

function normalizeIncomingPayload(body: any) {
  // Accept legacy shapes:
  // - { input: "..." } or { inputs: "..." } -> messages = [{role:'user', content: ...}]
  // - { messages: [...] } (OpenAI style) -> use as-is (but validate)
  // - { model: "...", messages: [...] } -> pass-through (after validation)
  const out: any = {};

  // model must be present (we require client to send). If not present, return null to indicate invalid.
  if (body.model && isString(body.model) && body.model.trim()) {
    out.model = body.model.trim();
  }

  // If client gave 'messages' use it (must be array)
  if (Array.isArray(body.messages)) {
    out.messages = body.messages.map((m: any) => ({
      role: m.role ?? "user",
      content: isString(m.content) ? m.content : String(m.content ?? "")
    }));
  } else if (body.input || body.inputs || body.prompt || body.message) {
    const text = (body.input ?? body.inputs ?? body.prompt ?? body.message);
    out.messages = [{ role: "user", content: isString(text) ? text : String(text ?? "") }];
  } else if (body.inputs && !Array.isArray(body.inputs) && isString(body.inputs)) {
    out.messages = [{ role: "user", content: body.inputs }];
  }

  // Forward safe top-level params that router accepts (max_tokens, temperature, stream etc.)
  const allowedTopLevel = ["max_tokens", "temperature", "top_p", "n", "stream", "stop", "presence_penalty", "frequency_penalty"];
  for (const k of allowedTopLevel) {
    if (k in body) out[k] = body[k];
  }

  return out;
}

async function callRouter(payload: unknown, timeoutMs = 60_000) {
  const url = `${ROUTER_BASE}${CHAT_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    // Try to parse JSON safely
    const text = await res.text();
    const data = safeJsonParse(text) ?? text;
    return { ok: res.ok, status: res.status, statusText: res.statusText, data };
  } catch (err: any) {
    clearTimeout(timer);
    return { ok: false, status: 500, statusText: err?.name ?? "Error", data: { error: err?.message ?? String(err) } };
  }
}

function extractTextFromRouterResponse(data: any): string | null {
  // OpenAI-style
  try {
    if (data && Array.isArray(data.choices) && data.choices.length > 0) {
      const ch = data.choices[0];
      if (ch?.message?.content && isString(ch.message.content)) return ch.message.content;
      if (isString(ch?.text)) return ch.text;
    }
    // HF legacy
    if (Array.isArray(data) && data[0]) {
      if (isString(data[0])) return data[0];
      if (data[0].generated_text) return data[0].generated_text;
    }
    if (data?.output_text && isString(data.output_text)) return data.output_text;
    if (data?.generated_text && isString(data.generated_text)) return data.generated_text;
  } catch (e) {
    // ignore
  }
  if (isString(data)) return data;
  return null;
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // parse body safely
  let body: any = {};
  try { body = await req.json(); } catch (e) { /* ignore parsing errors below */ }

  // Normalize incoming body -> { model, messages, ...params }
  const normalized = normalizeIncomingPayload(body);

  // Validation: model required (we choose to require explicit model to avoid silent defaults that 404)
  if (!normalized.model) {
    return new Response(JSON.stringify({ error: "Missing 'model' in request. Provide 'model' (e.g. 'meta-llama/Meta-Llama-3-8B-Instruct' or 'deepseek-ai/DeepSeek-R1:fastest')." }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Validation: messages must be present and be array of objects with content string
  if (!Array.isArray(normalized.messages) || normalized.messages.length === 0) {
    return new Response(JSON.stringify({ error: "Missing 'messages' or 'input' in request. Provide 'messages' (array) or 'input' string." }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
  // Ensure content strings
  for (const m of normalized.messages) {
    if (!m || !("content" in m) || m.content === null || m.content === undefined) {
      return new Response(JSON.stringify({ error: "Each message must have a 'content' field." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    m.content = isString(m.content) ? m.content : String(m.content);
  }

  // Build router payload (OpenAI-style)
  const routerPayload: any = {
    model: normalized.model,
    messages: normalized.messages,
    stream: false,
  };
  // copy allowed params if provided
  const allowedTopLevel = ["max_tokens", "temperature", "top_p", "n", "stream", "stop", "presence_penalty", "frequency_penalty"];
  for (const k of allowedTopLevel) if (k in normalized) routerPayload[k] = normalized[k];

  // Debug log request (no secrets)
  console.log("➡️ Calling HF Router with model:", routerPayload.model, "messages:", routerPayload.messages.length);

  // Call router
  const hf = await callRouter(routerPayload);

  if (!hf.ok) {
    // Log full HF object for debugging (stringify safely)
    try {
      console.error(`❌ Error calling HF Router (status ${hf.status}). Full response: ${JSON.stringify(hf.data, null, 2)}`);
    } catch (e) {
      console.error("❌ Error calling HF Router (status", hf.status, "): (failed to stringify hf.data)");
    }

    // Helpful hints for common 400 causes
    const commonHints: string[] = [];
    if (hf.status === 400) commonHints.push("400 often means malformed payload (check 'messages' shape) or model not allowed for your account.");
    if (hf.status === 401 || hf.status === 403) commonHints.push("401/403: token unauthorized or missing scopes.");
    if (hf.status === 402) commonHints.push("402: model may require payment / Pro access.");
    if (hf.status === 429) commonHints.push("429: rate limited.");
    if (hf.status === 503) commonHints.push("503: model cold / loading; retry after a short delay.");

    // Return HF's own body in 'details' for troubleshooting
    return new Response(JSON.stringify({
      error: `Upstream Hugging Face Router returned ${hf.status} ${hf.statusText || ""}. See details.`,
      hints: commonHints,
      details: hf.data
    }), { status: Math.max(400, Math.min(hf.status || 502, 599)), headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Normalize response for frontend convenience
  const normalizedText = extractTextFromRouterResponse(hf.data);
  if (normalizedText !== null) {
    return new Response(JSON.stringify({ response: normalizedText, raw: hf.data }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // fallback: return raw
  return new Response(JSON.stringify({ response: hf.data }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

console.log("✅ Deno server starting — proxy to Hugging Face Router (v1 chat/completions)");
serve(handler);
