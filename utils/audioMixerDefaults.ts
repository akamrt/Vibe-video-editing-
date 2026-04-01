import type { AudioMixerState, AudioEffects, EQBand } from '../types';

export const DEFAULT_EQ_BANDS: [EQBand, EQBand, EQBand] = [
  { frequency: 100, gain: 0, Q: 1, type: 'lowshelf' },
  { frequency: 1000, gain: 0, Q: 1, type: 'peaking' },
  { frequency: 8000, gain: 0, Q: 1, type: 'highshelf' },
];

export const DEFAULT_AUDIO_EFFECTS: AudioEffects = {
  noiseReduction: false,
  eqEnabled: false,
  eqBands: [...DEFAULT_EQ_BANDS] as [EQBand, EQBand, EQBand],
  compressorEnabled: false,
  compressorThreshold: -24,
  compressorKnee: 30,
  compressorRatio: 12,
  compressorAttack: 0.003,
  compressorRelease: 0.25,
  limiterEnabled: false,
  limiterThreshold: -1,
  normalizationEnabled: false,
  normalizationTarget: -14, // YouTube standard
};

export function createDefaultAudioMixer(): AudioMixerState {
  return {
    masterVolume: 1.0,
    effects: { ...DEFAULT_AUDIO_EFFECTS, eqBands: [...DEFAULT_EQ_BANDS] as [EQBand, EQBand, EQBand] },
  };
}

/** Preset configurations */
export const AUDIO_PRESETS = {
  voice: {
    label: 'Voice',
    description: 'Clear voice with noise reduction',
    apply: (state: AudioMixerState): AudioMixerState => ({
      ...state,
      effects: {
        ...state.effects,
        noiseReduction: true,
        eqEnabled: true,
        eqBands: [
          { frequency: 80, gain: -6, Q: 1, type: 'lowshelf' },   // Cut low rumble
          { frequency: 2500, gain: 3, Q: 1.5, type: 'peaking' }, // Boost presence
          { frequency: 8000, gain: 2, Q: 1, type: 'highshelf' }, // Add clarity
        ],
        compressorEnabled: true,
        compressorThreshold: -20,
        compressorKnee: 10,
        compressorRatio: 4,
        compressorAttack: 0.01,
        compressorRelease: 0.15,
        limiterEnabled: true,
        limiterThreshold: -1,
      },
    }),
  },
  music: {
    label: 'Music',
    description: 'Balanced for music content',
    apply: (state: AudioMixerState): AudioMixerState => ({
      ...state,
      effects: {
        ...state.effects,
        noiseReduction: false,
        eqEnabled: true,
        eqBands: [
          { frequency: 100, gain: 2, Q: 1, type: 'lowshelf' },
          { frequency: 1000, gain: 0, Q: 1, type: 'peaking' },
          { frequency: 10000, gain: 1, Q: 1, type: 'highshelf' },
        ],
        compressorEnabled: true,
        compressorThreshold: -18,
        compressorKnee: 20,
        compressorRatio: 3,
        compressorAttack: 0.02,
        compressorRelease: 0.3,
        limiterEnabled: true,
        limiterThreshold: -1,
      },
    }),
  },
  podcast: {
    label: 'Podcast',
    description: 'Optimized for speech, -16 LUFS',
    apply: (state: AudioMixerState): AudioMixerState => ({
      ...state,
      effects: {
        ...state.effects,
        noiseReduction: true,
        eqEnabled: true,
        eqBands: [
          { frequency: 80, gain: -8, Q: 1, type: 'lowshelf' },
          { frequency: 3000, gain: 4, Q: 1.2, type: 'peaking' },
          { frequency: 8000, gain: 1, Q: 1, type: 'highshelf' },
        ],
        compressorEnabled: true,
        compressorThreshold: -18,
        compressorKnee: 10,
        compressorRatio: 6,
        compressorAttack: 0.005,
        compressorRelease: 0.2,
        limiterEnabled: true,
        limiterThreshold: -1,
        normalizationEnabled: true,
        normalizationTarget: -16,
      },
    }),
  },
  loud: {
    label: 'Loud & Clear',
    description: 'Maximum loudness boost',
    apply: (state: AudioMixerState): AudioMixerState => ({
      ...state,
      masterVolume: 1.5,
      effects: {
        ...state.effects,
        noiseReduction: false,
        eqEnabled: false,
        eqBands: [...DEFAULT_EQ_BANDS] as [EQBand, EQBand, EQBand],
        compressorEnabled: true,
        compressorThreshold: -30,
        compressorKnee: 5,
        compressorRatio: 8,
        compressorAttack: 0.003,
        compressorRelease: 0.1,
        limiterEnabled: true,
        limiterThreshold: -0.5,
        normalizationEnabled: true,
        normalizationTarget: -14,
      },
    }),
  },
} as const;
