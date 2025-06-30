// ========== Chrome Extension Service Worker - Refactored version ==========

console.log('=== Service Worker: Start ===');

// === Configuration constants ===
const CONFIG = {
    WORD_API_ENDPOINT: 'https://4gjsn9p4kc.execute-api.us-east-1.amazonaws.com/dev/word-muncher',
    CONCEPT_API_ENDPOINT: 'https://4gjsn9p4kc.execute-api.us-east-1.amazonaws.com/dev/concept-muncher',
    MEMORY_CACHE_TIME: 3000,
    INDEXEDDB_CACHE_TIME: 24 * 60 * 60 * 1000,
    DB_NAME: 'WordMunchCache',
    DB_VERSION: 1,
    STORE_NAME: 'simplifiedResults'
};

// === Global state management ===
class ServiceWorkerState {
    constructor() {
        this.memoryCache = new Map();
        this.recentSelections = new Map();
        this.activeRequests = new Map();
        this.db = null;
    }

    clearMemory() {
        this.memoryCache.clear();
        this.recentSelections.clear();
        this.activeRequests.clear();
    }
}

const serviceState = new ServiceWorkerState();

// === Service Worker lifecycle management ===
class LifecycleManager {
    static async initialize() {
        console.log('Service Worker: Initialize extension');
        
        try {
            await DatabaseManager.initializeIndexedDB();
            await this.setDefaultSettings();
            console.log('Service Worker: Initialize completed');
        } catch (error) {
            console.error('Service Worker: Initialize failed:', error);
        }
    }

    static async setDefaultSettings() {
        const defaults = {
            extensionEnabled: true,
            outputLanguage: 'english',
            notificationsEnabled: true,
            conceptMuncherEnabled: true,
            wordCounts: {
                today: 0,
                week: 0,
                total: 0,
                lastDate: new Date().toDateString()
            },
            conceptCounts: {
                today: 0,
                week: 0,
                total: 0,
                lastDate: new Date().toDateString()
            }
        };
        
        for (const [key, value] of Object.entries(defaults)) {
            const result = await chrome.storage.sync.get([key]);
            if (!result[key]) {
                await chrome.storage.sync.set({ [key]: value });
            }
        }
    }
}

// === Message router ===
class MessageRouter {
    static async handleMessage(request, sender) {
        console.log('Service Worker: Start asynchronous processing:', request.type);
        
        try {
            switch (request.type) {
                case 'WORD_SELECTED':
                case 'SENTENCE_SELECTED':
                    await WordProcessor.handleWordSelection(request, sender);
                    break;
                    
                case 'CONCEPT_ANALYSIS':
                    await ConceptProcessor.handleConceptAnalysis(request, sender);
                    break;
                    
                case 'CONTENT_SCRIPT_READY':
                    console.log('Service Worker: Content script ready:', request.url);
                    break;
                    
                case 'SETTINGS_UPDATED':
                    await SettingsManager.handleSettingsUpdate(request.settings);
                    break;
                    
                case 'CLEANUP_CACHE':
                    CacheManager.cleanupMemoryCache();
                    await DatabaseManager.cleanupExpiredDBCache();
                    break;

                case 'CLEAR_ALL_CACHE':
                    await CacheManager.clearAllCache();
                    break;

                case 'USER_LOGIN':
                    await UserManager.handleUserLogin(request.userInfo);
                    break;

                case 'USER_LOGOUT':
                    await UserManager.handleUserLogout();
                    break;
                    
                default:
                    console.log('Service Worker: Unknown message type:', request.type);
            }
            
        } catch (error) {
            console.error('Service Worker: Asynchronous processing failed:', error);
            await this.sendErrorToTab(sender, request, error.message);
            await NotificationManager.showError(`Error processing ${request.type}: ${error.message}`);
        }
    }

    static async sendErrorToTab(sender, request, errorMessage) {
        let errorType, text;
        
        if (request.type === 'WORD_SELECTED' || request.type === 'SENTENCE_SELECTED') {
            errorType = 'SIMPLIFY_ERROR';
            text = request.word || request.text;
        } else if (request.type === 'CONCEPT_ANALYSIS') {
            errorType = 'CONCEPT_ANALYSIS_ERROR';
            text = request.original_text;
        } else {
            return;
        }
        
        if (sender.tab?.id) {
            try {
                await chrome.tabs.sendMessage(sender.tab.id, {
                    type: errorType,
                    text: text,
                    word: text,
                    error: errorMessage
                });
            } catch (error) {
                console.log('Service Worker: Cannot send error to content script:', error.message);
            }
        }
    }
}

