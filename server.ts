import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// ✅✅✅ DEBUGGING FIX: API Key ko yahan hardcode karein ✅✅✅
// Apni key ko "hf_..." waale quotes ke andar paste karein
const HF_API_KEY = "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"; 

// Hum check kar rahe hain ki key load hui ya nahi
if (!HF_API_KEY || HF_API_KEY === "YOUR_HF_API_KEY_HERE") {
  console.error("❌ FATAL: HF_API_KEY ko code mein hardcode nahi kiya gaya hai!");
  // Server ko start hi nahi karenge
  Deno.exit(1); 
} else {
  console.log("✅ API Key loaded from code (DEBUG MODE)");
}

// ✅ Yahi URL sahi hai
const HF_API_URL = "https://router.huggingface.co/hf-inference";

// ✅ 3. Model Mapping (Hum 'gpt2' se test kar rahe hain)
const MODEL_MAP: { [key: string]: string } = {
  "Nexari G1": "gpt2", // Sabse reliable test model
  "Nexari G2": "google/gemma-7b-it",
};
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

  // API Key Check (ab yeh check hamesha pass hoga)
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

    // Prompt formatting
    if (modelId.includes("mistralai/Mistral")) {
      prompt = `[INST] ${message} [/INST]`;
    } else if (modelId.includes("google/gemma")) {
      prompt = `<start_of_turn>user\n${message}<end_of_turn>\n<start_of_turn>model\n`;
    }

    console.log(`ℹ️ DEBUG: Calling HF Router for model: ${modelId}`);
    console.log(`ℹ️ DEBUG: Using Fixed Endpoint: ${HF_API_URL}`);

    // Payload (bilkul sahi hai)
    const payload = {
      model: modelId, 
      inputs: prompt,
      parameters: {
        return_full_text: false,
        max_new_tokens: 50,
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

    // ... (output cleanup) ...
    if (output && modelId.includes("google/gemma")) {
        if (output.startsWith(prompt)) {
            output = output.substring(prompt.length);
        }
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
    console.log("✅ SUCCESS: Test request with hardcoded key was successful!");
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

console.log("✅ Deno server starting (HARDCODED KEY TEST)");
console.log("Registered Hugging Face models (DEBUG MODE):");
Object.keys(MODEL_MAP).forEach(key => {
    console.log(`- ${key} -> ${MODEL_MAP[key]}`);
});

// Server ko start karein
serve(handler);
