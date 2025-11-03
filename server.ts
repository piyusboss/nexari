import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// ✅ 1. Hugging Face API Key ko environment se load karein
const HF_API_KEY = Deno.env.get("HF_API_KEY");

if (!HF_API_KEY) {
  console.error("❌ WARNING: HF_API_KEY environment variable not set!");
  console.error("Server will start, but all API calls will fail.");
}

// ✅✅✅ YAHI HAI ASLI FIX (URL BADAL GAYA HAI) ✅✅✅
// Puraana (wrong) URL: "https://api-inference.huggingface.co/models/"
// Aapke error log ke mutabik naya URL:
const HF_API_BASE_URL = "https://router.huggingface.co/hf-inference/models/";

// ✅ 3. Model Mapping
const MODEL_MAP: { [key: string]: string } = {
  // Aapke logs ke hisaab se v0.3 update kiya
  "Nexari G1": "mistralai/Mistral-7B-Instruct-v0.3", 
  "Nexari G2": "gpt-oss-20b",
};
const DEFAULT_MODEL_ID = MODEL_MAP["Nexari G1"];

// ✅ CORS config
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function handler(req: Request) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Sirf POST requests
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST requests allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // API Key ko request ke andar check karein
  if (!HF_API_KEY) {
    console.error("❌ API Key is missing. Request failed.");
    return new Response(
      JSON.stringify({ error: "Server configuration error: API Key missing." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Client se 'message' aur 'model' ka naam lein
    const { message, model } = await req.json();

    if (!message || typeof message !== "string" || message.trim() === "") {
      return new Response(JSON.stringify({ error: "Message required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ✅ 4. Sahi Model ID chunein
    const modelId = MODEL_MAP[model] || DEFAULT_MODEL_ID;
    
    // ✅✅✅ FIX: Yahan naya URL banega ✅✅✅
    const apiUrl = HF_API_BASE_URL + modelId;
    
    let prompt = message;

    // ✅ 5. Mistral ke liye prompt ko format karein
    if (modelId.includes("mistralai/Mistral")) {
      prompt = `[INST] ${message} [/INST]`;
    }

    console.log(`ℹ️ Calling Hugging Face Model: ${modelId}`);
    console.log(`ℹ️ Using Endpoint: ${apiUrl}`); // Debugging ke liye

    // ✅ 6. Hugging Face API ke liye payload taiyaar karein
    const payload = {
      inputs: prompt,
      parameters: {
        return_full_text: false,
        max_new_tokens: 512,
      },
      options: {
        wait_for_model: true,
      },
    };

    // ✅ 7. Hugging Face API ko call karein
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Hugging Face API Error:", data);
      return new Response(
        JSON.stringify({ error: "Hugging Face API failed", details: data.error || "Unknown error" }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ✅ 8. Response ko extract karein
    const output = data[0]?.generated_text;

    if (!output) {
      console.error("❌ Invalid HF Response Structure:", data);
      return new Response(
        JSON.stringify({ response: "Maaf kijiye, model se empty response mila." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Response ko client ko wapas bhej dein
    return new Response(JSON.stringify({ response: output.trim() }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("💥 Server error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

console.log("✅ Deno server starting...");
console.log("Registered Hugging Face models:");
Object.keys(MODEL_MAP).forEach(key => {
    console.log(`- ${key} -> ${MODEL_MAP[key]}`);
});

// Server ko start karein
serve(handler);
