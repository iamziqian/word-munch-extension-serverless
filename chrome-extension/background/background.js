import API_CONFIG from '../config/config';

console.log('=== Service Worker: Start ===');

// === Configuration constants ===
const CONFIG = {
    WORD_API_ENDPOINT: API_CONFIG.WORD_API_ENDPOINT,
    CONCEPT_API_ENDPOINT: API_CONFIG.CONCEPT_API_ENDPOINT,
    COGNITIVE_API_ENDPOINT: API_CONFIG.COGNITIVE_API_ENDPOINT,
    MEMORY_CACHE_TIME: 3000,
    INDEXEDDB_CACHE_TIME: 24 * 60 * 60 * 1000,
    DB_NAME: 'WordMunchCache',
    DB_VERSION: 1,
    STORE_NAME: 'simplifiedResults'
};

// Load API configuration from localStorage if available
try {
    const storedConfig = localStorage.getItem('wordMunchAPIConfig');
    if (storedConfig) {
        const apiConfig = JSON.parse(storedConfig);
        CONFIG.WORD_API_ENDPOINT = apiConfig.WORD_API_ENDPOINT || CONFIG.WORD_API_ENDPOINT;
        CONFIG.CONCEPT_API_ENDPOINT = apiConfig.CONCEPT_API_ENDPOINT || CONFIG.CONCEPT_API_ENDPOINT;
        CONFIG.COGNITIVE_API_ENDPOINT = apiConfig.COGNITIVE_API_ENDPOINT || CONFIG.COGNITIVE_API_ENDPOINT;
    }
} catch (error) {
    console.warn('Failed to load API config from localStorage:', error);
}

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

// === Cognitive Profile Manager ===
class CognitiveProfileManager {
    constructor() {
        this.profileCache = new Map();
        this.cognitiveAPI = CONFIG.COGNITIVE_API_ENDPOINT;
    }

    async handleCognitiveDashboardRequest(tabId) {
        console.log('=== Background: handleCognitiveDashboardRequest called ===', tabId);
        
        try {
            let userInfo = await UserManager.getUserInfo();
            console.log('Background: getUserInfo result:', userInfo);
            
            // If no user info, use anonymous user
            if (!userInfo) {
                console.log('Background: No user login, using anonymous user');
                userInfo = {
                    userId: 'anonymous_user',
                    email: 'anonymous@wordmunch.local',
                    isAnonymous: true
                };
            }
    
            console.log('Background: Sending dashboard message to tab:', tabId, 'for user:', userInfo.userId);
            
            // Send message to content script to show dashboard
            await chrome.tabs.sendMessage(tabId, {
                type: 'SHOW_COGNITIVE_DASHBOARD',
                userId: userInfo.userId || userInfo.email,
                isAnonymous: userInfo.isAnonymous || false
            });
            
            console.log('Background: Dashboard message sent successfully');
    
        } catch (error) {
            console.error('Background: Failed to show cognitive dashboard:', error);
            
            // As fallback, use anonymous user
            try {
                console.log('Background: Error fallback - using anonymous user');
                await chrome.tabs.sendMessage(tabId, {
                    type: 'SHOW_COGNITIVE_DASHBOARD',
                    userId: 'anonymous_user',
                    isAnonymous: true
                });
                console.log('Background: Anonymous dashboard message sent successfully');
            } catch (fallbackError) {
                console.error('Background: Fallback also failed:', fallbackError);
                await NotificationManager.showError('Unable to display cognitive analysis: ' + fallbackError.message);
            }
        }
    }

    async fetchCognitiveProfile(userId, days = 30) {
        const cacheKey = `cognitive_profile_${userId}_${days}`;
        
        // Check cache (5 minute cache)
        if (this.profileCache.has(cacheKey)) {
            const cached = this.profileCache.get(cacheKey);
            if (Date.now() - cached.timestamp < 300000) {
                return cached.data;
            }
        }
    
        // If anonymous user, return demo data
        if (userId === 'anonymous_user' || userId.includes('anonymous')) {
            console.log('Service Worker: Using demo data for anonymous user');
            const demoData = this.generateDemoData();
            
            // Cache demo data
            this.profileCache.set(cacheKey, {
                data: demoData,
                timestamp: Date.now()
            });
            
            return demoData;
        }
    
        try {
            const authToken = await UserManager.getAuthToken();
            
            const response = await fetch(this.cognitiveAPI, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': authToken ? `Bearer ${authToken}` : ''
                },
                body: JSON.stringify({
                    action: 'get_profile',
                    user_id: userId,
                    days: days
                })
            });
    
            if (!response.ok) {
                throw new Error(`API request failed: ${response.status}`);
            }
    
            const profileData = await response.json();
            
            // Cache result
            this.profileCache.set(cacheKey, {
                data: profileData,
                timestamp: Date.now()
            });
    
