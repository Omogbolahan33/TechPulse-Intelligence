/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Server-side AI API routes.
 * All AI operations are proxied through the server to keep API keys secure.
 */

import { Router, Request, Response } from "express";
import { serverAI } from "./aiProvider";
import { Type } from "@google/genai";

const router = Router();

// ------------------------------------------------------------------
// AI News Generation
// ------------------------------------------------------------------

interface NewsGenerationParams {
  category: string;
  region: string;
  existingIds?: string[];
  today: string;
}

router.post("/news/generate", async (req: Request, res: Response) => {
  try {
    const { category, region, existingIds = [], today } = req.body as NewsGenerationParams;
    
    const categoryPrompt = category === "All" ? "technology, startups, and innovation" : category;
    const regionPrompt = region === "Global" ? "globally" : `in ${region}`;

    const prompt = `
      Today is ${today}. 
      Use Google Search to find exactly 8 HIGH-IMPACT, BREAKING news stories published within the LAST 24 HOURS specifically about ${categoryPrompt} ${regionPrompt}.
      
      REQUIREMENTS:
      1. ARTICLES MUST BE RECENT: Only include news published since yesterday.
      2. VERBATIM TITLES: Use the actual original headline as the 'title'.
      3. ACCURATE TIMESTAMPS: Use the exact publication time in ISO 8601 format.
      4. REAL SOURCES: Use the official name of the publication (e.g., 'Reuters', 'TechCrunch').
      5. DIVERSITY: Avoid duplicate stories or different sources for the same story.
      
      Return a JSON array of objects with these fields:
      - title: string (the original headline)
      - summary: string (2-3 sentences of core facts)
      - category: string (one of: AI, Software, Hardware, Startups, Cloud, Jobs)
      - timestamp: string (ISO 8601 publication date)
      - source: string (publisher name)
      - imageUrl: string (valid direct HTTPS link to article image)
      - url: string (valid direct HTTPS link to the article)
    `;

    const response = await serverAI.generateContent({
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              summary: { type: Type.STRING },
              category: { type: Type.STRING },
              timestamp: { type: Type.STRING, format: "date-time" },
              source: { type: Type.STRING },
              imageUrl: { type: Type.STRING },
              url: { type: Type.STRING },
            },
            required: ["title", "summary", "category", "timestamp", "source", "imageUrl", "url"],
          },
        },
      },
    });

    // Extract JSON from response
    const text = response.text || "[]";
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || [null, text];
    const jsonContent = (jsonMatch[1] || text).trim();
    const rawNews = JSON.parse(jsonContent);

    res.json({ 
      success: true, 
      articles: rawNews,
      provider: serverAI.getActiveProviderName()
    });
  } catch (error: any) {
    console.error("[API] News generation failed:", error.message);
    res.status(500).json({ 
      success: false, 
      error: "Failed to generate news. Please try again.",
      provider: serverAI.getActiveProviderName()
    });
  }
});

// ------------------------------------------------------------------
// AI Search
// ------------------------------------------------------------------

router.post("/search", async (req: Request, res: Response) => {
  try {
    const { query } = req.body as { query: string };
    
    if (!query) {
      return res.status(400).json({ success: false, error: "Query is required" });
    }

    const response = await serverAI.generateContent({
      contents: `Search for 8 current news stories related to the query: "${query}". Include a high-quality article image URL for each. Ensure all URLs (imageUrl and url) are absolute https links. Return JSON.`,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              title: { type: Type.STRING },
              summary: { type: Type.STRING },
              category: { type: Type.STRING },
              timestamp: { type: Type.STRING },
              source: { type: Type.STRING },
              imageUrl: { type: Type.STRING },
              url: { type: Type.STRING },
            },
            required: ["id", "title", "summary", "category", "timestamp", "source", "imageUrl", "url"],
          },
        },
      },
    });

    const text = response.text || "[]";
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || [null, text];
    const jsonContent = (jsonMatch[1] || text).trim();
    const rawNews = JSON.parse(jsonContent);

    res.json({ 
      success: true, 
      articles: rawNews,
      provider: serverAI.getActiveProviderName()
    });
  } catch (error: any) {
    console.error("[API] Search failed:", error.message);
    res.status(500).json({ 
      success: false, 
      error: "Search capacity exceeded. Please wait a moment.",
      provider: serverAI.getActiveProviderName()
    });
  }
});

