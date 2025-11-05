// server.ts — Deno proxy for Hugging Face Router with chat/completions fallback
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing. Set HF_API_KEY env variable before starting the server.");
  Deno.exit(1);
}

const ROUTER_BASE = "https://router.huggingface.co/v1"; // base
const CHAT_PATH = "/chat/completions";
const COMPLETIONS_PATH = "/completions";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

function isString(x: any) { return typeof x === "string"; }
function safeJsonParse(text: string) { try { return JSON.parse(text); } catch { return null; } }

// Normalize incoming web payload to { model?, messages? , allowed params... }
function normalizeIncomingPayload(body: any) {
  const out: any = {};
  if (body.model && isString(body.model) && body.model.trim()) out.model = body.model.trim();

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    out.messages = body.messages.map((m: any) => ({
      role: m.role ?? "user",
      content: isString(m.content) ? m.content : String(m.content ?? "")
    }));
  } else if (body.input || body.inputs || body.prompt || body.message) {
    const text = (body.input ?? body.inputs ?? body.prompt ?? body.message);
    out.messages = [{ role: "user", content: isString(text) ? text : String(text ?? "") }];
  }

  const allowedTopLevel = ["max_tokens", "temperature", "top_p", "n", "stream", "stop", "presence_penalty", "frequency_penalty"];
  for (const k of allowedTopLevel) if (k in body) out[k] = body[k];
  return out;
}

// Build candidate model ids (if user passed short name like "distilgpt2")
function buildModelCandidates(originalModel: string) {
  const candidates: string[] = [];
  const fallbackList = [
    "deepseek-ai/DeepSeek-R1:fastest",
    "google/flan-t5-small",
    "facebook/bart-large-mnli"
  ];
  const trimmed = (originalModel || "").trim();
  if (!trimmed) return [...fallbackList];

  if (trimmed.includes("/")) {
    candidates.push(trimmed);
    return candidates;
  }

  const prefixes = ["distilbert", "openai-community", "huggingface", "google", "facebook"];
  candidates.push(trimmed);
  for (const p of prefixes) candidates.push(`${p}/${trimmed}`);
  for (const f of fallbackList) candidates.push(f);
  return [...new Set(candidates)];
}

