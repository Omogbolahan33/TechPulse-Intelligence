import React from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, AlertTriangle, MessageSquare, Briefcase, Zap, ShieldAlert } from 'lucide-react';
import { StrategicImplication } from '../services/newsService';
import { cn } from '../lib/utils';
import { usePersonaStore } from '../lib/personaStore';

interface ProsConsProps {
  pros: (string | StrategicImplication)[];
  cons: (string | StrategicImplication)[];
  digest: string;
  onDeepDive: (context: string) => void;
}

export const ProsCons: React.FC<ProsConsProps> = ({ pros, cons, digest, onDeepDive }) => {
  const { userPersona } = usePersonaStore();

  const renderCard = (item: string | StrategicImplication, type: 'pro' | 'con', idx: number) => {
    const isPro = type === 'pro';
    const isImplication = typeof item !== 'string';
    const persona = isImplication ? item.persona : '';
    const insight = isImplication ? item.insight : item;
    const actionPlan = isImplication ? item.actionPlan : '';
    
    const isMatch = userPersona && persona.toLowerCase().includes(userPersona.toLowerCase());

    return (
      <motion.div
        key={idx}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: idx * 0.1 }}
        className={cn(
          "group relative p-6 rounded-2xl border transition-all duration-300",
          isMatch 
            ? (isPro ? "bg-emerald-50/50 border-emerald-200 ring-1 ring-emerald-200" : "bg-rose-50/50 border-rose-200 ring-1 ring-rose-200")
            : "bg-white border-gray-100 hover:border-gray-200 shadow-sm hover:shadow-md"
        )}
      >
        {isMatch && (
          <div className={cn(
            "absolute -top-3 left-6 px-3 py-1 rounded-full text-[8px] font-mono uppercase tracking-[0.2em] font-bold shadow-sm",
            isPro ? "bg-emerald-500 text-white" : "bg-rose-500 text-white"
          )}>
            Target Position Match
          </div>
        )}

        <div className="flex gap-4 items-start">
          <div className={cn(
            "p-2 rounded-xl flex-shrink-0",
            isPro ? "bg-emerald-100 text-emerald-600" : "bg-rose-100 text-rose-600"
          )}>
            {isPro ? <Zap size={18} /> : <ShieldAlert size={18} />}
          </div>
          
          <div className="flex-1 space-y-3">
            <div className="space-y-1">
              {persona && (
                <div className="flex items-center gap-2">
                  <Briefcase size={12} className="text-gray-400" />
                  <span className="font-mono text-[10px] uppercase tracking-widest text-gray-500">{persona}</span>
                </div>
              )}
              <h4 className="font-medium text-gray-900 leading-tight">{insight}</h4>
            </div>

            {actionPlan && (
              <div className={cn(
                "p-3 rounded-lg text-xs italic border-l-2",
                isPro ? "bg-emerald-50/50 border-emerald-500 text-emerald-800" : "bg-rose-50/50 border-rose-500 text-rose-800"
              )}>
                <span className="font-bold mr-1 not-italic uppercase text-[9px] tracking-tighter">Action:</span>
                {actionPlan}
              </div>
            )}

            <button
              onClick={() => onDeepDive(isImplication ? `${persona}: ${insight}. Action: ${actionPlan}` : insight)}
              className={cn(
                "flex items-center gap-2 font-mono text-[9px] uppercase tracking-widest transition-all",
                isPro ? "text-emerald-600 hover:text-emerald-700" : "text-rose-600 hover:text-rose-700",
                "opacity-0 group-hover:opacity-100"
              )}
            >
              <MessageSquare size={12} />
              Strategic Deep Dive
            </button>
          </div>
        </div>
      </motion.div>
    );
  };

  return (
    <div className="space-y-12">
      {/* Digest Header */}
      <div className="bg-black text-white p-8 rounded-3xl relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-10 rotate-12">
          <Zap size={120} />
        </div>
        <div className="relative z-10 space-y-4 max-w-2xl">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-gray-400">Executive Briefing</h3>
          <p className="font-serif italic text-2xl leading-relaxed">
            {digest}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Pros Column */}
        <div className="space-y-6">
          <div className="flex items-center gap-3 px-4">
            <CheckCircle2 className="text-emerald-500" size={20} />
            <h4 className="font-mono text-xs uppercase tracking-[0.3em] font-bold">Strategic Assets / Pros</h4>
          </div>
          <div className="space-y-4">
            {pros.map((item, i) => renderCard(item, 'pro', i))}
          </div>
        </div>

        {/* Cons Column */}
        <div className="space-y-6">
          <div className="flex items-center gap-3 px-4">
            <AlertTriangle className="text-rose-500" size={20} />
            <h4 className="font-mono text-xs uppercase tracking-[0.3em] font-bold">Risk Factors / Cons</h4>
          </div>
          <div className="space-y-4">
            {cons.map((item, i) => renderCard(item, 'con', i))}
          </div>
        </div>
      </div>

      {pros.length === 0 && cons.length === 0 && (
        <div className="text-center py-20 bg-gray-50 rounded-3xl border border-dashed border-gray-200">
          <p className="font-mono text-xs text-gray-400 uppercase tracking-widest">
            Detailed Strategic Matrix pending analysis...
          </p>
        </div>
      )}
    </div>
  );
};