// ------------------------------------------------------------------
// AI Article Synthesis
// ------------------------------------------------------------------

router.post("/synthesis", async (req: Request, res: Response) => {
  try {
    const { title, summary, source, url } = req.body as { 
      title: string; 
      summary: string; 
      source: string; 
      url: string; 
    };

    if (!title) {
      return res.status(400).json({ success: false, error: "Title is required" });
    }

    const response = await serverAI.generateContent({
      contents: `Generate a high-impact, tactical intelligence synthesis for the following article.
      
      Title: "${title}"
      Summary: "${summary}"
      Source: "${source}"
      URL: "${url}"
      
      You MUST return your response as a VALID JSON object with the following EXACT structure:
      {
        "fullContent": "A deep, comprehensive analysis of the news, its context, and its profound significance (minimum 3-4 detailed paragraphs).",
        "keyTakeaways": ["Takeaway 1", "Takeaway 2", "Takeaway 3", "Takeaway 4", "Takeaway 5"],
        "implications": {
          "digest": "A high-impact executive summary for board-level briefing.",
          "pros": [
            { "persona": "Persona Name", "insight": "Strategic benefit", "actionPlan": "Execution steps" }
          ],
          "cons": [
            { "persona": "Persona Name", "insight": "Strategic risk", "actionPlan": "Mitigation steps" }
          ]
        }
      }
      
      STRICT CONSTRAINTS:
      - Use the keys provided above EXACTLY.
      - DO NOT hallucinate. 
      - The 'fullContent' must be substantive and professional.`,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            fullContent: { type: Type.STRING },
            keyTakeaways: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            implications: {
              type: Type.OBJECT,
              properties: {
                pros: { 
                  type: Type.ARRAY, 
                  items: { 
                    type: Type.OBJECT,
                    properties: {
                      persona: { type: Type.STRING },
                      insight: { type: Type.STRING },
                      actionPlan: { type: Type.STRING }
                    },
                    required: ["persona", "insight", "actionPlan"]
                  } 
                },
                cons: { 
                  type: Type.ARRAY, 
                  items: { 
                    type: Type.OBJECT,
                    properties: {
                      persona: { type: Type.STRING },
                      insight: { type: Type.STRING },
                      actionPlan: { type: Type.STRING }
                    },
                    required: ["persona", "insight", "actionPlan"]
                  } 
                },
                digest: { type: Type.STRING }
              },
              required: ["pros", "cons", "digest"]
            }
          },
          required: ["fullContent", "keyTakeaways", "implications"],
        },
      },
    });

    const text = response.text || "";
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || [null, text];
    const jsonContent = (jsonMatch[1] || text).trim();
    const analysis = JSON.parse(jsonContent);

    res.json({ 
      success: true, 
      synthesis: analysis,
      provider: serverAI.getActiveProviderName()
    });
  } catch (error: any) {
    console.error("[API] Synthesis failed:", error.message);
    res.status(500).json({ 
      success: false, 
      error: "Synthesis capacity reached. Please try again later.",
      provider: serverAI.getActiveProviderName()
    });
  }
});

// ------------------------------------------------------------------
// AI Article Extras (Quiz, Flashcards, Scripts)
// ------------------------------------------------------------------

router.post("/extras", async (req: Request, res: Response) => {
  try {
    const { title, summary, source } = req.body as { 
      title: string; 
      summary: string; 
      source: string; 
    };

    if (!title) {
      return res.status(400).json({ success: false, error: "Title is required" });
    }

    const response = await serverAI.generateContent({
      contents: `Generate interactive educational extras for the following news article:
      Title: "${title}"
      Summary: "${summary}"
      Source: "${source}"

      Include:
      1. 3-question quiz (multiple choice).
      2. 5 flashcards (front/back).
      3. 1-min video script (engaging, social media style).
      4. 2-min podcast script (conversational dialogue).
      Return JSON.`,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            quiz: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  question: { type: Type.STRING },
                  options: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  correctAnswer: { type: Type.NUMBER },
                  explanation: { type: Type.STRING },
                },
                required: ["question", "options", "correctAnswer", "explanation"],
              },
            },
            flashcards: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  front: { type: Type.STRING },
                  back: { type: Type.STRING },
                },
                required: ["front", "back"],
              },
            },
            videoScript: { type: Type.STRING },
            podcastScript: { type: Type.STRING },
          },
          required: ["quiz", "flashcards", "videoScript", "podcastScript"],
        },
      },
    });

    const text = response.text || "";
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || [null, text];
    const jsonContent = (jsonMatch[1] || text).trim();
    const extras = JSON.parse(jsonContent);

    res.json({ 
      success: true, 
      extras,
      provider: serverAI.getActiveProviderName()
    });
  } catch (error: any) {
    console.error("[API] Extras generation failed:", error.message);
    res.status(500).json({ 
      success: false, 
      error: "Extras generation failed. Please try again.",
      provider: serverAI.getActiveProviderName()
    });
  }
});

