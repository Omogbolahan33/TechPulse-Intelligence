import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RotateCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';

interface FlashcardsProps {
  cards: {
    front: string;
    back: string;
  }[];
}

export const Flashcards: React.FC<FlashcardsProps> = ({ cards }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);

  const handleNext = () => {
    setIsFlipped(false);
    setTimeout(() => {
      setCurrentIndex((prev) => (prev + 1) % cards.length);
    }, 150);
  };

  const handlePrev = () => {
    setIsFlipped(false);
    setTimeout(() => {
      setCurrentIndex((prev) => (prev - 1 + cards.length) % cards.length);
    }, 150);
  };

  return (
    <div className="flex flex-col items-center py-8">
      <div className="relative w-full max-w-md h-80 perspective-1000">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentIndex}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="w-full h-full"
          >
            <motion.div
              className="relative w-full h-full cursor-pointer preserve-3d transition-all duration-500"
              animate={{ rotateY: isFlipped ? 180 : 0 }}
              onClick={() => setIsFlipped(!isFlipped)}
            >
              {/* Front */}
              <div className="absolute inset-0 backface-hidden bg-white border-2 border-black flex flex-col items-center justify-center p-8 text-center shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                <span className="absolute top-4 left-4 font-mono text-[10px] text-gray-400 uppercase tracking-widest">
                  Term {currentIndex + 1}
                </span>
                <h3 className="text-2xl font-serif italic">{cards[currentIndex].front}</h3>
                <div className="mt-8 flex items-center gap-2 text-[10px] font-mono text-gray-400 uppercase tracking-widest">
                  <RotateCw size={12} /> Click to reveal
                </div>
              </div>

              {/* Back */}
              <div 
                className="absolute inset-0 backface-hidden bg-black text-white flex flex-col items-center justify-center p-8 text-center shadow-[8px_8px_0px_0px_rgba(255,255,255,0.2)]"
                style={{ transform: 'rotateY(180deg)' }}
              >
                <span className="absolute top-4 left-4 font-mono text-[10px] text-gray-500 uppercase tracking-widest">
                  Definition
                </span>
                <p className="text-lg leading-relaxed">{cards[currentIndex].back}</p>
                <div className="mt-8 flex items-center gap-2 text-[10px] font-mono text-gray-500 uppercase tracking-widest">
                  <RotateCw size={12} /> Click to flip back
                </div>
              </div>
            </motion.div>
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-8 mt-12">
        <button
          onClick={handlePrev}
          className="p-3 border border-black hover:bg-black hover:text-white transition-colors"
        >
          <ChevronLeft size={20} />
        </button>
        <span className="font-mono text-sm">
          {currentIndex + 1} / {cards.length}
        </span>
        <button
          onClick={handleNext}
          className="p-3 border border-black hover:bg-black hover:text-white transition-colors"
        >
          <ChevronRight size={20} />
        </button>
      </div>
    </div>
  );
};
