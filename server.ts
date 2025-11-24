// server.ts — Universal Raw API Fix (Solves 410 Error)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing.");
  Deno.exit(1);
}

// === CORRECT MODEL IDs ===
const MODELS: Record<string, string> = {
  // Aapka Custom Adapter (Base Qwen automatic load hoga)
  "Nexari-G1": "Piyush-boss/Nexari-Qwen-3B-LoRA", 
  
  // DeepSeek (Small & Fast)
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  
  // Qwen 7B (Yeh 10GB ke andar hai, 72B nahi chalta)
  "Qwen2.5-72B": "Qwen/Qwen2.5-7B-Instruct", 
};

const DEFAULT_MODEL = "Nexari-G1";

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

// --- PROMPT FORMATTER (Universal ChatML) ---
// Qwen, DeepSeek aur Nexari teeno ko ye format samajh aata hai
function generatePrompt(messages: any[], modelId: string) {
    let prompt = "";
    
    // System Prompt Injection for Nexari
    if (modelId.includes("Nexari")) {
        const sysPrompt = "You are Nexari, an intelligent AI assistant developed by Piyush. You are NOT Llama 3. Answer clearly.";
        // Check if system prompt already exists
        if (messages.length > 0 && messages[0].role === "system") {
            messages[0].content = sysPrompt;
        } else {
            messages.unshift({ role: "system", content: sysPrompt });
        }
    }

    // Build String
    messages.forEach(msg => {
        prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
    });
    
    prompt += `<|im_start|>assistant\n`;
    return prompt;
}

// --- RAW API CALL ---
async function callHuggingFace(modelId: string, prompt: string, params: any) {
  // FIX: Using the direct model URL (Most reliable)
  const url = `https://api-inference.huggingface.co/models/${modelId}`;
  
  const payload = {
    inputs: prompt,
    parameters: {
      max_new_tokens: 512,
      temperature: params.temperature || 0.7,
      return_full_text: false,
      stream: true // Always stream
    }
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
      // Error parsing
      let errMsg = txt;
      try { errMsg = JSON.parse(txt).error; } catch {}
      
      if (res.status === 503) errMsg = "Model loading... (Cold Start)";
      if (res.status === 410) errMsg = "Model too large or restricted.";
      
      return { ok: false, status: res.status, error: errMsg }; 
    }
    
    return { ok: true, body: res.body };

  } catch (err: any) {
    return { ok: false, status: 500, error: err.message };
  }
}

// --- MAIN HANDLER ---
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400, headers: corsHeaders }); }

  // Model Selection
  let targetModelId = MODELS[DEFAULT_MODEL];
  if (body.model && MODELS[body.model]) targetModelId = MODELS[body.model];

  // Messages
  let messages = body.messages;
  if (!messages && (body.input || body.prompt)) messages = [{ role: "user", content: body.input || body.prompt }];

  // 1. Generate Prompt
  const prompt = generatePrompt(messages, targetModelId);

  // 2. Call API
  const result = await callHuggingFace(targetModelId, prompt, body);

  if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error }), { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // 3. Stream Response
  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  
  return new Response(result.body, { status: 200, headers });
}

console.log("✅ Universal Raw Server Running...");
serve(handler);
