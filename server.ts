// server.ts — Deno proxy using Hugging Face Router (v1 chat/completions)
// Works with HF Router: https://router.huggingface.co/v1/chat/completions
// - Sends OpenAI-compatible chat requests to the Router
// - Wraps plain "input" into messages automatically
// - Robust timeout, error normalization, better logs

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

function extractTextFromHfLike(data: any): string | null {
  // OpenAI-like: { choices: [{ message: { content: "..." } }] }
  if (data && Array.isArray(data.choices) && data.choices.length > 0) {
    const ch = data.choices[0];
    if (ch?.message?.content && typeof ch.message.content === "string") return ch.message.content;
    if (typeof ch?.text === "string") return ch.text;
  }
  // HF legacy shapes
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (typeof first === "string") return first;
    if (first?.generated_text && typeof first.generated_text === "string") return first.generated_text;
    if (first?.text && typeof first.text === "string") return first.text;
  }
  if (data && typeof data === "object") {
    if (typeof data.generated_text === "string") return data.generated_text;
    if (typeof data.text === "string") return data.text;
    if (Array.isArray(data.output) && data.output[0]?.generated_text) return data.output[0].generated_text;
    // Some router responses include 'output_text'
    if (typeof data.output_text === "string") return data.output_text;
  }
  if (typeof data === "string") return data;
  return null;
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

    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: res.ok, status: res.status, statusText: res.statusText, data };
  } catch (err: any) {
    clearTimeout(timer);
    return { ok: false, status: 500, data: { error: err?.message ?? String(err) } };
  }
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let body: any = {};
  try { body = await req.json(); } catch (e) { /* ignore - we'll validate below */ }

  const input = body.input ?? body.inputs ?? body.prompt ?? body.message ?? "";
  const messagesFromClient = body.messages; // optional OpenAI-style messages array
  const model = (body.model ?? null)?.toString?.() ?? null;
  const clientParameters = (body.parameters && typeof body.parameters === "object") ? body.parameters : {};

  if (!input && !Array.isArray(messagesFromClient)) {
    return new Response(JSON.stringify({ error: "Missing 'input'/'message'/'prompt' or 'messages' in request body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
  if (!model) {
    return new Response(JSON.stringify({ error: "Missing 'model' in request body. Provide model id like 'meta-llama/Meta-Llama-3-8B-Instruct' or 'deepseek-ai/DeepSeek-R1:fastest'." }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Build OpenAI-compatible chat payload for HF Router v1
  // If client supplied `messages`, use them; otherwise wrap `input` as a single user message.
  const messages = Array.isArray(messagesFromClient)
    ? messagesFromClient
    : [{ role: "user", content: String(input) }];

  // router expects model + messages at top-level; other 'parameters' (max_tokens, temperature, stream) also top-level
  const routerPayload: any = {
    model,
    messages,
    stream: false,
    ...clientParameters
  };

  // Call router
  const hf = await callRouter(routerPayload);

  // Handle 410 specifically (older api-inference deprecation message passed through)
  if (!hf.ok) {
    // If HF returned 410 with suggestion to use router, include helpful guidance
    const lowMsg = typeof hf.data === "object" ? JSON.stringify(hf.data) : String(hf.data);
    if (hf.status === 410 || (lowMsg && lowMsg.includes("api-inference.huggingface.co is no longer"))) {
      console.error("❌ Detected deprecated api-inference usage from upstream. Using router.huggingface.co is required.");
      return new Response(JSON.stringify({
        error: "Upstream indicates 'api-inference.huggingface.co' is deprecated. This proxy uses 'router.huggingface.co/v1/chat/completions'.",
        upstream: hf.data,
        status: hf.status
      }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Pass through other HF/router errors with context
    let message = hf.data?.error ?? hf.data?.message ?? hf.statusText ?? JSON.stringify(hf.data);
    console.error(`❌ Error calling HF Router (status ${hf.status}): ${message}`);
    return new Response(JSON.stringify({ error: message, status: hf.status, details: hf.data }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // normalize output
  const normalized = extractTextFromHfLike(hf.data);
  if (normalized !== null) {
    return new Response(JSON.stringify({ response: normalized, raw: hf.data }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // fallback: return raw router response
  return new Response(JSON.stringify({ response: hf.data }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

console.log("✅ Deno server starting — proxy to Hugging Face Router (v1 chat/completions)");
serve(handler);
