import React from 'react';
import { motion } from 'motion/react';
import { NewsArticle } from '../services/newsService';
import { cn } from '../lib/utils';
import { Clock, Tag, ChevronRight, ExternalLink } from 'lucide-react';

interface NewsCardProps {
  article: NewsArticle;
  onClick: () => void;
}

export const NewsCard = React.memo<NewsCardProps>(({ article, onClick }) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -4 }}
      onClick={onClick}
      className={cn(
        "group relative flex flex-col p-6 bg-white border border-gray-200 cursor-pointer transition-all duration-300",
        "hover:border-black hover:shadow-xl"
      )}
    >
      <div className="flex justify-between items-start mb-4">
        <span className="font-mono text-[10px] uppercase tracking-widest text-gray-400">
          ID: {article.id.slice(0, 8)}
        </span>
        <div className="flex items-center gap-2 text-[10px] font-mono text-gray-500">
          <Clock size={12} />
          {article.timestamp}
        </div>
      </div>

      <h3 className="font-serif italic text-2xl mb-3 group-hover:text-black transition-colors">
        {article.title}
      </h3>

      <p className="text-sm text-gray-600 line-clamp-2 mb-6 font-sans leading-relaxed">
        {article.summary}
      </p>

      <div className="mt-auto flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Tag size={12} className="text-gray-400" />
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
              {article.category}
            </span>
          </div>
          {article.url && (
            <a 
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 text-[10px] font-mono text-gray-400 hover:text-black transition-colors"
            >
              Source: {article.source} <ExternalLink size={10} />
            </a>
          )}
        </div>
        <motion.div 
          whileHover={{ x: 4 }}
          className="flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-tighter transition-transform"
        >
          Read Digest <ChevronRight size={14} />
        </motion.div>
      </div>
    </motion.div>
  );
});