// ------------------------------------------------------------------
// AI Chat
// ------------------------------------------------------------------

router.post("/chat", async (req: Request, res: Response) => {
  try {
    const { articleTitle, context, message, history } = req.body as {
      articleTitle: string;
      context: string;
      message: string;
      history: { role: 'user' | 'model', text: string }[];
    };

    if (!message) {
      return res.status(400).json({ success: false, error: "Message is required" });
    }

    const prompt = `
      You are an elite career and technology consultant for TechPulse Intelligence.
      The user is reading about: "${articleTitle}"
      Context related to their specific question: "${context}"
      
      User's question: "${message}"
      
      Conversation History:
      ${history.map(h => `${h.role === 'user' ? 'User' : 'Consultant'}: ${h.text}`).join('\n')}
      
      Provide a sharp, strategic, and practical answer. Keep it professional but engaging, with a "premium intelligence" tone.
    `;

    const response = await serverAI.generateContent({
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        maxOutputTokens: 1000,
      },
    });

    res.json({ 
      success: true, 
      response: response.text || "I'm sorry, I couldn't process that request at the moment.",
      provider: serverAI.getActiveProviderName()
    });
  } catch (error: any) {
    console.error("[API] Chat failed:", error.message);
    res.status(500).json({ 
      success: false, 
      response: "The intelligence network is currently experiencing heavy volume. Please try again shortly.",
      provider: serverAI.getActiveProviderName()
    });
  }
});

// ------------------------------------------------------------------
// AI Provider Diagnostics
// ------------------------------------------------------------------

router.get("/diagnostics", async (_req: Request, res: Response) => {
  try {
    const results = await serverAI.testAllProviders();
    res.json({ 
      success: true, 
      providers: results,
      activeProvider: serverAI.getActiveProviderName(),
      providerCount: serverAI.getProviderCount()
    });
  } catch (error: any) {
    console.error("[API] Diagnostics failed:", error.message);
    res.status(500).json({ success: false, error: "Diagnostics failed" });
  }
});

// ------------------------------------------------------------------
// AI Text-to-Speech (TTS)
// ------------------------------------------------------------------

router.post("/tts", async (req: Request, res: Response) => {
  try {
    const { text, voice } = req.body as { text: string; voice: 'Kore' | 'Puck' | 'Charon' | 'Zephyr' };

    if (!text) {
      return res.status(400).json({ success: false, error: "Text is required" });
    }

    // Import Gemini AI for TTS
    const { GoogleGenAI } = await import("@google/genai");
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      return res.status(503).json({ success: false, error: "TTS not available" });
    }

    const ai = new GoogleGenAI({ apiKey });
    
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice || 'Kore' },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    
    if (base64Audio) {
      res.json({ 
        success: true, 
        audioUrl: `data:audio/mp3;base64,${base64Audio}` 
      });
    } else {
      res.status(500).json({ success: false, error: "TTS generation failed" });
    }
  } catch (error: any) {
    console.error("[API] TTS failed:", error.message);
    res.status(500).json({ success: false, error: "TTS generation failed" });
  }
});

// ------------------------------------------------------------------
// AI Generic Generation (for client proxy)
// ------------------------------------------------------------------

router.post("/generate", async (req: Request, res: Response) => {
  try {
    const { contents, config } = req.body;
    
    if (!contents) {
      return res.status(400).json({ success: false, error: "Contents required" });
    }

    const response = await serverAI.generateContent({ contents, config });
    
    res.json({ 
      success: true, 
      response: response.text,
      provider: serverAI.getActiveProviderName()
    });
  } catch (error: any) {
    console.error("[API] Generate failed:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
