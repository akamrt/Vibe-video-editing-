/**
 * Content Library Database Service
 * 
 * Uses IndexedDB for local storage of sermon transcripts, categories, and generated shorts.
 * Simple, free, and local - perfect for 100+ sermons with text and timestamps.
 */

import { ProjectState, MediaItem, KeywordEmphasis } from '../types';

// ==================== Types ====================

export interface VideoRecord {
    id: string;           // YouTube video ID
    url: string;
    title: string;
    channelName: string;
    thumbnailUrl: string;
    duration: number;     // In seconds
    importedAt: Date;
    categories: string[]; // Category IDs
}

export interface TranscriptSegment {
    id: string;           // Auto-generated: `${videoId}_${index}`
    videoId: string;      // Foreign key to VideoRecord
    start: number;        // Start time in seconds
    duration: number;     // Duration in seconds
    text: string;
}

export interface Category {
    id: string;
    name: string;
    color: string;        // Hex color for UI
    description: string;
}

export interface GeneratedShort {
    id: string;
    title: string;
    prompt: string;          // AI prompt used to find this content
    videoId: string;         // Source video ID - shorts come from ONE sermon only
    videoTitle: string;      // Source video title for display
    segments: ShortSegment[];// Clips from within the same sermon
    hook: string;            // Opening hook text
    hookTitle: string;       // Short, punchy hook title (for title layer)
    resolution: string;      // Closing resolution text
    totalDuration: number;
    createdAt: Date;
    trendingTopic?: string;
}

export interface ShortSegment {
    // Note: All segments in a short MUST be from the same video (single sermon rule)
    startTime: number;
    endTime: number;
    text: string;
    keywords?: KeywordEmphasis[];
    removedWordIndices?: number[];
}

// ==================== Database Class ====================

const DB_NAME = 'ContentLibraryDB';
const DB_VERSION = 3; // Incremented to add 'costLog' store

class ContentDatabase {
    private db: IDBDatabase | null = null;
    private initPromise: Promise<void> | null = null;

    // Initialize the database
    async init(): Promise<void> {
        if (this.db) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                console.error('Failed to open database:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('Content Library database opened successfully');
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;

                // Videos store
                if (!db.objectStoreNames.contains('videos')) {
                    const videosStore = db.createObjectStore('videos', { keyPath: 'id' });
                    videosStore.createIndex('importedAt', 'importedAt', { unique: false });
                    videosStore.createIndex('channelName', 'channelName', { unique: false });
                }

                // Transcript segments store
                if (!db.objectStoreNames.contains('segments')) {
                    const segmentsStore = db.createObjectStore('segments', { keyPath: 'id' });
                    segmentsStore.createIndex('videoId', 'videoId', { unique: false });
                    segmentsStore.createIndex('start', 'start', { unique: false });
                }

                // Categories store
                if (!db.objectStoreNames.contains('categories')) {
                    const categoriesStore = db.createObjectStore('categories', { keyPath: 'id' });
                    categoriesStore.createIndex('name', 'name', { unique: true });
                }

                // Generated shorts store
                if (!db.objectStoreNames.contains('shorts')) {
                    const shortsStore = db.createObjectStore('shorts', { keyPath: 'id' });
                    shortsStore.createIndex('createdAt', 'createdAt', { unique: false });
                    shortsStore.createIndex('prompt', 'prompt', { unique: false });
                }

                // Projects store
                if (!db.objectStoreNames.contains('projects')) {
                    db.createObjectStore('projects', { keyPath: 'id' });
                }

                // AI cost log store
                if (!db.objectStoreNames.contains('costLog')) {
                    const costStore = db.createObjectStore('costLog', { keyPath: 'id', autoIncrement: true });
                    costStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                console.log('Database schema created/updated');
            };
        });

