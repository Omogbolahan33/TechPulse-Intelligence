import React, { useState, useEffect } from 'react';
import { 
  db, 
  auth, 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  onSnapshot, 
  serverTimestamp, 
  handleFirestoreError, 
  OperationType,
  Comment,
  signInWithPopup,
  googleProvider,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  where
} from '../firebase';
import { Send, Trash2, User, LogIn, Loader2, Heart } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '../lib/utils';
import { sanitizeText } from '../lib/sanitize';

interface CommentsSectionProps {
  articleId: string;
}

const CommentItem: React.FC<{ comment: Comment; user: any; onDelete: (id: string) => void }> = ({ comment, user, onDelete }) => {
  const [likesCount, setLikesCount] = useState(0);
  const [isLiked, setIsLiked] = useState(false);

  useEffect(() => {
    const likesRef = collection(db, 'likes');
    const q = query(likesRef, where('targetId', '==', comment.id));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setLikesCount(snapshot.size);
    });

    const checkUserLike = async () => {
      if (user) {
        const userLikeRef = doc(db, 'likes', `${user.uid}_${comment.id}`);
        const snap = await getDoc(userLikeRef);
        setIsLiked(snap.exists());
      } else {
        setIsLiked(false);
      }
    };
    checkUserLike();

    return () => unsubscribe();
  }, [comment.id, user]);

  const handleLike = async () => {
    if (!user) return;
    const likeId = `${user.uid}_${comment.id}`;
    const likeRef = doc(db, 'likes', likeId);
    try {
      if (isLiked) {
        await deleteDoc(likeRef);
        setIsLiked(false);
      } else {
        await setDoc(likeRef, {
          userId: user.uid,
          targetId: comment.id,
          targetType: 'comment',
          createdAt: serverTimestamp()
        });
        setIsLiked(true);
      }
    } catch (error) {
      console.error("Error toggling comment like:", error);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="group"
    >
      <div className="flex items-start gap-3">
        {comment.userPhoto ? (
          <img src={comment.userPhoto} alt="" className="w-8 h-8 rounded-full flex-shrink-0" referrerPolicy="no-referrer" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center flex-shrink-0">
            <User size={14} className="text-white/40" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[11px] font-bold text-white/60">{comment.userName}</span>
            <span className="text-[9px] text-white/20 font-mono">
              {comment.createdAt?.toDate ? formatDistanceToNow(comment.createdAt.toDate(), { addSuffix: true }) : 'just now'}
            </span>
          </div>
          <p className="text-sm text-white/90 break-words leading-snug">{sanitizeText(comment.text)}</p>
          <div className="flex items-center gap-4 mt-2">
            <button className="flex items-center gap-1 text-[10px] font-bold text-white/40 hover:text-white/60 transition-colors">
              Reply
            </button>
            {user?.uid === comment.userId && (
              <button 
                onClick={() => onDelete(comment.id)}
                className="text-white/20 hover:text-red-500 transition-colors p-1"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-col items-center gap-1 pt-1">
          <Heart 
            size={14} 
            onClick={handleLike}
            className={cn(
              "transition-colors cursor-pointer",
              isLiked ? "text-red-500 fill-red-500" : "text-white/20 hover:text-red-500"
            )} 
          />
          <span className="text-[9px] font-bold text-white/20">{likesCount}</span>
        </div>
      </div>
    </motion.div>
  );
};

export const CommentsSection: React.FC<CommentsSectionProps> = ({ articleId }) => {
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [user, setUser] = useState(auth.currentUser);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribeAuth = auth.onAuthStateChanged((u) => {
      setUser(u);
    });

    const commentsRef = collection(db, 'articles', articleId, 'comments');
    const q = query(commentsRef, orderBy('createdAt', 'desc'));

    const unsubscribeComments = onSnapshot(q, (snapshot) => {
      const fetchedComments = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Comment[];
      setComments(fetchedComments);
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `articles/${articleId}/comments`);
    });

    return () => {
      unsubscribeAuth();
      unsubscribeComments();
    };
  }, [articleId]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !newComment.trim() || submitting) return;

    setSubmitting(true);
    try {
      const commentsRef = collection(db, 'articles', articleId, 'comments');
      await addDoc(commentsRef, {
        articleId,
        userId: user.uid,
        userName: user.displayName || 'Anonymous',
        userPhoto: user.photoURL,
        text: newComment.trim(),
        createdAt: serverTimestamp()
      });
      setNewComment('');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `articles/${articleId}/comments`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (commentId: string) => {
    setDeletingId(commentId);
  };

  const confirmDelete = async () => {
    if (!deletingId) return;
    try {
      await deleteDoc(doc(db, 'articles', articleId, 'comments', deletingId));
      setDeletingId(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `articles/${articleId}/comments/${deletingId}`);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#121212] text-white">
      <div className="p-4 border-b border-white/5 flex items-center justify-between sticky top-0 bg-[#121212] z-10">
        <h3 className="text-sm font-bold">{comments.length} comments</h3>
        <span className="text-[10px] font-mono text-white/40 uppercase tracking-widest">Community Intelligence</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="animate-spin text-white/20" size={24} />
          </div>
        ) : comments.length === 0 ? (
          <div className="text-center py-20 text-white/20 font-sans text-sm italic">
            No intelligence shared yet. Initiate the conversation.
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {comments.map((comment) => (
              <CommentItem 
                key={comment.id} 
                comment={comment} 
                user={user} 
                onDelete={handleDelete} 
              />
            ))}
          </AnimatePresence>
        )}
      </div>

      <div className="p-4 bg-[#121212] border-t border-white/5 pb-8">
        {deletingId ? (
          <div className="flex flex-col gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
            <p className="text-xs font-bold text-red-500 text-center">Delete this comment permanently?</p>
            <div className="flex gap-2">
              <button 
                onClick={() => setDeletingId(null)}
                className="flex-1 py-2 bg-white/5 hover:bg-white/10 rounded-full text-[10px] font-bold uppercase tracking-widest transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={confirmDelete}
                className="flex-1 py-2 bg-red-500 hover:bg-red-600 rounded-full text-[10px] font-bold uppercase tracking-widest transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        ) : user ? (
          <form onSubmit={handleSubmit} className="flex items-center gap-3 bg-white/5 rounded-full pl-4 pr-1 py-1">
            <input
              type="text"
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Add your insight..."
              className="flex-1 bg-transparent border-none text-sm text-white placeholder:text-white/20 outline-none py-2"
              maxLength={500}
            />
            <button
              type="submit"
              disabled={!newComment.trim() || submitting}
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                newComment.trim() ? "bg-red-500 text-white" : "bg-white/10 text-white/20"
              )}
            >
              {submitting ? <Loader2 className="animate-spin" size={14} /> : <Send size={14} />}
            </button>
          </form>
        ) : (
          <button
            onClick={handleLogin}
            className="w-full py-3 bg-white text-black rounded-full flex items-center justify-center gap-2 font-bold text-xs uppercase tracking-widest hover:bg-gray-200 transition-colors"
          >
            <LogIn size={16} /> Login to Comment
          </button>
        )}
      </div>
    </div>
  );
};
