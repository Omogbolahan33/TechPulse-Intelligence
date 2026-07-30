import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, X, Bot, User, Loader2, Sparkles, MessageSquare } from 'lucide-react';
import { cn } from '../lib/utils';
import { chatWithAI } from '../services/newsService';

interface Message {
  role: 'user' | 'model';
  text: string;
}

interface ChatPanelProps {
  articleTitle: string;
  context: string;
  isOpen: boolean;
  onClose: () => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ articleTitle, context, isOpen, onClose }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const userMsg: Message = { role: 'user', text: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const response = await chatWithAI(articleTitle, context, input, messages);
      const aiMsg: Message = { role: 'model', text: response };
      setMessages(prev => [...prev, aiMsg]);
    } catch (error) {
      setMessages(prev => [...prev, { role: 'model', text: "I'm sorry, I'm having trouble connecting to the network." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          className="fixed top-0 right-0 h-full w-full md:w-96 bg-white shadow-2xl z-[110] flex flex-col border-l border-gray-200"
        >
          {/* Header */}
          <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center text-white">
                <MessageSquare size={16} />
              </div>
              <div>
                <h3 className="font-mono text-[10px] uppercase tracking-widest text-gray-400">Intelligence Chat</h3>
                <p className="font-serif italic text-sm text-gray-800">Deep Dive Analyst</p>
              </div>
            </div>
            <button 
              onClick={onClose}
              className="p-2 hover:bg-gray-200 rounded-full transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          {/* Context Banner */}
          <div className="px-6 py-3 bg-indigo-50 border-b border-indigo-100 flex items-start gap-3">
            <Sparkles size={14} className="text-indigo-500 mt-1 flex-shrink-0" />
            <p className="text-[10px] text-indigo-700 font-medium leading-tight">
              Focusing on: <span className="opacity-70">{context}</span>
            </p>
          </div>

          {/* Messages */}
          <div 
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-6 space-y-6 no-scrollbar"
          >
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-40">
                <Bot size={48} className="text-gray-300" />
                <p className="font-mono text-[10px] uppercase tracking-widest leading-relaxed">
                  Analyze the implications further.<br />Ask me anything about this strategic insight.
                </p>
              </div>
            )}
            {messages.map((msg, i) => (
              <div 
                key={i}
                className={cn(
                  "flex gap-3",
                  msg.role === 'user' ? "flex-row-reverse" : "flex-row"
                )}
              >
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0",
                  msg.role === 'user' ? "bg-gray-100" : "bg-black text-white"
                )}>
                  {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
                </div>
                <div className={cn(
                  "p-4 rounded-2xl text-sm leading-relaxed max-w-[85%]",
                  msg.role === 'user' 
                    ? "bg-gray-100 text-gray-800 rounded-tr-none" 
                    : "bg-white border border-gray-100 text-gray-900 shadow-sm rounded-tl-none"
                )}>
                  {msg.text}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex gap-3">
                <div className="w-8 h-8 bg-black text-white rounded-full flex items-center justify-center">
                  <Bot size={14} />
                </div>
                <div className="p-4 bg-white border border-gray-100 rounded-2xl rounded-tl-none flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin text-gray-400" />
                  <span className="text-xs text-gray-400 font-mono uppercase tracking-widest">Processing...</span>
                </div>
              </div>
            )}
          </div>

          {/* Suggested Questions */}
          {messages.length === 0 && !loading && (
            <div className="px-6 py-4 border-t border-gray-50 bg-white space-y-2">
              <p className="font-mono text-[8px] uppercase tracking-widest text-gray-400 mb-2">Suggested Deep Dives</p>
              <div className="flex flex-wrap gap-2">
                {[
                  "Can you explain the long-term impact?",
                  "What are the immediate action steps?",
                  "How does this affect my career path?",
                  "Tell me more about the technical details."
                ].map((q, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setInput(q);
                      // Use a temporary variable to call handleSend immediately
                      const triggerSend = async (val: string) => {
                        const userMsg: Message = { role: 'user', text: val };
                        setMessages(prev => [...prev, userMsg]);
                        setInput('');
                        setLoading(true);
                        try {
                          const response = await chatWithAI(articleTitle, context, val, messages);
                          setMessages(prev => [...prev, { role: 'model', text: response }]);
                        } catch {
                          setMessages(prev => [...prev, { role: 'model', text: "Error connecting to AI fleet." }]);
                        } finally {
                          setLoading(false);
                        }
                      };
                      triggerSend(q);
                    }}
                    className="text-[10px] bg-gray-50 hover:bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full border border-gray-100 transition-colors text-left"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input */}
          <div className="p-6 border-t border-gray-100 bg-gray-50/50">
            <div className="relative">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="Ask for more details..."
                className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 pr-12 text-sm focus:outline-none focus:border-black transition-all shadow-sm"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || loading}
                className={cn(
                  "absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg transition-all",
                  input.trim() && !loading ? "bg-black text-white hover:bg-gray-800" : "text-gray-300"
                )}
              >
                <Send size={18} />
              </button>
            </div>
            <p className="mt-4 text-[9px] font-mono text-gray-400 uppercase tracking-widest text-center">
              Powered by Enigma Intelligence
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
