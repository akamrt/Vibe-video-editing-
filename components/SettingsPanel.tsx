import React, { useState, useEffect, useCallback } from 'react';
import HotkeysPanel from './HotkeysPanel';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface KeyStatus {
  masked: string;
  set: boolean;
}

const API_KEY_LABELS: Record<string, string> = {
  GEMINI_API_KEY: 'Google Gemini',
  KIMI_API_KEY: 'Kimi (Moonshot)',
  OPENAI_API_KEY: 'OpenAI',
  MINIMAX_API_KEY: 'MiniMax',
  ASSEMBLYAI_API_KEY: 'AssemblyAI',
  PEXELS_API_KEY: 'Pexels (Stock Video)',
  YOUTUBE_API_KEY: 'YouTube Data API',
};

const SettingsPanel: React.FC<SettingsPanelProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'api-keys' | 'shortcuts'>('api-keys');
  const [keys, setKeys] = useState<Record<string, KeyStatus>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/keys');
      if (res.ok) {
        const data = await res.json();
        setKeys(data);
      }
    } catch (e) {
      console.warn('Failed to fetch API keys:', e);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchKeys();
      setMessage('');
    }
  }, [isOpen, fetchKeys]);

  const handleSave = async (keyName: string) => {
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: { [keyName]: editValue } }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage('Key updated successfully');
        setEditingKey(null);
        setEditValue('');
        fetchKeys();
      } else {
        setMessage(data.error || 'Failed to update key');
      }
    } catch (e) {
      setMessage('Failed to save key');
    }
    setSaving(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[#1e1e1e] rounded-xl shadow-2xl border border-[#333] w-full max-w-lg mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#333]">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Settings
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#333] px-5">
          {(['api-keys', 'shortcuts'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-indigo-500 text-white'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab === 'api-keys' ? 'API Keys' : '⌨ Shortcuts'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">

          {/* Shortcuts tab */}
          {activeTab === 'shortcuts' && (
            <HotkeysPanel />
          )}

          {/* API Keys tab */}
          {activeTab === 'api-keys' && <>
          <div>
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-3">API Keys</h3>
            <div className="space-y-3">
              {Object.entries(API_KEY_LABELS).map(([keyName, label]) => {
                const status = keys[keyName];
                const isEditing = editingKey === keyName;
                return (
                  <div key={keyName} className="bg-[#2a2a2a] rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-white font-medium">{label}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${status?.set ? 'bg-green-900/50 text-green-400' : 'bg-yellow-900/50 text-yellow-400'}`}>
                        {status?.set ? 'Configured' : 'Not set'}
                      </span>
                    </div>
                    {status?.set && !isEditing && (
                      <div className="text-xs text-gray-500 font-mono">{status.masked}</div>
                    )}
                    {isEditing ? (
                      <div className="mt-2 flex gap-2">
                        <input
                          type="password"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          placeholder={`Enter ${label} API key`}
                          className="flex-1 bg-[#1a1a1a] border border-[#444] rounded px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                          autoFocus
                        />
                        <button
                          onClick={() => handleSave(keyName)}
                          disabled={saving || !editValue.trim()}
                          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-600 text-white text-xs rounded font-medium"
                        >
                          {saving ? '...' : 'Save'}
                        </button>
                        <button
                          onClick={() => { setEditingKey(null); setEditValue(''); }}
                          className="px-2 py-1.5 text-gray-400 hover:text-white text-xs"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingKey(keyName); setEditValue(''); }}
                        className="mt-1 text-xs text-indigo-400 hover:text-indigo-300"
                      >
                        {status?.set ? 'Update key' : 'Add key'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Status message */}
          {message && (
            <div className={`text-xs px-3 py-2 rounded ${message.includes('success') ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
              {message}
            </div>
          )}
          </>}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#333] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-[#333] hover:bg-[#444] text-white text-sm rounded-lg"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
