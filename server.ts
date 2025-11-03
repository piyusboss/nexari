import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// ✅ 1. Hugging Face API Key
const HF_API_KEY = Deno.env.get("HF_API_KEY");

if (!HF_API_KEY) {
  console.error("❌ WARNING: HF_API_KEY environment variable not set!");
}

// ✅✅✅ YAHI URL SAHI HAI (Error 410 ke mutabik) ✅✅✅
const HF_API_URL = "https://router.huggingface.co/hf-inference";

// ✅ 3. Model Mapping (FIX YAHAN HAI)
// Humne models ko un models se badal diya hai jo free tier par available hote hain.
const MODEL_MAP: { [key: string]: string } = {
  "Nexari G1": "meta-llama/Meta-Llama-3-8B-Instruct", // v0.3 free tier par nahi tha
  "Nexari G2": "google/gemma-7b-it", // gpt-oss-20b free tier par nahi tha
};
// Default model ko bhi update kar diya
const DEFAULT_MODEL_ID = MODEL_MAP["Nexari G1"];

// ✅ CORS config
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function handler(req: Request) {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Sirf POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST requests allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // API Key Check
  if (!HF_API_KEY) {
    console.error("❌ API Key is missing. Request failed.");
    return new Response(
      JSON.stringify({ error: "Server configuration error: API Key missing." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Client se data lein
    const { message, model } = await req.json();

    if (!message || typeof message !== "string" || message.trim() === "") {
      return new Response(JSON.stringify({ error: "Message required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Sahi Model ID chunein
    const modelId = MODEL_MAP[model] || DEFAULT_MODEL_ID;
    
    let prompt = message;

    // Mistral ya Gemma ke liye prompt format karein
    if (modelId.includes("mistralai/Mistral")) {
      prompt = `[INST] ${message} [/INST]`;
    } else if (modelId.includes("google/gemma")) {
      // Gemma ke liye format
      prompt = `<start_of_turn>user\n${message}<end_of_turn>\n<start_of_turn>model\n`;
    }

    console.log(`ℹ️ Calling Hugging Face Router for model: ${modelId}`);
    console.log(`ℹ️ Using Fixed Endpoint: ${HF_API_URL}`);

    // ✅✅✅ YAHI PAYLOAD SAHI HAI ✅✅✅
    const payload = {
      model: modelId, // <-- Model ka naam JSON ke andar
      inputs: prompt,
      parameters: {
        return_full_text: false,
        max_new_tokens: 512,
      },
      options: {
        wait_for_model: true,
      },
    };

    // Hugging Face API ko call karein
    const response = await fetch(HF_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // Error handling
    if (!response.ok) {
      const errorText = await response.text();
      // Yahan 404 error ka matlab hoga ki naya model bhi load nahi hua
      console.error(`❌ Hugging Face API Error (Status: ${response.status}):`, errorText);
      return new Response(
        JSON.stringify({ 
          error: "Hugging Face API failed", 
          details: errorText || `HTTP status ${response.status}` 
        }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();

    // Response ko extract karein
    let output = data[0]?.generated_text;

    // Gemma kabhi kabhi prompt wapas bhej deta hai, use saaf karein
    if (output && modelId.includes("google/gemma")) {
        if (output.startsWith(prompt)) {
            output = output.substring(prompt.length);
        }
        // Gemma kabhi kabhi "<end_of_turn>" bhejta hai
        output = output.replace(/<end_of_turn>/g, "").trim();
    }

    if (!output || output.trim() === "") {
      console.error("❌ Invalid HF Response Structure:", data);
      return new Response(
        JSON.stringify({ response: "Maaf kijiye, model se empty response mila." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Client ko response bhej dein
    return new Response(JSON.stringify({ response: output.trim() }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("💥 Server error:", error);
    return new Response(JSON.stringify({ error: "Internal server error", details: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

console.log("✅ Deno server starting...");
console.log("Registered Hugging Face models (Updated):");
Object.keys(MODEL_MAP).forEach(key => {
    console.log(`- ${key} -> ${MODEL_MAP[key]}`);
});

// Server ko start karein
serve(handler);
