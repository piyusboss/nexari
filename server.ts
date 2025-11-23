// server.ts — Fixed for Custom Models (Raw Mode)
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

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

// --- HELPER: Verify Token ---
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

// --- HELPER: Format Errors ---
function formatHfError(status: number, rawBody: string) {
  let code = "UNKNOWN_ERROR";
  let message = `Server Error (${status})`;
  try {
      const jsonBody = JSON.parse(rawBody);
      const hfErrorMsg = jsonBody?.error?.message || jsonBody?.error || rawBody;
      
      if (status === 503) { code = "MODEL_LOADING"; message = "Nexari is waking up. Please try again in 30s."; }
      else if (status === 429) { code = "HEAVY_TRAFFIC"; message = "Traffic high. Please wait 1 min."; }
      else if (status === 500) { code = "INTERNAL_ERROR"; message = "Hugging Face Internal Error."; }
      
      return { error: { code, message, details: hfErrorMsg } };
  } catch {
      return { error: { code, message: rawBody } };
  }
}

// --- HELPER: Manual Llama 3 Prompting ---
// Custom models ke liye hum khud prompt banayenge taaki HF crash na ho
function generateLlama3Prompt(messages: any[]) {
    let prompt = "<|begin_of_text|>";
    
    // System Prompt (Hidden)
    prompt += `<|start_header_id|>system<|end_header_id|>\n\nYou are Nexari, an intelligent AI assistant developed by Piyush. You are NOT Llama 3. Answer clearly.<|eot_id|>`;
    
    // User/Assistant History
    messages.forEach(msg => {
        prompt += `<|start_header_id|>${msg.role}<|end_header_id|>\n\n${msg.content}<|eot_id|>`;
    });
    
    // Assistant trigger
    prompt += `<|start_header_id|>assistant<|end_header_id|>\n\n`;
    return prompt;
}

// --- API CALLS ---

// 1. Standard Call (For DeepSeek/Qwen) - Uses OpenAI format
async function callChatEndpoint(modelId: string, payload: any) {
  const url = `https://api-inference.huggingface.co/models/${modelId}/v1/chat/completions`;
  const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${HF_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
  });
  if (!res.ok) { const txt = await res.text(); return { ok: false, status: res.status, data: formatHfError(res.status, txt) }; }
  return { ok: true, body: res.body }; // Returns stream
}

// 2. Raw Call (For Nexari) - Uses Manual Prompting
async function callRawEndpoint(modelId: string, messages: any[], params: any) {
  const url = `https://api-inference.huggingface.co/models/${modelId}`;
  
  // Manual Prompt Construction
  const prompt = generateLlama3Prompt(messages);
  
  const payload = {
      inputs: prompt,
      parameters: {
          max_new_tokens: params.max_tokens || 512,
          temperature: params.temperature || 0.7,
          return_full_text: false,
          stream: true // Always stream
      }
  };

  const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${HF_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
  });

  if (!res.ok) { const txt = await res.text(); return { ok: false, status: res.status, data: formatHfError(res.status, txt) }; }
  return { ok: true, body: res.body };
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

  let targetModelId = MODELS[DEFAULT_MODEL];
  if (body.model && MODELS[body.model]) targetModelId = MODELS[body.model];

  let messages = body.messages;
  if (!messages && (body.input || body.prompt)) messages = [{ role: "user", content: body.input || body.prompt }];

  // === LOGIC SWITCH ===
  // Agar Nexari hai toh Raw Endpoint use karo, baaki ke liye Standard Chat Endpoint
  let result;
  if (targetModelId.includes("Nexari")) {
      result = await callRawEndpoint(targetModelId, messages, body);
  } else {
      result = await callChatEndpoint(targetModelId, {
          model: targetModelId,
          messages: messages,
          max_tokens: body.max_tokens || 512,
          temperature: body.temperature || 0.7,
          stream: true
      });
  }

  if (!result.ok) {
      return new Response(JSON.stringify(result.data), { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Stream Response Forwarding
  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  
  return new Response(result.body, { status: 200, headers });
}

console.log("✅ Hybrid Routing Server Running...");
serve(handler);
