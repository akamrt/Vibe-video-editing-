/**
 * Brand Settings — small localStorage-backed store for social media handles,
 * website, and default CTA. Auto-injected into every social package prompt.
 */

import { BrandSettings } from './contentDatabase';

const KEY = 'vibecut_social_brand_settings';

export function loadBrandSettings(): BrandSettings {
    try {
        const raw = localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

export function saveBrandSettings(settings: BrandSettings): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn('[brandSettings] Failed to persist:', e);
    }
}
