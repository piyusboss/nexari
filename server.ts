import { serve } from "https://deno.land/std@0.182.0/http/server.ts";

const GEMINI_API_KEY = "AIzaSyAn_AV2_WQiOdUAEzUGoKrJH-adMsVlWC4";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;

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

  // ✅ Only POST allowed
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // ✅ Parse client request
    const { message } = await req.json();
    if (!message || typeof message !== "string" || message.trim() === "") {
      return new Response(JSON.stringify({ error: "Message required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ✅ Create Gemini request body
    const body = {
      contents: [
        {
          parts: [{ text: message }],
        },
      ],
    };

    // ✅ Call Gemini API
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    // ✅ Handle empty or invalid responses
    const rawText = await res.text();
    if (!rawText) {
      console.error("Gemini returned empty body");
      return new Response(
        JSON.stringify({ error: "Empty response from Gemini API" }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error("Invalid JSON from Gemini:", rawText);
      return new Response(
        JSON.stringify({ error: "Invalid JSON from Gemini", raw: rawText }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ✅ Handle Gemini error payloads
    if (!res.ok) {
      console.error("Gemini error:", data);
      return new Response(
        JSON.stringify({ error: "Gemini API failed", details: data }),
        {
          status: res.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ✅ Extract response text safely
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Maaf kijiye, koi jawab nahi mil paaya.";

    // ✅ Send success response to client
    return new Response(JSON.stringify({ response: text }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Server error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

console.log("✅ Deno server running on http://localhost:8000");
await serve(handler, { port: 8000 });