// === Word processor ===
class WordProcessor {
    static async handleWordSelection(request, sender) {
        const { word, text, context, url, title } = request;
        const targetWord = word || text;
        
        try {
            const settings = await SettingsManager.getSettings();
            if (!settings.extensionEnabled) {
                console.log('Service Worker: Extension disabled');
                return;
            }
            
            const cacheKeys = CacheManager.generateCacheKeys('word', targetWord, url, settings.outputLanguage);
            const requestKey = `word_${targetWord}_${settings.outputLanguage}`;
            const now = Date.now();
            
            // Check ongoing requests
            if (serviceState.activeRequests.has(requestKey)) {
                console.log('Service Worker: Found ongoing request, waiting for result:', targetWord);
                try {
                    const result = await serviceState.activeRequests.get(requestKey);
                    await ResultManager.showWordResult(result, targetWord, url, sender.tab?.id);
                    return;
                } catch (error) {
                    console.error('Service Worker: Waiting for existing request failed:', error);
                }
            }
            
            // Check memory cache
            if (CacheManager.checkRecentSelection(cacheKeys.memory, now)) {
                const cachedData = await CacheManager.getCachedData(cacheKeys.data);
                if (cachedData) {
                    console.log('Service Worker: Return cached data to repeated request');
                    await ResultManager.showWordResult(cachedData, targetWord, url, sender.tab?.id);
                    return;
                }
            }
            
            // Update memory cache
            serviceState.recentSelections.set(cacheKeys.memory, now);
            CacheManager.cleanupMemoryCache();
            
            // Check data cache
            const cachedData = await CacheManager.getCachedData(cacheKeys.data);
            if (cachedData) {
                console.log('Service Worker: Memory data cache hit');
                await ResultManager.showWordResult(cachedData, targetWord, url, sender.tab?.id);
                return;
            }
            
            // Check IndexedDB cache
            const cachedResult = await DatabaseManager.getCachedResultFromDB('word', targetWord, settings.outputLanguage);
            if (cachedResult) {
                console.log('Service Worker: IndexedDB cache hit');
                await ResultManager.showWordResult(cachedResult, targetWord, url, sender.tab?.id);
                
                // Promote to memory cache
                serviceState.memoryCache.set(cacheKeys.data, {
                    data: cachedResult,
                    timestamp: now
                });
                
                return;
            }
            
            console.log('Service Worker: Cache missed, call API');
            
            // Call API
            const apiPromise = APIManager.callWordAPI(targetWord, context, settings.outputLanguage);
            serviceState.activeRequests.set(requestKey, apiPromise);
            
            try {
                const result = await apiPromise;
                
                // Cache result
                await Promise.all([
                    DatabaseManager.cacheResultToDB('word', targetWord, settings.outputLanguage, result),
                    CacheManager.cacheResultToMemory('word', targetWord, settings.outputLanguage, result)
                ]);
                
                // Show result
                await ResultManager.showWordResult(result, targetWord, url, sender.tab?.id);
                await StatsManager.updateWordStats();
                
            } finally {
                serviceState.activeRequests.delete(requestKey);
            }
            
        } catch (error) {
            console.error('Service Worker: Word processing failed:', error);
            
            const requestKey = `word_${targetWord}_${(await SettingsManager.getSettings()).outputLanguage}`;
            serviceState.activeRequests.delete(requestKey);
            
            throw error;
        }
    }
}

