/**
 * Supabase Client — handles auth and shared database access.
 *
 * SUPABASE_URL and SUPABASE_ANON_KEY are public (safe for frontend).
 * They are NOT secrets — Row Level Security (RLS) protects the data.
 * The anon key only allows access that RLS policies permit.
 *
 * These are loaded from the backend /api/config endpoint (which reads from env vars).
 */

import { createClient, SupabaseClient, Session, User } from '@supabase/supabase-js';

let supabase: SupabaseClient | null = null;
let initPromise: Promise<SupabaseClient> | null = null;

/** Initialize the Supabase client by fetching config from the backend */
async function initSupabase(): Promise<SupabaseClient> {
  if (supabase) return supabase;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const resp = await fetch('/api/config');
    if (!resp.ok) throw new Error('Failed to fetch config from server');
    const config = await resp.json();

    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      throw new Error('Supabase not configured on server');
    }

    supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true, // For magic link redirects
      }
    });

    return supabase;
  })();

  return initPromise;
}

/** Get the initialized Supabase client */
export async function getSupabase(): Promise<SupabaseClient> {
  return initSupabase();
}

/** Sign in with magic link (email) */
export async function signInWithMagicLink(email: string): Promise<{ error: Error | null }> {
  const sb = await getSupabase();
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: {
      // The redirect URL after clicking the magic link
      emailRedirectTo: window.location.origin,
    }
  });
  return { error: error ? new Error(error.message) : null };
}

/** Sign out */
export async function signOut(): Promise<void> {
  const sb = await getSupabase();
  await sb.auth.signOut();
}

/** Get current session */
export async function getSession(): Promise<Session | null> {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  return data.session;
}

/** Get current user */
export async function getUser(): Promise<User | null> {
  const sb = await getSupabase();
  const { data } = await sb.auth.getUser();
  return data.user;
}

/** Subscribe to auth state changes */
export async function onAuthStateChange(
  callback: (event: string, session: Session | null) => void
): Promise<{ unsubscribe: () => void }> {
  const sb = await getSupabase();
  const { data } = sb.auth.onAuthStateChange(callback);
  return { unsubscribe: data.subscription.unsubscribe };
}

// ==================== Shared Database Operations ====================

export interface SharedProject {
  id?: string;
  user_id?: string;
  user_email?: string;
  name: string;
  data: any; // ProjectState JSON
  created_at?: string;
  updated_at?: string;
}

/** Save a project to the shared database */
export async function saveSharedProject(project: SharedProject): Promise<SharedProject | null> {
  const sb = await getSupabase();
  const user = await getUser();
  if (!user) throw new Error('Not authenticated');

  const record = {
    ...project,
    user_id: user.id,
    user_email: user.email,
    updated_at: new Date().toISOString(),
  };

  if (project.id) {
    // Update existing
    const { data, error } = await sb
      .from('projects')
      .update(record)
      .eq('id', project.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  } else {
    // Insert new
    const { data, error } = await sb
      .from('projects')
      .insert({ ...record, created_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}

/** Get all shared projects (visible to all authenticated users) */
export async function getSharedProjects(): Promise<SharedProject[]> {
  const sb = await getSupabase();
  const { data, error } = await sb
    .from('projects')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/** Delete a shared project */
export async function deleteSharedProject(id: string): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.from('projects').delete().eq('id', id);
  if (error) throw error;
}
