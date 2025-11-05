// server.ts — Deno proxy for Hugging Face Router with model resolution + fallbacks
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing. Set HF_API_KEY env variable before starting the server.");
  Deno.exit(1);
}

const ROUTER_BASE = "https://router.huggingface.co/v1";
const CHAT_PATH = "/chat/completions"; // router endpoint

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

function isString(x: any) { return typeof x === "string"; }
function safeJsonParse(text: string) { try { return JSON.parse(text); } catch { return null; } }

/**
 * Normalize incoming request body to { model?, messages?, ...allowedParams }
 * Accepts legacy shapes: { input / inputs / prompt / message } OR { messages }.
 */
function normalizeIncomingPayload(body: any) {
  const out: any = {};

  if (body.model && isString(body.model) && body.model.trim()) out.model = body.model.trim();

  if (Array.isArray(body.messages)) {
    out.messages = body.messages.map((m: any) => ({
      role: m.role ?? "user",
      content: isString(m.content) ? m.content : String(m.content ?? "")
    }));
  } else if (body.input || body.inputs || body.prompt || body.message) {
    const text = (body.input ?? body.inputs ?? body.prompt ?? body.message);
    out.messages = [{ role: "user", content: isString(text) ? text : String(text ?? "") }];
  }

  // forward a small allowed set of top-level params to router
  const allowedTopLevel = ["max_tokens", "temperature", "top_p", "n", "stream", "stop", "presence_penalty", "frequency_penalty"];
  for (const k of allowedTopLevel) if (k in body) out[k] = body[k];

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

    const text = await res.text();
    const data = safeJsonParse(text) ?? text;
    return { ok: res.ok, status: res.status, statusText: res.statusText, data };
  } catch (err: any) {
    clearTimeout(timer);
    return { ok: false, status: 500, statusText: err?.name ?? "Error", data: { error: err?.message ?? String(err) } };
  }
}

/**
 * Extract a simple string reply from common router/HF shapes.
 */
function extractTextFromRouterResponse(data: any): string | null {
  try {
    if (data && Array.isArray(data.choices) && data.choices.length > 0) {
      const ch = data.choices[0];
      if (ch?.message?.content && isString(ch.message.content)) return ch.message.content;
      if (isString(ch?.text)) return ch.text;
    }
    if (Array.isArray(data) && data[0]) {
      if (isString(data[0])) return data[0];
      if (data[0].generated_text) return data[0].generated_text;
    }
    if (data?.output_text && isString(data.output_text)) return data.output_text;
    if (data?.generated_text && isString(data.generated_text)) return data.generated_text;
  } catch (e) { /* ignore */ }
  if (isString(data)) return data;
  return null;
}

/**
 * Generate candidate model identifiers to try when the incoming model looks short.
 * - If model already includes '/', we return [model] only.
 * - If model is short (no slash), return a prioritized list:
 *    [original, distilbert/original, openai-community/original, huggingface/original, google/original, facebook/original, ...fallback list]
 */
function buildModelCandidates(originalModel: string) {
  const candidates: string[] = [];
  const fallbackList = [
    // safe-ish router models to try as last resort (you can adjust this list)
    "deepseek-ai/DeepSeek-R1:fastest",
    "google/flan-t5-small",
    "facebook/bart-large-mnli"
  ];

  const trimmed = (originalModel || "").trim();
  if (!trimmed) return fallbackList.slice(0, 3);

  // If already contains owner/repo style, just try it
  if (trimmed.includes("/")) {
    candidates.push(trimmed);
    return candidates;
  }

  // common owner prefixes to try for short names
  const prefixes = ["distilbert", "openai-community", "huggingface", "google", "facebook"];
  candidates.push(trimmed); // try raw short name first
  for (const p of prefixes) candidates.push(`${p}/${trimmed}`);
  // Finally append configured fallback models
  for (const f of fallbackList) candidates.push(f);

  // Deduplicate preserving order
  return [...new Set(candidates)];
}

/**
 * Try models sequentially (bounded attempts) until one succeeds or all fail.
 */
