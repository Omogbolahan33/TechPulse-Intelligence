/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * News Service - Client-side service that proxies AI calls through the server.
 * All AI operations are handled server-side to keep API keys secure.
 */

import { unifiedAI } from "./aiProvider";
import { db } from "../firebase";
import { 
  collection, 
  query, 
  where, 
  getDocs, 
  limit,  orderBy,
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

    // 3. Fallback to AI Search via Server (Slow)
    if (skipAI) {
      console.log("Skipping AI fetch as requested.");
      return bestCachedNews;
    }

    console.log("Cache miss or stale content. Fetching fresh news from AI via server...");
    
    const today = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    try {
      // Use the server-side AI proxy
      const news = await unifiedAI.generateNews(category, region, today, existingIds);
      
      // Process and cache the news
      const processedNews = news.map((item: any) => {
        const absoluteUrl = ensureAbsoluteUrl(item.url);
        return {
          ...item,
          url: absoluteUrl,
          imageUrl: ensureAbsoluteUrl(item.imageUrl),
          id: generateStableId(absoluteUrl),
        };
      });
      
      // Save to Firestore in background
      processedNews.forEach(article => {
        const articleRef = doc(db, "news", article.id);
        setDoc(articleRef, {
          ...article,
          region,
          fetchedAt: new Date().toISOString()
        }, { merge: true }).catch(err => console.error("Error caching article:", err));
      });

      return processedNews.length > 0 ? processedNews : bestCachedNews;
    } catch (aiError) {
      console.error("AI news fetch failed, falling back to cached results:", aiError);
      return bestCachedNews.length > 0 ? bestCachedNews : [];
    }
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

    // Use the server-side AI proxy
    const news = await unifiedAI.searchNews(query);
    
    const processedNews = news.map((n: any) => {
      const absoluteUrl = ensureAbsoluteUrl(n.url);
      return {
        ...n,
        url: absoluteUrl,
        imageUrl: ensureAbsoluteUrl(n.imageUrl),
        id: generateStableId(absoluteUrl),
      };
    });
    
    // Cache search results too
    processedNews.forEach(article => {
      const articleRef = doc(db, "news", article.id);
      setDoc(articleRef, {
        ...article,
        region: "Search", // Mark as search result
        fetchedAt: new Date().toISOString()
      }, { merge: true }).catch(err => console.error("Error caching search result:", err));
    });

    return processedNews;
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
      imageUrl: meta.image || null,
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

    // 3. Fallback to AI Generation via Server (Slow)
    if (typeof window === 'undefined') {
      console.log("Skipping AI synthesis on server.");
      return null;
    }
    
    console.log("Synthesis cache miss. Generating Analysis with AI via server...");
    
    // Use the server-side AI proxy
    const analysis = await unifiedAI.generateSynthesis(articleTitle, article.summary, source || "", url || "");
    
    if (!analysis) {
      return null;
    }

    // Safety check: Fix missing fullContent if AI misnamed it
    if (!analysis.fullContent) {
      analysis.fullContent = (analysis as any).detailedExplanation || 
                            (analysis as any).explanation || 
                            (analysis as any).content || 
                            "Deep analysis unavailable. Refer to original source.";
    }
    
    // Cache Analysis in Firestore in background
    if (articleId) {
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
    // Always use the server-side chat endpoint
    const response = await unifiedAI.chat(articleTitle, context, message, history);
    return response;
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
    
    console.log("Generating Extras with AI via server...");
    
    // Use the server-side AI proxy
    const extras = await unifiedAI.generateExtras(articleTitle, summary, source || "");
    
    if (!extras) {
      return null;
    }
    
    // Cache extras in Firestore
    if (articleId) {
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
    
    // TTS is handled via server endpoint now
    const response = await fetch('/api/ai/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    });
    
    if (!response.ok) {
      throw new Error("TTS request failed");
    }
    
    const data = await response.json();
    return data.audioUrl || null;
  } catch (error) {
    console.error("Error generating audio:", error);
    return null;
  }
}
