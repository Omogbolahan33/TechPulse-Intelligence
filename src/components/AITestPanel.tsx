import React, { useState } from 'react';
import { unifiedAI } from '../services/aiProvider';
import { Play, CheckCircle2, AlertCircle, Key, Loader2, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

export function AITestPanel() {
  const [results, setResults] = useState<{ name: string; status: 'ok' | 'error' | 'no-key' | 'testing'; error?: string }[]>([]);
  const [isTesting, setIsTesting] = useState(false);

  const runTest = async () => {
    setIsTesting(true);
    // Initial state
    const initial = [
      "Gemini 3 Flash", "Gemini 3.1 Flash Lite", "Groq (Llama-3)", 
      "OpenAI (GPT-4o)", "Anthropic (Claude 3.5)", 
      "OpenRouter Online (Perplexity/Search)", 
      "OpenRouter (Universal Aggregator)", "Gemini 3.1 Pro"
    ].map(name => ({ name, status: 'testing' as const }));
    
    setResults(initial);

    const data = await unifiedAI.testAllProviders();
    setResults(data as any);
    setIsTesting(false);
  };

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl">
      <div className="p-6 border-b border-zinc-900 bg-zinc-900/50 flex items-center justify-between">
        <div>
          <h3 className="text-white font-bold flex items-center gap-2">
            AI Node Diagnostics
            <span className="px-2 py-0.5 bg-orange-500/10 text-orange-500 text-[10px] font-black uppercase tracking-tighter rounded">Beta</span>
          </h3>
          <p className="text-zinc-500 text-xs mt-1">Verify health and latency across the intelligence fleet</p>
        </div>
        <button
          onClick={runTest}
          disabled={isTesting}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all active:scale-95",
            isTesting 
              ? "bg-zinc-800 text-zinc-500 cursor-not-allowed" 
              : "bg-white text-black hover:bg-zinc-200"
          )}
        >
          {isTesting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {isTesting ? "Scanning..." : "Run System Scan"}
        </button>
      </div>

      <div className="p-4 space-y-2">
        {results.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center text-zinc-600 gap-3">
            <RefreshCw size={32} className="opacity-20" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-center">Ready for initial fleet broadcast scan</p>
          </div>
        ) : (
          <div className="grid gap-2">
            {results.map((res, i) => (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
                key={res.name}
                className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/30 border border-zinc-800/50 group hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-2 h-2 rounded-full",
                    res.status === 'ok' ? "bg-emerald-500" :
                    res.status === 'testing' ? "bg-orange-500 animate-pulse" :
                    res.status === 'no-key' ? "bg-zinc-700" : "bg-red-500"
                  )} />
                  <span className="text-sm font-medium text-zinc-300">{res.name}</span>
                </div>

                <div className="flex items-center gap-3">
                  {res.status === 'ok' && (
                    <span className="text-[10px] font-mono text-emerald-500/80 uppercase tracking-widest flex items-center gap-1">
                      <CheckCircle2 size={12} />
                      Operational
                    </span>
                  )}
                  {res.status === 'no-key' && (
                    <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest flex items-center gap-1">
                      <Key size={12} />
                      Config Required
                    </span>
                  )}
                  {res.status === 'error' && (
                    <div className="flex flex-col items-end">
                      <span className="text-[10px] font-mono text-red-500 uppercase tracking-widest flex items-center gap-1">
                        <AlertCircle size={12} />
                        Fault Detected
                      </span>
                      <span className="text-[9px] text-red-500/60 font-mono mt-0.5 max-w-[150px] truncate">
                        {res.error}
                      </span>
                    </div>
                  )}
                  {res.status === 'testing' && (
                    <span className="text-[10px] font-mono text-orange-500 uppercase tracking-widest animate-pulse">
                      Sending Ping...
                    </span>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {results.some(r => r.status === 'error') && (
        <div className="p-4 bg-red-500/5 border-t border-red-500/10">
          <p className="text-[9px] text-red-500/60 font-mono leading-relaxed">
            Note: Faults usually indicate quota exhaustion or rate limits. These nodes have been automatically isolated from the primary failover matrix until reset.
          </p>
        </div>
      )}
    </div>
  );
}
