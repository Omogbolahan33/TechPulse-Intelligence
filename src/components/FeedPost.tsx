import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { PlusSquare, ExternalLink, Heart, MessageCircle, Share2, Bookmark, AlertTriangle, Loader2, BookOpen } from 'lucide-react';
import { NewsArticle, ArticleContent, getArticleDetails, getRelatedArticles, StrategicImplication } from '../services/newsService';
import { cn } from '../lib/utils';
import { 
  db, 
  auth, 
  collection, 
  query, 
  where, 
  onSnapshot, 
  doc, 
  getDoc, 
  setDoc, 
  deleteDoc, 
  serverTimestamp,
  signInWithPopup,
  googleProvider
} from '../firebase';
import { LazyImage } from './LazyImage';
import { ImagePlaceholder } from './ImagePlaceholder';
import { Quiz } from './Quiz';
import { ProsCons } from './ProsCons';
import { MediaSection } from './MediaSection';
import { Flashcards } from './Flashcards';
import { CommentsSection } from './CommentsSection';
import { ChatPanel } from './ChatPanel';
import ReactMarkdown from 'react-markdown';
import { usePersonaStore } from '../lib/personaStore';

interface FeedPostProps {
  article: NewsArticle;
  isActive: boolean;
  isNextPost: boolean;
  onSelectArticle: (article: NewsArticle) => void;
  onOpenArticle?: (article: NewsArticle) => void;
}

