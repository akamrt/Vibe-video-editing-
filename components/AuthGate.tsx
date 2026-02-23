/**
 * AuthGate — wraps the app and shows login screen if not authenticated.
 * Handles magic link redirect detection and session management.
 *
 * In development (no Supabase configured), offers a "skip" option.
 */

import React, { useState, useEffect } from 'react';
import LoginScreen from './LoginScreen';
import { getSession, onAuthStateChange, signOut } from '../services/supabaseClient';
import { clearCachedApiKey as clearGeminiKey } from '../services/geminiService';

interface AuthGateProps {
  children: React.ReactNode;
}

const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [supabaseAvailable, setSupabaseAvailable] = useState(true);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;

    const init = async () => {
      try {
        // Check if Supabase is configured
        const resp = await fetch('/api/config');
        const config = await resp.json();

        if (!config.supabaseUrl || !config.supabaseAnonKey) {
          // Supabase not configured — development mode
          console.log('[AuthGate] Supabase not configured, running in dev mode');
          setSupabaseAvailable(false);
          setLoading(false);
          return;
        }

        // Check existing session
        const session = await getSession();
        if (session) {
          setAuthenticated(true);
          setUserEmail(session.user?.email || null);
        }

        // Listen for auth changes (magic link redirect, sign out, etc.)
        const sub = await onAuthStateChange((event, session) => {
          console.log('[AuthGate] Auth event:', event);
          if (session) {
            setAuthenticated(true);
            setUserEmail(session.user?.email || null);
          } else {
            setAuthenticated(false);
            setUserEmail(null);
            clearGeminiKey(); // Clear cached API key on logout
          }
        });
        unsubscribe = sub.unsubscribe;

      } catch (err) {
        console.warn('[AuthGate] Init error:', err);
        setSupabaseAvailable(false);
      } finally {
        setLoading(false);
      }
    };

    init();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const handleSignOut = async () => {
    try {
      await signOut();
      setAuthenticated(false);
      setUserEmail(null);
      clearGeminiKey();
    } catch (err) {
      console.error('Sign out error:', err);
    }
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
    return (
      <LoginScreen
        onSkipAuth={!supabaseAvailable ? () => setAuthenticated(true) : undefined}
      />
    );
  }

  // Authenticated — render the app with a user bar
  return (
    <div className="flex flex-col h-screen">
      {/* User bar */}
      {userEmail && (
        <div className="bg-[#1a1a1a] border-b border-[#333] px-4 py-1 flex items-center justify-between text-xs">
          <span className="text-gray-500">
            Signed in as <span className="text-gray-300">{userEmail}</span>
          </span>
          <button
            onClick={handleSignOut}
            className="text-gray-500 hover:text-red-400 transition-colors"
          >
            Sign Out
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {children}
      </div>
    </div>
  );
};

export default AuthGate;
