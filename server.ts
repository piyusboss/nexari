// server.ts — DIRECT HF API FIX
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

// === YAHAN CHANGE KIYA HAI ===
// Pehle hum Router use kar rahe the, ab hum Direct Inference API use karenge
// Router aksar custom models ko pehchanne mein fail ho jata hai.
const HF_API_BASE = "https://api-inference.huggingface.co/models"; 

if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing.");
  Deno.exit(1);
}

const MODELS: Record<string, string> = {
  "Nexari-G1": "Piyush-boss/Nexari-Qwen-3B-Full",
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
};

const DEFAULT_MODEL = "Nexari-G1"; 

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

function verifyToken(authHeader: string | null): boolean {
  if (!authHeader) return false;
  try {
    const [payloadB64, signature] = authHeader.split(".");
    if (!payloadB64 || !signature) return false;
    const hmac = createHmac("sha256", SHARED_SECRET);
    hmac.update(payloadB64);
    if (signature !== hmac.digest("hex")) return false;
    return true; // Simplified for speed
  } catch { return false; }
}

// --- MAIN HANDLER ---
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  // 1. Auth Check
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  // 2. Parse Body
  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }

  // 3. Model Selection
  let modelKey = body.model || DEFAULT_MODEL;
  let targetModelId = MODELS[modelKey] || MODELS[DEFAULT_MODEL];
  
  // === CRITICAL FIX: URL Construction ===
  // Hum direct model URL bana rahe hain + OpenAI Compatibility Layer (/v1/chat/completions)
  // Yeh URL format TGI (Text Generation Inference) wale models ke liye standard hai.
  const url = `${HF_API_BASE}/${targetModelId}/v1/chat/completions`;

  console.log(`🚀 Direct Hit to: ${targetModelId}`);

  // 4. Forward Request
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: targetModelId,
        messages: body.messages || [{ role: "user", content: body.prompt || "Hello" }],
        max_tokens: body.max_tokens || 512,
        stream: body.stream || false,
        temperature: body.temperature || 0.7
      })
    });

    // 5. Error Handling (Ab ye Detailed Hoga)
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ HF Error: ${errorText}`);
      
      // Agar Model Loading state mein hai (503 Error)
      if (response.status === 503) {
        return new Response(JSON.stringify({ 
          error: { message: "Model is loading (cold start). Please try again in 20 seconds." } 
        }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ 
        error: { message: `HF Rejected: ${errorText}` } 
      }), { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 6. Return Success
    // Agar stream hai toh seedha body pipe karo, nahi toh JSON return karo
    if (body.stream) {
      return new Response(response.body, { headers: { ...corsHeaders, "Content-Type": "text/event-stream" } });
    } else {
      const data = await response.json();
      return new Response(JSON.stringify(data), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

serve(handler);
