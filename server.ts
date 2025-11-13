// server.ts — Deno proxy (MODIFIED FOR DUAL API KEY ROUTING)
// --- MODIFIED TO SUPPORT STREAMING AND MODEL SWITCHING ---
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// === KEY 1 (DeepSeek) ===
const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
if (!HF_API_KEY) {
  console.warn("⚠️ HF_API_KEY (default) missing. DeepSeek-R1 model may fail.");
  // Don't exit, maybe user only wants to use NEW_MODEL
}

// === KEY 2 (Nexari G1 / New Model) ===
const NEW_API_KEY = Deno.env.get("NEW_MODEL") ?? "";
if (!NEW_API_KEY) {
  console.warn("⚠️ NEW_MODEL key missing. 'Nexari G1' model will not work.");
}

// === MODEL MAPPING ===
// Map 'value' from index.html to Hugging Face Model IDs
const MODEL_MAP: Record<string, { id: string; key: string }> = {
  "DeepSeek-R1": {
    id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
    key: HF_API_KEY,
  },
  "Nexari-G1": {
    // === ZAROORI: Is line ko apne naye model ID se badlein ===
    id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B", // Jaise "mistralai/Mistral-7B-Instruct-v0.2"
    key: NEW_API_KEY,
  },
};
// Default model agar user kuch na bheje
const DEFAULT_MODEL_KEY = "DeepSeek-R1";


const ROUTER_BASE = "https://router.huggingface.co/v1";
const CHAT_PATH = "/chat/completions";
const COMPLETIONS_PATH = "/completions";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization",
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
  // === MODIFIED: 'model' ko bhi forward karein ===
  const allowed = ["max_tokens", "temperature", "top_p", "n", "stop", "stream", "model"];
  for (const k of allowed) if (k in body) out[k] = body[k];
  return out;
}

