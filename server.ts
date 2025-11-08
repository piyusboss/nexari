// server.ts — Deno proxy locked to deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing. Set HF_API_KEY env variable before starting the server.");
  Deno.exit(1);
}

// === SINGLE MODEL (locked) ===
const MODEL_ID = "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B";

const ROUTER_BASE = "https://router.huggingface.co/v1";
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

function normalizeIncoming(body: any) {
  // accept {messages: [...] } or legacy { input / prompt / message }
  const out: any = {};
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    out.messages = body.messages.map((m: any) => ({ role: m.role ?? "user", content: isString(m.content) ? m.content : String(m.content ?? "") }));
  } else if (body.input || body.inputs || body.prompt || body.message) {
    const text = body.input ?? body.inputs ?? body.prompt ?? body.message;
    out.messages = [{ role: "user", content: isString(text) ? text : String(text ?? "") }];
  }
  // forward a small safe set of params if present
  const allowed = ["max_tokens", "temperature", "top_p", "n", "stop", "stream"];
  for (const k of allowed) if (k in body) out[k] = body[k];
  return out;
}

async function callRouter(path: string, payload: unknown, timeoutMs = 60_000) {
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

function messagesToPrompt(messages: Array<{role:string,content:string}>) {
  return messages.map(m => {
    const role = (m.role || "user").toLowerCase();
    if (role === "system") return `System: ${m.content}`;
    if (role === "assistant") return `Assistant: ${m.content}`;
    return `User: ${m.content}`;
  }).join("\n\n");
}

function extractText(data: any): string | null {
  try {
    if (data && Array.isArray(data.choices) && data.choices.length > 0) {
      const c = data.choices[0];
      if (c?.message?.content && isString(c.message.content)) return c.message.content;
      if (c?.text && isString(c.text)) return c.text;
    }
    if (data?.generated_text && isString(data.generated_text)) return data.generated_text;
    if (data?.output_text && isString(data.output_text)) return data.output_text;
    if (isString(data)) return data;
  } catch (e) {}
  return null;
}

// ================== GEMINI MODIFY START ==================
/**
 * Cleans AI response from model-specific artifacts.
 * @param text The raw text from the AI.
 * @returns A cleaned string, or null.
 */
function cleanAiResponse(text: string | null): string | null {
  if (!text) return null;

  let cleanedText = text;

  // 1. Remove common model special tokens (like <|endoftext|>, [PAD], etc.)
  cleanedText = cleanedText.replace(/<\|.*?\|>/g, "");
  cleanedText = cleanedText.replace(/\[(SEP|CLS|PAD)\]/g, "");

  // 2. Remove the specific Chinese "hash" artifact '井' (jǐng)
  cleanedText = cleanedText.replace(/井/g, "");

  // 3. Remove Markdown headings (like '### ' or '## ') from the start of lines
  // (Uses /gm flags: g=global, m=multiline)
  cleanedText = cleanedText.replace(/^\s*#+\s*/gm, "");

  // 4. Trim any leading/trailing whitespace left over
  cleanedText = cleanedText.trim();

  return cleanedText;
}
// ==================  GEMINI MODIFY END  ==================

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const normalized = normalizeIncoming(body);
  if (!Array.isArray(normalized.messages) || normalized.messages.length === 0) {
    return new Response(JSON.stringify({ error: "Missing 'messages' or 'input' in request body." }), { status: 400, headers: corsHeaders });
  }

  // ALWAYS use our SINGLE MODEL
  // Try chat endpoint first (best for multi-message chat)
  const chatPayload: any = {
    model: MODEL_ID,
    messages: normalized.messages,
    stream: false
  };
  // copy optional params
  for (const k of ["max_tokens","temperature","top_p","n","stop","stream"]) if (k in normalized) chatPayload[k] = normalized[k];

  console.log(`➡️ Calling HF Router (chat) with model: ${MODEL_ID} messages:${normalized.messages.length}`);

  const chatRes = await callRouter(CHAT_PATH, chatPayload);

  if (chatRes.ok) {
    const txt = extractText(chatRes.data);
    // ================== GEMINI MODIFY START ==================
    // Clean the text before sending it to the client
    const cleanedTxt = cleanAiResponse(txt);
    return new Response(JSON.stringify({ response: cleanedTxt ?? chatRes.data, modelUsed: MODEL_ID, endpoint: "chat", raw: chatRes.data }), { status: 200, headers: corsHeaders });
    // ==================  GEMINI MODIFY END  ==================
  }

  // If HF says "not a chat model" (model_not_supported) -> try completions endpoint (same model)
  const errMsg = (chatRes.data?.error?.message ?? chatRes.data?.message ?? "").toString().toLowerCase();
  const errCode = chatRes.data?.error?.code ?? chatRes.data?.code ?? null;
  const isNotChat = chatRes.status === 400 && (errMsg.includes("not a chat model") || errCode === "model_not_supported");

  // Log full HF response for debugging (safe stringify)
  try { console.error(`❌ Upstream HF chat error (status ${chatRes.status}):`, JSON.stringify(chatRes.data, null, 2)); } catch(e) { console.error(chatRes.data); }

  if (isNotChat) {
    // Build prompt and call completions path with same MODEL_ID
    const prompt = messagesToPrompt(normalized.messages);
    const compPayload: any = { model: MODEL_ID, prompt };
    if (normalized.max_tokens) compPayload.max_tokens = normalized.max_tokens;
    if (normalized.temperature) compPayload.temperature = normalized.temperature;
    console.log(`➡️ Falling back to completions endpoint (same model): ${MODEL_ID}`);
    const compRes = await callRouter(COMPLETIONS_PATH, compPayload);
    if (compRes.ok) {
      const txt = extractText(compRes.data);
      // ================== GEMINI MODIFY START ==================
      // Clean the text here as well (for the fallback)
      const cleanedTxt = cleanAiResponse(txt);
      return new Response(JSON.stringify({ response: cleanedTxt ?? compRes.data, modelUsed: MODEL_ID, endpoint: "completions", raw: compRes.data }), { status: 200, headers: corsHeaders });
      // ==================  GEMINI MODIFY END  ==================
    }
    try { console.error(`❌ Upstream HF completions error (status ${compRes.status}):`, JSON.stringify(compRes.data, null, 2)); } catch(e){ console.error(compRes.data); }
    // If completions also failed, return that error to client
    return new Response(JSON.stringify({ error: `Upstream HF completions error (status ${compRes.status})`, details: compRes.data }), { status: 502, headers: corsHeaders });
  }

  // If chatRes failure is auth/payment or rate-limit, bubble up
  if ([401,403,402,429].includes(chatRes.status)) {
    return new Response(JSON.stringify({ error: `Upstream HF error (status ${chatRes.status})`, details: chatRes.data }), { status: 502, headers: corsHeaders });
  }

  // Otherwise treat as model-not-found/other — return HF details
  return new Response(JSON.stringify({ error: `Upstream HF chat error (status ${chatRes.status})`, details: chatRes.data }), { status: 502, headers: corsHeaders });
}

console.log("✅ Deno server starting — locked to model:", MODEL_ID);
serve(handler);
