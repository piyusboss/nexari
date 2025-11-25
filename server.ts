// server.ts — Deno Server (Fixed for Custom Models)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing.");
  Deno.exit(1);
}

// === MODEL MAPPING ===
const MODELS: Record<string, string> = {
  "Nexari-G1": "Piyush-boss/Nexari-Qwen-3B-Full",
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  "Qwen2.5-72B": "Qwen/Qwen2.5-72B-Instruct", 
};

const DEFAULT_MODEL = "Nexari-G1"; 

// === NEW LOGIC: URL Selection ===
// Custom models ke liye 'api-inference' use karenge, Popular ke liye 'router'
function getModelUrl(modelId: string): string {
  // Agar Nexari (Custom) hai, toh Direct Inference API use karo
  if (modelId.includes("Piyush-boss") || modelId.includes("Nexari")) {
    console.log("⚠️ Using Direct Inference API for Custom Model");
    // Yeh URL OpenAI format (/v1/chat/completions) support karta hai custom models ke liye
    return `https://api-inference.huggingface.co/models/${modelId}/v1/chat/completions`;
  }
  
  // Baaki sab ke liye Router (Fast & Standard)
  return `https://router.huggingface.co/v1/chat/completions`;
}

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

// --- AUTH ---
function verifyToken(authHeader: string | null): boolean {
  if (!authHeader) return false;
  try {
    const [payloadB64, signature] = authHeader.split(".");
    if (!payloadB64 || !signature) return false;
    const hmac = createHmac("sha256", SHARED_SECRET);
    hmac.update(payloadB64);
    if (signature !== hmac.digest("hex")) return false;
    const payload = JSON.parse(atob(payloadB64));
    if (payload.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// --- ERROR FORMATTING ---
function formatHfError(status: number, rawBody: string) {
  let code = "UNKNOWN_ERROR";
  let message = "An unexpected error occurred.";
  let originalError = rawBody;

  try {
      const jsonBody = JSON.parse(rawBody);
      originalError = jsonBody?.error?.message || jsonBody?.error || JSON.stringify(jsonBody);
      
      if (status === 503) { 
        code = "MODEL_LOADING"; 
        // User ko batana zaroori hai ki model load ho raha hai
        message = "Nexari is waking up from sleep. Please try again in 20 seconds."; 
      }
      else if (status === 429) { code = "HEAVY_TRAFFIC"; message = "Server busy. Try again later."; }
      else if (status === 400) { code = "INVALID_REQUEST"; message = `Configuration Error: ${originalError}`; }
      else if (status === 404) { code = "NOT_FOUND"; message = "Model URL not found. Check repository name."; }
      else { message = `HF Error (${status}): ${originalError}`; }
      
      return { error: { code, message, details: originalError } };
  } catch {
      return { error: { code, message: `Raw Error: ${rawBody}` } };
  }
}

// --- API CALLS ---
async function callRouterStream(modelId: string, payload: unknown): Promise<Response> {
  // Dynamic URL Logic
  const url = getModelUrl(modelId);
  console.log(`🚀 Sending Stream Request to: ${url}`);

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
      console.error(`❌ HF ERROR [${res.status}]:`, rawText);
      const formatted = formatHfError(res.status, rawText);
      return new Response(JSON.stringify(formatted), { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set("Content-Type", res.headers.get("Content-Type") || "text/event-stream");
    return new Response(res.body, { status: res.status, headers: responseHeaders });
  } catch (err: any) {
     return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

async function callRouterJson(modelId: string, payload: unknown) {
    // Dynamic URL Logic
    const url = getModelUrl(modelId);
    console.log(`🚀 Sending JSON Request to: ${url}`);

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${HF_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const text = await res.text();
        if (!res.ok) {
            console.error(`❌ HF ERROR [${res.status}]:`, text);
            return { ok: false, status: res.status, data: formatHfError(res.status, text) };
        }
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
    return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid Token" } }), { status: 401, headers: corsHeaders });
  }

  if (req.method !== "POST") return new Response("Only POST allowed", { status: 405, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  let messages = body.messages || [{ role: "user", content: body.input || body.prompt }];
  
  let targetModelId = MODELS[DEFAULT_MODEL];
  if (body.model && MODELS[body.model]) targetModelId = MODELS[body.model];

  const chatPayload: any = { 
      model: targetModelId, 
      messages: messages,
      max_tokens: body.max_tokens || 512, 
      temperature: body.temperature || 0.7
  };
  
  // Forward to Dynamic HF URL
  if (body.stream === true) {
    return await callRouterStream(targetModelId, chatPayload);
  } else {
    const res = await callRouterJson(targetModelId, chatPayload);
    return new Response(JSON.stringify(res.data), { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

console.log("✅ Nexari Dynamic Server Running...");
serve(handler);
