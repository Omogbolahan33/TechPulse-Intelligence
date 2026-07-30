import React from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Crosshair, Briefcase, TrendingUp, Cpu, Eye, Shield } from 'lucide-react';
import { usePersonaStore } from '../lib/personaStore';
import { cn } from '../lib/utils';

const PERSONAS = [
  { id: 'Founder', icon: Crosshair, desc: 'Strategy, growth, and market positioning' },
  { id: 'Investor', icon: TrendingUp, desc: 'Cap tables, risk, and macro trends' },
  { id: 'Operator', icon: Briefcase, desc: 'Execution, logistics, and scaling' },
  { id: 'Engineer', icon: Cpu, desc: 'Architecture, technical shipping, APIs' },
  { id: 'Regulator', icon: Shield, desc: 'Compliance, policy, and safety' },
  { id: 'Spectator', icon: Eye, desc: 'General observation and learning' }
];

export const Onboarding: React.FC = () => {
  const { setUserPersona, completeOnboarding, userPersona } = usePersonaStore();

  const handleSelect = (id: string) => {
    setUserPersona(id);
  };

  const handleComplete = () => {
    if (userPersona) {
      completeOnboarding();
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col items-center justify-center p-6 sm:p-12 overflow-y-auto">
      <div className="w-full max-w-2xl mx-auto space-y-12">
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-4"
        >
          <h1 className="font-sans font-black text-4xl sm:text-5xl text-white tracking-tighter uppercase italic">
            Calibrate Pulse
          </h1>
          <p className="text-white/60 font-mono text-sm max-w-md mx-auto leading-relaxed">
            Intelligence is only useful when contextualized. Establish your active vantage point to intercept relevant strategic gains and market counter-moves.
          </p>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="grid grid-cols-1 sm:grid-cols-2 gap-4"
        >
          {PERSONAS.map((p, i) => (
            <motion.button
              key={p.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 + (i * 0.05) }}
              onClick={() => handleSelect(p.id)}
              className={cn(
                "flex items-start gap-4 p-6 rounded-xl border transition-all text-left group",
                userPersona === p.id 
                  ? "bg-white/10 border-white text-white" 
                  : "bg-transparent border-white/10 text-white/60 hover:bg-white/5 hover:border-white/30"
              )}
            >
              <div className={cn(
                "p-3 rounded-lg transition-colors",
                userPersona === p.id ? "bg-white text-black" : "bg-white/10 text-white group-hover:bg-white/20"
              )}>
                <p.icon size={20} />
              </div>
              <div className="space-y-1">
                <h3 className={cn("font-mono text-xs uppercase tracking-widest font-bold", userPersona === p.id ? "text-white" : "text-white/80")}>
                  {p.id}
                </h3>
                <p className="text-xs text-white/50 leading-relaxed font-serif">
                  {p.desc}
                </p>
              </div>
            </motion.button>
          ))}
        </motion.div>

        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: userPersona ? 1 : 0 }}
          className="flex justify-center pt-8"
        >
          <button
            disabled={!userPersona}
            onClick={handleComplete}
            className="flex items-center gap-3 bg-white text-black px-8 py-4 rounded-full font-mono text-xs uppercase tracking-widest font-bold hover:bg-gray-200 transition-all hover:scale-105 active:scale-95 disabled:opacity-0 disabled:pointer-events-none"
          >
            Initialize Feed <ArrowRight size={16} />
          </button>
        </motion.div>

      </div>
    </div>
  );
};