            return profileData;
    
        } catch (error) {
            console.error('Service Worker: Failed to fetch cognitive profile, using demo data:', error);
            
            // If failed, return demo data
            const demoData = this.generateDemoData();
            this.profileCache.set(cacheKey, {
                data: demoData,
                timestamp: Date.now()
            });
            
            return demoData;
        }
    }

    async recordConceptAnalysis(userId, analysisData) {
        try {
            const authToken = await UserManager.getAuthToken();
            
            await fetch(this.cognitiveAPI, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': authToken ? `Bearer ${authToken}` : ''
                },
                body: JSON.stringify({
                    action: 'record_analysis',
                    user_id: userId,
                    analysis_data: analysisData
                })
            });

            // Clear related cache
            for (const key of this.profileCache.keys()) {
                if (key.startsWith(`cognitive_profile_${userId}_`)) {
                    this.profileCache.delete(key);
                }
            }

            console.log('Service Worker: Cognitive analysis recorded successfully');

        } catch (error) {
            console.error('Service Worker: Failed to record cognitive analysis:', error);
        }
    }

    generateDemoData() {
        return {
            total_analyses: 23,
            days_covered: 15,
            cognitive_radar: {
                comprehension: 78,
                coverage: 65,
                depth: 82,
                accuracy: 71,
                analysis: 69,
                synthesis: 75
            },
            strengths: [
                'Strong analytical depth',
                'Clear logical analysis', 
                'High comprehension accuracy'
            ],
            weaknesses: [
                'Information coverage needs improvement',
                'Synthesis ability could be enhanced'
            ],
            bloom_distribution: {
                'understand': 8,
                'analyze': 7,
                'apply': 5,
                'evaluate': 3
            },
            personalized_suggestions: [
                {
                    icon: '🎯',
                    title: 'Improve Coverage Completeness',
                    description: 'You have room for improvement in understanding the full scope of articles',
                    action: 'Try previewing the entire text first to build an overall framework before diving into details'
                },
                {
                    icon: '🔍',
                    title: 'Strengthen Synthesis Analysis',
                    description: 'You can do more to compare and analyze different viewpoints',
                    action: 'When reading, think more about how the author\'s viewpoint differs from other positions'
                },
                {
                    icon: '📋',
                    title: 'Maintain Deep Thinking Advantage',
                    description: 'Your deep analysis ability is a major strength',
                    action: 'Continue leveraging this advantage, and try more complex texts'
                }
            ],
            error_patterns: {
                'main_idea': { 
                    label: 'Main Idea Understanding', 
                    count: 3, 
                    percentage: 35,
                    suggestion: 'Focus more on the article\'s core arguments and thesis statements' 
                },
                'details': { 
                    label: 'Detail Comprehension', 
                    count: 5, 
                    percentage: 55,
                    suggestion: 'Pay attention to supporting evidence and specific examples' 
                },
                'logic': { 
                    label: 'Logical Relationships', 
                    count: 2, 
                    percentage: 25,
                    suggestion: 'Strengthen identification of causal, transitional, and other logical relationships' 
                }
            },
            isDemo: true,
            userId: 'anonymous_user'
        };
    }
}

const cognitiveManager = new CognitiveProfileManager()

// Global function for context menu
async function handleCognitiveDashboardRequest(tabId) {
    await cognitiveManager.handleCognitiveDashboardRequest(tabId);
}

// === Context Menu Manager ===
class ContextMenuManager {
    static async initializeContextMenus() {
        try {
            // Check if contextMenus API is available
            if (!chrome.contextMenus) {
                console.log('Service Worker: Context menus API not available');
                return;
            }

            // Clear existing menus first
            await chrome.contextMenus.removeAll();
            
            // Create cognitive dashboard menu
            chrome.contextMenus.create({
                id: 'show-cognitive-dashboard',
                title: 'View My Cognitive Growth',
                contexts: ['page', 'selection']
            }, () => {
                if (chrome.runtime.lastError) {
                    console.error('Service Worker: Failed to create context menu:', chrome.runtime.lastError.message);
                } else {
                    console.log('Service Worker: Context menu created successfully');
                }
            });

        } catch (error) {
            console.error('Service Worker: Failed to initialize context menus:', error);
        }
    }

    static setupContextMenuListener() {
        try {
            if (!chrome.contextMenus || !chrome.contextMenus.onClicked) {
                console.log('Service Worker: Context menu click listener not available');
                return;
            }

            chrome.contextMenus.onClicked.addListener((info, tab) => {
                try {
                    if (info.menuItemId === 'show-cognitive-dashboard' && tab && tab.id) {
                        handleCognitiveDashboardRequest(tab.id);
                    }
                } catch (error) {
                    console.error('Service Worker: Context menu click handler error:', error);
                }
            });

            console.log('Service Worker: Context menu click listener added');

        } catch (error) {
            console.error('Service Worker: Failed to setup context menu listener:', error);
        }
    }
}

