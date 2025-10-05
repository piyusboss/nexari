import { serve } from "https://deno.land/std@0.182.0/http/server.ts";

// Aapke dwara di gayi API Key
const GEMINI_API_KEY = "AIzaSyAn_AV2_WQiOdUAEzUGoKrJH-adMsVIWC4";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

// CORS headers, taaki PHP server isse connect kar sake
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function handler(req: Request): Promise<Response> {
  // CORS preflight request ko handle karna
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Sirf POST requests allowed hain" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { message } = await req.json();

    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "Message khali nahi ho sakta" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Gemini API ke liye request body taiyar karna
    const geminiPayload = {
      contents: [
        {
          parts: [{ text: message }],
        },
      ],
    };

    // Gemini API ko call karna
    const geminiResponse = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(geminiPayload),
    });

    if (!geminiResponse.ok) {
        const errorBody = await geminiResponse.text();
        console.error("Gemini API Error:", errorBody);
        return new Response(JSON.stringify({ error: "Gemini API se response nahi mila", details: errorBody }), {
            status: geminiResponse.status,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
    
    const geminiData = await geminiResponse.json();
    
    // API response se text nikalna
    const textResponse = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "Maaf kijiye, main iska jawab nahi de pa raha hoon.";

    // PHP proxy ko jawab bhejna
    return new Response(JSON.stringify({ response: textResponse }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Server Error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

console.log("Deno server http://localhost:8000 par chal raha hai...");
await serve(handler, { port: 8000 });