        return this.initPromise;
    }

    private getStore(storeName: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
        if (!this.db) throw new Error('Database not initialized. Call init() first.');
        const tx = this.db.transaction(storeName, mode);
        return tx.objectStore(storeName);
    }

    // ==================== Videos CRUD ====================

    async addVideo(video: VideoRecord): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('videos', 'readwrite');
            const request = store.put(video); // put = upsert
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getVideo(id: string): Promise<VideoRecord | undefined> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('videos');
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllVideos(): Promise<VideoRecord[]> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('videos');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async deleteVideo(id: string): Promise<void> {
        await this.init();
        // Delete video and all its segments
        await this.deleteSegmentsByVideoId(id);
        return new Promise((resolve, reject) => {
            const store = this.getStore('videos', 'readwrite');
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async updateVideoCategories(videoId: string, categories: string[]): Promise<void> {
        const video = await this.getVideo(videoId);
        if (video) {
            video.categories = categories;
            await this.addVideo(video);
        }
    }

    // ==================== Segments CRUD ====================

    async addSegments(segments: TranscriptSegment[]): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('segments', 'readwrite');
            let completed = 0;
            let hasError = false;

            segments.forEach(segment => {
                const request = store.put(segment);
                request.onsuccess = () => {
                    completed++;
                    if (completed === segments.length && !hasError) resolve();
                };
                request.onerror = () => {
                    if (!hasError) {
                        hasError = true;
                        reject(request.error);
                    }
                };
            });

            if (segments.length === 0) resolve();
        });
    }

    async getSegmentsByVideoId(videoId: string): Promise<TranscriptSegment[]> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('segments');
            const index = store.index('videoId');
            const request = index.getAll(videoId);
            request.onsuccess = () => {
                const segments = request.result || [];
                // Sort by start time
                segments.sort((a, b) => a.start - b.start);
                resolve(segments);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getAllSegments(): Promise<TranscriptSegment[]> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('segments');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    private async deleteSegmentsByVideoId(videoId: string): Promise<void> {
        const segments = await this.getSegmentsByVideoId(videoId);
        return new Promise((resolve, reject) => {
            if (segments.length === 0) {
                resolve();
                return;
            }
            const store = this.getStore('segments', 'readwrite');
            let completed = 0;
            segments.forEach(seg => {
                const request = store.delete(seg.id);
                request.onsuccess = () => {
                    completed++;
                    if (completed === segments.length) resolve();
                };
                request.onerror = () => reject(request.error);
            });
        });
    }

    // ==================== Categories CRUD ====================

    async addCategory(category: Category): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('categories', 'readwrite');
            const request = store.put(category);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getAllCategories(): Promise<Category[]> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('categories');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async deleteCategory(id: string): Promise<void> {
        await this.init();
        // Remove category from all videos
        const videos = await this.getAllVideos();
        for (const video of videos) {
            if (video.categories.includes(id)) {
                video.categories = video.categories.filter(c => c !== id);
                await this.addVideo(video);
            }
        }
        return new Promise((resolve, reject) => {
            const store = this.getStore('categories', 'readwrite');
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // ==================== Generated Shorts CRUD ====================

    async addShort(short: GeneratedShort): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('shorts', 'readwrite');
            const request = store.put(short);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getAllShorts(): Promise<GeneratedShort[]> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('shorts');
            const request = store.getAll();
            request.onsuccess = () => {
                const shorts = request.result || [];
                // Sort by creation date, newest first
                shorts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                resolve(shorts);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteShort(id: string): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('shorts', 'readwrite');
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async updateShort(short: GeneratedShort): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('shorts', 'readwrite');
            const request = store.put(short);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // ==================== Search Helpers ====================

    /**
     * Search all segments for text matches (simple text search)
     * Returns segments with their video info
     */
    async searchSegments(query: string): Promise<(TranscriptSegment & { videoTitle: string })[]> {
        const allSegments = await this.getAllSegments();
        const allVideos = await this.getAllVideos();
        const videoMap = new Map(allVideos.map(v => [v.id, v]));

        const lowerQuery = query.toLowerCase();
        return allSegments
            .filter(seg => seg.text.toLowerCase().includes(lowerQuery))
            .map(seg => ({
                ...seg,
                videoTitle: videoMap.get(seg.videoId)?.title || 'Unknown Video'
            }));
    }

    /**
     * Get full transcript as a single string for AI analysis
     */
    async getFullTranscript(videoId: string): Promise<string> {
        const segments = await this.getSegmentsByVideoId(videoId);
        return segments.map(s => s.text).join(' ');
    }

    /**
     * Get all transcripts combined for AI search
     */
    async getAllTranscriptsForAI(): Promise<{ videoId: string; videoTitle: string; transcript: string }[]> {
        const videos = await this.getAllVideos();
        const results: { videoId: string; videoTitle: string; transcript: string }[] = [];

        for (const video of videos) {
            const transcript = await this.getFullTranscript(video.id);
            results.push({
                videoId: video.id,
                videoTitle: video.title,
                transcript
            });
        }

        return results;
    }

    // ==================== Database Stats ====================

    async getStats(): Promise<{
        videoCount: number;
        segmentCount: number;
        categoryCount: number;
        shortCount: number;
    }> {
        const [videos, segments, categories, shorts] = await Promise.all([
            this.getAllVideos(),
            this.getAllSegments(),
            this.getAllCategories(),
            this.getAllShorts()
        ]);

        return {
            videoCount: videos.length,
            segmentCount: segments.length,
            categoryCount: categories.length,
            shortCount: shorts.length
        };
    }

    // ==================== Project Persistence ====================

    async saveProject(project: ProjectState): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('projects', 'readwrite');
            // Cast to any to add the required 'id' field for the store
            const projectToSave = { ...project, id: 'current_project' } as any;

            // Ensure isPlaying is false on save
            projectToSave.isPlaying = false;

            const request = store.put(projectToSave);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getProject(): Promise<ProjectState | null> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('projects');
            const request = store.get('current_project');
            request.onsuccess = () => {
                const proj = request.result;
                if (!proj) {
                    resolve(null);
                    return;
                }

                // Remove the db ID
                const { id, ...projectState } = proj;

                // Revive object URLs for files
                if (projectState.library) {
                    projectState.library.forEach((item: MediaItem) => {
                        // Check if file exists and is a Blob/File (IDB restores it as Blob/File)
                        if (item.file && item.file instanceof Blob) {
                            item.url = URL.createObjectURL(item.file);
                        }
                    });
                }

                resolve(projectState as ProjectState);
            };
            request.onerror = () => reject(request.error);
        });
    }

    // ==================== Clear Database ====================

    async clearAll(): Promise<void> {
        await this.init();
        const stores = ['videos', 'segments', 'categories', 'shorts'];

        for (const storeName of stores) {
            await new Promise<void>((resolve, reject) => {
                const store = this.getStore(storeName, 'readwrite');
                const request = store.clear();
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        }

        console.log('All database stores cleared');
    }

    // ==================== AI Cost Log ====================

    async addCostEntry(entry: { timestamp: number; operation: string; model: string; inputTokens: number; outputTokens: number; estimatedCost: number }): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('costLog', 'readwrite');
            const request = store.add(entry);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getAllCostEntries(): Promise<Array<{ id: number; timestamp: number; operation: string; model: string; inputTokens: number; outputTokens: number; estimatedCost: number }>> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('costLog');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async clearCostLog(): Promise<void> {
        await this.init();
        return new Promise((resolve, reject) => {
            const store = this.getStore('costLog', 'readwrite');
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}

// Export a singleton instance
export const contentDB = new ContentDatabase();

// Helper to generate unique IDs
export function generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
