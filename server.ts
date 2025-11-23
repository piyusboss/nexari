// server.ts — Fixed Routing for Custom Models
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing.");
  Deno.exit(1);
}

// Models Mapping
const MODELS: Record<string, string> = {
  "Nexari-G1": "Piyush-boss/Nexari-G1-3-8B", 
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  "Qwen2.5-72B": "Qwen/Qwen2.5-72B-Instruct", 
};

const DEFAULT_MODEL = "Nexari-G1";

// Allow CORS
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

// --- AUTH HELPER (Unchanged) ---
function verifyToken(authHeader: string | null): boolean {
  if (!authHeader) return false;
  try {
    const [payloadB64, signature] = authHeader.split(".");
    if (!payloadB64 || !signature) return false;
    const hmac = createHmac("sha256", SHARED_SECRET);
    hmac.update(payloadB64);
    const expectedSignature = hmac.digest("hex");
    if (signature !== expectedSignature) return false;
    const payload = JSON.parse(atob(payloadB64));
    if (payload.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch (e) { return false; }
}

// --- ERROR FORMATTING (Unchanged) ---
function formatHfError(status: number, rawBody: string) {
  let code = "UNKNOWN_ERROR";
  let message = "An unexpected error occurred.";
  try {
      const jsonBody = JSON.parse(rawBody);
      // Hugging Face specific errors often come as { error: "Model loading..." }
      const hfErrorMsg = jsonBody?.error?.message || jsonBody?.error || rawBody;
      
      if (status === 503) { code = "MODEL_LOADING"; message = "Nexari is waking up. Please try again in 30s."; }
      else if (status === 429) { code = "HEAVY_TRAFFIC"; message = "Too many requests. Please wait."; }
      else if (status === 400) { code = "INVALID_REQUEST"; message = "Request format issue."; }
      else if (status === 401) { code = "AUTH_ERROR"; message = "HF Token Issue."; }
      
      return { error: { code, message, details: hfErrorMsg } };
  } catch {
      return { error: { code, message: rawBody } };
  }
}

// --- UPDATED API CALLS (DIRECT MODEL ROUTING) ---

async function callRouterStream(modelId: string, payload: unknown): Promise<Response> {
  // FIX: Pointing directly to the model's OpenAI-compatible endpoint
  const url = `https://api-inference.huggingface.co/models/${modelId}/v1/chat/completions`;
  
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
    responseHeaders.set("Content-Type", "text/event-stream");
    responseHeaders.set("Cache-Control", "no-cache");
    
    return new Response(res.body, { status: res.status, headers: responseHeaders });
  } catch (err: any) {
     return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

async function callRouterJson(modelId: string, payload: unknown) {
    // FIX: Using direct endpoint here too
    const url = `https://api-inference.huggingface.co/models/${modelId}/v1/chat/completions`;
    
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
  
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) {
    return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid Token." } }), { 
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400, headers: corsHeaders }); }

  // Default Model Logic
  let targetModelId = MODELS[DEFAULT_MODEL];
  if (body.model && MODELS[body.model]) targetModelId = MODELS[body.model];

  // Prepare Payload
  let messages = body.messages;
  if (!messages && (body.input || body.prompt)) {
      messages = [{ role: "user", content: body.input || body.prompt }];
  }

  const chatPayload: any = { 
      model: targetModelId, 
      messages: messages,
      max_tokens: body.max_tokens || 512,
      temperature: body.temperature || 0.7,
      stream: body.stream ?? false
  };

  // Call HF
  if (chatPayload.stream === true) {
    return await callRouterStream(targetModelId, chatPayload);
  } else {
    const res = await callRouterJson(targetModelId, chatPayload);
    return new Response(JSON.stringify(res.data), { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

console.log("✅ Fixed Routing Server Running...");
serve(handler);
