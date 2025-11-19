// server.ts — Deno Server with Token Authentication
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; // MUST MATCH PHP SECRET

if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing.");
  Deno.exit(1);
}

const MODELS: Record<string, string> = {
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  "Qwen2.5-72B": "Qwen/Qwen2.5-72B-Instruct", 
};

const DEFAULT_MODEL = "DeepSeek-R1";
const ROUTER_BASE = "https://router.huggingface.co/v1";
const CHAT_PATH = "/chat/completions";
const COMPLETIONS_PATH = "/completions";

// Allow CORS for everyone (Security is handled via Token now)
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

function isString(x: any) { return typeof x === "string"; }

// --- AUTHENTICATION HELPER ---
function verifyToken(authHeader: string | null): boolean {
  if (!authHeader) return false;
  
  try {
    const [payloadB64, signature] = authHeader.split(".");
    if (!payloadB64 || !signature) return false;

    // Re-create signature
    const hmac = createHmac("sha256", SHARED_SECRET);
    hmac.update(payloadB64);
    const expectedSignature = hmac.digest("hex");

    if (signature !== expectedSignature) return false;

    // Check Expiration
    const payloadStr = atob(payloadB64);
    const payload = JSON.parse(payloadStr);
    
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      console.error("Token expired");
      return false;
    }

    return true;
  } catch (e) {
    console.error("Token verification failed:", e);
    return false;
  }
}

// --- Error Formatting ---
function formatHfError(status: number, rawBody: string) {
  let code = "UNKNOWN_ERROR";
  let message = "An unexpected error occurred while contacting the AI model.";
  try {
      const jsonBody = JSON.parse(rawBody);
      const hfErrorMsg = jsonBody?.error?.message || jsonBody?.error || rawBody;
      
      if (status === 503) { code = "MODEL_LOADING"; message = "The AI model is loading. Try again in 30s."; }
      else if (status === 429) { code = "HEAVY_TRAFFIC"; message = "Server busy. Please wait."; }
      else if (status === 400) { code = "INVALID_REQUEST"; message = "Invalid request."; }
      
      return { error: { code, message, details: hfErrorMsg } };
  } catch {
      return { error: { code, message: rawBody } };
  }
}

// --- HF API CALLS ---
async function callRouterStream(modelId: string, path: string, payload: unknown): Promise<Response> {
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

    if (!res.ok) {
      const rawText = await res.text();
      const formatted = formatHfError(res.status, rawText);
      return new Response(JSON.stringify(formatted), { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set("Content-Type", res.headers.get("Content-Type") || "text/event-stream");
    responseHeaders.set("Cache-Control", "no-cache");
    
    return new Response(res.body, { status: res.status, headers: responseHeaders });
  } catch (err: any) {
     return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

async function callRouterJson(modelId: string, path: string, payload: unknown) {
    const url = `${ROUTER_BASE}${path}`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${HF_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const text = await res.text();
        if (!res.ok) return { ok: false, status: res.status, data: formatHfError(res.status, text) };
        return { ok: true, status: res.status, data: JSON.parse(text) };
    } catch (err: any) {
        return { ok: false, status: 500, data: { error: err.message } };
    }
}

// --- MAIN HANDLER ---
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  
  // 1. VERIFY TOKEN (Direct from JS headers)
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) {
    return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid or expired token." } }), { 
        status: 401, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400, headers: corsHeaders }); }

  // Normalization
  let messages = body.messages;
  if (!messages && (body.input || body.prompt)) {
      messages = [{ role: "user", content: body.input || body.prompt }];
  }
  
  let targetModelId = MODELS[DEFAULT_MODEL];
  if (body.model && MODELS[body.model]) targetModelId = MODELS[body.model];

  const chatPayload: any = { model: targetModelId, messages: messages };
  for (const k of ["max_tokens","temperature","top_p","stream"]) if (k in body) chatPayload[k] = body[k];

  // Forward to HF
  if (chatPayload.stream === true) {
    return await callRouterStream(targetModelId, CHAT_PATH, chatPayload);
  } else {
    const res = await callRouterJson(targetModelId, CHAT_PATH, chatPayload);
    return new Response(JSON.stringify(res.data), { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

console.log("✅ Secure Deno Server running...");
serve(handler);
