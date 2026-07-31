import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

interface LazyImageProps {
  src: string;
  alt: string;
  className?: string;
  placeholderClassName?: string;
  referrerPolicy?: React.HTMLAttributeReferrerPolicy;
}

export const LazyImage: React.FC<LazyImageProps> = ({ 
  src, 
  alt, 
  className, 
  placeholderClassName,
  referrerPolicy = "no-referrer"
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [currentSrc, setCurrentSrc] = useState<string | null>(null);

  useEffect(() => {
    setIsLoaded(false);
    
    // Safety check for empty src
    if (!src) return;

    const img = new Image();
    if (referrerPolicy) {
      img.referrerPolicy = referrerPolicy;
    }
    img.src = src;
    
    img.onload = () => {
      setCurrentSrc(src);
      setIsLoaded(true);
    };
    
    img.onerror = () => {
      console.warn(`Failed to preload image: ${src}`);
      // Fallback to a solid state or error image if needed, for now just show what we can
      setCurrentSrc(src); 
      setIsLoaded(true);
    };
  }, [src, referrerPolicy]);

  return (
    <div className={cn("relative overflow-hidden", className)}>
      {/* Placeholder / Loading State */}
      <AnimatePresence>
        {!isLoaded && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
            className={cn(
              "absolute inset-0 bg-neutral-900 animate-pulse flex items-center justify-center",
              placeholderClassName
            )}
          >
            <div className="w-full h-full bg-gradient-to-br from-neutral-800 to-neutral-900" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Actual Image */}
      {currentSrc && (
        <motion.img
          src={currentSrc}
          alt={alt || 'Article image'}
          initial={{ opacity: 0, scale: 1.05 }}
          animate={{ 
            opacity: isLoaded ? 1 : 0,
            scale: isLoaded ? 1 : 1.05
          }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className={cn("w-full h-full object-cover", className)}
          referrerPolicy={referrerPolicy}
          loading="lazy"
          role={alt ? 'img' : 'presentation'}
        />
      )}
    </div>
  );
};
