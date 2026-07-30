import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Play, Pause, Volume2, VolumeX, Mic, Video, Loader2 } from 'lucide-react';
import { generateAudio } from '../services/newsService';
import { cn } from '../lib/utils';

interface MediaSectionProps {
  videoScript: string;
  podcastScript: string;
}

export const MediaSection: React.FC<MediaSectionProps> = ({ videoScript, podcastScript }) => {
  const [activeTab, setActiveTab] = useState<'video' | 'podcast'>('video');
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handlePlay = async () => {
    if (audioUrl) {
      if (isPlaying) {
        audioRef.current?.pause();
      } else {
        audioRef.current?.play();
      }
      setIsPlaying(!isPlaying);
      return;
    }

    setIsLoading(true);
    const script = activeTab === 'video' ? videoScript : podcastScript;
    const url = await generateAudio(script, activeTab === 'video' ? 'Kore' : 'Zephyr');
    
    if (url) {
      setAudioUrl(url);
      setIsPlaying(true);
      // Audio will play via ref effect or manual call
    }
    setIsLoading(false);
  };

  const switchTab = (tab: 'video' | 'podcast') => {
    if (tab === activeTab) return;
    setActiveTab(tab);
    setAudioUrl(null);
    setIsPlaying(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
  };

  return (
    <div className="bg-[#151619] text-white rounded-2xl overflow-hidden shadow-2xl">
      <div className="flex border-b border-white/10">
        <button
          onClick={() => switchTab('video')}
          className={cn(
            "flex-1 py-4 flex items-center justify-center gap-2 font-mono text-xs uppercase tracking-widest transition-all",
            activeTab === 'video' ? "bg-white/5 text-white" : "text-gray-500 hover:text-gray-300"
          )}
        >
          <Video size={16} /> Video Explainer
        </button>
        <button
          onClick={() => switchTab('podcast')}
          className={cn(
            "flex-1 py-4 flex items-center justify-center gap-2 font-mono text-xs uppercase tracking-widest transition-all",
            activeTab === 'podcast' ? "bg-white/5 text-white" : "text-gray-500 hover:text-gray-300"
          )}
        >
          <Mic size={16} /> Podcaster
        </button>
      </div>

      <div className="p-8">
        <div className="relative aspect-video bg-black/40 rounded-xl border border-white/5 flex flex-col items-center justify-center overflow-hidden group">
          {/* Atmospheric Background */}
          <div className="absolute inset-0 opacity-20 pointer-events-none">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-500/20 via-purple-500/20 to-orange-500/20 animate-pulse" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200%] h-[200%] bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.05)_0%,transparent_70%)]" />
          </div>

          <AnimatePresence mode="wait">
            {isLoading ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center gap-4"
              >
                <Loader2 className="animate-spin text-white/40" size={48} />
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Synthesizing Voice...</p>
              </motion.div>
            ) : (
              <motion.div
                key="content"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col items-center gap-6 z-10"
              >
                <div className="flex items-center gap-4">
                  <button
                    onClick={handlePlay}
                    className="w-20 h-20 rounded-full bg-white text-black flex items-center justify-center hover:scale-110 transition-transform shadow-[0_0_30px_rgba(255,255,255,0.2)]"
                  >
                    {isPlaying ? <Pause size={32} fill="currentColor" /> : <Play size={32} fill="currentColor" className="ml-1" />}
                  </button>
                </div>
                <div className="text-center max-w-md px-4">
                  <p className="font-mono text-[10px] uppercase tracking-widest text-white/40 mb-2">
                    {activeTab === 'video' ? 'Visual Script Preview' : 'Audio Narrative'}
                  </p>
                  <p className="text-sm text-gray-400 italic line-clamp-3">
                    {activeTab === 'video' ? videoScript : podcastScript}
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Visualizer bars (fake) */}
          <div className="absolute bottom-4 left-4 right-4 h-8 flex items-end gap-1">
            {Array.from({ length: 40 }).map((_, i) => (
              <motion.div
                key={i}
                className="flex-1 bg-white/10 rounded-t-sm"
                animate={{
                  height: isPlaying ? [4, Math.random() * 24 + 4, 4] : 4
                }}
                transition={{
                  repeat: Infinity,
                  duration: 0.5 + Math.random() * 0.5,
                  ease: "easeInOut"
                }}
              />
            ))}
          </div>
        </div>

        {audioUrl && (
          <audio
            ref={audioRef}
            src={audioUrl}
            onEnded={() => setIsPlaying(false)}
            className="hidden"
            autoPlay
          />
        )}

        <div className="mt-8 flex items-center justify-between">
          <div className="flex items-center gap-2 text-[10px] font-mono text-white/40 uppercase tracking-widest">
            <Volume2 size={14} /> High Fidelity Audio
          </div>
          <div className="flex items-center gap-4">
            <div className="w-32 h-1 bg-white/10 rounded-full overflow-hidden">
              <motion.div 
                className="h-full bg-white"
                animate={{ width: isPlaying ? "100%" : "0%" }}
                transition={{ duration: activeTab === 'video' ? 60 : 120, ease: "linear" }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
