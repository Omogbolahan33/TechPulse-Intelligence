import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, XCircle, ArrowRight, RotateCcw } from 'lucide-react';
import { cn } from '../lib/utils';

interface QuizProps {
  questions: {
    question: string;
    options: string[];
    correctAnswer: number;
    explanation: string;
  }[];
}

export const Quiz: React.FC<QuizProps> = ({ questions }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [isAnswered, setIsAnswered] = useState(false);
  const [score, setScore] = useState(0);
  const [showResult, setShowResult] = useState(false);

  const handleOptionSelect = (index: number) => {
    if (isAnswered) return;
    setSelectedOption(index);
  };

  const handleSubmit = () => {
    if (selectedOption === null) return;
    setIsAnswered(true);
    if (selectedOption === questions[currentStep].correctAnswer) {
      setScore(score + 1);
    }
  };

  const handleNext = () => {
    if (currentStep < questions.length - 1) {
      setCurrentStep(currentStep + 1);
      setSelectedOption(null);
      setIsAnswered(false);
    } else {
      setShowResult(true);
    }
  };

  const resetQuiz = () => {
    setCurrentStep(0);
    setSelectedOption(null);
    setIsAnswered(false);
    setScore(0);
    setShowResult(false);
  };

  if (showResult) {
    return (
      <div className="p-8 text-center bg-black text-white rounded-lg">
        <h3 className="font-serif italic text-3xl mb-4">Quiz Complete</h3>
        <p className="font-mono text-5xl mb-6">{score} / {questions.length}</p>
        <button
          onClick={resetQuiz}
          className="flex items-center gap-2 mx-auto px-6 py-3 border border-white/20 hover:bg-white hover:text-black transition-all font-mono text-sm uppercase tracking-widest"
        >
          <RotateCcw size={16} /> Try Again
        </button>
      </div>
    );
  }

  const currentQuestion = questions[currentStep];

  return (
    <div className="bg-white border border-black p-8">
      <div className="flex justify-between items-center mb-8">
        <span className="font-mono text-xs text-gray-400 uppercase tracking-widest">
          Question {currentStep + 1} of {questions.length}
        </span>
        <div className="h-1 flex-1 mx-4 bg-gray-100">
          <motion.div
            className="h-full bg-black"
            initial={{ width: 0 }}
            animate={{ width: `${((currentStep + 1) / questions.length) * 100}%` }}
          />
        </div>
      </div>

      <h3 className="text-xl font-medium mb-8 leading-tight">
        {currentQuestion.question}
      </h3>

      <div className="space-y-3 mb-8">
        {currentQuestion.options.map((option, index) => {
          const isSelected = selectedOption === index;
          const isCorrect = isAnswered && index === currentQuestion.correctAnswer;
          const isWrong = isAnswered && isSelected && index !== currentQuestion.correctAnswer;

          return (
            <button
              key={index}
              disabled={isAnswered}
              onClick={() => handleOptionSelect(index)}
              className={cn(
                "w-full p-4 text-left border transition-all duration-200 flex justify-between items-center group",
                !isAnswered && "hover:border-black hover:bg-gray-50",
                isSelected && !isAnswered && "border-black bg-gray-50",
                isCorrect && "border-green-500 bg-green-50 text-green-700",
                isWrong && "border-red-500 bg-red-50 text-red-700",
                !isSelected && !isCorrect && isAnswered && "opacity-50"
              )}
            >
              <span className="text-sm">{option}</span>
              {isCorrect && <CheckCircle2 size={18} />}
              {isWrong && <XCircle size={18} />}
            </button>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        {isAnswered && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-4 bg-gray-50 border-l-4 border-black mb-8"
          >
            <p className="text-xs font-mono uppercase text-gray-400 mb-1">Explanation</p>
            <p className="text-sm text-gray-700 italic">{currentQuestion.explanation}</p>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex justify-end">
        {!isAnswered ? (
          <button
            disabled={selectedOption === null}
            onClick={handleSubmit}
            className="px-8 py-3 bg-black text-white font-mono text-sm uppercase tracking-widest disabled:opacity-30 transition-opacity"
          >
            Submit Answer
          </button>
        ) : (
          <button
            onClick={handleNext}
            className="px-8 py-3 bg-black text-white font-mono text-sm uppercase tracking-widest flex items-center gap-2"
          >
            {currentStep === questions.length - 1 ? 'Finish' : 'Next Question'} <ArrowRight size={16} />
          </button>
        )}
      </div>
    </div>
  );
};
