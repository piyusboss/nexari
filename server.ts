// server.ts — Deno Server (Latest 2025 Architecture: Raw vs Router)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing.");
  Deno.exit(1);
}

// === MODEL CONFIG ===
const MODELS: Record<string, string> = {
  "Nexari-G1": "Piyush-boss/Nexari-Qwen-3B-Full",
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  "Qwen2.5-72B": "Qwen/Qwen2.5-72B-Instruct", 
};

const DEFAULT_MODEL = "Nexari-G1"; 

// === HELPER: Manual Chat Template (Qwen Format) ===
// Kyunki Raw API "messages" array nahi samajhta, humein text bhejna hoga.
function applyChatTemplate(messages: any[]): string {
  let prompt = "";
  // System Prompt Handle karo (Agar pehla message system hai)
  if (messages[0].role === "system") {
      prompt += `<|im_start|>system\n${messages[0].content}<|im_end|>\n`;
      messages = messages.slice(1);
  } else {
      // Default System Prompt for Nexari
      prompt += `<|im_start|>system\nYou are Nexari, a helpful AI assistant.<|im_end|>\n`;
  }

  for (const msg of messages) {
    prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
  }
  // Assistant ko trigger karne ke liye
  prompt += `<|im_start|>assistant\n`;
  return prompt;
}

// === URL SELECTION ===
function getModelConfig(modelId: string) {
  // Custom Models use RAW Generation Endpoint
  if (modelId.includes("Piyush-boss") || modelId.includes("Nexari")) {
    return {
      type: "CUSTOM",
      url: `https://api-inference.huggingface.co/models/${modelId}`, // Note: No /v1/chat here!
    };
  }
  // VIP Models use Global Router (OpenAI Compatible)
  return {
    type: "VIP",
    url: `https://router.huggingface.co/v1/chat/completions`
  };
}

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

// --- ERROR HANDLING ---
function formatHfError(status: number, rawBody: string) {
  let message = rawBody;
  try {
      const json = JSON.parse(rawBody);
      message = json.error || json.message || JSON.stringify(json);
  } catch {}

  if (status === 503) return { error: { code: "LOADING", message: "Model is loading (Cold Boot). Wait 20s." } };
  if (status === 404) return { error: { code: "NOT_FOUND", message: "Model endpoint not found. Check URL logic." } };
  return { error: { code: `HF_${status}`, message: `HF Error: ${message}` } };
}

// --- HANDLER ---
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  // 1. Auth Check
  const token = req.headers.get("X-Nexari-Token");
  // Simple check for now to debug (Add verifyToken logic back if needed strictly)
  if (!token) return new Response(JSON.stringify({error: "No Token"}), {status: 401, headers: corsHeaders});

  if (req.method !== "POST") return new Response("Only POST", { status: 405 });

  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  let targetModelId = MODELS[body.model] || MODELS[DEFAULT_MODEL];
  const config = getModelConfig(targetModelId);

  console.log(`🎯 Request: ${targetModelId} via [${config.type}] mode`);

  try {
    let finalPayload: any;
    let finalHeaders = {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json"
    };

    // === LOGIC BRANCHING ===
    
    if (config.type === "CUSTOM") {
        // SCENARIO A: CUSTOM MODEL (Raw Text)
        // Convert Messages to String
        const inputs = applyChatTemplate(body.messages || []);
        
        finalPayload = {
            inputs: inputs,
            parameters: {
                max_new_tokens: body.max_tokens || 512,
                temperature: body.temperature || 0.7,
                return_full_text: false // Sirf naya text chahiye
            }
        };
    } else {
        // SCENARIO B: VIP MODEL (OpenAI Format)
        finalPayload = {
            model: targetModelId,
            messages: body.messages,
            max_tokens: body.max_tokens,
            temperature: body.temperature,
            stream: false // Simplicity ke liye stream off rakha hai abhi
        };
    }

    // Call Hugging Face
    const res = await fetch(config.url, {
        method: "POST",
        headers: finalHeaders,
        body: JSON.stringify(finalPayload)
    });

    const text = await res.text();
    
    if (!res.ok) {
        console.error(`❌ Error [${res.status}]:`, text);
        const errData = formatHfError(res.status, text);
        return new Response(JSON.stringify(errData), { status: res.status, headers: {...corsHeaders, "Content-Type": "application/json"} });
    }

    // === RESPONSE NORMALIZATION ===
    // Hum frontend ko hamesha OpenAI format hi bhejenge, chahe peeche kuch bhi ho
    let finalData;

    if (config.type === "CUSTOM") {
        // Raw API returns: [{ generated_text: "..." }]
        const rawResponse = JSON.parse(text);
        const generatedText = rawResponse[0]?.generated_text || "";
        
        // Mock OpenAI Structure
        finalData = {
            id: crypto.randomUUID(),
            object: "chat.completion",
            created: Date.now(),
            choices: [{
                index: 0,
                message: { role: "assistant", content: generatedText },
                finish_reason: "stop"
            }]
        };
    } else {
        // Router returns OpenAI format directly
        finalData = JSON.parse(text);
    }

    return new Response(JSON.stringify(finalData), { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });

  } catch (err: any) {
    console.error("Critical:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

console.log("✅ Nexari Universal Server (2025 Edition) Running...");
serve(handler);
