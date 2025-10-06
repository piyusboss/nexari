import { serve } from "https://deno.land/std@0.182.0/http/server.ts";

// ✅ Your Gemini API key
const GEMINI_API_KEY = "AIzaSyAn_AV2_WQiOdUAEzUGoKrJH-adMsVlWC4";

// ✅ Correct API endpoint and model
const API_URL = `https://generativelanguage.googleapis.com/v1beta1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ✅ CORS config
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function handler(req) {
  // ✅ Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST requests allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { message } = await req.json();
    if (!message || typeof message !== "string" || message.trim() === "") {
      return new Response(JSON.stringify({ error: "Message required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ✅ Proper Gemini API request body
    const payload = {
      contents: [
        {
          role: "user",
          parts: [{ text: message }],
        },
      ],
    };

    // ✅ Call Gemini API
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const rawText = await response.text();

    // 🧩 Debug logging (helps track if response is empty)
    console.log("🔍 Raw Gemini response:", rawText);

    if (!rawText || rawText.trim() === "") {
      return new Response(
        JSON.stringify({
          error: "Gemini returned empty response",
          hint: "Check if model name and payload format are correct.",
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error("❌ JSON parse error:", err, "Raw:", rawText);
      return new Response(
        JSON.stringify({ error: "Invalid JSON response from Gemini", raw: rawText }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!response.ok) {
      console.error("❌ Gemini API Error:", data);
      return new Response(
        JSON.stringify({ error: "Gemini API failed", details: data }),
        {
          status: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ✅ Extract AI message
    const output =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Maaf kijiye, Gemini ne koi jawab nahi diya.";

    return new Response(JSON.stringify({ response: output }), {
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

console.log("✅ Deno server running at http://localhost:8000");
await serve(handler, { port: 8000 });