async function tryModelCandidates(candidates: string[], routerPayloadBase: any, maxAttempts = 6) {
  const tried: Array<{model:string,status:number,details:any}> = [];
  const limit = Math.min(candidates.length, maxAttempts);
  for (let i=0;i<limit;i++) {
    const modelCandidate = candidates[i];
    const payload = { ...routerPayloadBase, model: modelCandidate };
    console.log(`➡️ Attempting model candidate: ${modelCandidate}`);
    const hf = await callRouter(payload);
    if (hf.ok) {
      console.log(`✅ Model candidate worked: ${modelCandidate}`);
      return { success: true, model: modelCandidate, hf };
    }
    // If hf returned a structured error indicating model_not_found, keep trying
    const code = hf.data?.error?.code ?? hf.data?.code ?? null;
    const msg = hf.data?.error?.message ?? hf.data?.message ?? hf.data;
    tried.push({ model: modelCandidate, status: hf.status, details: hf.data });
    console.warn(`Model candidate failed: ${modelCandidate} (status ${hf.status})`, hf.data);

    // If HF says "model_not_found" or HTTP 400 with model not found, continue to next candidate.
    const isNotFound =
      hf.status === 404 ||
      (hf.status === 400 && typeof msg === "string" && msg.toLowerCase().includes("does not exist")) ||
      code === "model_not_found";

    // If error is "requires payment/pro" or auth (402/401/403), stop and return the HF response immediately.
    if (!isNotFound) {
      return { success: false, model: modelCandidate, hf, tried };
    }
    // else continue loop
  }

  return { success: false, model: null, tried };
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: corsHeaders });
  }

  // parse body safely
  let body: any = {};
  try { body = await req.json(); } catch (e) { /* ignore, validate later */ }

  const normalized = normalizeIncomingPayload(body);

  // minimal validation: must have messages
  if (!Array.isArray(normalized.messages) || normalized.messages.length === 0) {
    return new Response(JSON.stringify({ error: "Missing 'messages' or 'input' in request body. Provide 'messages' (array) or 'input' string." }), {
      status: 400, headers: corsHeaders
    });
  }

  // routerBase payload to pass candidate model into
  const routerPayloadBase: any = {
    messages: normalized.messages,
    stream: false
  };
  const allowedTopLevel = ["max_tokens", "temperature", "top_p", "n", "stream", "stop", "presence_penalty", "frequency_penalty"];
  for (const k of allowedTopLevel) if (k in normalized) routerPayloadBase[k] = normalized[k];

  // If client provided explicit model try that strategy first; else we'll rely on candidates built from a default
  const clientModel = normalized.model ?? null;

  // Build candidates
  const modelInputForCandidates = clientModel ?? (localStorageSafeModelName() ?? "distilgpt2"); // fallback to old behavior if nothing
  // Note: localStorageSafeModelName() is server-side placeholder — in practice, we won't read localStorage here.
  // We'll use clientModel or fallback to 'distilgpt2' only for historical behaviour.
  // But primary approach: build candidates from clientModel if available else use simple default
  const baseModelToUse = clientModel ?? "distilgpt2";
  const candidates = buildModelCandidates(baseModelToUse);

  // Try candidates sequentially (bounded)
  const attemptResult = await tryModelCandidates(candidates, routerPayloadBase, 6);

  if (attemptResult.success && attemptResult.hf?.ok) {
    // Success, return normalized text if possible
    const normalizedText = extractTextFromRouterResponse(attemptResult.hf.data);
    if (normalizedText !== null) {
      return new Response(JSON.stringify({ response: normalizedText, modelUsed: attemptResult.model, raw: attemptResult.hf.data }), { status: 200, headers: corsHeaders });
    }
    return new Response(JSON.stringify({ response: attemptResult.hf.data, modelUsed: attemptResult.model }), { status: 200, headers: corsHeaders });
  }

  // If we got back an HF-like error (e.g., authorization/payment) from a candidate attempt, bubble it up
  if (attemptResult.hf && !attemptResult.success) {
    const hf = attemptResult.hf;
    console.error("❌ Upstream HF error on attempt:", JSON.stringify(hf.data, null, 2));
    const hints = [];
    if (hf.status === 401 || hf.status === 403) hints.push("Check your HF token scopes and validity.");
    if (hf.status === 402) hints.push("Model may require payment / pro access.");
    return new Response(JSON.stringify({ error: `Upstream error from HF (status ${hf.status})`, details: hf.data, hints }), { status: 502, headers: corsHeaders });
  }

  // Final fallback: return aggregated tried candidates and upstream details
  return new Response(JSON.stringify({
    error: "None of the model candidates worked. The router reports model not found for the candidates we tried.",
    tried: attemptResult.tried,
    suggestion: "Pass a full model id (owner/repo[:revision]) that is available to your account, or pick one of our fallback models (e.g., 'deepseek-ai/DeepSeek-R1:fastest', 'google/flan-t5-small')."
  }), { status: 404, headers: corsHeaders });
}

// NOTE: placeholder to avoid lint error. On server there is no localStorage; we keep function to show intent.
function localStorageSafeModelName() { return null; }

console.log("✅ Deno server starting — proxy to Hugging Face Router (v1 chat/completions) with model resolution");
serve(handler);
