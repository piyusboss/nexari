// server.ts — The "Universal Router" Fix (Guaranteed Path)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing.");
  Deno.exit(1);
}

const MODELS: Record<string, string> = {
  // Custom Model (Updated ID)
  "Nexari-G1": "Piyush-boss/Nexari-Qwen-3B-Full", 
  
  // Official Models
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  "Qwen-7B": "Qwen/Qwen2.5-7B-Instruct", 
};

const DEFAULT_MODEL = "Nexari-G1";

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
  } catch (e) { return false; }
}

// --- THE MAGIC FIX: UNIVERSAL API CALL ---
async function callHuggingFaceRouter(modelId: string, messages: any[], params: any) {
  
  // ✅ SOLUTION: Hum URL mein model ID nahi dalenge.
  // Hum "hf-inference" provider ka Generic URL use karenge.
  const url = "https://router.huggingface.co/hf-inference/v1/chat/completions";
  
  // System Prompt Logic for Nexari
  if (modelId.includes("Nexari")) {
      const hasSystem = messages.some((m: any) => m.role === "system");
      if (!hasSystem) {
          messages.unshift({ 
              role: "system", 
              content: "You are Nexari, an intelligent AI assistant developed by Piyush. You are NOT Llama 3. Answer clearly." 
          });
      }
  }

  const payload = {
    model: modelId, // <--- Model ID yahan body mein jayega
    messages: messages,
    max_tokens: params.max_tokens || 512,
    temperature: params.temperature || 0.7,
    stream: true 
  };

  console.log(`Routing to: ${modelId} via Universal Endpoint`);

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
      let errMsg = `HF Error ${res.status}`;
      
      if (res.status === 503) errMsg = "Model is loading (Cold Start)... Please wait 30s and retry.";
      if (res.status === 404) errMsg = "Model not found. Check 'pipeline_tag' in README.md";
      if (res.status === 422) errMsg = "Unprocessable Entity (Format Issue).";
      
      return { ok: false, status: res.status, data: { error: { message: errMsg, details: txt } } }; 
    }
    
    return { ok: true, body: res.body, status: res.status };

  } catch (err: any) {
    return { ok: false, status: 500, data: { error: { message: err.message } } };
  }
}

// --- HANDLER ---
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401, headers: corsHeaders });

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400, headers: corsHeaders }); }

  let targetModelId = MODELS[DEFAULT_MODEL];
  if (body.model && MODELS[body.model]) targetModelId = MODELS[body.model];

  let messages = body.messages || [{ role: "user", content: body.input || "Hi" }];

  // Call Universal Router
  const result = await callHuggingFaceRouter(targetModelId, messages, body);

  if (!result.ok) {
      return new Response(JSON.stringify(result.data), { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  
  return new Response(result.body, { status: 200, headers });
}

console.log("✅ Universal Router v3 Running...");
serve(handler);