export const FeedPost = React.memo<FeedPostProps>(({ article, isActive, isNextPost, onSelectArticle, onOpenArticle }) => {
  const { userPersona } = usePersonaStore();
  const [isLiked, setIsLiked] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [likesCount, setLikesCount] = useState(0);
  const [showToast, setShowToast] = useState<string | null>(null);

  useEffect(() => {
    if (!article.id) return;

    // Listen for total likes
    const likesRef = collection(db, 'likes');
    const q = query(likesRef, where('targetId', '==', article.id));
    
    const unsubscribeLikes = onSnapshot(q, (snapshot) => {
      setLikesCount(snapshot.size);
    });

    // Check if current user liked/bookmarked it
    let isMounted = true;
    const checkUserStatus = async () => {
      if (auth.currentUser) {
        const userLikeRef = doc(db, 'likes', `${auth.currentUser.uid}_${article.id}`);
        const likeSnap = await getDoc(userLikeRef);
        
        const userBookmarkRef = doc(db, 'bookmarks', `${auth.currentUser.uid}_${article.id}`);
        const bookmarkSnap = await getDoc(userBookmarkRef);
        
        if (isMounted) {
          setIsLiked(likeSnap.exists());
          setIsBookmarked(bookmarkSnap.exists());
        }
      } else if (isMounted) {
        setIsLiked(false);
        setIsBookmarked(false);
      }
    };

    checkUserStatus();

    // Listen for auth changes to re-check
    const unsubscribeAuth = auth.onAuthStateChanged(() => {
      checkUserStatus();
    });

    return () => {
      isMounted = false;
      unsubscribeLikes();
      unsubscribeAuth();
    };
  }, [article.id]);

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (!auth.currentUser) {
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (error) {
        console.error("Login failed:", error);
        return;
      }
    }

    if (!auth.currentUser) return;

    const likeId = `${auth.currentUser.uid}_${article.id}`;
    const likeRef = doc(db, 'likes', likeId);

    try {
      if (isLiked) {
        await deleteDoc(likeRef);
        setIsLiked(false);
      } else {
        await setDoc(likeRef, {
          userId: auth.currentUser.uid,
          targetId: article.id,
          targetType: 'article',
          createdAt: serverTimestamp()
        });
        setIsLiked(true);
      }
    } catch (error) {
      console.error("Error toggling like:", error);
    }
  };

  const handleBookmark = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (!auth.currentUser) {
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (error) {
        console.error("Login failed:", error);
        return;
      }
    }

    if (!auth.currentUser) return;

    const bookmarkId = `${auth.currentUser.uid}_${article.id}`;
    const bookmarkRef = doc(db, 'bookmarks', bookmarkId);

    try {
      if (isBookmarked) {
        await deleteDoc(bookmarkRef);
        setIsBookmarked(false);
        setShowToast("Removed from bookmarks");
      } else {
        await setDoc(bookmarkRef, {
          userId: auth.currentUser.uid,
          articleId: article.id,
          createdAt: serverTimestamp()
        });
        setIsBookmarked(true);
        setShowToast("Saved to bookmarks");
      }
      setTimeout(() => setShowToast(null), 2000);
    } catch (error) {
      console.error("Error toggling bookmark:", error);
    }
  };

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const shareData = {
      title: article.title,
      text: article.summary,
      url: window.location.href,
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(window.location.href);
        setShowToast("Link copied to clipboard");
        setTimeout(() => setShowToast(null), 2000);
      }
    } catch (error) {
      console.error("Error sharing:", error);
    }
  };
  const [showDigest, setShowDigest] = useState(false);
  const [details, setDetails] = useState<ArticleContent | null>(null);
  const [relatedArticles, setRelatedArticles] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'digest' | 'quiz' | 'analysis' | 'media' | 'flashcards' | 'comments'>('digest');
  const [chatOpen, setChatOpen] = useState(false);
  const [chatContext, setChatContext] = useState('');

  const handleDeepDive = (context: string) => {
    setChatContext(context);
    setChatOpen(true);
  };

  useEffect(() => {
    if ((showDigest || isNextPost) && !details && !loading) {
      const loadDetails = async () => {
        setLoading(true);
        setError(null);
        try {
          console.log(`Loading details for article: ${article.id}`);
          const data = await getArticleDetails(article);
          if (data) {
            setDetails(data);
            console.log(`Details loaded for ${article.id}. hasExtras: ${data.hasExtras}`);
            
            // Also fetch related articles
            const related = await getRelatedArticles(article.category, article.id);
            setRelatedArticles(related);

            // If extras are missing, trigger background load
            if (!data.hasExtras && article.id) {
              console.log(`Extras missing for ${article.id}, triggering generation...`);
              const { getArticleExtras } = await import('../services/newsService');
              const extras = await getArticleExtras(article);
              if (extras) {
                setDetails(prev => prev ? { ...prev, ...extras, hasExtras: true } : null);
                console.log(`Extras generated and merged for ${article.id}`);
              }
            } else {
              console.log(`Extras already present for ${article.id}`);
            }
          } else {
            setError("We couldn't synthesize this article at the moment.");
          }
        } catch (err: any) {
          console.error("Synthesis error:", err);
          setError(err.message || "Intelligence synthesis failed. Our neural nodes might be busy.");
        } finally {
          setLoading(false);
        }
      };
      loadDetails();
    }
  }, [showDigest, isNextPost, article.title, article.id, article.category, details, loading]);

  const bgImage = article.imageUrl || null;

  const renderImplicationList = (items: (string | StrategicImplication)[], type: 'gain' | 'loss') => {
    const isGain = type === 'gain';
    const colorTheme = isGain ? 'emerald' : 'rose';
    const symbol = isGain ? '+' : '-';

    const prioritized: (string | StrategicImplication)[] = [];
    const others: (string | StrategicImplication)[] = [];

    items.forEach(item => {
      let isMatch = false;
      const targetStr = userPersona ? userPersona.toLowerCase() : '';
      if (typeof item === 'string') {
        const match = item.match(/^[*\s]*\[(.*?)\]/);
        if (match && targetStr && match[1].toLowerCase().includes(targetStr)) isMatch = true;
      } else {
        if (targetStr && item.persona.toLowerCase().includes(targetStr)) isMatch = true;
      }
      
      if (isMatch) prioritized.push(item);
      else others.push(item);
    });

    const renderItem = (item: string | StrategicImplication, idx: number, isMatch: boolean) => {
      if (typeof item === 'string') {
        const match = item.match(/^[*\s]*\[(.*?)\][*\s:]*(.*)$/);
        return (
          <li key={idx} className="flex gap-4 text-sm text-white/70 items-start">
            <span className={`text-${colorTheme}-500 font-mono text-[10px] mt-1`}>{symbol}</span>
            <span className="leading-relaxed flex-1">
              {match ? (
                <>
                  <span className={`block text-[10px] font-mono text-${colorTheme}-400 mb-1 tracking-widest uppercase`}>
                    {match[1]} {isMatch && <span className="ml-2 px-1.5 py-0.5 bg-white/10 rounded-sm text-[8px] text-white">YOUR POSITION</span>}
                  </span>
                  {match[2]}
                </>
              ) : (
                item
              )}
            </span>
          </li>
        );
      } else {
        return (
          <li key={idx} className="flex gap-4 text-sm items-start">
            <span className={`text-${colorTheme}-500 font-mono text-[10px] mt-1`}>{symbol}</span>
            <span className="leading-relaxed flex-1 space-y-2">
              <span className={`block text-[10px] font-mono text-${colorTheme}-400 tracking-widest uppercase flex items-center gap-2`}>
                {item.persona}
                {isMatch && <span className="px-1.5 py-0.5 bg-white/10 rounded-sm text-[8px] text-white">YOUR POSITION</span>}
              </span>
              <span className="block text-white/90 font-medium">{item.insight}</span>
              <span className={`block text-white/60 italic text-xs border-l border-${colorTheme}-500/20 pl-3 py-1`}>Action: {item.actionPlan}</span>
            </span>
          </li>
        );
      }
    };

    return (
      <div className="space-y-6">
        {prioritized.length > 0 && (
          <div className="space-y-4">
            <ul className="space-y-4">
              {prioritized.map((item, i) => renderItem(item, i, true))}
            </ul>
            <div className="h-[1px] w-full bg-white/5 my-4" />
          </div>
        )}
        
        {others.length > 0 && (
          <div className="space-y-4">
            {prioritized.length > 0 && <h6 className="font-mono text-[8px] uppercase tracking-widest text-white/30">Counter-Party Intel</h6>}
            <ul className={cn("space-y-4", prioritized.length > 0 ? "opacity-60" : "")}>
              {others.map((item, i) => renderItem(item, i, false))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="relative w-full h-full bg-black overflow-hidden snap-item">
      {/* Background Image/Video Placeholder */}
      <div 
        className="absolute inset-0 z-0 cursor-pointer"
        onClick={() => setShowDigest(true)}
      >
        {bgImage ? (
          <LazyImage 
            src={bgImage} 
            alt={article.title}
            className="w-full h-full opacity-60"
          />
        ) : (
          <ImagePlaceholder category={article.category} className="opacity-60" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/80" />
      </div>

      {/* Side Actions */}
      <div className="absolute right-4 bottom-32 z-20 flex flex-col items-center gap-6" onClick={(e) => e.stopPropagation()}>
        <motion.button 
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={handleLike}
          className="flex flex-col items-center gap-1"
        >
          <motion.div
            animate={isLiked ? { scale: [1, 1.4, 1] } : { scale: 1 }}
            transition={{ duration: 0.3 }}
          >
            <Heart 
              size={32} 
              className={cn("transition-colors", isLiked ? "text-red-500 fill-red-500" : "text-white")} 
            />
          </motion.div>
          <span className="text-[10px] font-bold text-white uppercase tracking-tighter">
            {likesCount > 999 ? `${(likesCount / 1000).toFixed(1)}k` : likesCount}
          </span>
        </motion.button>

        <motion.button 
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => handleDeepDive(`General briefing for: ${article.title}`)}
          className="flex flex-col items-center gap-1"
        >
          <MessageCircle size={32} className="text-white" />
          <span className="text-[10px] font-bold text-white uppercase tracking-tighter">Deep Dive</span>
        </motion.button>

        <motion.button 
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={(e) => {
            e.stopPropagation();
            setShowDigest(true);
            setActiveTab('comments');
          }}
          className="flex flex-col items-center gap-1"
        >
          <PlusSquare size={32} className="text-white" />
          <span className="text-[10px] font-bold text-white uppercase tracking-tighter">Comment</span>
        </motion.button>

        <motion.button 
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={handleBookmark}
          className="flex flex-col items-center gap-1"
        >
          <motion.div
            animate={isBookmarked ? { scale: [1, 1.3, 1] } : { scale: 1 }}
            transition={{ duration: 0.3 }}
          >
            <Bookmark 
              size={32} 
              className={cn("transition-colors", isBookmarked ? "text-yellow-500 fill-yellow-500" : "text-white")} 
            />
          </motion.div>
          <span className="text-[10px] font-bold text-white uppercase tracking-tighter">Save</span>
        </motion.button>

        <motion.button 
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={handleShare}
          className="flex flex-col items-center gap-1"
        >
          <Share2 size={32} className="text-white" />
          <span className="text-[10px] font-bold text-white uppercase tracking-tighter">Share</span>
        </motion.button>
      </div>

      <AnimatePresence>
        {showToast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-32 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-white text-black rounded-full text-xs font-bold shadow-xl"
          >
            {showToast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom Info */}
      <div className="absolute bottom-0 left-0 right-16 p-6 z-10 pb-24" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          {article.url ? (
            <a 
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-sans font-black text-[12px] text-white tracking-tight hover:text-red-500 transition-colors"
            >
              @{article.source.replace(/\s+/g, '').toLowerCase()}
            </a>
          ) : (
            <span className="font-sans font-black text-[12px] text-white tracking-tight">
              @{article.source.replace(/\s+/g, '').toLowerCase()}
            </span>
          )}
          <div className="w-1 h-1 rounded-full bg-white/40" />
          <span className="text-[10px] text-white/60 font-mono uppercase tracking-widest">
            {(() => {
              try {
                return formatDistanceToNow(parseISO(article.timestamp), { addSuffix: true });
              } catch (e) {
                return article.timestamp;
              }
            })()}
          </span>
        </div>
        
        <h2 
          className="text-xl font-bold text-white mb-2 leading-tight tracking-tight cursor-pointer hover:text-red-400 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onOpenArticle?.(article);
          }}
        >
          {article.title}
        </h2>
        
        <p className="text-sm text-white/80 line-clamp-2 mb-4 font-sans leading-snug">
          {article.summary}
        </p>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="font-mono text-[9px] text-white/40 uppercase tracking-[0.2em] font-bold">
              {article.category} Intelligence Network
            </span>
          </div>
          
          <div className="flex items-center gap-2">
            {onOpenArticle && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenArticle(article);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 rounded-full transition-colors border border-red-500/30"
              >
                <BookOpen size={10} className="text-red-400" />
                <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider">Read</span>
              </button>
            )}
            {article.url && (
              <a 
                href={article.url} 
                target="_blank" 
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-full transition-colors border border-white/5"
              >
                <span className="text-[10px] font-bold text-white/80 uppercase tracking-wider">Source</span>
                <ExternalLink size={10} className="text-white/60" />
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Sheets (Digest / Comments) */}
      <AnimatePresence>
        {showDigest && (
          <>
            {/* Backdrop */}
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowDigest(false)}
              className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm"
            />
            
            {/* Bottom Sheet */}
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className={cn(
                "absolute inset-x-0 bottom-0 z-50 bg-[#121212] flex flex-col rounded-t-[16px] overflow-hidden border-t border-white/10",
                activeTab === 'comments' ? "h-[75%]" : "h-[92%]"
              )}
            >
              {/* Handle / Header */}
              <div className="flex flex-col items-center pt-2 pb-4 sticky top-0 bg-[#121212] z-20">
                <div className="w-10 h-1 bg-white/20 rounded-full mb-4" />
                <div className="w-full px-4 flex items-center justify-between">
                  <div className="w-8" /> {/* Spacer */}
                  <h3 className="text-sm font-bold text-white uppercase tracking-tight">
                    {activeTab === 'comments' ? 'Comments' : 'Intelligence Synthesis'}
                  </h3>
                  <button 
                    onClick={() => setShowDigest(false)}
                    className="p-1 hover:bg-white/5 rounded-full transition-colors"
                  >
                    <PlusSquare className="rotate-45 text-white/60" size={24} />
                  </button>
                </div>
              </div>

              {/* Tabs (Only if not just comments) */}
              {activeTab !== 'comments' && (
                <div className="px-4 mb-6 sticky top-[60px] bg-[#121212] z-10">
                  <div className="flex gap-1 p-1 bg-white/5 rounded-full overflow-x-auto no-scrollbar">
                    {[
                      { id: 'digest', label: 'Analysis' },
                      { id: 'quiz', label: 'Quiz' },
                      { id: 'analysis', label: 'Pros & Cons' },
                      { id: 'media', label: 'Media' },
                      { id: 'flashcards', label: 'Cards' },
                    ].map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id as any)}
                        className={cn(
                          "flex-1 px-4 py-2 rounded-full font-mono text-[9px] uppercase tracking-widest transition-all whitespace-nowrap",
                          activeTab === tab.id ? "bg-white text-black font-bold" : "text-white/40 hover:text-white/60"
                        )}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex-1 overflow-y-auto px-6 pb-32 no-scrollbar">
                {loading ? (
                  <div className="flex flex-col items-center justify-center h-full gap-6">
                    <div className="relative">
                      <div className="w-12 h-12 border-2 border-white/5 rounded-full" />
                      <div className="absolute inset-0 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-white/40 animate-pulse">Synthesizing</p>
                  </div>
                ) : error ? (
                  <div className="flex flex-col items-center justify-center h-full px-8 text-center gap-6">
                    <AlertTriangle className="text-red-500/40" size={40} />
                    <p className="font-mono text-[10px] text-white/40 leading-relaxed">{error}</p>
                  </div>
                ) : details && (
                  <div className="max-w-3xl mx-auto">
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={activeTab}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.2 }}
                      >
                        {activeTab === 'digest' && (
                          <div className="space-y-10">
                            <div className="prose prose-invert prose-sm max-w-none">
                              <ReactMarkdown>{details.fullContent}</ReactMarkdown>
                            </div>
                            
                            <div className="grid gap-4">
                              <div className="flex items-center gap-4 mb-2">
                                <div className="h-[1px] flex-1 bg-white/10" />
                                <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/20">Key Takeaways</span>
                                <div className="h-[1px] flex-1 bg-white/10" />
                              </div>
                              <div className="grid gap-3">
                                {details.keyTakeaways.map((t, i) => (
                                  <div key={i} className="p-4 bg-white/5 border border-white/10 rounded-xl flex gap-4">
                                    <span className="text-red-500 font-mono text-xs font-bold">0{i+1}</span>
                                    <p className="text-sm text-white/80 leading-relaxed italic">{t}</p>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {article.url && (
                              <div className="mt-8">
                                <motion.a 
                                  whileHover={{ scale: 1.02 }}
                                  whileTap={{ scale: 0.98 }}
                                  href={article.url} 
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  className="flex items-center justify-center gap-2 w-full py-4 bg-white text-black rounded-xl font-mono text-[10px] uppercase tracking-widest font-bold hover:bg-gray-200 transition-colors"
                                >
                                  Read Full Article on {article.source}
                                  <ExternalLink size={14} />
                                </motion.a>
                              </div>
                            )}

                            {relatedArticles.length > 0 && (
                              <div className="mt-16 pt-8 border-t border-white/5">
                                <h4 className="font-mono text-[10px] uppercase tracking-[0.3em] text-white/20 mb-6">Related Intelligence</h4>
                                <div className="grid gap-3">
                                  {relatedArticles.map((rel) => (
                                    <button
                                      key={rel.id}
                                      onClick={() => {
                                        setShowDigest(false);
                                        onSelectArticle(rel);
                                      }}
                                      className="flex gap-4 p-3 bg-white/5 rounded-xl border border-white/5 hover:border-white/20 transition-all text-left group"
                                    >
                                      <div className="w-16 h-16 rounded-lg overflow-hidden flex-shrink-0">
                                        <LazyImage 
                                          src={rel.imageUrl} 
                                          alt="" 
                                          className="w-full h-full" 
                                        />
                                      </div>
                                      <div className="flex-1 min-w-0 flex flex-col justify-center">
                                        <h5 className="text-xs font-bold text-white line-clamp-2 mb-1">{rel.title}</h5>
                                        <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">{rel.source}</span>
                                      </div>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {activeTab === 'quiz' && (
                          details.quiz ? <Quiz questions={details.quiz} /> : <div className="py-20 text-center text-white/20 font-mono text-[10px] uppercase tracking-widest">Generating Quiz...</div>
                        )}
                        {activeTab === 'analysis' && (
                          details.implications ? (
                            <ProsCons 
                              pros={details.implications.pros} 
                              cons={details.implications.cons} 
                              digest={details.implications.digest}
                              onDeepDive={handleDeepDive}
                            />
                          ) : (
                            <div className="py-20 text-center text-white/20 font-mono text-[10px] uppercase tracking-widest">Analyzing Strategic Data...</div>
                          )
                        )}
                        {activeTab === 'media' && (
                          details.videoScript && details.podcastScript ? (
                            <MediaSection videoScript={details.videoScript} podcastScript={details.podcastScript} />
                          ) : <div className="py-20 text-center text-white/20 font-mono text-[10px] uppercase tracking-widest">Synthesizing Media...</div>
                        )}
                        {activeTab === 'flashcards' && (
                          details.flashcards ? (
                            <Flashcards cards={details.flashcards} />
                          ) : (
                            <div className="py-20 text-center text-white/20 font-mono text-[10px] uppercase tracking-widest">Generating Flashcards...</div>
                          )
                        )}
                        {activeTab === 'comments' && <CommentsSection articleId={article.id} />}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <ChatPanel 
        articleTitle={article.title}
        context={chatContext || `General briefing for ${article.title}`}
        isOpen={chatOpen}
        onClose={() => setChatOpen(false)}
      />
    </div>
  );
});
