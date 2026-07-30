import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, Globe, Plus, Trash2, AlertCircle, ExternalLink } from 'lucide-react';
import { cn } from '../lib/utils';
import { getSourcesForSelection } from '../services/sourceConfig';

const STORAGE_KEY = 'techpulse_source_preferences';

export interface CustomSource {
  url: string;
  title: string;
  icon?: string;
  isSelected: boolean;
}

export interface SourcePreferences {
  selectedSources: string[];
  customSources: CustomSource[];
}

interface UrlMetadata {
  title?: string;
  description?: string;
  image?: string;
  icon?: string;
  url: string;
}

interface SourceSettingsProps {
  region: string;
  category: string;
}

export const SourceSettings: React.FC<SourceSettingsProps> = ({ region, category }) => {
  const presetSources = getSourcesForSelection(region, category);
  
  const [prefs, setPrefs] = useState<SourcePreferences>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return { selectedSources: presetSources.slice(0, 5), customSources: [] };
    
    const parsed = JSON.parse(saved);
    // Migration: if old format exists, convert it
    if (parsed.customUrls) {
      return {
        selectedSources: parsed.selectedSources || [],
        customSources: parsed.customUrls.map((url: string) => ({
          url,
          title: new URL(url).hostname,
          isSelected: true
        }))
      };
    }
    return parsed;
  });

  const [newUrl, setNewUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<UrlMetadata | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  // Debounced preview fetch
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!newUrl.trim() || !validateUrl(newUrl)) {
        setPreview(null);
        return;
      }

      setLoadingPreview(true);
      setError(null);
      try {
        const response = await fetch(`/api/metadata?url=${encodeURIComponent(newUrl)}`);
        if (response.ok) {
          const data = await response.json();
          setPreview(data);
        } else {
          setPreview(null);
          setError("Could not fetch site metadata, but you can still add it.");
        }
      } catch (e) {
        setPreview(null);
      } finally {
        setLoadingPreview(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [newUrl]);

  const toggleSource = (source: string) => {
    setPrefs(prev => {
      const isSelected = prev.selectedSources.includes(source);
      if (isSelected) {
        return { ...prev, selectedSources: prev.selectedSources.filter(s => s !== source) };
      } else {
        return { ...prev, selectedSources: [...prev.selectedSources, source] };
      }
    });
  };

  const validateUrl = (url: string) => {
    try {
      new URL(url);
      return true;
    } catch (e) {
      return false;
    }
  };

  const addCustomUrl = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!newUrl.trim()) return;

    if (!validateUrl(newUrl)) {
      setError("Please enter a valid URL (e.g., https://example.com)");
      return;
    }

    if (prefs.customSources.some(s => s.url === newUrl)) {
      setError("This URL is already in your sources.");
      return;
    }

    const newCustomSource: CustomSource = {
      url: newUrl,
      title: preview?.title || new URL(newUrl).hostname,
      icon: preview?.icon,
      isSelected: true
    };

    setPrefs(prev => ({
      ...prev,
      customSources: [...prev.customSources, newCustomSource]
    }));
    setNewUrl('');
    setPreview(null);
  };

  const toggleCustomSource = (url: string) => {
    setPrefs(prev => ({
      ...prev,
      customSources: prev.customSources.map(s => 
        s.url === url ? { ...s, isSelected: !s.isSelected } : s
      )
    }));
  };

  const removeCustomSource = (url: string) => {
    setPrefs(prev => ({
      ...prev,
      customSources: prev.customSources.filter(s => s.url !== url)
    }));
  };

  return (
    <div className="space-y-8">
      {/* Preset Sources */}
      <div className="space-y-4">
        <div className="flex flex-col">
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/40">Intelligence Sources</span>
          <p className="text-white/20 text-[10px] font-mono mt-1">Select the primary sources for your intelligence feed.</p>
        </div>
        
        <div className="grid grid-cols-2 gap-2">
          {presetSources.map(source => {
            const isSelected = prefs.selectedSources.includes(source);
            return (
              <button
                key={source}
                onClick={() => toggleSource(source)}
                className={cn(
                  "flex items-center justify-between px-4 py-3 rounded-xl border transition-all text-left",
                  isSelected 
                    ? "bg-white/10 border-white/20 text-white" 
                    : "bg-transparent border-white/5 text-white/40 hover:border-white/10"
                )}
              >
                <span className="text-xs font-medium">{source}</span>
                {isSelected && <Check size={14} className="text-white" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* Custom URLs */}
      <div className="space-y-4">
        <div className="flex flex-col">
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/40">Custom Intelligence Nodes</span>
          <p className="text-white/20 text-[10px] font-mono mt-1">Add specific URLs or RSS feeds to monitor.</p>
        </div>

        <form onSubmit={addCustomUrl} className="flex gap-2">
          <div className="relative flex-1">
            <Globe className={cn(
              "absolute left-3 top-1/2 -translate-y-1/2 transition-colors",
              loadingPreview ? "text-white animate-pulse" : "text-white/20"
            )} size={16} />
            <input
              type="text"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://news.ycombinator.com"
              className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-3 text-xs text-white placeholder:text-white/20 outline-none focus:ring-1 focus:ring-white/20 transition-all"
            />
          </div>
          <button
            type="submit"
            disabled={!validateUrl(newUrl)}
            className="bg-white text-black p-3 rounded-xl hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={20} />
          </button>
        </form>

        <AnimatePresence mode="popLayout">
          {preview && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="p-4 bg-white/5 border border-white/10 rounded-2xl flex gap-4 overflow-hidden"
            >
              {preview.image ? (
                <div className="w-20 h-20 rounded-xl overflow-hidden flex-shrink-0">
                  <img src={preview.image} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                </div>
              ) : (
                <div className="w-20 h-20 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0">
                  <Globe size={24} className="text-white/20" />
                </div>
              )}
              <div className="flex-1 min-w-0 flex flex-col justify-center">
                <div className="flex items-center gap-2 mb-1">
                  {preview.icon && <img src={preview.icon} alt="" className="w-3 h-3 rounded-sm" referrerPolicy="no-referrer" />}
                  <span className="text-[8px] font-mono text-white/40 uppercase tracking-widest truncate">{new URL(preview.url).hostname}</span>
                </div>
                <h4 className="text-xs font-bold text-white line-clamp-1 mb-1">{preview.title || "Untitled Node"}</h4>
                <p className="text-[10px] text-white/40 line-clamp-2 leading-relaxed">{preview.description || "No description available for this intelligence node."}</p>
              </div>
            </motion.div>
          )}

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-[10px] font-mono"
            >
              <AlertCircle size={14} />
              {error}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-2 gap-2">
          {prefs.customSources.map(source => (
            <motion.div
              layout
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              key={source.url}
              className="relative group"
            >
              <button
                onClick={() => toggleCustomSource(source.url)}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-left h-full",
                  source.isSelected 
                    ? "bg-white/10 border-white/20 text-white" 
                    : "bg-transparent border-white/5 text-white/40 hover:border-white/10"
                )}
              >
                <div className="w-5 h-5 rounded bg-white/5 flex items-center justify-center flex-shrink-0">
                  {source.icon ? (
                    <img src={source.icon} alt="" className="w-3 h-3 rounded-sm" referrerPolicy="no-referrer" />
                  ) : (
                    <Globe size={12} className="text-white/20" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] font-bold truncate block leading-tight">{source.title}</span>
                  <span className="text-[8px] font-mono text-white/20 truncate block">{new URL(source.url).hostname}</span>
                </div>
                {source.isSelected && <Check size={14} className="text-white flex-shrink-0" />}
              </button>
              
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeCustomSource(source.url);
                }}
                className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-10"
              >
                <Trash2 size={10} />
              </button>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
};
