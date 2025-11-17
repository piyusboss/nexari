// server.ts — Deno proxy locked to deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B
// --- MODIFIED TO SUPPORT STREAMING AND BETTER ERROR HANDLING ---
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
};

function isString(x: any) { return typeof x === "string"; }
function safeJsonParse(text: string) { try { return JSON.parse(text); } catch { return null; } }

function normalizeIncoming(body: any) {
  const out: any = {};
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    out.messages = body.messages.map((m: any) => ({ role: m.role ?? "user", content: isString(m.content) ? m.content : String(m.content ?? "") }));
  } else if (body.input || body.inputs || body.prompt || body.message) {
    const text = body.input ?? body.inputs ?? body.prompt ?? body.message;
    out.messages = [{ role: "user", content: isString(text) ? text : String(text ?? "") }];
  }
  const allowed = ["max_tokens", "temperature", "top_p", "n", "stop", "stream"];
  for (const k of allowed) if (k in body) out[k] = body[k];
  return out;
}

// --- NON-STREAMING HELPER ---
async function callRouterJson(path: string, payload: unknown, timeoutMs = 60_000) {
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

// --- NEW STREAMING HELPER WITH ERROR HANDLING ---
async function callRouterStream(path: string, payload: unknown): Promise<Response> {
  const url = `${ROUTER_BASE}${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify(payload),
    });

    // === ERROR HANDLING IMPROVEMENT ===
    // Agar status OK nahi hai (e.g., 429, 503, 400), toh stream pipe mat karo.
    // Error message ko parse karo aur JSON return karo.
    if (!res.ok) {
      const errorText = await res.text();
      let errorJson: any = { error: `HF Error ${res.status}: ${res.statusText}` };
      
      try {
        const parsed = JSON.parse(errorText);
        // HF errors aksar { error: "message" } ya { error: { message: "..." } } hote hain
        if (parsed.error) {
             errorJson = { error: typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error)) };
        } else if (parsed.message) {
             errorJson = { error: parsed.message };
        }
      } catch (e) {
        // Agar JSON parse fail ho, toh raw text use karo
        if (errorText.length > 0) errorJson = { error: `HF Error: ${errorText}` };
      }

      console.error(`❌ HF Stream Error (${res.status}):`, JSON.stringify(errorJson));

      // JSON Response return karo taaki frontend/PHP ise pakad sake
      return new Response(JSON.stringify(errorJson), {
        status: res.status, // Original status code pass karo (e.g. 429, 503)
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    // === END ERROR HANDLING ===

    // Agar sab sahi hai, toh stream pipe karo
    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set("Content-Type", res.headers.get("Content-Type") || "text/event-stream");
    responseHeaders.set("Cache-Control", "no-cache");
    
    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders
    });

  } catch (err: any) {
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

  // Use Chat Payload
  const chatPayload: any = {
    model: MODEL_ID,
    messages: normalized.messages,
  };
  for (const k of ["max_tokens","temperature","top_p","n","stop","stream"]) if (k in normalized) chatPayload[k] = normalized[k];

  // --- STREAMING LOGIC ---
  if (chatPayload.stream === true) {
    console.log(`➡️ Calling HF Router (STREAM) with model: ${MODEL_ID} messages:${normalized.messages.length}`);
    return await callRouterStream(CHAT_PATH, chatPayload);
  }

  // --- NON-STREAMING LOGIC ---
  console.log(`➡️ Calling HF Router (JSON) with model: ${MODEL_ID} messages:${normalized.messages.length}`);
  responseHeaders.set("Content-Type", "application/json"); 

  const chatRes = await callRouterJson(CHAT_PATH, chatPayload);

  if (chatRes.ok) {
    const txt = extractText(chatRes.data);
    return new Response(JSON.stringify({ response: txt ?? chatRes.data, modelUsed: MODEL_ID, endpoint: "chat", raw: chatRes.data }), { status: 200, headers: responseHeaders });
  }

  const errMsg = (chatRes.data?.error?.message ?? chatRes.data?.message ?? "").toString().toLowerCase();
  const errCode = chatRes.data?.error?.code ?? chatRes.data?.code ?? null;
  const isNotChat = chatRes.status === 400 && (errMsg.includes("not a chat model") || errCode === "model_not_supported");

  if (isNotChat) {
    const prompt = messagesToPrompt(normalized.messages);
    const compPayload: any = { model: MODEL_ID, prompt };
    if (normalized.max_tokens) compPayload.max_tokens = normalized.max_tokens;
    if (normalized.temperature) compPayload.temperature = normalized.temperature;
    console.log(`➡️ Falling back to completions endpoint: ${MODEL_ID}`);
    const compRes = await callRouterJson(COMPLETIONS_PATH, compPayload);
    if (compRes.ok) {
      const txt = extractText(compRes.data);
      return new Response(JSON.stringify({ response: txt ?? compRes.data, modelUsed: MODEL_ID, endpoint: "completions", raw: compRes.data }), { status: 200, headers: responseHeaders });
    }
    return new Response(JSON.stringify({ error: `Upstream HF completions error (status ${compRes.status})`, details: compRes.data }), { status: 502, headers: responseHeaders });
  }

  // Return specific HF error
  return new Response(JSON.stringify({ error: `Upstream HF error: ${chatRes.data?.error || JSON.stringify(chatRes.data)}` }), { status: chatRes.status || 502, headers: responseHeaders });
}

console.log("✅ Deno server starting — locked to model:", MODEL_ID);
serve(handler);
