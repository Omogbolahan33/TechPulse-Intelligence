import { ai, MODELS } from "../lib/gemini";
import { unifiedAI } from "./aiProvider";
import { Type } from "@google/genai";
import { getSourcesForSelection } from "./sourceConfig";
import { db } from "../firebase";
import { 
  collection, 
  query, 
  where, 
  getDocs, 
  limit, 
  orderBy,
  doc,
  setDoc,
  getDoc
} from "firebase/firestore";

export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  category: string;
  timestamp: string;
  source: string;
  imageUrl: string;
  url: string;
  region?: string;
  fetchedAt?: string;
}

export interface StrategicImplication {
  persona: string;
  insight: string;
  actionPlan: string;
}

export interface ArticleContent {
  fullContent: string;
  keyTakeaways: string[];
  implications?: {
    pros: (string | StrategicImplication)[];
    cons: (string | StrategicImplication)[];
    digest: string;
  };
  url?: string;
  source?: string;
  quiz?: {
    question: string;
    options: string[];
    correctAnswer: number;
    explanation: string;
  }[];
  flashcards?: {
    front: string;
    back: string;
  }[];
  videoScript?: string;
  podcastScript?: string;
  hasExtras?: boolean;
}

function ensureAbsoluteUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `https://${url}`;
}

function generateStableId(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash) + url.charCodeAt(i);
    hash |= 0;
  }
  const tail = url.slice(-30).replace(/[^a-zA-Z0-9]/g, '');
  return `${Math.abs(hash).toString(36)}_${tail}`;
}

function isRateLimitError(error: any): boolean {
  if (!error) return false;
  const errorStr = JSON.stringify(error).toLowerCase();
  return errorStr.includes("429") || errorStr.includes("quota") || errorStr.includes("resource_exhausted");
}

