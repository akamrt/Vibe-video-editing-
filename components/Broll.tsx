import React, { useState } from 'react';

interface BrollProps {
  transcript?: string;
}

const Broll: React.FC<BrollProps> = ({ transcript }) => {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const copyBrollPrompt = async () => {
    if (!transcript) return;

    // Truncate if too long — ChatGPT has token limits
    const shortTranscript = transcript.length > 4000
      ? transcript.slice(0, 4000) + '\n...[transcript truncated]'
      : transcript;

    const prompt = `You are a video editor assistant. Based on this transcript, suggest 5 B-roll video clips for each segment. For each clip provide: timestamp, a description, and a YouTube search term or Pexels/Unsplash URL.

Format your response like this for each segment:
[00:30] - Beach waves rolling in slowly - "ocean waves relaxing"
[01:15] - City timelapse at night - "city night timelapse"
[02:00] - Coffee being poured slowly - "coffee pour slow motion"

TRANSCRIPT:
${shortTranscript}

Keep suggestions realistic and easy to find. Respond in this exact format only.`;

    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setError('');
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      setError('Failed to copy — try selecting the text manually');
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <h2 className="text-lg font-semibold text-white">B-Roll Suggestion Generator</h2>
      <button
        onClick={copyBrollPrompt}
        disabled={!transcript}
        style={{
          background: copied ? '#22c55e' : '#3b82f6',
          color: 'white',
          padding: '8px 16px',
          borderRadius: '6px',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        {copied ? '\u2713 Copied!' : transcript ? 'Copy for ChatGPT' : 'Generate transcript first'}
      </button>
      {error && <p style={{ color: '#ef4444', fontSize: '12px' }}>{error}</p>}
    </div>
  );
};

export default Broll;
