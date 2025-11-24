// server.ts — Final Production Fix (OpenAI Compatible Standard)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) {
  console.error("❌ Critical: HF_API_KEY is missing in Environment Variables.");
  Deno.exit(1);
}

// === 🛡️ SAFE MODEL LIST (Free Tier Optimized) ===
const MODELS: Record<string, string> = {
  // 1. Aapka Nexari (LoRA Adapter)
  "Nexari-G1": "Piyush-boss/Nexari-Qwen-3B-LoRA", 
  
  // 2. DeepSeek (1.5B - Super Light & Fast)
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  
  // 3. Qwen 3B (7B hata diya kyunki wo kabhi-kabhi crash hota hai)
  "Qwen2.5-72B": "Qwen/Qwen2.5-3B-Instruct", 
};

const DEFAULT_MODEL = "Nexari-G1";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

// --- AUTHENTICATION (Security Layer) ---
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
    // Token expiration check (60 seconds)
    if (payload.exp < Math.floor(Date.now() / 1000)) return false;
    
    return true;
  } catch (e) { return false; }
}

// --- ERROR HANDLING (Detailed Diagnostics) ---
function formatHfError(status: number, rawBody: string) {
  let code = "SERVER_ERROR";
  let message = `Hugging Face Error (${status})`;
  
  try {
      const jsonBody = JSON.parse(rawBody);
      const hfErrorMsg = jsonBody?.error?.message || jsonBody?.error || rawBody;
      
      if (status === 503) { 
          code = "MODEL_LOADING"; 
          message = "Model is loading (Cold Start). Please wait 30s and try again."; 
      }
      else if (status === 429) { 
          code = "RATE_LIMIT"; 
          message = "Too many requests. Please slow down."; 
      }
      else if (status === 410 || status === 404) { 
          code = "MODEL_ACCESS_ERROR"; 
          message = "Model not found or too large for Free API. Check Model ID."; 
      }
      else if (status === 401) { 
          code = "AUTH_ERROR"; 
          message = "Invalid Hugging Face API Key."; 
      }
      
      return { error: { code, message, details: hfErrorMsg } };
  } catch {
      return { error: { code, message: rawBody } };
  }
}

// --- THE CORE: OpenAI Compatible API Call ---
async function callOpenAIStyleEndpoint(modelId: string, messages: any[], params: any) {
  // Yeh "v1/chat/completions" endpoint sabse stable hai naye models ke liye
  const url = `https://api-inference.huggingface.co/models/${modelId}/v1/chat/completions`;
  
  const payload = {
    model: modelId,
    messages: messages,
    max_tokens: params.max_tokens || 512,
    temperature: params.temperature || 0.7,
    stream: true // Streaming is essential for chat experience
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
    return { ok: false, status: 500, data: { error: { code: "NETWORK_ERROR", message: err.message } } };
  }
}

// --- MAIN HANDLER ---
async function handler(req: Request): Promise<Response> {
  // 1. CORS Preflight
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  
  // 2. Token Verification
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) {
    return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Security Token Invalid." } }), { 
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  // 3. Parse Request
  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400, headers: corsHeaders }); }

  // 4. Model Selection Logic
  let targetModelId = MODELS[DEFAULT_MODEL];
  if (body.model && MODELS[body.model]) {
      targetModelId = MODELS[body.model];
  } else {
      console.warn(`Warning: Model '${body.model}' not found in config. Using Default.`);
  }

  // 5. Message Formatting
  let messages = body.messages;
  if (!messages && (body.input || body.prompt)) {
      messages = [{ role: "user", content: body.input || body.prompt }];
  }

  // --- NEXARI IDENTITY INJECTION ---
  // System prompt frontend se aana chahiye, par backup ke liye yahan bhi inject karte hain
  if (targetModelId.includes("Nexari")) {
      const hasSystem = messages.some((m: any) => m.role === "system");
      if (!hasSystem) {
          messages.unshift({ 
              role: "system", 
              content: "You are Nexari, an intelligent AI assistant developed by Piyush. Answer clearly and concisely." 
          });
      }
  }

  // 6. Execute Call
  const result = await callOpenAIStyleEndpoint(targetModelId, messages, body);

  // 7. Handle Response
  if (!result.ok) {
      return new Response(JSON.stringify(result.data), { 
          status: result.status, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
  }

  // 8. Return Stream
  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  headers.set("Connection", "keep-alive");
  
  return new Response(result.body, { status: 200, headers });
}

console.log("✅ Production Server Running (v1/chat/completions Mode)...");
serve(handler);
