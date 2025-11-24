// server.ts — Optimized for Qwen, DeepSeek & Nexari (Standard Chat API)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing. Please add it in Deno Settings.");
  Deno.exit(1);
}

// === MODEL CONFIGURATION ===
const MODELS: Record<string, string> = {
  // Aapka Adapter Model
  "Nexari-G1": "Piyush-boss/Nexari-Qwen-3B-LoRA", 
  
  // DeepSeek (Small & Fast)
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  
  // Qwen 7B (72B Free tier par nahi chalta, isliye 7B use kar rahe hain)
  "Qwen2.5-72B": "Qwen/Qwen2.5-7B-Instruct", 
};

const DEFAULT_MODEL = "Nexari-G1";

// CORS Headers
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

// --- AUTHENTICATION ---
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

// --- ERROR HANDLING ---
function formatHfError(status: number, rawBody: string) {
  let code = "UNKNOWN_ERROR";
  let message = `Server Error (${status})`;
  
  try {
      const jsonBody = JSON.parse(rawBody);
      const hfErrorMsg = jsonBody?.error?.message || jsonBody?.error || rawBody;
      
      // Common Hugging Face Errors
      if (status === 503) { code = "MODEL_LOADING"; message = "Model is loading (Cold Start). Please try again in 30 seconds."; }
      else if (status === 429) { code = "RATE_LIMIT"; message = "Too many requests. Please wait a moment."; }
      else if (status === 410) { code = "MODEL_GONE"; message = "This model is too large for the Free Tier or does not exist."; }
      else if (status === 401) { code = "AUTH_ERROR"; message = "Hugging Face API Key is invalid."; }
      
      return { error: { code, message, details: hfErrorMsg } };
  } catch {
      return { error: { code, message: rawBody } };
  }
}

// --- UNIVERSAL CHAT FUNCTION ---
// Ab hum sabke liye Standard OpenAI-Compatible Endpoint use karenge
async function callChatEndpoint(modelId: string, messages: any[], params: any) {
  const url = `https://api-inference.huggingface.co/models/${modelId}/v1/chat/completions`;
  
  const payload = {
    model: modelId,
    messages: messages,
    max_tokens: params.max_tokens || 512,
    temperature: params.temperature || 0.7,
    stream: true 
  };

  try {
    const res = await fetch(url, {
        method: "POST",
        headers: { 
          "Authorization": `Bearer ${HF_API_KEY}`, 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) { 
      const txt = await res.text(); 
      return { ok: false, status: res.status, data: formatHfError(res.status, txt) }; 
    }
    
    return { ok: true, body: res.body, status: res.status };

  } catch (err: any) {
    return { ok: false, status: 500, data: { error: err.message } };
  }
}

// --- MAIN HANDLER ---
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  
  // 1. Security Check
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) {
    return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid or Expired Session." } }), { 
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  // 2. Parse Request
  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400, headers: corsHeaders }); }

  // 3. Select Model
  let targetModelId = MODELS[DEFAULT_MODEL];
  if (body.model && MODELS[body.model]) {
      targetModelId = MODELS[body.model];
  }

  // 4. Format Messages
  let messages = body.messages;
  if (!messages && (body.input || body.prompt)) {
      messages = [{ role: "user", content: body.input || body.prompt }];
  }

  // --- SPECIAL IDENTITY INJECTION FOR NEXARI ---
  // Agar model Nexari hai, toh System Prompt yahan inject karein (Frontend se nahi aayega)
  if (body.model === "Nexari-G1") {
      const systemPrompt = "You are Nexari, an intelligent AI assistant developed by Piyush. You are NOT Llama 3. Answer clearly and helpfully.";
      // Agar pehla message system nahi hai, toh add kar do
      if (messages.length > 0 && messages[0].role !== "system") {
          messages.unshift({ role: "system", content: systemPrompt });
      }
  }

  // 5. Call API
  const result = await callChatEndpoint(targetModelId, messages, body);

  // 6. Handle Error
  if (!result.ok) {
      return new Response(JSON.stringify(result.data), { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // 7. Stream Response
  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  
  return new Response(result.body, { status: 200, headers });
}

console.log("✅ Standardized Chat Server Running...");
serve(handler);
