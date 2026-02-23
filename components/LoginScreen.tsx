import React, { useState } from 'react';
import { signInWithMagicLink } from '../services/supabaseClient';

interface LoginScreenProps {
  onSkipAuth?: () => void; // For development mode without Supabase
}

const LoginScreen: React.FC<LoginScreenProps> = ({ onSkipAuth }) => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const { error: authError } = await signInWithMagicLink(email.trim());
      if (authError) {
        setError(authError.message);
      } else {
        setSent(true);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to send magic link');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#1a1a1a] flex items-center justify-center">
      <div className="bg-[#252525] rounded-xl border border-[#333] p-8 w-full max-w-md shadow-2xl">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">VibeCut Pro</h1>
          <p className="text-gray-400 text-sm">AI-Powered Video Editor</p>
        </div>

        {sent ? (
          <div className="text-center">
            <div className="text-4xl mb-4">📧</div>
            <h2 className="text-xl font-semibold text-white mb-2">Check your email</h2>
            <p className="text-gray-400 text-sm mb-4">
              We sent a magic link to <span className="text-blue-400">{email}</span>.
              Click the link in the email to sign in.
            </p>
            <button
              onClick={() => { setSent(false); setEmail(''); }}
              className="text-blue-400 hover:text-blue-300 text-sm underline"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-1">
                  Email Address
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full bg-[#1a1a1a] border border-[#444] rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                  autoFocus
                />
              </div>

              {error && (
                <p className="text-red-400 text-sm">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading || !email.trim()}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors"
              >
                {loading ? 'Sending...' : 'Sign in with Magic Link'}
              </button>
            </form>

            <p className="text-center text-gray-500 text-xs mt-6">
              No password needed. We'll send you a sign-in link.
            </p>

            {onSkipAuth && (
              <button
                onClick={onSkipAuth}
                className="w-full mt-4 text-gray-500 hover:text-gray-300 text-xs underline"
              >
                Skip login (development only)
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default LoginScreen;
