import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { ArrowLeft, Share2, Bookmark, Sparkles, BookOpen, BrainCircuit, Layers, PlayCircle, ExternalLink, ChevronDown, MessageSquare } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { NewsArticle, ArticleContent, getArticleDetails } from '../services/newsService';
import { Quiz } from './Quiz';
import { ProsCons } from './ProsCons';
import { MediaSection } from './MediaSection';
import { cn } from '../lib/utils';
import { usePersonaStore } from '../lib/personaStore';
import { StrategicImplication } from '../services/newsService';
import { ChatPanel } from './ChatPanel';

interface ArticleViewProps {
  article: NewsArticle;
  onBack: () => void;
}

export const ArticleView: React.FC<ArticleViewProps> = ({ article, onBack }) => {
  const { userPersona } = usePersonaStore();
  const [details, setDetails] = useState<ArticleContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<'digest' | 'quiz' | 'analysis' | 'media'>('digest');
  const [chatOpen, setChatOpen] = useState(false);
  const [chatContext, setChatContext] = useState('');

  useEffect(() => {
    const loadDetails = async () => {
      setLoading(true);
      const data = await getArticleDetails(article);
      setDetails(data);
      setLoading(false);
    };
    loadDetails();
  }, [article]);

  const handleDeepDive = (context: string) => {
    setChatContext(context);
    setChatOpen(true);
  };

  const sections = [
    { id: 'digest', label: 'Digest', icon: BookOpen },
    { id: 'quiz', label: 'Quiz', icon: BrainCircuit },
    { id: 'analysis', label: 'Pros & Cons', icon: Layers },
    { id: 'media', label: 'Explainer', icon: PlayCircle },
  ] as const;

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
      const itemText = typeof item === 'string' ? item : `${item.persona}: ${item.insight}. Action: ${item.actionPlan}`;
      
      if (typeof item === 'string') {
        const match = item.match(/^[*\s]*\[(.*?)\][*\s:]*(.*)$/);
        return (
          <li key={idx} className="flex gap-4 text-sm text-gray-700 items-start group">
            <span className={`text-${colorTheme}-500 font-mono text-[10px] mt-1`}>{symbol}</span>
            <div className="flex-1 space-y-2">
              <span className="leading-relaxed block">
                {match ? (
                  <>
                    <span className={`block text-[10px] font-mono text-${colorTheme}-600 mb-1 tracking-widest uppercase`}>
                      {match[1]} {isMatch && <span className={`ml-2 px-1.5 py-0.5 bg-${colorTheme}-100 rounded-sm text-[8px] text-${colorTheme}-800`}>YOUR POSITION</span>}
                    </span>
                    {match[2]}
                  </>
                ) : (
                  item
                )}
              </span>
              <button 
                onClick={() => handleDeepDive(itemText)}
                className={cn(
                  "opacity-0 group-hover:opacity-100 transition-all font-mono text-[8px] uppercase tracking-widest px-2 py-1 rounded border",
                  `text-${colorTheme}-600 border-${colorTheme}-200 hover:bg-${colorTheme}-50`
                )}
              >
                Deep Dive Chat
              </button>
            </div>
          </li>
        );
      } else {
        return (
          <li key={idx} className="flex gap-4 text-sm items-start group">
            <span className={`text-${colorTheme}-500 font-mono text-[10px] mt-1`}>{symbol}</span>
            <span className="leading-relaxed flex-1 space-y-2">
              <span className={`block text-[10px] font-mono text-${colorTheme}-600 tracking-widest uppercase flex items-center gap-2`}>
                {item.persona}
                {isMatch && <span className={`px-1.5 py-0.5 bg-${colorTheme}-100 rounded-sm text-[8px] text-${colorTheme}-800`}>YOUR POSITION</span>}
              </span>
              <span className="block text-gray-900 font-medium">{item.insight}</span>
              <span className={`block text-gray-600 italic text-xs border-l border-${colorTheme}-500/20 pl-3 py-1`}>Action: {item.actionPlan}</span>
              <button 
                onClick={() => handleDeepDive(itemText)}
                className={cn(
                  "opacity-0 group-hover:opacity-100 transition-all font-mono text-[8px] uppercase tracking-widest px-2 py-1 rounded border",
                  `text-${colorTheme}-600 border-${colorTheme}-200 hover:bg-${colorTheme}-50`
                )}
              >
                Deep Dive Chat
              </button>
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
            <div className="h-[1px] w-full bg-black/5 my-4" />
          </div>
        )}
        
        {others.length > 0 && (
          <div className="space-y-4">
            {prioritized.length > 0 && <h6 className="font-mono text-[8px] uppercase tracking-widest text-black/30">Counter-Party Intel</h6>}
            <ul className={cn("space-y-4", prioritized.length > 0 ? "opacity-60" : "")}>
              {others.map((item, i) => renderItem(item, i, false))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="max-w-4xl mx-auto pb-20">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-[#f5f5f5]/80 backdrop-blur-md py-4 mb-8 flex items-center justify-between border-b border-gray-200">
        <button
          onClick={onBack}
          className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest hover:text-black transition-colors"
        >
          <ArrowLeft size={16} /> Back to News
        </button>
        <div className="flex items-center gap-4">
          <button className="p-2 hover:bg-gray-200 rounded-full transition-colors">
            <Bookmark size={18} />
          </button>
          <button className="p-2 hover:bg-gray-200 rounded-full transition-colors">
            <Share2 size={18} />
          </button>
        </div>
      </div>

      {/* Hero */}
      <div className="mb-12">
        <div className="flex items-center gap-2 mb-4">
          <span className="px-2 py-1 bg-black text-white text-[10px] font-mono uppercase tracking-widest">
            {article.category}
          </span>
          <span className="text-[10px] font-mono text-gray-400 uppercase tracking-widest">
            {article.url ? (
              <a 
                href={article.url} 
                target="_blank" 
                rel="noopener noreferrer"
                className="hover:text-black transition-colors underline decoration-gray-200 underline-offset-2"
              >
                {article.source}
              </a>
            ) : article.source} • {(() => {
              try {
                return formatDistanceToNow(parseISO(article.timestamp), { addSuffix: true });
              } catch (e) {
                return article.timestamp;
              }
            })()}
          </span>
        </div>
        <h1 className="font-serif text-5xl md:text-6xl italic leading-[0.9] mb-6">
          {article.title}
        </h1>
        
        {article.url && (
          <a 
            href={article.url} 
            target="_blank" 
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-black text-white rounded-full font-mono text-[10px] uppercase tracking-widest hover:bg-gray-800 transition-colors"
          >
            Read Original Article
            <ExternalLink size={12} />
          </a>
        )}
      </div>

      {/* Navigation */}
      <div className="flex border-b border-gray-200 mb-12 overflow-x-auto no-scrollbar">
        {sections.map((section) => (
          <button
            key={section.id}
            onClick={() => setActiveSection(section.id)}
            className={cn(
              "flex items-center gap-2 px-6 py-4 font-mono text-[10px] uppercase tracking-widest whitespace-nowrap transition-all relative",
              activeSection === section.id ? "text-black" : "text-gray-400 hover:text-gray-600"
            )}
          >
            <section.icon size={14} />
            {section.label}
            {activeSection === section.id && (
              <motion.div
                layoutId="activeSection"
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-black"
              />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="min-h-[400px]">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <Sparkles className="animate-pulse text-gray-300" size={48} />
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-gray-400">Synthesizing Digest...</p>
          </div>
        ) : details ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            {activeSection === 'digest' && (
              <div className="space-y-12">
                <div className="prose prose-gray max-w-none">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-gray-400 mb-4">Full Analysis</div>
                  <div className="text-lg leading-relaxed text-gray-800">
                    <ReactMarkdown>{details.fullContent}</ReactMarkdown>
                  </div>
                </div>
                
                <div className="bg-white border border-black p-8">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-gray-400 mb-6">Key Takeaways</div>
                  <ul className="space-y-4">
                    {details.keyTakeaways.map((point, i) => (
                      <li key={i} className="flex gap-4 items-start">
                        <span className="font-mono text-xs text-gray-300">0{i + 1}</span>
                        <p className="text-sm font-medium">{point}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {activeSection === 'quiz' && (
              <Quiz questions={details.quiz} />
            )}

            {activeSection === 'analysis' && details.implications && (
              <ProsCons 
                pros={details.implications.pros}
                cons={details.implications.cons}
                digest={details.implications.digest}
                onDeepDive={handleDeepDive}
              />
            )}

            {activeSection === 'analysis' && !details.implications && (
               <div className="flex flex-col items-center justify-center py-20 gap-4">
                 <Sparkles className="animate-pulse text-gray-300" size={48} />
                 <p className="font-mono text-xs uppercase tracking-[0.3em] text-gray-400">Strategic Data Unavailable</p>
               </div>
            )}

            {activeSection === 'media' && (
              <MediaSection 
                videoScript={details.videoScript} 
                podcastScript={details.podcastScript} 
              />
            )}
          </motion.div>
        ) : (
          <div className="text-center py-20 text-gray-400 font-mono text-xs">
            Failed to load digest. Please try again.
          </div>
        )}
      </div>

      <ChatPanel 
        articleTitle={article.title}
        context={chatContext || `General briefing for ${article.title}`}
        isOpen={chatOpen}
        onClose={() => setChatOpen(false)}
      />

      {/* Persistent Chat Button */}
      <motion.button
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
        onClick={() => {
          if (!chatContext) setChatContext(`General intelligence for: ${article.title}`);
          setChatOpen(true);
        }}
        className="fixed bottom-8 right-8 w-14 h-14 bg-black text-white rounded-full shadow-2xl flex items-center justify-center z-40 hover:bg-gray-800 transition-colors"
      >
        <MessageSquare size={24} />
        <div className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-[#f5f5f5] animate-pulse" />
      </motion.button>
    </div>
  );
};
