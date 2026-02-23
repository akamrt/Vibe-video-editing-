import React, { useState } from 'react';

interface LoginScreenProps {
  onAuthenticated: (token: string) => void;
}

const LoginScreen: React.FC<LoginScreenProps> = ({ onAuthenticated }) => {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const resp = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password.trim() }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setError(data.error || 'Incorrect password');
        return;
      }

      // Store token and notify parent
      localStorage.setItem('auth_token', data.token);
      onAuthenticated(data.token);
    } catch (err: any) {
      setError(err.message || 'Connection failed');
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

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-1">
              Access Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
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
            disabled={loading || !password.trim()}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors"
          >
            {loading ? 'Checking...' : 'Enter'}
          </button>
        </form>

        <p className="text-center text-gray-500 text-xs mt-6">
          Contact the admin for access credentials.
        </p>
      </div>
    </div>
  );
};

export default LoginScreen;