// --- MODIFIED: Accepts apiKey as an argument ---
async function callRouterJson(path: string, payload: unknown, apiKey: string, timeoutMs = 60_000) {
  const url = `${ROUTER_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`, // <-- MODIFIED
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

// --- MODIFIED: Accepts apiKey as an argument ---
async function callRouterStream(path: string, payload: unknown, apiKey: string): Promise<Response> {
  const url = `${ROUTER_BASE}${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`, // <-- MODIFIED
        "Content-Type": "application/json",
        "Accept": "text/event-stream" // Request a stream
      },
      body: JSON.stringify(payload),
    });

    // We pipe the response body (a ReadableStream) directly to our client.
    // We must also forward the content-type (e.g., 'text/event-stream')
    // and handle CORS headers.
    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set("Content-Type", res.headers.get("Content-Type") || "text/event-stream");
    responseHeaders.set("Cache-Control", "no-cache");
    
    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders
    });

  } catch (err: any) {
    // If the fetch itself fails (e.g., network error)
    return new Response(JSON.stringify({ error: err?.message ?? String(err) }), { 
      status: 500, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
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

async function handler(req: Request): Promise<Response> {
  const responseHeaders = new Headers(corsHeaders);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") {
    responseHeaders.set("Content-Type", "application/json");
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: responseHeaders });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const normalized = normalizeIncoming(body);
  if (!Array.isArray(normalized.messages) || normalized.messages.length === 0) {
    responseHeaders.set("Content-Type", "application/json");
    return new Response(JSON.stringify({ error: "Missing 'messages' or 'input' in request body." }), { status: 400, headers: responseHeaders });
  }

  // === NEW ROUTING LOGIC START ===
  const modelKey = normalized.model || DEFAULT_MODEL_KEY;
  const modelConfig = MODEL_MAP[modelKey];

  if (!modelConfig) {
    responseHeaders.set("Content-Type", "application/json");
    return new Response(JSON.stringify({ error: `Model '${modelKey}' is not configured on the server.` }), { status: 400, headers: responseHeaders });
  }
  
  if (modelConfig.id === "YOUR_NEW_MODEL_ID_HERE") {
     console.error(`❌ 'Nexari-G1' model ID is not set. Please update 'YOUR_NEW_MODEL_ID_HERE' in server.ts`);
     responseHeaders.set("Content-Type", "application/json");
     return new Response(JSON.stringify({ error: `Server configuration error: 'Nexari-G1' model ID is not set.` }), { status: 500, headers: responseHeaders });
  }

  if (!modelConfig.key) {
    console.error(`❌ API key for model '${modelKey}' (ID: ${modelConfig.id}) is missing.`);
    responseHeaders.set("Content-Type", "application/json");
    return new Response(JSON.stringify({ error: `Server configuration error: API key for model '${modelKey}' is not set.` }), { status: 500, headers: responseHeaders });
  }
  
  const MODEL_ID = modelConfig.id;
  const API_KEY_TO_USE = modelConfig.key;
  // === NEW ROUTING LOGIC END ===


  // Try chat endpoint first (best for multi-message chat)
  const chatPayload: any = {
    model: MODEL_ID, // <-- Use routed model ID
    messages: normalized.messages,
  };
  // copy optional params (lekin 'model' ko dobara copy na karein)
  for (const k of ["max_tokens","temperature","top_p","n","stop","stream"]) if (k in normalized) chatPayload[k] = normalized[k];

  // --- STREAMING LOGIC ---
  if (chatPayload.stream === true) {
    console.log(`➡️ Calling HF Router (STREAM) with model: ${MODEL_ID} messages:${normalized.messages.length}`);
    // This function returns a complete Response object (piping the stream)
    return await callRouterStream(CHAT_PATH, chatPayload, API_KEY_TO_USE); // <-- Use routed API key
  }
  // --- END STREAMING LOGIC ---


  // --- NON-STREAMING LOGIC (Unchanged) ---
  console.log(`➡️ Calling HF Router (JSON) with model: ${MODEL_ID} messages:${normalized.messages.length}`);
  responseHeaders.set("Content-Type", "application/json"); // Set for all JSON responses

  const chatRes = await callRouterJson(CHAT_PATH, chatPayload, API_KEY_TO_USE); // <-- Use routed API key

  if (chatRes.ok) {
    const txt = extractText(chatRes.data);
    return new Response(JSON.stringify({ response: txt ?? chatRes.data, modelUsed: MODEL_ID, endpoint: "chat", raw: chatRes.data }), { status: 200, headers: responseHeaders });
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
    const compRes = await callRouterJson(COMPLETIONS_PATH, compPayload, API_KEY_TO_USE); // <-- Use routed API key
    if (compRes.ok) {
      const txt = extractText(compRes.data);
      return new Response(JSON.stringify({ response: txt ?? compRes.data, modelUsed: MODEL_ID, endpoint: "completions", raw: compRes.data }), { status: 200, headers: responseHeaders });
    }
    try { console.error(`❌ Upstream HF completions error (status ${compRes.status}):`, JSON.stringify(compRes.data, null, 2)); } catch(e){ console.error(compRes.data); }
    // If completions also failed, return that error to client
    return new Response(JSON.stringify({ error: `Upstream HF completions error (status ${compRes.status})`, details: compRes.data }), { status: 502, headers: responseHeaders });
  }

  // If chatRes failure is auth/payment or rate-limit, bubble up
  if ([401,403,402,429].includes(chatRes.status)) {
    return new Response(JSON.stringify({ error: `Upstream HF error (status ${chatRes.status})`, details: chatRes.data }), { status: 502, headers: responseHeaders });
  }

  // Otherwise treat as model-not-found/other — return HF details
  return new Response(JSON.stringify({ error: `Upstream HF chat error (status ${chatRes.status})`, details: chatRes.data }), { status: 502, headers: responseHeaders });
}

console.log("✅ Deno server starting — (Dual Key Mode)");
console.log(`🔑 Default (DeepSeek-R1) Key: ${HF_API_KEY ? "Loaded" : "MISSING"}`);
console.log(`🔑 Nexari G1 (NEW_MODEL) Key: ${NEW_API_KEY ? "Loaded" : "MISSING"}`);
serve(handler);