async function callRouterPath(path: string, payload: unknown, timeoutMs = 60_000) {
  const url = `${ROUTER_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
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

// Convert messages[] -> single prompt for non-chat models
function buildPromptFromMessages(messages: Array<{role:string,content:string}>) {
  // Keep role hints — helpful for instructing base models
  return messages.map(m => {
    const roleLabel = (m.role || "user").toLowerCase();
    if (roleLabel === "system") return `System: ${m.content}`;
    if (roleLabel === "assistant") return `Assistant: ${m.content}`;
    return `User: ${m.content}`;
  }).join("\n\n");
}

// Try a single candidate: first try chat endpoint; if model_not_supported, try completions endpoint
async function tryCandidateModel(candidate: string, routerPayloadBase: any) {
  // 1) Chat attempt (messages)
  const chatPayload = { ...routerPayloadBase, model: candidate, messages: routerPayloadBase.messages, stream: false };
  const chatRes = await callRouterPath(CHAT_PATH, chatPayload);

  if (chatRes.ok) return { ok: true, model: candidate, path: CHAT_PATH, res: chatRes };

  // If failure and HF error says 'not a chat model' or code 'model_not_supported', then try completions
  const errMsg = (chatRes.data?.error?.message ?? chatRes.data?.message ?? "").toString().toLowerCase();
  const errCode = chatRes.data?.error?.code ?? chatRes.data?.code ?? null;

  const isNotChat = chatRes.status === 400 && (errMsg.includes("not a chat model") || errMsg.includes("not supported") || errCode === "model_not_supported");

  // If it's a model-not-found, we want to bubble that up to let caller try other candidates
  if (!isNotChat) {
    // For auth/payment errors, return immediately (do not try completions)
    if (chatRes.status === 401 || chatRes.status === 403 || chatRes.status === 402 || chatRes.status === 429) {
      return { ok: false, model: candidate, path: CHAT_PATH, res: chatRes, stop: true };
    }
    // Otherwise (like model_not_found) return with ok:false but allow candidate loop to continue
    return { ok: false, model: candidate, path: CHAT_PATH, res: chatRes, stop: false };
  }

  // 2) Build prompt and try completions endpoint
  const prompt = buildPromptFromMessages(routerPayloadBase.messages || []);
  const compPayload: any = { ...routerPayloadBase, model: candidate, prompt: prompt };
  // Map some params if present
  if (routerPayloadBase.max_tokens) compPayload.max_tokens = routerPayloadBase.max_tokens;
  if (routerPayloadBase.temperature) compPayload.temperature = routerPayloadBase.temperature;
  const compRes = await callRouterPath(COMPLETIONS_PATH, compPayload);

  if (compRes.ok) return { ok: true, model: candidate, path: COMPLETIONS_PATH, res: compRes };
  // on error: if payment/auth errors -> stop; else allow trying other candidates
  if (compRes.status === 401 || compRes.status === 403 || compRes.status === 402 || compRes.status === 429) {
    return { ok: false, model: candidate, path: COMPLETIONS_PATH, res: compRes, stop: true };
  }
  return { ok: false, model: candidate, path: COMPLETIONS_PATH, res: compRes, stop: false };
}

async function tryModelCandidates(candidates: string[], routerPayloadBase: any, maxAttempts = 6) {
  const tried: Array<any> = [];
  const limit = Math.min(candidates.length, maxAttempts);
  for (let i = 0; i < limit; i++) {
    const candidate = candidates[i];
    console.log(`➡️ Attempting model candidate: ${candidate}`);
    const attempt = await tryCandidateModel(candidate, routerPayloadBase);

    // Log full HF error body for debugging (safe stringify)
    try {
      if (!attempt.ok) {
        console.warn(`Model candidate failed: ${candidate} (status ${attempt.res.status})`, JSON.stringify(attempt.res.data, null, 2));
      }
    } catch (_) {}

    tried.push({
      model: candidate,
      status: attempt.res?.status ?? null,
      pathTried: attempt.path,
      details: attempt.res?.data ?? null
    });

    // If success -> return it
    if (attempt.ok) {
      return { success: true, model: candidate, path: attempt.path, hf: attempt.res, tried };
    }

    // If we must stop (auth/payment/rate limit) -> return immediately with that HF response
    if (attempt.stop) {
      return { success: false, hf: attempt.res, tried, modelTried: candidate };
    }

    // else continue to next candidate
  }
  return { success: false, tried };
}

function extractTextFromRouterResponse(data: any): string | null {
  try {
    if (data && Array.isArray(data.choices) && data.choices.length > 0) {
      const c = data.choices[0];
      if (c?.text) return c.text;
      if (c?.message?.content) return c.message.content;
    }
    if (data?.output_text && isString(data.output_text)) return data.output_text;
    if (data?.generated_text && isString(data.generated_text)) return data.generated_text;
    if (isString(data)) return data;
  } catch (e) {}
  return null;
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const normalized = normalizeIncomingPayload(body);
  if (!Array.isArray(normalized.messages) || normalized.messages.length === 0) {
    return new Response(JSON.stringify({ error: "Missing 'messages' or 'input' in request body. Provide 'messages' (array) or 'input' string." }), { status: 400, headers: corsHeaders });
  }

  // Build payload base (messages and allowed params)
  const routerPayloadBase: any = { messages: normalized.messages };
  const allowedTopLevel = ["max_tokens", "temperature", "top_p", "n", "stream", "stop", "presence_penalty", "frequency_penalty"];
  for (const k of allowedTopLevel) if (k in normalized) routerPayloadBase[k] = normalized[k];

  // Determine candidates
  const baseModel = normalized.model ?? ""; // if user provided model use it, else try with empty fallback
  const candidates = buildModelCandidates(baseModel || ""); // will include fallbacks

  // Try candidates
  const attempt = await tryModelCandidates(candidates, routerPayloadBase, 6);

  if (attempt.success && attempt.hf?.ok) {
    // Normalize text and return
    const txt = extractTextFromRouterResponse(attempt.hf.data);
    if (txt !== null) {
      return new Response(JSON.stringify({ response: txt, modelUsed: attempt.model, pathUsed: attempt.path, raw: attempt.hf.data }), { status: 200, headers: corsHeaders });
    }
    return new Response(JSON.stringify({ response: attempt.hf.data, modelUsed: attempt.model, pathUsed: attempt.path }), { status: 200, headers: corsHeaders });
  }

  // If we got an upstream HF error returned directly (auth/payment/etc.)
  if (attempt.hf && !attempt.success) {
    try { console.error("❌ Upstream HF error on attempt:", JSON.stringify(attempt.hf.data, null, 2)); } catch {}
    const hints = [];
    if (attempt.hf.status === 401 || attempt.hf.status === 403) hints.push("Check your HF token scopes and validity.");
    if (attempt.hf.status === 402) hints.push("Model may require payment / pro access.");
    if (attempt.hf.status === 429) hints.push("Rate limited; retry later or reduce QPS.");
    return new Response(JSON.stringify({ error: `Upstream error from HF (status ${attempt.hf.status})`, details: attempt.hf.data, hints }), { status: 502, headers: corsHeaders });
  }

  // Final fallback: show tried candidates and HF details for each
  return new Response(JSON.stringify({
    error: "None of the model candidates worked (either model not found or not supported for chat).",
    tried: attempt.tried,
    suggestion: "Provide a full chat-capable model id (owner/repo[:revision]) or use a known chat model (e.g., 'openai/gpt-oss-120b', 'deepseek-ai/DeepSeek-R1:fastest' or 'google/flan-t5-small')."
  }), { status: 404, headers: corsHeaders });
}

console.log("✅ Deno server starting — proxy to Hugging Face Router (chat/completions + completions fallback)");
serve(handler);