// === Service Worker lifecycle management ===
class LifecycleManager {
    static async initialize() {
        console.log('Service Worker: Initialize extension');
        
        try {
            await DatabaseManager.initializeIndexedDB();
            await this.setDefaultSettings();
            
            // Initialize context menus with error handling
            await ContextMenuManager.initializeContextMenus();
            ContextMenuManager.setupContextMenuListener();
            
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
                
                case 'GET_COGNITIVE_PROFILE':
                    try {
                        const userInfo = await UserManager.getUserInfo();
                        if (!userInfo) {
                            throw new Error('User not logged in');
                        }
                
                        const profileData = await cognitiveManager.fetchCognitiveProfile(
                            userInfo.userId || userInfo.email, 
                            request.days || 30
                        );
                
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'COGNITIVE_PROFILE_DATA',
                                data: profileData,
                                requestId: request.requestId
                            });
                        } 
                    } catch (error) {
                        console.error('Service Worker: Failed to get cognitive profile:', error);
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'COGNITIVE_PROFILE_ERROR',
                                error: error.message,
                                requestId: request.requestId
                            });
                        }
                    }
                    return;
                
                case 'RECORD_COGNITIVE_DATA':
                    try {
                        const userInfo = await UserManager.getUserInfo();
                        if (userInfo && request.userId) {
                            await cognitiveManager.recordConceptAnalysis(
                                request.userId,
                                request.data
                            );
                        }
                    } catch (error) {
                        console.error('Service Worker: Failed to record cognitive data:', error);
                    }
                    return;
                
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
            
            this.recordCognitiveDataAsync(request, sender).catch(error => {
                console.error('Service Worker: Failed to record cognitive data:', error);
            });
            
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

    static async recordCognitiveDataAsync(request, sender) {
        try {
            const userInfo = await UserManager.getUserInfo();
            if (!userInfo) return;
    
            const analysisData = {
                original_text: request.original_text,
                user_understanding: request.user_understanding,
                context: request.context,
                timestamp: Date.now(),
                url: request.url,
                title: request.title
            };
    
            await cognitiveManager.recordConceptAnalysis(
                userInfo.userId || userInfo.email, 
                analysisData
            );
    
        } catch (error) {
            console.error('Service Worker: Cognitive data recording failed:', error);
        }
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
            console.log('Service Worker: Concept stats updated:', counts);
            
            // Check cognitive milestones
            await this.checkCognitiveMilestones();
            
        } catch (error) {
            console.error('Service Worker: Update concept stats failed:', error);
        }
    }

    static async checkCognitiveMilestones() {
        try {
            const userInfo = await UserManager.getUserInfo();
            if (!userInfo) return;
    
            const result = await chrome.storage.sync.get(['conceptCounts', 'cognitiveMilestones']);
            const counts = result.conceptCounts || {};
            const milestones = result.cognitiveMilestones || {};
    
            let newMilestones = false;
    
            // Check various milestones
            if (counts.total >= 1 && !milestones.firstAnalysis) {
                milestones.firstAnalysis = {
                    achieved: true,
                    date: new Date().toISOString(),
                    title: 'Comprehension Novice',
                    description: 'Completed first understanding analysis'
                };
                newMilestones = true;
            }
    
            if (counts.total >= 10 && !milestones.explorer) {
                milestones.explorer = {
                    achieved: true,
                    date: new Date().toISOString(),
                    title: 'Reading Explorer',
                    description: 'Analyzed 10+ articles'
                };
                newMilestones = true;
            }
    
            if (counts.total >= 50 && !milestones.analyst) {
                milestones.analyst = {
                    achieved: true,
                    date: new Date().toISOString(),
                    title: 'Deep Thinker',
                    description: 'Analyzed 50+ articles'
                };
                newMilestones = true;
            }
    
            if (newMilestones) {
                await chrome.storage.sync.set({ cognitiveMilestones: milestones });
                
                // Show achievement notification
                const latestMilestone = Object.values(milestones).pop();
                await NotificationManager.showNotification('🏆 Achievement Unlocked!', {
                    type: 'basic',
                    title: `🏆 ${latestMilestone.title}`,
                    message: latestMilestone.description
                });
            }
    
        } catch (error) {
            console.error('Service Worker: Failed to check cognitive milestones:', error);
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
                    token: result.userToken,
                    isAnonymous: false
                };
            }
            
            // Return anonymous user info instead of null
            console.log('Service Worker: No user login, returning anonymous user info');
            return {
                userId: 'anonymous_user',
                email: 'anonymous@wordmunch.local',
                token: null,
                isAnonymous: true
            };
            
        } catch (error) {
            console.error('Service Worker: Get user info failed, using anonymous:', error);
            return {
                userId: 'anonymous_user',
                email: 'anonymous@wordmunch.local',
                token: null,
                isAnonymous: true
            };
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