export async function fetchLatestTechNews(
  category: string = "All",
  region: string = "Global",
  existingIds: string[] = [],
  skipAI: boolean = false,
  forceRefresh: boolean = false
): Promise<NewsArticle[]> {
  try {
    const now = new Date();
    const isServer = typeof window === 'undefined';
    
    // 1. & 2. Parallelize Server API and Firestore fetches for maximum speed
    const serverFetch = !isServer ? fetch(`/api/news?category=${encodeURIComponent(category)}&region=${encodeURIComponent(region)}`)
      .then(async res => {
        if (res.ok) {
          const news = await res.json() as NewsArticle[];
          const filtered = news.filter(n => !existingIds.includes(n.id));
          return { source: 'server', news: filtered };
        }
        throw new Error("Server fetch failed");
      }).catch(() => null) : Promise.resolve(null);

    const firestoreFetch = (async () => {
      const newsRef = collection(db, "news");
      let q = query(
        newsRef,
        where("category", "==", category),
        where("region", "==", region),
        orderBy("timestamp", "desc"),
        limit(12)
      );

      if (category === "All") {
        q = query(
          newsRef,
          where("region", "==", region),
          orderBy("timestamp", "desc"),
          limit(12)
        );
      }

      const querySnapshot = await getDocs(q);
      const fsNews: NewsArticle[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data() as NewsArticle;
        if (!existingIds.includes(data.id)) {
          fsNews.push(data);
        }
      });
      return { source: 'firestore', news: fsNews };
    })().catch(() => null);

    // Race the two sources - return the first one that gives us enough data
    const fastResult = await Promise.race([serverFetch, firestoreFetch]);
    
    if (fastResult && fastResult.news.length >= 5 && !forceRefresh) {
      const latest = fastResult.news[0];
      const isFresh = latest && (now.getTime() - new Date(latest.timestamp).getTime() < 2 * 60 * 60 * 1000);
      
      if (isFresh) {
        console.log(`Fastest source (${fastResult.source}) returned ${fastResult.news.length} fresh articles.`);
        return fastResult.news;
      }
    }

    // If the fastest didn't have enough/fresh data, wait for the other one
    const results = await Promise.all([serverFetch, firestoreFetch]);
    const allNews = results
      .filter((r): r is { source: string; news: NewsArticle[] } => !!r)
      .sort((a, b) => b.news.length - a.news.length); // Prefer the source with more data

    if (allNews.length > 0) {
      const bestSource = allNews[0];
      const latest = bestSource.news[0];
      const isFresh = latest && (now.getTime() - new Date(latest.timestamp).getTime() < 2 * 60 * 60 * 1000);

      if (bestSource.news.length >= 5 && isFresh && !forceRefresh) {
        return bestSource.news;
      }
      
      // If we have some data but it's stale, we'll return it but maybe trigger AI in background?
      // For now, if we have data, we return it to keep it "fast".
      if (bestSource.news.length > 0 && !skipAI && !forceRefresh) {
        // If it's stale, we return it but the caller might want to know it's stale
        // In this app, we'll return it and let the background polling handle updates
        return bestSource.news;
      }
    }

    const bestCachedNews = allNews[0]?.news || [];

    // 3. Fallback to Gemini AI Search (Slow)
    if (skipAI) {
      console.log("Skipping AI fetch as requested.");
      return bestCachedNews;
    }

    console.log("Cache miss or stale content. Fetching fresh news from AI...");
    
    const today = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const categoryPrompt = category === "All" ? "technology, startups, and innovation" : `${category}`;
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

    let news: NewsArticle[] = [];
    try {
      const aiResponse = await unifiedAI.generateContent({
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

      let rawNews: any = [];
      try {
        const text = aiResponse.text || "[]";
        // Robust JSON extraction: Strip markdown code blocks if they exist
        const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || [null, text];
        const jsonContent = (jsonMatch[1] || text).trim();
        rawNews = JSON.parse(jsonContent);
      } catch (e) {
        console.error("AI News JSON Parsing failed:", e);
        rawNews = [];
      }

      // Robustly handle different potential AI-generated structures (array vs wrapped object)
      const newsArray = Array.isArray(rawNews) 
        ? rawNews 
        : (rawNews.news || rawNews.articles || rawNews.items || rawNews.data || []);
      
      news = newsArray.map((item: any) => {
        const absoluteUrl = ensureAbsoluteUrl(item.url);
        return {
          ...item,
          url: absoluteUrl,
          imageUrl: ensureAbsoluteUrl(item.imageUrl),
          id: generateStableId(absoluteUrl), // Use robust ID generation
        };
      });
      
      // Save to Firestore in background
      news.forEach(article => {
        const articleRef = doc(db, "news", article.id);
        setDoc(articleRef, {
          ...article,
          region,
          fetchedAt: new Date().toISOString()
        }, { merge: true }).catch(err => console.error("Error caching article:", err));
      });
    } catch (aiError) {
      console.error("AI news fetch failed, falling back to cached results:", aiError);
      // If AI fails, we return whatever we found in Firestore earlier
      return bestCachedNews.length > 0 ? bestCachedNews : [];
    }

    return news.length > 0 ? news : bestCachedNews;
  } catch (error) {
    console.error("Error fetching news:", error);
    return [];
  }
}

export async function searchNews(query: string): Promise<NewsArticle[]> {
  try {
    if (typeof window === 'undefined') {
      console.log("Skipping AI search on server.");
      return [];
    }
    const response = await unifiedAI.generateContent({
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
    }).catch(err => {
      if (isRateLimitError(err)) {
        throw new Error("Search capacity exceeded. Please wait a moment.");
      }
      throw err;
    });

    const rawNews = JSON.parse(response.text || "[]") as NewsArticle[];
    const news = rawNews.map(n => {
      const absoluteUrl = ensureAbsoluteUrl(n.url);
      return {
        ...n,
        url: absoluteUrl,
        imageUrl: ensureAbsoluteUrl(n.imageUrl),
        id: btoa(absoluteUrl).replace(/[/+=]/g, '').slice(0, 20), // Ensure stable ID from URL
      };
    });
    
    // Cache search results too
    news.forEach(article => {
      const articleRef = doc(db, "news", article.id);
      setDoc(articleRef, {
        ...article,
        region: "Search", // Mark as search result
        fetchedAt: new Date().toISOString()
      }, { merge: true }).catch(err => console.error("Error caching search result:", err));
    });

    return news;
  } catch (error) {
    console.error("Error searching news:", error);
    return [];
  }
}

export async function fetchArticleByUrl(url: string): Promise<NewsArticle | null> {
  try {
    const cleanUrl = ensureAbsoluteUrl(url);
    
    // 1. Try to fetch metadata from our server
    const metadataRes = await fetch(`/api/metadata?url=${encodeURIComponent(cleanUrl)}`);
    if (!metadataRes.ok) throw new Error("Could not extract technical intelligence from this source.");
    
    const meta = await metadataRes.json();
    
    // Create a skeleton article
    const article: NewsArticle = {
      id: generateStableId(cleanUrl),
      title: meta.title || "Technical Intelligence",
      summary: meta.description || "Synthesizing deep dive from provided transmission...",
      category: "Intelligence",
      timestamp: new Date().toISOString(),
      source: new URL(cleanUrl).hostname.replace('www.', ''),
      imageUrl: meta.image || `https://picsum.photos/seed/${generateStableId(cleanUrl)}/800/600`,
      url: cleanUrl
    };

    // Cache the article so it's pickable by the UI
    const articleRef = doc(db, "news", article.id);
    await setDoc(articleRef, {
      ...article,
      region: "Custom",
      fetchedAt: new Date().toISOString()
    }, { merge: true });

    return article;
  } catch (err) {
    console.error("Deep Link ingest failed:", err);
    return null;
  }
}

export async function getRelatedArticles(category: string, currentArticleId: string, limitCount: number = 4): Promise<NewsArticle[]> {
  try {
    const newsRef = collection(db, "news");
    const q = query(
      newsRef,
      where("category", "==", category),
      orderBy("timestamp", "desc"),
      limit(limitCount + 1)
    );

    const snapshot = await getDocs(q);
    const related: NewsArticle[] = [];
    snapshot.forEach((doc) => {
      const data = doc.data() as NewsArticle;
      if (data.id !== currentArticleId && related.length < limitCount) {
        related.push(data);
      }
    });

    return related;
  } catch (error) {
    console.error("Error fetching related articles:", error);
    return [];
  }
}

export async function getArticleDetails(article: NewsArticle): Promise<ArticleContent | null> {
  const { title: articleTitle, id: articleId, url, source } = article;
  try {
    // 1. Try to fetch from our high-performance server API (Fastest)
    if (articleId) {
      try {
        const response = await fetch(`/api/news/${articleId}/synthesis`);
        if (response.ok) {
          const data = await response.json() as ArticleContent;
          console.log("Returning synthesis from Server API.");
          return data;
        }
      } catch (e) {
        console.warn("Server Synthesis API unavailable, falling back to Firestore.");
      }
    }

    // 2. Try to fetch from Firestore directly (Medium)
    if (articleId) {
      const synthesisRef = doc(db, "synthesis", articleId);
      const synthesisSnap = await getDoc(synthesisRef);
      if (synthesisSnap.exists()) {
        console.log(`Synthesis cache HIT for ${articleId}`);
        return synthesisSnap.data() as ArticleContent;
      }
    }

    // 3. Fallback to Gemini AI Generation (Slow) - STAGGERED: Only fetch Analysis first
    if (typeof window === 'undefined') {
      console.log("Skipping AI synthesis on server.");
      return null;
    }
    console.log("Synthesis cache miss. Generating Analysis with AI...");
    const response = await unifiedAI.generateContent({
      contents: `Generate a high-impact, tactical intelligence synthesis for the following article.
      
      Title: "${articleTitle}"
      Summary: "${article.summary}"
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
    }).catch(err => {
      if (isRateLimitError(err)) {
        throw new Error("Synthesis capacity reached. Please try again later.");
      }
      throw err;
    });

    let analysis: ArticleContent | null = null;
    try {
      const text = response.text || "";
      // Robust extraction: Handle markdown JSON blocks
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || [null, text];
      const jsonContent = (jsonMatch[1] || text).trim();
      analysis = JSON.parse(jsonContent) as ArticleContent;
      
      // Safety check: Fix missing fullContent if AI misnamed it
      if (analysis && !analysis.fullContent) {
        analysis.fullContent = (analysis as any).detailedExplanation || 
                              (analysis as any).explanation || 
                              (analysis as any).content || 
                              "Deep analysis unavailable. Refer to original source.";
      }
    } catch (e) {
      console.error("Failed to parse synthesis JSON:", e, response.text);
      analysis = null;
    }
    
    // Cache Analysis in Firestore in background
    if (analysis && articleId) {
      const synthesisRef = doc(db, "synthesis", articleId);
      setDoc(synthesisRef, {
        ...analysis,
        articleId,
        url,
        source,
        hasExtras: false,
        synthesizedAt: new Date().toISOString()
      }, { merge: true }).catch(err => console.error("Error caching analysis:", err));
      
      // Trigger Extras generation in background (don't await)
      getArticleExtras(article).catch(err => console.error("Error in background extras generation:", err));
    }

    return analysis;
  } catch (error) {
    console.error("Error fetching article details:", error);
    return null;
  }
}

export async function chatWithAI(articleTitle: string, context: string, message: string, history: { role: 'user' | 'model', text: string }[] = []): Promise<string> {
  try {
    const isServer = typeof window === 'undefined';
    
    if (!isServer) {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleTitle, context, message, history })
      });
      if (!response.ok) throw new Error("Chat request failed");
      const data = await response.json();
      return data.response;
    }

    // Server-side direct call
    const prompt = `
      You are an elite career and technology consultant for the Enigma Engine.
      The user is reading about: "${articleTitle}"
      Context related to their specific question: "${context}"
      
      User's question: "${message}"
      
      Conversation History:
      ${history.map(h => `${h.role === 'user' ? 'User' : 'Consultant'}: ${h.text}`).join('\n')}
      
      Provide a sharp, strategic, and practical answer. Keep it professional but engaging, with a "premium intelligence" tone.
    `;

    const result = await unifiedAI.generateContent({
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }] // Allow search for fresh grounding
      }
    });

    return result.text || "I'm sorry, I couldn't process that request at the moment.";
  } catch (error) {
    console.error("Chat error:", error);
    return "The intelligence network is currently experiencing heavy volume. Please try again shortly.";
  }
}

export async function getArticleExtras(article: NewsArticle): Promise<Partial<ArticleContent> | null> {
  const { title: articleTitle, id: articleId, summary, source } = article;
  try {
    // 1. Check Firestore first
    const synthesisRef = doc(db, "synthesis", articleId);
    const synthesisSnap = await getDoc(synthesisRef);
    if (synthesisSnap.exists()) {
      const data = synthesisSnap.data() as ArticleContent;
      if (data.hasExtras) {
        console.log("Returning extras from Firestore cache.");
        return {
          quiz: data.quiz,
          flashcards: data.flashcards,
          videoScript: data.videoScript,
          podcastScript: data.podcastScript,
          hasExtras: true
        };
      }
    }

    if (typeof window === 'undefined') {
      console.log("Skipping AI extras generation on server.");
      return null;
    }
    console.log("Generating Extras with AI...");
    const response = await unifiedAI.generateContent({
      contents: `Generate interactive educational extras for the following news article:
      Title: "${articleTitle}"
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

    const extrasText = response.text || "";
    const extrasMatch = extrasText.match(/```json\s*([\s\S]*?)\s*```/) || [null, extrasText];
    const extrasContent = (extrasMatch[1] || extrasText).trim();
    const extras = JSON.parse(extrasContent) as Partial<ArticleContent>;
    
    if (extras && articleId) {
      const synthesisRef = doc(db, "synthesis", articleId);
      await setDoc(synthesisRef, {
        ...extras,
        hasExtras: true,
        extrasSynthesizedAt: new Date().toISOString()
      }, { merge: true });
    }

    return extras;
  } catch (error) {
    console.error("Error generating article extras:", error);
    return null;
  }
}

export async function generateAudio(text: string, voice: 'Kore' | 'Puck' | 'Charon' | 'Zephyr' = 'Kore'): Promise<string | null> {
  try {
    if (typeof window === 'undefined') {
      console.log("Skipping AI TTS on server.");
      return null;
    }
    const response = await ai.models.generateContent({
      model: MODELS.TTS,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (base64Audio) {
      return `data:audio/mp3;base64,${base64Audio}`;
    }
    return null;
  } catch (error) {
    console.error("Error generating audio:", error);
    return null;
  }
}
