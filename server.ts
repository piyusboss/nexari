import { serve } from "https://deno.land/std@0.182.0/http/server.ts";

// 🔑 Your Gemini API Key
const GEMINI_API_KEY = "AIzaSyAn_AV2_WQiOdUAEzUGoKrJH-adMsVlWC4";

// ✅ Correct API endpoint and model name
const API_URL = `https://generativelanguage.googleapis.com/v1beta1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function handler(req) {
  // ✅ Handle CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ✅ Only POST allowed
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST requests allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // ✅ Parse input
    const { message } = await req.json();
    if (!message || typeof message !== "string" || message.trim() === "") {
      return new Response(JSON.stringify({ error: "Message required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ✅ Prepare Gemini request body
    const payload = {
      contents: [
        {
          parts: [{ text: message }],
        },
      ],
    };

    // ✅ Call Gemini API
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const textResponse = await response.text();

    // ✅ Handle empty/invalid response
    if (!textResponse) {
      console.error("Gemini returned empty response");
      return new Response(
        JSON.stringify({ error: "Empty response from Gemini API" }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ✅ Try parsing JSON
    let data;
    try {
      data = JSON.parse(textResponse);
    } catch (err) {
      console.error("Invalid JSON from Gemini:", textResponse);
      return new Response(
        JSON.stringify({ error: "Invalid JSON response from Gemini", raw: textResponse }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ✅ If Gemini error
    if (!response.ok) {
      console.error("Gemini API Error:", data);
      return new Response(JSON.stringify({ error: "Gemini API failed", details: data }), {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ✅ Extract the actual response text
    const output =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Maaf kijiye, koi jawab nahi mil paaya.";

    return new Response(JSON.stringify({ response: output }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Server error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

console.log("✅ Deno server running on http://localhost:8000");
await serve(handler, { port: 8000 });
