import "dotenv/config";

console.log("[Intelligence System] Initializing Server...");
console.log("[Intelligence System] NODE_ENV:", process.env.NODE_ENV || "development");

import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { fetchLatestTechNews, getArticleDetails, NewsArticle, ArticleContent } from "./src/services/newsService";
import { db } from "./src/firebase";
import { unifiedAI } from "./src/services/aiProvider";
import { doc, setDoc, getDoc, collection, getDocs, query, where, limit, orderBy, deleteDoc } from "firebase/firestore";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CATEGORIES = ["All", "Tech", "Jobs", "Hiring", "Remote Work", "Career Advice"];
const REGIONS = ["Global", "USA", "Europe", "Asia", "Africa", "LatAm", "Nigeria"];

// Priority categories for more frequent/deeper prefetching
const PRIORITY_CATEGORIES = ["All", "Tech", "Jobs"];

// In-memory cache for API responses
const apiCache = new Map<string, { data: any, timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function synthesizeArticle(article: NewsArticle, priority: boolean = false) {
  try {
    const synthesisRef = doc(db, "synthesis", article.id);
    const synthesisSnap = await getDoc(synthesisRef);
    
    let details: ArticleContent | null = null;
    if (synthesisSnap.exists()) {
      details = synthesisSnap.data() as ArticleContent;
    } else if (priority) {
      // Only synthesize in background if it's a priority article
      console.log(`Synthesizing (Priority): ${article.title}`);
      details = await getArticleDetails(article);
      
      if (details) {
        await setDoc(synthesisRef, {
          ...details,
          articleId: article.id,
          synthesizedAt: new Date().toISOString()
        });
      }
    }

    if (details) {
      const cacheKey = `synthesis_${article.id}`;
      apiCache.set(cacheKey, { data: details, timestamp: Date.now() });
    }
  } catch (error) {
    console.error(`Error synthesizing article ${article.id}:`, error);
  }
}

async function cleanupOldData() {
  console.log("Running data cleanup...");
  const now = new Date();
  const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 hours
  const cutoffStr = cutoff.toISOString();

  try {
    const newsRef = collection(db, "news");
    const q = query(newsRef, where("fetchedAt", "<", cutoffStr));
    const snapshot = await getDocs(q);
    
    console.log(`Cleaning up ${snapshot.size} old articles...`);
    for (const d of snapshot.docs) {
      await deleteDoc(d.ref);
      // Also try to delete synthesis
      await deleteDoc(doc(db, "synthesis", d.id)).catch(() => {});
    }
  } catch (error) {
    console.error("Cleanup error:", error);
  }
}

// Track fetches to avoid 100/day Gemini quota
const fetchHistory = new Map<string, number>();
const activeCombinations = new Map<string, number>();

// Internal diagnostic state
const diagnostis = {
  lastPrefetchStart: null as string | null,
  lastPrefetchEnd: null as string | null,
  lastPrefetchCount: 0,
  errors: [] as string[],
  fetchHistory: {} as Record<string, string>
};

async function prefetchNews() {
  diagnostis.lastPrefetchStart = new Date().toISOString();
  console.log("[Pulse] Starting optimized prefetch cycle...");
  const startTime = Date.now();
  let totalNewArticles = 0;
  let cycleErrors = 0;

  const PRIORITY_REGIONS = ["Global", "USA", "Europe", "Asia", "Africa", "Nigeria"];
  const combinationsToFetch = new Map<string, number>();

  // 1. Prioritize user's last state
  const sortedActive = [...activeCombinations.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(entry => entry[0]);
  
  sortedActive.slice(0, 4).forEach(combo => {
    combinationsToFetch.set(combo, 15 * 60 * 1000); // 15-min cooldown for active combinations
  });

  // 2. Default priorities
  for (const category of PRIORITY_CATEGORIES) {
    for (const region of PRIORITY_REGIONS) {
      const combo = `${category}|${region}`;
      if (!combinationsToFetch.has(combo)) {
        combinationsToFetch.set(combo, 60 * 60 * 1000); // 1-hour cooldown for defaults
      }
    }
  }

  for (const [combo, cooldown] of combinationsToFetch.entries()) {
    const [category, region] = combo.split('|');
    try {
      const cacheKey = `${category}_${region}`;
      const lastFetch = fetchHistory.get(cacheKey) || 0;
      
      if (Date.now() - lastFetch < cooldown) {
        continue; 
      }

      console.log(`[Pulse] Scheduled fetch: ${category} in ${region}`);
      const news = await fetchLatestTechNews(category, region, [], false, true);
      
      fetchHistory.set(cacheKey, Date.now());
      diagnostis.fetchHistory[cacheKey] = new Date().toISOString();
      
      const apiCacheKey = `news_${category}_${region}`;
      apiCache.set(apiCacheKey, { data: news, timestamp: Date.now() });

      for (const [index, article] of news.entries()) {
        const articleRef = doc(db, "news", article.id);
        const articleSnap = await getDoc(articleRef);

        if (!articleSnap.exists()) {
          totalNewArticles++;
          await setDoc(articleRef, {
            ...article,
            region,
            fetchedAt: new Date().toISOString()
          }, { merge: true });
        }

        if (index === 0) synthesizeArticle(article, true);
      }
    } catch (error) {
      cycleErrors++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Pulse] Prefetch Error (${category}/${region}):`, msg);
      if (diagnostis.errors.length > 20) diagnostis.errors.shift();
      diagnostis.errors.push(`${new Date().toISOString()}: ${category}/${region} - ${msg}`);
    }
  }
  
  diagnostis.lastPrefetchEnd = new Date().toISOString();
  diagnostis.lastPrefetchCount = totalNewArticles;
  console.log(`[Pulse] Cycle complete. Articles: ${totalNewArticles}, Errors: ${cycleErrors}, Time: ${(Date.now() - startTime)/1000}s`);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.get("/api/admin/diagnostics", (req, res) => {
    res.json({
      ...diagnostis,
      activeCombinations: Object.fromEntries(activeCombinations.entries()),
      nodeEnv: process.env.NODE_ENV,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  });

  // Add basic request logging
  app.use((req, res, next) => {
    console.log(`[Pulse] ${req.method} ${req.url}`);
    next();
  });

  // Health and connectivity
  app.get("/api/health", (req, res) => res.json({ status: "ok" }));
  app.get("/ping", (req, res) => res.send("pong"));

  app.get("/api/news", async (req, res) => {
    const start = Date.now();
    const { category = "All", region = "Global" } = req.query;
    const cacheKey = `news_${category}_${region}`;

    // Track user's last state / interests
    activeCombinations.set(`${category as string}|${region as string}`, Date.now());

    const cached = apiCache.get(cacheKey);
    res.setHeader("X-Intelligence-Node", unifiedAI.getActiveProviderName());
    res.setHeader("X-Diagnostic-Portal", "/api/admin/diagnostics");

    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      res.setHeader("X-Response-Time", `${Date.now() - start}ms`);
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.json(cached.data);
    }

    try {
      const newsRef = collection(db, "news");
      let q = query(
        newsRef,
        where("category", "==", category),
        where("region", "==", region),
        orderBy("timestamp", "desc"),
        limit(20)
      );

      if (category === "All") {
        q = query(
          newsRef,
          where("region", "==", region),
          orderBy("timestamp", "desc"),
          limit(20)
        );
      }

      const snapshot = await getDocs(q);
      let news = snapshot.docs.map(doc => doc.data()) as NewsArticle[];
      
      // Freshness check: If the latest article is older than 2 hours, try to fetch fresh news
      const now = Date.now();
      const latestTimestamp = news[0] ? new Date(news[0].timestamp).getTime() : 0;
      const isStale = !news[0] || (now - latestTimestamp > 2 * 60 * 60 * 1000);

      if (isStale) {
        console.log(`Data for ${category}/${region} is stale or missing. Triggering background fetch...`);
        // Use forceRefresh = true to guarantee we bypass the SWR protection in fetchLatestTechNews
        const fetchPromise = fetchLatestTechNews(category as string, region as string, [], false, true);
        
        fetchPromise.then(freshNews => {
          if (freshNews.length > 0) {
            apiCache.set(cacheKey, { data: freshNews, timestamp: Date.now() });
            console.log(`Background fetch complete for ${category}/${region}`);
          }
        }).catch(err => console.error("Background fetch error:", err));

        // If we have NO news at all, we MUST wait for the fetch to have something to show
        if (news.length === 0) {
          const freshNews = await fetchPromise;
          if (freshNews.length > 0) news = freshNews;
        }
      }

      apiCache.set(cacheKey, { data: news, timestamp: Date.now() });
      
      res.setHeader("X-Response-Time", `${Date.now() - start}ms`);
      res.setHeader("X-Cache", "MISS");
      res.setHeader("Cache-Control", "public, max-age=30"); // Cache for 30 seconds in browser
      res.json(news);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch news" });
    }
  });

  app.post("/api/chat", express.json(), async (req, res) => {
    const { articleTitle, context, message, history } = req.body;
    try {
      const { chatWithAI } = await import("./src/services/newsService");
      const response = await chatWithAI(articleTitle, context, message, history);
      res.json({ response });
    } catch (error) {
      console.error("Chat API error:", error);
      res.status(500).json({ error: "Intelligence network busy" });
    }
  });

  app.get("/api/news/:id/synthesis", async (req, res) => {
    const start = Date.now();
    const { id } = req.params;
    const cacheKey = `synthesis_${id}`;

    const cached = apiCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      res.setHeader("X-Response-Time", `${Date.now() - start}ms`);
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.json(cached.data);
    }

    try {
      const synthesisRef = doc(db, "synthesis", id);
      const snap = await getDoc(synthesisRef);
      
      if (snap.exists()) {
        const data = snap.data();
        apiCache.set(cacheKey, { data, timestamp: Date.now() });
        res.setHeader("X-Response-Time", `${Date.now() - start}ms`);
        res.setHeader("X-Cache", "MISS");
        res.setHeader("Cache-Control", "public, max-age=600");
        res.json(data);
      } else {
        res.status(404).json({ error: "Synthesis not found" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch synthesis" });
    }
  });

  app.get("/api/metadata", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "PulseAI-Bot/1.0",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.statusText}`);
      }

      const html = await response.text();
      
      const extract = (regex: RegExp) => {
        const match = html.match(regex);
        return match ? match[1] : null;
      };

      const title = extract(/<title[^>]*>([^<]+)<\/title>/i) || 
                    extract(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
                    extract(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);

      const description = extract(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
                          extract(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) ||
                          extract(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);

      const image = extract(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                    extract(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

      let icon = extract(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i) ||
                 extract(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut )?icon["']/i);

      if (icon && !icon.startsWith("http")) {
        const urlObj = new URL(url);
        icon = new URL(icon, urlObj.origin).href;
      }

      res.json({
        title: title?.trim(),
        description: description?.trim(),
        image,
        icon,
        url
      });
    } catch (error) {
      console.error("Metadata fetch error:", error);
      res.status(500).json({ error: "Failed to fetch metadata" });
    }
  });

  // Explicit headers for PWA assets (Must be BEFORE Vite/Static middleware)
  const getPwaAsset = (filename: string) => {
    const distPath = path.resolve(__dirname, "dist", filename);
    const publicPath = path.resolve(__dirname, "public", filename);
    const rootPath = path.resolve(__dirname, filename);
    
    if (fs.existsSync(distPath)) return distPath;
    if (fs.existsSync(publicPath)) return publicPath;
    if (fs.existsSync(rootPath)) return rootPath;
    return null;
  };

  app.get("/manifest.json", (req, res) => {
    const assetPath = getPwaAsset("manifest.json");
    if (!assetPath) {
      console.warn("[PWA] manifest.json not found in dist, public, or root");
      return res.status(404).send("manifest.json not found");
    }
    res.setHeader("Content-Type", "application/manifest+json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.sendFile(assetPath);
  });

  app.get("/sw.js", (req, res) => {
    const assetPath = getPwaAsset("sw.js");
    if (!assetPath) {
      console.warn("[PWA] sw.js not found in dist, public, or root");
      return res.status(404).send("sw.js not found");
    }
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Service-Worker-Allowed", "/");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.sendFile(assetPath);
  });

  // Explicitly handle root to prevent redirects or 404s
  app.get("/", async (req, res, next) => {
    if (process.env.NODE_ENV !== "production") {
      // In dev, let Vite handle the transformation
      return next();
    }
    const indexPath = path.resolve(__dirname, "dist", "index.html");
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    next();
  });

  // Determine if we should use Vite middleware
  // We use it if NOT in production OR if production build is missing
  const distPath = path.resolve(__dirname, "dist");
  const useVite = process.env.NODE_ENV !== "production" || !fs.existsSync(distPath);

  if (useVite) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[Pulse] WARNING: Production build (dist) is missing. Falling back to Vite development bridge for resiliency.");
    } else {
      console.log("[Pulse] Development mode: Launching Vite engine.");
    }

    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    
    // Explicit Fallback for Dev Mode (Ensures / doesn't 404 for bots)
    app.get("*", async (req, res, next) => {
      if (res.headersSent || req.path.startsWith("/api")) return next();
      
      try {
        const url = req.originalUrl;
        const template = fs.readFileSync(path.resolve(__dirname, "index.html"), "utf-8");
        const html = await vite.transformIndexHtml(url, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (e) {
        console.error("[Pulse] Vite transformation error:", e);
        next(e);
      }
    });
  } else {
    console.log("[Pulse] Production mode: Serving optimized assets from dist.");
    
    // Recovery Path: Handle /src or /@vite requests in production if they leak
    let viteInstance: any = null;
    app.use(async (req, res, next) => {
      if (req.path.startsWith("/src/") || req.path.startsWith("/@vite") || req.path.startsWith("/node_modules/")) {
        console.warn(`[Pulse] Recovery Attempt: Handling dev-path ${req.url} in production mode.`);
        if (!viteInstance) {
          try {
            viteInstance = await createViteServer({
              server: { middlewareMode: true },
              appType: "spa",
            });
            console.log("[Pulse] Fallback Vite engine initialized successfully.");
          } catch (err) {
            console.error("[Pulse] Failed to initialize fallback Vite engine:", err);
            return next();
          }
        }
        return viteInstance.middlewares(req, res, next);
      }
      next();
    });

    app.use(express.static(distPath));

    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || res.headersSent) return next();
      // Force no-cache for index.html to ensure users get the latest production bundle
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Global 404 logger for debugging
  app.use((req, res) => {
    console.warn(`[404] Resource not found: ${req.method} ${req.url}`);
    res.status(404).send("Intelligence Network Error: Resource not found");
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Intelligence System] Server Listening on port ${PORT}`);
    
    // Background tasks
    prefetchNews().catch(err => console.error("Initial prefetch failed:", err));
    setInterval(prefetchNews, 20 * 60 * 1000);
    setInterval(cleanupOldData, 60 * 60 * 1000);
  });
}

startServer().catch(err => {
  console.error("CRITICAL: Server failed to start:", err);
  process.exit(1);
});
