/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef, useMemo, Suspense, lazy } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Home, 
  Search, 
  PlusSquare, 
  User, 
  Settings,
  Sparkles,
  Loader2,
  Filter,
  AlertTriangle,
  RefreshCw,
  ArrowUp,
  ExternalLink,
  MessageCircle,
  LayoutGrid,
  X
} from 'lucide-react';
import { useMotionValue, useTransform, animate } from 'motion/react';
import { NewsArticle, fetchLatestTechNews, searchNews, fetchArticleByUrl } from './services/newsService';
import { cn } from './lib/utils';
import { logger } from './lib/logger';

// Lazy load heavy components for better initial load
const FeedPost = lazy(() => import('./components/FeedPost').then(m => ({ default: m.FeedPost })));
const LazyImage = lazy(() => import('./components/LazyImage').then(m => ({ default: m.LazyImage })));
const NewsCard = lazy(() => import('./components/NewsCard').then(m => ({ default: m.NewsCard })));
const ArticleView = lazy(() => import('./components/ArticleView').then(m => ({ default: m.ArticleView })));

const CATEGORIES = [
  "All", "Tech", "Jobs", "Hiring", "Remote Work", "Career Advice", "Gig Economy", "Autonomous Agents", "Payments", "Fintech", "Cybersecurity", "Web3", "Hardware", "Biotech", "SaaS",
  "Cloud Computing", "Quantum Computing", "Robotics", "EdTech", "HealthTech", "CleanTech", "E-commerce", "Gaming", "AR/VR", "SpaceTech",
  "Semiconductors", "Data Science", "Blockchain", "InsurTech", "PropTech", "AgriTech", "Mobility", "Social Media", "Digital Marketing", "Venture Capital", "Open Banking"
];
const REGIONS = ["Global", "USA", "Europe", "Asia", "Africa", "LatAm", "Nigeria"];

const STORAGE_KEY = 'techpulse_preferences';
const NEWS_CACHE_KEY = 'techpulse_news_cache';
const RECENTLY_VIEWED_KEY = 'techpulse_recently_viewed';

import { SourceSettings } from './components/SourceSettings';
import { Onboarding } from './components/Onboarding';
import { InstallPrompt } from './components/InstallPrompt';
import { AITestPanel } from './components/AITestPanel';
import { usePersonaStore } from './lib/personaStore';

import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';

