// server.ts — THE FINAL BRIDGE (VIP = Router, Custom = Raw Translator)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) { console.error("❌ HF_API_KEY missing."); Deno.exit(1); }

// === MODEL CONFIG ===
const MODELS: Record<string, string> = {
  "Nexari-G1": "Piyush-boss/Nexari-Qwen-3B-Full",
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  "Qwen2.5-72B": "Qwen/Qwen2.5-72B-Instruct", 
};
const DEFAULT_MODEL = "Nexari-G1"; 

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

// === 🧠 THE TRANSLATOR BRAIN (JSON -> RAW STRING) ===
// Custom models raw text mangte hain, unhe JSON samajh nahi aata
function convertMessagesToQwenPrompt(messages: any[]): string {
  let prompt = "";
  // System Prompt (Agar user ne nahi diya, toh default lagao)
  const hasSystem = messages.length > 0 && messages[0].role === "system";
  if (!hasSystem) {
    prompt += "<|im_start|>system\nYou are Nexari, a helpful AI assistant.<|im_end|>\n";
  }

  // Messages Loop
  for (const msg of messages) {
    prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
  }
  // Assistant Trigger
  prompt += "<|im_start|>assistant\n";
  return prompt;
}

// === AUTH ===
function verifyToken(authHeader: string | null): boolean {
  if (!authHeader) return false;
  try {
    const [payloadB64, signature] = authHeader.split(".");
    if (!payloadB64 || !signature) return false;
    const hmac = createHmac("sha256", SHARED_SECRET);
    hmac.update(payloadB64);
    return signature === hmac.digest("hex");
  } catch { return false; }
}

// === HANDLER ===
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) return new Response(JSON.stringify({error: "Unauthorized"}), {status: 401, headers: corsHeaders});
  if (req.method !== "POST") return new Response("Only POST", { status: 405 });

  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  let targetModelId = MODELS[body.model] || MODELS[DEFAULT_MODEL];
  const isCustomModel = targetModelId.includes("Piyush-boss") || targetModelId.includes("Nexari");

  console.log(`🎯 Logic: ${isCustomModel ? "CUSTOM (Raw Bridge)" : "VIP (Router)"} for ${targetModelId}`);

  try {
    let fetchUrl = "";
    let fetchPayload = {};
    const headers = { 
        "Authorization": `Bearer ${HF_API_KEY}`, 
        "Content-Type": "application/json" 
    };

    // === BRANCHING LOGIC ===
    if (isCustomModel) {
        // 🛠️ CUSTOM PATH (The Bridge)
        // URL: Seedha model root par hit karo (No /v1/chat)
        fetchUrl = `https://api-inference.huggingface.co/models/${targetModelId}`;
        
        // Input: Raw String banao
        const rawInput = convertMessagesToQwenPrompt(body.messages || []);
        
        fetchPayload = {
            inputs: rawInput,
            parameters: {
                max_new_tokens: body.max_tokens || 512,
                temperature: body.temperature || 0.7,
                return_full_text: false // Sirf naya text chahiye
            }
        };
    } else {
        // 🚀 VIP PATH (Router)
        fetchUrl = "https://router.huggingface.co/v1/chat/completions";
        fetchPayload = {
            model: targetModelId,
            messages: body.messages,
            max_tokens: body.max_tokens,
            temperature: body.temperature,
            stream: false
        };
    }

    // === EXECUTE REQUEST ===
    const res = await fetch(fetchUrl, {
        method: "POST", headers, body: JSON.stringify(fetchPayload)
    });

    const rawText = await res.text();

    if (!res.ok) {
        console.error(`HF Error [${res.status}]:`, rawText);
        // Special case for loading
        if (res.status === 503) {
             return new Response(JSON.stringify({ error: { code: "LOADING", message: "Nexari is waking up (Cold Boot). Try in 20s." } }), { status: 503, headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: `HF Error: ${rawText}` }), { status: res.status, headers: corsHeaders });
    }

    // === RESPONSE ADAPTER (Sabko OpenAI Format bana do) ===
    let finalJson;
    
    if (isCustomModel) {
        // Raw API returns: [{ "generated_text": "Hello world" }]
        // Ise hum OpenAI format mein wrap karenge
        const rawData = JSON.parse(rawText);
        const reply = Array.isArray(rawData) ? rawData[0].generated_text : (rawData.generated_text || "");
        
        finalJson = {
            id: crypto.randomUUID(),
            object: "chat.completion",
            created: Date.now(),
            choices: [{
                index: 0,
                message: { role: "assistant", content: reply },
                finish_reason: "stop"
            }]
        };
    } else {
        // Router already returns OpenAI JSON
        finalJson = JSON.parse(rawText);
    }

    return new Response(JSON.stringify(finalJson), { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

console.log("✅ 2025 Bridge Server Running...");
serve(handler);