// === Concept analysis processor ===
class ConceptProcessor {
    static async handleConceptAnalysis(request, sender) {
        const { original_text, user_understanding, context, auto_extract_context, cache_key } = request;
        
        try {
            const settings = await SettingsManager.getSettings();
            if (!settings.extensionEnabled) {
                console.log('Service Worker: Extension disabled');
                return;
            }
            
            const uniqueCacheKey = cache_key || this.generateUniqueCacheKey(original_text, user_understanding, context);
            const dataCacheKey = `concept_${uniqueCacheKey}_${settings.outputLanguage}`;
            const requestKey = `concept_analysis_${uniqueCacheKey}`;
            const now = Date.now();
            
            console.log('Service Worker: Concept analysis cache key:', dataCacheKey);
            
            // Check ongoing requests
            if (serviceState.activeRequests.has(requestKey)) {
                console.log('Service Worker: Found ongoing concept analysis request, waiting for result');
                try {
                    const result = await serviceState.activeRequests.get(requestKey);
                    await ResultManager.showConceptResult(result, original_text, request.url, sender.tab?.id);
                    return;
                } catch (error) {
                    console.error('Service Worker: Waiting for existing concept analysis request failed:', error);
                }
            }
            
            // Check short-term cache (5 minutes)
            const shortCacheTime = 5 * 60 * 1000;
            const cachedData = await CacheManager.getCachedData(dataCacheKey);
            if (cachedData) {
                const cacheAge = now - (cachedData.timestamp || 0);
                if (cacheAge < shortCacheTime) {
                    console.log('Service Worker: Concept analysis short-term cache hit');
                    await ResultManager.showConceptResult(cachedData.data, original_text, request.url, sender.tab?.id);
                    return;
                } else {
                    serviceState.memoryCache.delete(dataCacheKey);
                    console.log('Service Worker: Clean up expired concept analysis cache');
                }
            }
            
            console.log('Service Worker: Concept analysis direct call API');
            
            // Call API
            const apiPromise = APIManager.callConceptAPI(original_text, user_understanding, context, auto_extract_context);
            serviceState.activeRequests.set(requestKey, apiPromise);
            
            try {
                const result = await apiPromise;
                
                // Short-term cache result
                serviceState.memoryCache.set(dataCacheKey, {
                    data: result,
                    timestamp: now
                });
                
                await ResultManager.showConceptResult(result, original_text, request.url, sender.tab?.id);
                await StatsManager.updateConceptStats();
                
            } finally {
                serviceState.activeRequests.delete(requestKey);
            }
            
        } catch (error) {
            console.error('Service Worker: Concept analysis processing failed:', error);
            
            const requestKey = `concept_analysis_${cache_key || this.generateUniqueCacheKey(original_text, user_understanding, context)}`;
            serviceState.activeRequests.delete(requestKey);
            
            throw error;
        }
    }

    static generateUniqueCacheKey(originalText, userUnderstanding, context) {
        const combinedContent = `${originalText}||${userUnderstanding}||${context || ''}||${Date.now()}`;
        
        let hash = 0;
        for (let i = 0; i < combinedContent.length; i++) {
            const char = combinedContent.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        
        return Math.abs(hash).toString(36);
    }
}

// === API manager ===
class APIManager {
    static async callWordAPI(word, context, language) {
        console.log('Service Worker: Call word API:', { word: word.substring(0, 20) });
        
        const requestBody = {
            word: word,
            context: context,
            language: language
        };

        const headers = {
            'Content-Type': 'application/json'
        };

        const authToken = await UserManager.getAuthToken();
        if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
        }
        
        const response = await fetch(CONFIG.WORD_API_ENDPOINT, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });
        
