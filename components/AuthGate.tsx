/**
 * AuthGate — wraps the app and shows login screen if not authenticated.
 * Uses simple token-based auth (no external services).
 */

import React, { useState, useEffect } from 'react';
import LoginScreen from './LoginScreen';
import { clearCachedApiKey as clearGeminiKey } from '../services/geminiService';

interface AuthGateProps {
  children: React.ReactNode;
}

const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    // Check for existing token on mount
    const checkToken = async () => {
      const token = localStorage.getItem('auth_token');
      if (!token) {
        setLoading(false);
        return;
      }

      try {
        const resp = await fetch('/api/auth/check', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await resp.json();
        if (data.valid) {
          setAuthenticated(true);
        } else {
          // Token expired or invalid — clear it
          localStorage.removeItem('auth_token');
        }
      } catch (err) {
        console.warn('[AuthGate] Token check failed:', err);
        localStorage.removeItem('auth_token');
      } finally {
        setLoading(false);
      }
    };

    checkToken();
  }, []);

  const handleAuthenticated = (token: string) => {
    setAuthenticated(true);
  };

  const handleSignOut = async () => {
    const token = localStorage.getItem('auth_token');
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (_) { /* ignore */ }

    localStorage.removeItem('auth_token');
    clearGeminiKey();
    setAuthenticated(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#1a1a1a] flex items-center justify-center">
        <div className="text-gray-400 text-lg">Loading...</div>
      </div>
    );
  }

  // Not authenticated — show login screen
  if (!authenticated) {
    return <LoginScreen onAuthenticated={handleAuthenticated} />;
  }

  // Authenticated — render the app with a sign-out button
  return (
    <div className="flex flex-col h-screen">
      {/* User bar */}
      <div className="bg-[#1a1a1a] border-b border-[#333] px-4 py-1 flex items-center justify-between text-xs">
        <span className="text-gray-500">VibeCut Pro — Testing</span>
        <button
          onClick={handleSignOut}
          className="text-gray-500 hover:text-red-400 transition-colors"
        >
          Sign Out
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {children}
      </div>
    </div>
  );
};

export default AuthGate;