export default function App() {
  const { hasSeenOnboarding } = usePersonaStore();

  useEffect(() => {
    // Initialize native features if on a native platform
    const initNative = async () => {
      try {
        await StatusBar.setStyle({ style: Style.Dark });
        await StatusBar.setBackgroundColor({ color: '#000000' });
        await SplashScreen.hide();
      } catch (e) {
        // Not on a native platform, ignore
      }
    };
    initNative();
  }, []);
  const [news, setNews] = useState<NewsArticle[]>([]);
  const [recentlyViewed, setRecentlyViewed] = useState<NewsArticle[]>(() => {
    const saved = localStorage.getItem(RECENTLY_VIEWED_KEY);
    return saved ? JSON.parse(saved) : [];
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activePostIndex, setActivePostIndex] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [profileTab, setProfileTab] = useState<'history' | 'sources' | 'intelligence'>('history');
  
  const [category, setCategory] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved).category : "All";
  });
  const [region, setRegion] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved).region : "Global";
  });

  const [activeTab, setActiveTab] = useState('home');
  const [pendingNews, setPendingNews] = useState<NewsArticle[]>([]);
  const [pullDistance, setPullDistance] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  
  // Article view state
  const [articleViewOpen, setArticleViewOpen] = useState(false);
  const [selectedArticle, setSelectedArticle] = useState<NewsArticle | null>(null);
  const [browseView, setBrowseView] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef(0);
  const PULL_THRESHOLD = 80;
  
  // Race condition prevention
  const loadingRequestId = useRef(0);
  const activeRequestId = useRef(0);
  const newsRef = useRef<NewsArticle[]>([]);
  
  // Keep newsRef in sync with news state
  useEffect(() => {
    newsRef.current = news;
  }, [news]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ category, region }));
  }, [category, region]);

  useEffect(() => {
    localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(recentlyViewed));
  }, [recentlyViewed]);

  const pullY = useMotionValue(0);
  const pullOpacity = useTransform(pullY, [0, PULL_THRESHOLD], [0, 1]);
  const pullRotation = useTransform(pullY, [0, PULL_THRESHOLD], [0, 360]);

  const loadNews = useCallback(async (isRefresh = false) => {
    // Generate unique request ID to prevent race conditions
    const requestId = ++loadingRequestId.current;
    
    if (isRefresh) setRefreshing(true);
    setError(null);
    const cacheKey = `${NEWS_CACHE_KEY}_${category}_${region}`;
    const cached = localStorage.getItem(cacheKey);
    
    if (cached && !isRefresh) {
      setNews(JSON.parse(cached));
      setLoading(false);
      setRefreshing(true);
    } else if (!isRefresh) {
      setLoading(true);
    }

    try {
      const data = await fetchLatestTechNews(category, region);
      
      // Check if this request is still the latest one
      if (requestId !== loadingRequestId.current) {
        // A newer request has been made, discard this result
        return;
      }
      
      if (data.length > 0) {
        setNews(data);
        setPendingNews([]);
        localStorage.setItem(cacheKey, JSON.stringify(data));
      } else if (!cached && !isRefresh) {
        setError("No intelligence found for this selection.");
      }
    } catch (err: any) {
      // Only update error if this is still the latest request
      if (requestId !== loadingRequestId.current) return;
      
      logger.error("Failed to load news:", err);
      if (!cached && !isRefresh) {
        setError(err.message || "Failed to connect to the intelligence network. Please try again.");
      }
    } finally {
      // Only update loading state if this is still the latest request
      if (requestId !== loadingRequestId.current) return;
      
      setLoading(false);
      setRefreshing(false);
      if (!isRefresh) setActivePostIndex(0);
    }
  }, [category, region]);

  useEffect(() => {
    loadNews();
  }, [loadNews]);

  // Poll for new updates
  useEffect(() => {
    const interval = setInterval(async () => {
      if (activeTab !== 'home' || loading || refreshing) return;
      
      try {
        // Fetch with skipAI to just check server/cache
        const latest = await fetchLatestTechNews(category, region, [], true);
        const existingIds = new Set(news.map(n => n.id));
        const newArticles = latest.filter(a => !existingIds.has(a.id));
        
        if (newArticles.length > 0) {
          if (containerRef.current && containerRef.current.scrollTop === 0 && activePostIndex === 0) {
            // If user is at the very top, auto-apply seamlessly
            setNews(prev => {
              const merged = [...newArticles, ...prev];
              // Keep feed length manageable
              return merged.slice(0, 50); 
            });
            // Give a tiny flash feedback if desired, but seamless is usually better
          } else {
            setPendingNews(newArticles);
          }
        }
      } catch (e) {
        console.warn("Update check failed", e);
      }
    }, 60000); // Check every minute

    return () => clearInterval(interval);
  }, [category, region, news, activeTab, loading, refreshing]);

  const handleApplyPending = () => {
    setNews(prev => [...pendingNews, ...prev]);
    setPendingNews([]);
    setActivePostIndex(0);
    if (containerRef.current) {
      containerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (containerRef.current && containerRef.current.scrollTop === 0) {
      touchStartY.current = e.touches[0].clientY;
      setIsPulling(true);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isPulling) return;
    
    const currentY = e.touches[0].clientY;
    const diff = currentY - touchStartY.current;
    
    if (diff > 0 && containerRef.current && containerRef.current.scrollTop === 0) {
      // Apply resistance
      const resistance = 0.4;
      const move = diff * resistance;
      pullY.set(move);
      setPullDistance(move);
      
      // Prevent default to avoid browser pull-to-refresh if possible
      if (move > 10 && e.cancelable) {
        e.preventDefault();
      }
    } else {
      setIsPulling(false);
      pullY.set(0);
      setPullDistance(0);
    }
  };

  const handleTouchEnd = () => {
    if (!isPulling) return;
    
    if (pullDistance >= PULL_THRESHOLD) {
      loadNews(true);
    }
    
    animate(pullY, 0, { type: 'spring', damping: 20, stiffness: 300 });
    setPullDistance(0);
    setIsPulling(false);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    
    setLoading(true);
    setShowSearch(false);

    // Auto-detect URL paste
    if (query.startsWith('http') || (query.match(/\.[a-z]{2,}\//i) && !query.includes(' '))) {
      const url = query.startsWith('http') ? query : `https://${query}`;
      const article = await fetchArticleByUrl(url);
      if (article) {
        handleSelectArticle(article);
        setSearchQuery('');
        setLoading(false);
        return;
      }
    }

    const data = await searchNews(query);
    if (data.length > 0) {
      setNews(data);
    }
    setLoading(false);
    setActivePostIndex(0);
  };

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || loading) return;
    
    // Use ref to get latest news value to avoid stale closure
    const currentNews = newsRef.current;
    if (currentNews.length === 0) return;
    
    // Generate unique request ID
    const requestId = ++activeRequestId.current;
    
    setLoadingMore(true);
    const existingIds = currentNews.map(n => n.id);
    
    try {
      const moreNews = await fetchLatestTechNews(category, region, existingIds);
      
      // Check if this request is still valid
      if (requestId !== activeRequestId.current) return;
      
      setNews(prev => [...prev, ...moreNews]);
    } catch (err) {
      logger.error("Failed to load more news:", err);
    } finally {
      if (requestId === activeRequestId.current) {
        setLoadingMore(false);
      }
    }
  }, [category, region, loadingMore, loading]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    const index = Math.round(container.scrollTop / container.clientHeight);
    if (index !== activePostIndex) {
      setActivePostIndex(index);
      
      // Track recently viewed
      if (news[index]) {
        setRecentlyViewed(prev => {
          const filtered = prev.filter(a => a.id !== news[index].id);
          return [news[index], ...filtered].slice(0, 20); // Keep last 20
        });
      }
    }

    // Load more when reaching n-2
    if (index >= news.length - 2 && news.length > 0) {
      handleLoadMore();
    }
  };

  const handleSelectArticle = useCallback((article: NewsArticle) => {
    setNews(prev => {
      const filtered = prev.filter(n => n.id !== article.id);
      return [article, ...filtered];
    });
    setActivePostIndex(0);
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, []);
  
  const handleOpenArticle = useCallback((article: NewsArticle) => {
    setSelectedArticle(article);
    setArticleViewOpen(true);
  }, []);
  
  const handleCloseArticleView = useCallback(() => {
    setArticleViewOpen(false);
    setSelectedArticle(null);
  }, []);

  const memoizedNews = useMemo(() => news, [news]);

  const handleInboundShare = useCallback(async () => {
    const params = new URLSearchParams(window.location.search);
    const sharedUrl = params.get('url') || params.get('text');
    
    if (sharedUrl && (sharedUrl.startsWith('http') || sharedUrl.includes('.'))) {
      const urlMatch = sharedUrl.match(/https?:\/\/[^\s]+/);
      const urlToFetch = urlMatch ? urlMatch[0] : (sharedUrl.startsWith('http') ? sharedUrl : `https://${sharedUrl}`);

      setLoading(true);
      const article = await fetchArticleByUrl(urlToFetch);
      if (article) {
        handleSelectArticle(article);
        window.history.replaceState({}, document.title, "/");
      } else {
        setError("Transmission ingest failed. Ensure the link is valid news.");
      }
      setLoading(false);
    } else if (params.get('search') === 'true') {
      setShowSearch(true);
    }
  }, [handleSelectArticle]);

  useEffect(() => {
    if (hasSeenOnboarding) {
      handleInboundShare();
    }
  }, [hasSeenOnboarding, handleInboundShare]);

  if (!hasSeenOnboarding) {
    return <Onboarding />;
  }

  // Loading fallback for lazy components
  const LoadingFallback = (
    <div className="h-full flex items-center justify-center bg-black">
      <Loader2 className="animate-spin text-white/40" size={32} />
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black flex flex-col lg:flex-row overflow-hidden" role="application" aria-label="TechPulse Intelligence">
      {/* Top Bar (Mobile) / Header */}
      <div className="absolute top-0 left-0 right-0 z-40 flex items-center justify-between px-6 py-6 bg-gradient-to-b from-black/80 to-transparent pointer-events-none">
          <div className="flex items-center gap-3 pointer-events-auto">
            <span className="font-sans font-black text-2xl text-white tracking-tighter uppercase italic" role="heading" aria-level={1}>Pulse</span>
            <div className="px-2 py-0.5 bg-red-500 rounded-sm flex items-center gap-1" aria-live="polite">
              <span className="font-sans text-[8px] font-black uppercase tracking-tighter text-white">Live</span>
            </div>
          </div>
        
        <div className="flex items-center gap-4 pointer-events-auto">
          <button 
            onClick={() => setShowFilters(!showFilters)}
            className="p-2.5 bg-white/10 backdrop-blur-xl rounded-full text-white hover:bg-white/20 transition-all active:scale-90"
            aria-label="Open filters"
            aria-expanded={showFilters}
          >
            <Filter size={20} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Main Feed */}
      <div 
        ref={containerRef}
        onScroll={handleScroll}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="flex-1 snap-container no-scrollbar pb-20 lg:pb-0 relative"
        role="main"
        aria-label="News feed"
        tabIndex={0}
      >
        {/* Pull to Refresh Indicator */}
        <motion.div 
          style={{ y: pullY, opacity: pullOpacity }}
          className="absolute top-0 left-0 right-0 flex justify-center pt-24 pointer-events-none z-50"
        >
          <motion.div 
            style={{ rotate: pullRotation }}
            className={cn(
              "w-10 h-10 rounded-full bg-white/10 backdrop-blur-xl border border-white/20 flex items-center justify-center text-white shadow-2xl",
              pullDistance >= PULL_THRESHOLD ? "text-red-500 border-red-500/50" : "text-white/60"
            )}
          >
            <RefreshCw size={20} className={refreshing ? "animate-spin" : ""} />
          </motion.div>
        </motion.div>

        {/* New Posts Pill (Twitter Style) */}
        <AnimatePresence>
          {pendingNews.length > 0 && !refreshing && (
            <motion.div
              initial={{ opacity: 0, y: -20, x: '-50%' }}
              animate={{ opacity: 1, y: 0, x: '-50%' }}
              exit={{ opacity: 0, y: -20, x: '-50%' }}
              className="absolute top-24 left-1/2 z-40"
            >
              <button
                onClick={handleApplyPending}
                className="flex items-center gap-2 bg-red-500 text-white px-4 py-2 rounded-full shadow-2xl shadow-red-500/20 font-sans text-[10px] font-black uppercase tracking-widest hover:bg-red-600 transition-all active:scale-95 border border-white/20"
              >
                <ArrowUp size={14} />
                See {pendingNews.length} new updates
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {refreshing && !isPulling && (
          <div className="absolute top-20 left-1/2 -translate-x-1/2 z-30 bg-white/10 backdrop-blur-md px-3 py-1 rounded-full flex items-center gap-2 border border-white/10">
            <Loader2 className="animate-spin text-white/60" size={12} />
            <span className="text-[8px] font-mono uppercase tracking-widest text-white/60">Updating Feed</span>
          </div>
        )}
        {loading ? (
          <div className="h-full flex flex-col items-center justify-center gap-4 text-white">
            <Loader2 className="animate-spin text-white/40" size={48} />
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-white/40">Initializing Feed...</p>
          </div>
        ) : error ? (
          <div className="h-full flex flex-col items-center justify-center text-white p-8 text-center">
            <AlertTriangle size={48} className="text-red-500/40 mb-4" />
            <p className="font-mono text-sm text-white/40 mb-6">{error}</p>
            <button 
              onClick={() => window.location.reload()}
              className="flex items-center gap-2 bg-white/10 hover:bg-white/20 px-6 py-3 rounded-xl font-mono text-[10px] uppercase tracking-widest text-white transition-all"
            >
              <RefreshCw size={14} />
              Retry Connection
            </button>
          </div>
        ) : memoizedNews.length > 0 ? (
          <Suspense fallback={LoadingFallback}>
            {memoizedNews.map((article, index) => (
              <FeedPost 
                key={`${article.id}-${index}`} 
                article={article} 
                isActive={index === activePostIndex} 
                isNextPost={index === activePostIndex + 1}
                onSelectArticle={handleSelectArticle}
                onOpenArticle={handleOpenArticle}
              />
            ))}
          </Suspense>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-white p-8 text-center">
            <Sparkles size={48} className="text-white/20 mb-4" />
            <p className="font-mono text-sm text-white/40">No intelligence found for this selection.</p>
          </div>
        )}
      </div>

      {/* Filter Overlay */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute inset-0 z-[60] bg-black/95 backdrop-blur-2xl flex flex-col p-8"
          >
            <div className="flex justify-between items-center mb-12">
              <div className="flex flex-col">
                <span className="text-[10px] font-mono uppercase tracking-[0.3em] text-white/20 mb-1">Intelligence</span>
                <h2 className="font-sans font-black text-3xl text-white uppercase tracking-tighter">Filters</h2>
              </div>
              <button 
                onClick={() => setShowFilters(false)}
                className="p-3 bg-white/5 rounded-full text-white/60 hover:text-white transition-all active:scale-90"
              >
                <PlusSquare className="rotate-45" size={24} />
              </button>
            </div>

            <div className="space-y-12 overflow-y-auto no-scrollbar">
              <div className="space-y-4">
                <span className="font-mono text-[10px] uppercase tracking-widest text-white/40">Category</span>
                <div className="flex flex-wrap gap-2">
                  {CATEGORIES.map(c => (
                    <button
                      key={c}
                      onClick={() => { setCategory(c); setShowFilters(false); }}
                      className={cn(
                        "px-4 py-2 font-mono text-[10px] uppercase tracking-widest border transition-all",
                        category === c ? "bg-white text-black border-white" : "text-white/60 border-white/20 hover:border-white"
                      )}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <span className="font-mono text-[10px] uppercase tracking-widest text-white/40">Region</span>
                <div className="flex flex-wrap gap-2">
                  {REGIONS.map(r => (
                    <button
                      key={r}
                      onClick={() => { setRegion(r); setShowFilters(false); }}
                      className={cn(
                        "px-4 py-2 font-mono text-[10px] uppercase tracking-widest border transition-all",
                        region === r ? "bg-white text-black border-white" : "text-white/60 border-white/20 hover:border-white"
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom Navbar */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-xl border-t border-white/10 px-4 py-3 flex items-center justify-between lg:hidden" aria-label="Main navigation">
        <button 
          onClick={() => {
            setActiveTab('home');
            setShowSearch(false);
            setShowFilters(false);
            setBrowseView(false);
          }}
          className={cn(
            "flex flex-col items-center gap-1 transition-all",
            activeTab === 'home' && !showSearch && !browseView ? "text-white scale-110" : "text-white/40 hover:text-white/60"
          )}
          aria-label="Home"
          aria-current={activeTab === 'home' ? 'page' : undefined}
        >
          <Home size={22} aria-hidden="true" />
          <span className="text-[8px] font-mono uppercase tracking-widest">Home</span>
        </button>

        <button 
          onClick={() => setBrowseView(!browseView)}
          className={cn(
            "flex flex-col items-center gap-1 transition-all",
            browseView ? "text-white scale-110" : "text-white/40 hover:text-white/60"
          )}
          aria-label="Browse articles"
          aria-expanded={browseView}
        >
          <LayoutGrid size={22} aria-hidden="true" />
          <span className="text-[8px] font-mono uppercase tracking-widest">Browse</span>
        </button>

        <button 
          onClick={() => {
            setActiveTab('discover');
            setShowSearch(true);
            setBrowseView(false);
          }}
          className={cn(
            "flex flex-col items-center gap-1 transition-all",
            showSearch ? "text-white scale-110" : "text-white/40 hover:text-white/60"
          )}
          aria-label="Search"
        >
          <Search size={22} aria-hidden="true" />
          <span className="text-[8px] font-mono uppercase tracking-widest">Search</span>
        </button>

        <button 
          onClick={() => {
            setActiveTab('profile');
            setBrowseView(false);
          }}
          className={cn(
            "flex flex-col items-center gap-1 transition-all",
            activeTab === 'profile' ? "text-white scale-110" : "text-white/40 hover:text-white/60"
          )}
          aria-label="History"
          aria-current={activeTab === 'profile' ? 'page' : undefined}
        >
          <User size={22} aria-hidden="true" />
          <span className="text-[8px] font-mono uppercase tracking-widest">History</span>
        </button>
      </nav>

      {/* History/Profile Overlay */}
      <AnimatePresence>
        {activeTab === 'profile' && (
          <motion.div
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '100%' }}
            className="absolute inset-0 z-[80] bg-black flex flex-col"
          >
            <div className="p-6 border-b border-white/5 flex items-center justify-between bg-black/80 backdrop-blur-xl">
              <div className="flex flex-col">
                <span className="text-[10px] font-mono uppercase tracking-[0.3em] text-white/20 mb-1">Intelligence</span>
                <h2 className="font-sans font-black text-2xl text-white uppercase tracking-tighter">Center</h2>
              </div>
              <button 
                onClick={() => setActiveTab('home')}
                className="p-3 bg-white/5 rounded-full text-white/60 hover:text-white transition-all active:scale-90"
              >
                <PlusSquare className="rotate-45" size={24} />
              </button>
            </div>

            {/* Profile Tabs */}
            <div className="px-6 pt-6 flex gap-6 border-b border-white/5">
              <button 
                onClick={() => setProfileTab('history')}
                className={cn(
                  "pb-4 font-mono text-[10px] uppercase tracking-widest transition-all relative",
                  profileTab === 'history' ? "text-white" : "text-white/40 hover:text-white/60"
                )}
              >
                History
                {profileTab === 'history' && (
                  <motion.div layoutId="profileTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-white" />
                )}
              </button>
              <button 
                onClick={() => setProfileTab('sources')}
                className={cn(
                  "pb-4 font-mono text-[10px] uppercase tracking-widest transition-all relative",
                  profileTab === 'sources' ? "text-white" : "text-white/40 hover:text-white/60"
                )}
              >
                Sources
                {profileTab === 'sources' && (
                  <motion.div layoutId="profileTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-white" />
                )}
              </button>
              <button 
                onClick={() => setProfileTab('intelligence')}
                className={cn(
                  "pb-4 font-mono text-[10px] uppercase tracking-widest transition-all relative",
                  profileTab === 'intelligence' ? "text-white" : "text-white/40 hover:text-white/60"
                )}
              >
                Intelligence
                {profileTab === 'intelligence' && (
                  <motion.div layoutId="profileTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-white" />
                )}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6 no-scrollbar">
              <AnimatePresence mode="wait">
                {profileTab === 'history' ? (
                  <motion.div
                    key="history"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-4"
                  >
                    <span className="font-mono text-[10px] uppercase tracking-widest text-white/40">Recently Viewed</span>
                    {recentlyViewed.length === 0 ? (
                      <p className="text-white/20 font-mono text-xs italic py-8">Your journey is just beginning.</p>
                    ) : (
                      <div className="grid gap-4">
                        {recentlyViewed.map((article, idx) => (
                          <button
                            key={`${article.id}-${idx}`}
                            onClick={() => {
                              handleSelectArticle(article);
                              setActiveTab('home');
                            }}
                            className="flex gap-4 p-3 bg-white/5 rounded-xl border border-white/10 hover:bg-white/10 transition-all text-left group"
                          >
                            <div className="w-20 h-20 rounded-lg overflow-hidden flex-shrink-0">
                              <LazyImage 
                                src={article.imageUrl} 
                                alt="" 
                                className="w-full h-full group-hover:scale-110 transition-transform duration-500"
                              />
                            </div>
                            <div className="flex-1 min-w-0 flex flex-col justify-center">
                              <span className="text-[8px] font-mono text-white/40 uppercase tracking-widest mb-1">{article.category}</span>
                              <h4 className="text-sm font-bold text-white line-clamp-2 leading-tight mb-1">{article.title}</h4>
                              <div className="flex items-center gap-2">
                                <span className="text-[8px] font-mono text-white/20 uppercase tracking-tighter">{article.source}</span>
                                {article.url && (
                                  <a 
                                    href={article.url} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-white/20 hover:text-white transition-colors"
                                  >
                                    <ExternalLink size={10} />
                                  </a>
                                )}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </motion.div>
                ) : profileTab === 'sources' ? (
                  <motion.div
                    key="sources"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <SourceSettings region={region} category={category} />
                  </motion.div>
                ) : (
                  <motion.div
                    key="intelligence"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <AITestPanel />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Search Overlay */}
      <AnimatePresence>
        {showSearch && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute inset-x-0 bottom-20 z-[70] p-6"
          >
            <div className="max-w-xl mx-auto bg-white/10 backdrop-blur-2xl border border-white/20 rounded-2xl p-4 shadow-2xl">
              <form onSubmit={handleSearch} className="flex gap-3">
                <input
                  autoFocus
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search intelligence or paste news link..."
                  className="flex-1 bg-white/10 border-none rounded-xl px-4 py-3 text-white placeholder:text-white/40 outline-none focus:ring-2 focus:ring-white/20 transition-all"
                />
                <button
                  type="submit"
                  className="bg-white text-black px-6 py-3 rounded-xl font-mono text-[10px] uppercase tracking-widest font-bold hover:bg-gray-200 transition-colors"
                >
                  Search
                </button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Article View Overlay */}
      <AnimatePresence>
        {articleViewOpen && selectedArticle && (
          <motion.div
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="absolute inset-0 z-[90] bg-[#f5f5f5] overflow-y-auto"
          >
            <Suspense fallback={<div className="p-8 text-center"><Loader2 className="animate-spin" /></div>}>
              <ArticleView 
                article={selectedArticle} 
                onBack={handleCloseArticleView}
              />
            </Suspense>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Browse View (News Card Grid) */}
      <AnimatePresence>
        {browseView && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute inset-0 z-[85] bg-black overflow-y-auto"
          >
            <div className="min-h-full p-6 pt-24">
              <div className="max-w-6xl mx-auto">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h2 className="font-sans font-black text-2xl text-white uppercase tracking-tighter">Browse Intelligence</h2>
                    <p className="text-white/40 font-mono text-[10px] uppercase tracking-widest mt-1">Explore all articles in a grid view</p>
                  </div>
                  <button 
                    onClick={() => setBrowseView(false)}
                    className="p-3 bg-white/5 rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-all active:scale-90"
                  >
                    <X size={24} />
                  </button>
                </div>
                {loading ? (
                  <div className="flex items-center justify-center py-20">
                    <Loader2 className="animate-spin text-white/40" size={48} />
                  </div>
                ) : news.length > 0 ? (
                  <Suspense fallback={LoadingFallback}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {news.map((article) => (
                        <NewsCard 
                          key={article.id} 
                          article={article} 
                          onClick={() => {
                            setBrowseView(false);
                            handleOpenArticle(article);
                          }}
                        />
                      ))}
                    </div>
                  </Suspense>
                ) : (
                  <div className="text-center py-20 text-white/40 font-mono text-sm">
                    No articles found for this selection.
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="hidden lg:flex flex-col w-20 bg-black border-r border-white/10 py-8 items-center gap-8">
        <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center mb-4">
          <Sparkles className="text-black" size={24} />
        </div>
        
        <button 
          onClick={() => setActiveTab('home')}
          className={cn("transition-colors", activeTab === 'home' ? "text-white" : "text-white/40 hover:text-white")}
        >
          <Home size={24} />
        </button>
        <button 
          onClick={() => setShowSearch(true)}
          className="text-white/40 hover:text-white transition-colors"
        >
          <Search size={24} />
        </button>
        <button 
          onClick={() => setActiveTab('profile')}
          className={cn("transition-colors", activeTab === 'profile' ? "text-white" : "text-white/40 hover:text-white")}
        >
          <User size={24} />
        </button>
        
        <div className="mt-auto">
          <button 
            onClick={() => setShowFilters(true)}
            className="text-white/40 hover:text-white transition-colors"
          >
            <Settings size={24} />
          </button>
        </div>
      </div>

      <InstallPrompt />
    </div>
  );
}