        console.log('Service Worker: API response status:', response.status);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API request failed ${response.status}: ${errorText}`);
        }
        
        const result = await response.json();
        console.log('Service Worker: API successful response');
        
        return result;
    }

    static async callConceptAPI(original_text, user_understanding, context, auto_extract_context) {
        console.log('Service Worker: Call concept analysis API');
        
        const requestBody = {
            original_text: original_text,
            user_understanding: user_understanding,
            context: context,
            auto_extract_context: auto_extract_context || false
        };

        const headers = {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache'
        };

        const authToken = await UserManager.getAuthToken();
        if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
        }
        
        const response = await fetch(CONFIG.CONCEPT_API_ENDPOINT, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody),
            cache: 'no-cache'
        });
        
        console.log('Service Worker: Concept analysis API response status:', response.status);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Service Worker: API error response:', errorText);
            throw new Error(`Concept analysis API request failed ${response.status}: ${errorText}`);
        }
        
        const result = await response.json();
        console.log('Service Worker: Concept analysis API successful response, similarity:', result.overall_similarity);
        
        return result;
    }
}

// === Cache manager ===
class CacheManager {
    static generateCacheKeys(type, text, url, language) {
        return {
            memory: this.generateMemoryCacheKey(type, text, url),
            data: this.generateDataCacheKey(type, text, language)
        };
    }

    static generateMemoryCacheKey(type, text, url) {
        return `memory_${type}_${text}_${url}`;
    }

    static generateDataCacheKey(type, text, language) {
        return `${type}_${text}_${language}`;
    }

    static checkRecentSelection(memoryCacheKey, now) {
        if (serviceState.recentSelections.has(memoryCacheKey)) {
            const lastTime = serviceState.recentSelections.get(memoryCacheKey);
            return now - lastTime < CONFIG.MEMORY_CACHE_TIME;
        }
        return false;
    }

    static async getCachedData(dataCacheKey) {
        if (serviceState.memoryCache.has(dataCacheKey)) {
            const cached = serviceState.memoryCache.get(dataCacheKey);
            const now = Date.now();
            if (now - cached.timestamp < CONFIG.MEMORY_CACHE_TIME * 3) {
                return cached.data;
            } else {
                serviceState.memoryCache.delete(dataCacheKey);
            }
        }
        return null;
    }

    static async cacheResultToMemory(type, text, language, data) {
        const cacheKey = this.generateDataCacheKey(type, text, language);
        serviceState.memoryCache.set(cacheKey, {
            data: data,
            timestamp: Date.now()
        });
        
        console.log('Service Worker: Result cached to memory');
        
        if (serviceState.memoryCache.size > 100) {
            const oldestKey = serviceState.memoryCache.keys().next().value;
            serviceState.memoryCache.delete(oldestKey);
        }
    }

    static cleanupMemoryCache() {
        const now = Date.now();
        
        // Clean up expired repeated selection records
        for (const [key, timestamp] of serviceState.recentSelections.entries()) {
            if (now - timestamp > CONFIG.MEMORY_CACHE_TIME) {
                serviceState.recentSelections.delete(key);
            }
        }
        
        // Clean up expired memory cache
        for (const [key, value] of serviceState.memoryCache.entries()) {
            let maxAge = CONFIG.MEMORY_CACHE_TIME * 3;
            
            if (key.startsWith('concept_')) {
                maxAge = 5 * 60 * 1000; // Concept analysis cache 5 minutes
            }
            
            if (now - value.timestamp > maxAge) {
                serviceState.memoryCache.delete(key);
            }
        }
    }

    static async clearAllCache() {
        try {
            serviceState.clearMemory();
            console.log('Service Worker: Memory cache cleared');
            
            if (serviceState.db) {
                const userInfo = await UserManager.getUserInfo();
                const userId = userInfo ? userInfo.userId : 'anonymous';
                
                const transaction = serviceState.db.transaction([CONFIG.STORE_NAME], 'readwrite');
                const store = transaction.objectStore(CONFIG.STORE_NAME);
                const index = store.index('userId');
                const request = index.openCursor(IDBKeyRange.only(userId));
                
                let deletedCount = 0;
                
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        cursor.delete();
                        deletedCount++;
                        cursor.continue();
                    } else {
                        console.log(`Service Worker: IndexedDB cache cleared, deleted ${deletedCount} records`);
                    }
                };

                request.onerror = () => {
                    console.error('Service Worker: Clean up IndexedDB failed:', request.error);
                };
            }
        } catch (error) {
            console.error('Service Worker: Clean up cache failed:', error);
        }
    }
}

// === Database manager ===
class DatabaseManager {
    static async initializeIndexedDB() {
        console.log('Service Worker: Initialize IndexedDB');
        
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
            
            request.onerror = () => {
                console.error('Service Worker: IndexedDB open failed:', request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                serviceState.db = request.result;
                console.log('Service Worker: IndexedDB initialized successfully');
                
                serviceState.db.onerror = (event) => {
                    console.error('Service Worker: IndexedDB error:', event.target.error);
                };
                
                resolve(serviceState.db);
            };
            
            request.onupgradeneeded = (event) => {
                const database = event.target.result;
                console.log('Service Worker: Upgrade IndexedDB structure');

                if (database.objectStoreNames.contains(CONFIG.STORE_NAME)) {
                    database.deleteObjectStore(CONFIG.STORE_NAME);
                }

                const store = database.createObjectStore(CONFIG.STORE_NAME, { 
                    keyPath: ['userId', 'type', 'textHash', 'language']
                });
        
                store.createIndex('userId', 'userId', { unique: false });
                store.createIndex('type', 'type', { unique: false });
                store.createIndex('language', 'language', { unique: false });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('textHash', 'textHash', { unique: false });
                
                console.log('Service Worker: IndexedDB object store created successfully');
            };
        });
    }

    static async getCachedResultFromDB(type, text, language) {
        try {
            if (!serviceState.db) {
                await this.initializeIndexedDB();
            }
            
            const cacheKey = await this.generateDBCacheKey(type, text, language);
            
            return new Promise((resolve, reject) => {
                const transaction = serviceState.db.transaction([CONFIG.STORE_NAME], 'readonly');
                const store = transaction.objectStore(CONFIG.STORE_NAME);
                const request = store.get(cacheKey);
                
                request.onsuccess = () => {
                    const cachedData = request.result;
                    
                    if (cachedData && cachedData.timestamp) {
                        const now = Date.now();
                        const cacheAge = now - cachedData.timestamp;
                        
                        if (cacheAge < CONFIG.INDEXEDDB_CACHE_TIME) {
                            console.log('Service Worker: IndexedDB cache is valid');
                            resolve(cachedData.data);
                        } else {
                            console.log('Service Worker: IndexedDB cache expired, delete');
                            this.deleteCachedResultFromDB(cacheKey);
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                };
                
                request.onerror = () => {
                    console.error('Service Worker: Read IndexedDB failed:', request.error);
                    resolve(null);
                };
            });
            
        } catch (error) {
            console.error('Service Worker: IndexedDB query failed:', error);
            return null;
        }
    }

    static async cacheResultToDB(type, text, language, data) {
        try {
            if (!serviceState.db) {
                await this.initializeIndexedDB();
            }

            const userInfo = await UserManager.getUserInfo();
            const userId = userInfo ? userInfo.userId : 'anonymous';
            const textHash = await this.hashString(text);
            
            const cacheData = {
                userId: userId,
                type: type,
                textHash: textHash,
                language: language,
                text: text,
                data: data,
                timestamp: Date.now()
            };
            
            return new Promise((resolve, reject) => {
                const transaction = serviceState.db.transaction([CONFIG.STORE_NAME], 'readwrite');
                const store = transaction.objectStore(CONFIG.STORE_NAME);
                const request = store.put(cacheData);
                
                request.onsuccess = () => {
                    console.log('Service Worker: Result cached to IndexedDB');
                    resolve();
                };
                
                request.onerror = () => {
                    console.error('Service Worker: IndexedDB cache failed:', request.error);
                    resolve();
                };
            });
            
        } catch (error) {
            console.error('Service Worker: IndexedDB cache failed:', error);
        }
    }

    static async deleteCachedResultFromDB(cacheKey) {
        try {
            if (!serviceState.db) return;
            
            return new Promise((resolve, reject) => {
                const transaction = serviceState.db.transaction([CONFIG.STORE_NAME], 'readwrite');
                const store = transaction.objectStore(CONFIG.STORE_NAME);
                const request = store.delete(cacheKey);
                
                request.onsuccess = () => {
                    console.log('Service Worker: IndexedDB cache deleted');
                    resolve();
                };
                
                request.onerror = () => {
                    console.error('Service Worker: Delete IndexedDB cache failed:', request.error);
                    resolve();
                };
            });
            
        } catch (error) {
            console.error('Service Worker: Delete IndexedDB cache failed:', error);
        }
    }

    static async generateDBCacheKey(type, text, language) {
        const userInfo = await UserManager.getUserInfo();
        const userId = userInfo ? userInfo.userId : 'anonymous';
        const textHash = await this.hashString(text);
        return [userId, type, textHash, language];
    }

    static async hashString(str) {
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
    }

    static async cleanupExpiredDBCache() {
        try {
            if (!serviceState.db) return;
            
            const cutoffTime = Date.now() - CONFIG.INDEXEDDB_CACHE_TIME;
            const transaction = serviceState.db.transaction([CONFIG.STORE_NAME], 'readwrite');
            const store = transaction.objectStore(CONFIG.STORE_NAME);
            const index = store.index('timestamp');
            const request = index.openCursor(IDBKeyRange.upperBound(cutoffTime));
            
            let deletedCount = 0;
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    deletedCount++;
                    cursor.continue();
                } else {
                    if (deletedCount > 0) {
                        console.log(`Service Worker: Clean up ${deletedCount} expired IndexedDB cache`);
                    }
                }
            };
        } catch (error) {
            console.error('Service Worker: Clean up expired IndexedDB cache failed:', error);
        }
    }
}

// === Result manager ===
class ResultManager {
    static async showWordResult(result, text, url, tabId) {
        try {
            await NotificationManager.showNotification(text, result);
            
            if (tabId) {
                try {
                    await chrome.tabs.sendMessage(tabId, {
                        type: 'WORD_SIMPLIFIED',
                        word: text,
                        result: result
                    });
                    console.log('Service Worker: Result sent to specified tab');
                    return;
                } catch (error) {
                    console.log('Service Worker: Send to specified tab failed, try current active tab');
                }
            }
            
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0] && TabManager.isValidTab(tabs[0])) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'WORD_SIMPLIFIED',
                    word: text,
                    result: result
                }).catch((error) => {
                    console.log('Service Worker: Cannot send to content script:', error.message);
                });
            }
        } catch (error) {
            console.error('Service Worker: Show result failed:', error);
        }
    }

    static async showConceptResult(result, original_text, url, tabId) {
        try {
            if (tabId) {
                try {
                    await chrome.tabs.sendMessage(tabId, {
                        type: 'CONCEPT_ANALYZED',
                        original_text: original_text,
                        result: result
                    });
                    console.log('Service Worker: Concept analysis result sent to specified tab');
                    return;
                } catch (error) {
                    console.log('Service Worker: Send to specified tab failed, try current active tab');
                }
            }
            
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0] && TabManager.isValidTab(tabs[0])) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'CONCEPT_ANALYZED',
                    original_text: original_text,
                    result: result
                }).catch((error) => {
                    console.log('Service Worker: Cannot send concept analysis result to content script:', error.message);
                });
            }
        } catch (error) {
            console.error('Service Worker: Show concept analysis result failed:', error);
        }
    }
}

// === Notification manager ===
class NotificationManager {
    static async showNotification(word, result) {
        try {
            const settings = await SettingsManager.getSettings();
            if (!settings.notificationsEnabled) return;
            
            const synonyms = result.synonyms || [];
            const firstSynonym = synonyms.length > 0 ? synonyms[0] : 'processing completed';
            
            await chrome.notifications.create({
                type: 'basic',
                iconUrl: '/icons/icon48.png',
                title: `Word Munch - ${word}`,
                message: typeof firstSynonym === 'string' ? firstSynonym : firstSynonym.word || 'processing completed'
            });
        } catch (error) {
            console.error('Service Worker: Show notification failed:', error);
        }
    }

    static async showError(message) {
        try {
            await chrome.notifications.create({
                type: 'basic',
                iconUrl: '/icons/icon48.png',
                title: 'Word Munch - Error',
                message: message
            });
        } catch (error) {
            console.error('Service Worker: Show error notification failed:', error);
        }
    }
}

// === Stats manager ===
class StatsManager {
    static async updateWordStats() {
        try {
            const today = new Date().toDateString();
            const result = await chrome.storage.sync.get(['wordCounts']);
            const counts = result.wordCounts || { today: 0, week: 0, total: 0, lastDate: '' };
            
            if (counts.lastDate !== today) {
                counts.today = 0;
                counts.lastDate = today;
            }
            
            counts.today++;
            counts.total++;
            
            await chrome.storage.sync.set({ wordCounts: counts });
            console.log('Service Worker: Stats updated:', counts);
        } catch (error) {
            console.error('Service Worker: Update stats failed:', error);
        }
    }

    static async updateConceptStats() {
        try {
            const today = new Date().toDateString();
            const result = await chrome.storage.sync.get(['conceptCounts']);
            const counts = result.conceptCounts || { today: 0, week: 0, total: 0, lastDate: '' };
            
            if (counts.lastDate !== today) {
                counts.today = 0;
                counts.lastDate = today;
            }
            
            counts.today++;
            counts.total++;
            
            await chrome.storage.sync.set({ conceptCounts: counts });
            console.log('Service Worker: Concept analysis stats updated:', counts);
        } catch (error) {
            console.error('Service Worker: Update concept analysis stats failed:', error);
        }
    }
}

// === Settings manager ===
class SettingsManager {
    static async getSettings() {
        const defaults = {
            extensionEnabled: true,
            outputLanguage: 'english',
            notificationsEnabled: true,
            conceptMuncherEnabled: true
        };
        
        try {
            const result = await chrome.storage.sync.get(Object.keys(defaults));
            return { ...defaults, ...result };
        } catch (error) {
            console.error('Service Worker: Get settings failed:', error);
            return defaults;
        }
    }

    static async handleSettingsUpdate(newSettings) {
        try {
            await chrome.storage.sync.set(newSettings);
            console.log('Service Worker: Settings updated:', newSettings);
            
            const tabs = await chrome.tabs.query({});
            for (const tab of tabs) {
                if (TabManager.isValidTab(tab)) {
                    chrome.tabs.sendMessage(tab.id, {
                        type: 'SETTINGS_UPDATED',
                        settings: newSettings
                    }).catch(() => {
                        // Ignore send failure
                    });
                }
            }
        } catch (error) {
            console.error('Service Worker: Handle settings update failed:', error);
        }
    }
}

// === User manager ===
class UserManager {
    static async getUserInfo() {
        try {
            const result = await chrome.storage.sync.get(['userEmail', 'userToken', 'userId']);
            if (result.userToken && result.userEmail) {
                return {
                    userId: result.userId || result.userEmail,
                    email: result.userEmail,
                    token: result.userToken
                };
            }
            return null;
        } catch (error) {
            console.error('Service Worker: Get user info failed:', error);
            return null;
        }
    }

    static async getAuthToken() {
        const userInfo = await this.getUserInfo();
        return userInfo ? userInfo.token : null;
    }

    static async handleUserLogin(userInfo) {
        try {
            await chrome.storage.sync.set({
                userEmail: userInfo.email,
                userToken: userInfo.token,
                userId: userInfo.userId || userInfo.email
            });

            console.log('Service Worker: User login successful:', userInfo.email);

        } catch (error) {
            console.error('Service Worker: Handle user login failed:', error);
            throw error;
        }
    }

    static async handleUserLogout() {
        try {
            await CacheManager.clearAllCache();
            await chrome.storage.sync.remove(['userEmail', 'userToken', 'userId']);
            console.log('Service Worker: User logout successful');

        } catch (error) {
            console.error('Service Worker: Handle user logout failed:', error);
            throw error;
        }
    }
}

// === Tab manager ===
class TabManager {
    static isValidTab(tab) {
        return tab.url && 
               !tab.url.startsWith('chrome://') && 
               !tab.url.startsWith('chrome-extension://') && 
               !tab.url.startsWith('edge://') && 
               !tab.url.startsWith('about:');
    }

    static async handleTabUpdate(tabId, changeInfo, tab) {
        if (changeInfo.status === 'complete' && this.isValidTab(tab)) {
            console.log('Service Worker: Tab loaded:', tab.url);
            
            try {
                const settings = await SettingsManager.getSettings();
                chrome.tabs.sendMessage(tabId, {
                    type: 'SETTINGS_UPDATED',
                    settings: settings
                }).catch(() => {
                    // Ignore send failure
                });
            } catch (error) {
                // Ignore error
            }
        }
    }
}

// === Event listener settings ===
chrome.runtime.onInstalled.addListener((details) => {
    console.log('=== Service Worker: Extension installed ===', details.reason);
    LifecycleManager.initialize();
});

chrome.runtime.onStartup.addListener(() => {
    console.log('=== Service Worker: Browser startup ===');
    DatabaseManager.initializeIndexedDB();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('=== Service Worker: Received message ===', request.type);
    
    const immediateResponse = {
        received: true,
        timestamp: Date.now(),
        messageType: request.type
    };
    
    sendResponse(immediateResponse);
    MessageRouter.handleMessage(request, sender);
    
    return false;
});

chrome.tabs.onUpdated.addListener(TabManager.handleTabUpdate.bind(TabManager));

console.log('=== Service Worker: Script loaded ===');