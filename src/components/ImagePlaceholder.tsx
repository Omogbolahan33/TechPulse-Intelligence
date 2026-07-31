import React from 'react';

interface ImagePlaceholderProps {
  category?: string;
  className?: string;
}

export const ImagePlaceholder: React.FC<ImagePlaceholderProps> = ({ category = 'News', className }) => {
  // Generate a consistent color based on category
  const getCategoryColor = (cat: string) => {
    const colors: Record<string, string> = {
      'Tech': '#3B82F6',
      'AI': '#8B5CF6',
      'Startups': '#10B981',
      'Jobs': '#F59E0B',
      'Cybersecurity': '#EF4444',
      'Web3': '#EC4899',
      'Hardware': '#6366F1',
      'Science': '#14B8A6',
      'Fintech': '#F97316',
    };
    return colors[cat] || '#6B7280';
  };

  const color = getCategoryColor(category);

  return (
    <div 
      className={`w-full h-full flex items-center justify-center ${className || ''}`}
      style={{ background: `linear-gradient(135deg, ${color}22 0%, ${color}44 100%)` }}
      aria-label={`${category} category placeholder`}
      role="img"
    >
      <div className="text-center">
        <div 
          className="w-16 h-16 mx-auto mb-2 rounded-full flex items-center justify-center"
          style={{ backgroundColor: `${color}33` }}
        >
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"/>
          </svg>
        </div>
        <span className="text-xs font-medium" style={{ color }}>{category}</span>
      </div>
    </div>
  );
};
