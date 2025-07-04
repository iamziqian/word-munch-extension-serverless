// === Configuration constants ===
let CONFIG = {
    WORD_API_ENDPOINT: '', // Will be loaded from config.js
    CONCEPT_API_ENDPOINT: '',
    COGNITIVE_API_ENDPOINT: '',
    USER_API_ENDPOINT: '', // Will be loaded from config.js
    SEMANTIC_SEARCH_API_ENDPOINT: '', // Will be loaded from config.js
    MEMORY_CACHE_TIME: 3000,
    INDEXEDDB_CACHE_TIME: 24 * 60 * 60 * 1000,
    DB_NAME: 'WordMunchCache',
    DB_VERSION: 1,
    STORE_NAME: 'simplifiedResults'
};

async function loadAPIConfig() { 
    try {
        // Load config from config.js file
        const response = await fetch(chrome.runtime.getURL('config/config.js'));
        const configText = await response.text();
        
        // Extract API endpoints using regex - support both single and double quotes
        const wordMatch = configText.match(/WORD_API_ENDPOINT:\s*['"](.*?)['"]/);
        const conceptMatch = configText.match(/CONCEPT_API_ENDPOINT:\s*['"](.*?)['"]/);
        const cognitiveMatch = configText.match(/COGNITIVE_API_ENDPOINT:\s*['"](.*?)['"]/);
        const userMatch = configText.match(/USER_API_ENDPOINT:\s*['"](.*?)['"]/);
        const semanticSearchMatch = configText.match(/SEMANTIC_SEARCH_API_ENDPOINT:\s*['"](.*?)['"]/);
        
        if (wordMatch) CONFIG.WORD_API_ENDPOINT = wordMatch[1];
        if (conceptMatch) CONFIG.CONCEPT_API_ENDPOINT = conceptMatch[1];
        if (cognitiveMatch) CONFIG.COGNITIVE_API_ENDPOINT = cognitiveMatch[1];
        if (userMatch) CONFIG.USER_API_ENDPOINT = userMatch[1];
        if (semanticSearchMatch) CONFIG.SEMANTIC_SEARCH_API_ENDPOINT = semanticSearchMatch[1];
        
        // Save to storage for content script use
        await chrome.storage.sync.set({
            apiConfig: {
                WORD_API_ENDPOINT: CONFIG.WORD_API_ENDPOINT,
                CONCEPT_API_ENDPOINT: CONFIG.CONCEPT_API_ENDPOINT,
                COGNITIVE_API_ENDPOINT: CONFIG.COGNITIVE_API_ENDPOINT,
                USER_API_ENDPOINT: CONFIG.USER_API_ENDPOINT,
                SEMANTIC_SEARCH_API_ENDPOINT: CONFIG.SEMANTIC_SEARCH_API_ENDPOINT
            }
        });
        console.log('Service Worker: API config saved to storage');
        
    } catch (error) {
        console.error('Service Worker: Failed to load config from config.js:', error);
        
        // Fallback: try to load from storage
        try {
            const result = await chrome.storage.sync.get(['apiConfig']);
            if (result.apiConfig) {
                CONFIG.WORD_API_ENDPOINT = result.apiConfig.WORD_API_ENDPOINT || '';
                CONFIG.CONCEPT_API_ENDPOINT = result.apiConfig.CONCEPT_API_ENDPOINT || '';
                CONFIG.COGNITIVE_API_ENDPOINT = result.apiConfig.COGNITIVE_API_ENDPOINT || '';
                CONFIG.USER_API_ENDPOINT = result.apiConfig.USER_API_ENDPOINT || '';
                CONFIG.SEMANTIC_SEARCH_API_ENDPOINT = result.apiConfig.SEMANTIC_SEARCH_API_ENDPOINT || '';
                console.log('Service Worker: Fallback - loaded from storage');
            }
        } catch (storageError) {
            console.error('Service Worker: Failed to load from storage:', storageError);
        }
    }
}

// Initialize API config on startup
loadAPIConfig();

// Listen for config reload messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'RELOAD_API_CONFIG') {
        loadAPIConfig();
        console.log('Service Worker: API config reloaded');
    }
});

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
        
        // Check if cognitive API endpoint is properly configured
        if (!this.cognitiveAPI || 
            this.cognitiveAPI === '' || 
            this.cognitiveAPI.includes('YOUR_COGNITIVE_API_ENDPOINT_HERE') ||
            this.cognitiveAPI === 'YOUR_COGNITIVE_API_ENDPOINT_HERE') {
            
            console.warn('Service Worker: Cognitive API endpoint not configured. Using demo data for cognitive analysis.');
            console.log('Service Worker: To use real cognitive analysis, please configure COGNITIVE_API_ENDPOINT in config.js');
        } else {
            console.log('Service Worker: Cognitive API endpoint configured:', this.cognitiveAPI);
        }
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

            // === New: Retry mechanism ===
            const maxRetries = 3;
            let retryCount = 0;
            
            const sendMessageWithRetry = async () => {
                try {
                    await chrome.tabs.sendMessage(tabId, {
                        type: 'SHOW_COGNITIVE_DASHBOARD',
                        userId: userInfo.userId || userInfo.email,
                        isAnonymous: userInfo.isAnonymous || false
                    });
                    console.log('Background: Dashboard message sent successfully');
                    return true;
                } catch (error) {
                    console.warn(`Background: Message send attempt ${retryCount + 1} failed:`, error.message);
                    
                    if (retryCount < maxRetries && error.message.includes('Could not establish connection')) {
                        retryCount++;
                        console.log(`Background: Retrying in ${retryCount * 500}ms...`);
                        
                        // Wait for a while and retry
                        await new Promise(resolve => setTimeout(resolve, retryCount * 500));
                        return sendMessageWithRetry();
                    }
                    
                    throw error;
                }
            };

            await sendMessageWithRetry();
    
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
                console.log('Service Worker: Using cached cognitive profile');
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

        // Check if cognitive API endpoint is properly configured
        if (!this.cognitiveAPI || 
            this.cognitiveAPI === '' || 
            this.cognitiveAPI.includes('YOUR_COGNITIVE_API_ENDPOINT_HERE') ||
            this.cognitiveAPI === 'YOUR_COGNITIVE_API_ENDPOINT_HERE') {
            
            console.log('Service Worker: Cognitive API endpoint not configured, using demo data');
            const demoData = this.generateDemoData();
            
            this.profileCache.set(cacheKey, {
                data: demoData,
                timestamp: Date.now()
            });
            
            return demoData;
        }
    
        try {
            const authToken = await UserManager.getAuthToken();
            
            const requestBody = {
                action: 'get_profile',
                user_id: userId,
                days: days
            };
            
            const response = await fetch(this.cognitiveAPI, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': authToken ? `Bearer ${authToken}` : ''
                },
                body: JSON.stringify(requestBody)
            });
    
            console.log('Service Worker: Cognitive API response status:', response.status);
            console.log('Service Worker: Cognitive API response content-type:', response.headers.get('content-type'));
    
            if (!response.ok) {
                throw new Error(`API request failed: ${response.status} - ${response.statusText}`);
            }

            // Check if response is JSON
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                console.warn('Service Worker: Response is not JSON, content-type:', contentType);
                throw new Error('API response is not JSON format');
            }
    
            const responseText = await response.text();
            console.log('Service Worker: Cognitive API raw response (first 200 chars):', responseText.substring(0, 200));
            
            let profileData;
            try {
                profileData = JSON.parse(responseText);
                console.log('Service Worker: Cognitive profile parsed successfully');
            } catch (parseError) {
                console.error('Service Worker: Failed to parse cognitive profile JSON:', parseError);
                console.error('Service Worker: Response text that failed to parse:', responseText);
                throw new Error('Invalid JSON response from cognitive API');
            }
            
            // Cache result
            this.profileCache.set(cacheKey, {
                data: profileData,
                timestamp: Date.now()
            });
    
            return profileData;
    
        } catch (error) {
            console.error('Service Worker: Failed to fetch cognitive profile, using demo data:', error.message);
            console.error('Service Worker: Cognitive API endpoint was:', this.cognitiveAPI);
            
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
        // Check if cognitive API endpoint is properly configured
        if (!this.cognitiveAPI || 
            this.cognitiveAPI === '' || 
            this.cognitiveAPI.includes('YOUR_COGNITIVE_API_ENDPOINT_HERE') ||
            this.cognitiveAPI === 'YOUR_COGNITIVE_API_ENDPOINT_HERE') {
            
            console.log('Service Worker: Cognitive API endpoint not configured, skipping analysis recording');
            return;
        }

        try {
            console.log('Service Worker: Recording cognitive analysis for user:', userId);
            const authToken = await UserManager.getAuthToken();
            
            const requestBody = {
                action: 'record_analysis',
                user_id: userId,
                analysis_data: analysisData
            };
            
            const response = await fetch(this.cognitiveAPI, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': authToken ? `Bearer ${authToken}` : ''
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                console.warn('Service Worker: Failed to record cognitive analysis:', response.status, response.statusText);
                return;
            }

            // Clear related cache
            for (const key of this.profileCache.keys()) {
                if (key.startsWith(`cognitive_profile_${userId}_`)) {
                    this.profileCache.delete(key);
                }
            }

            console.log('Service Worker: Cognitive analysis recorded successfully');

        } catch (error) {
            console.error('Service Worker: Failed to record cognitive analysis:', error.message);
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

// === Semantic Search Manager ===
class SemanticSearchManager {
    constructor() {
        this.searchCache = new Map();
        this.semanticSearchAPI = CONFIG.SEMANTIC_SEARCH_API_ENDPOINT;
    }

    async searchSemanticChunks(chunks, query, options = {}) {
        console.log('Service Worker: Starting semantic search for query:', query);
        
        // Refresh API endpoint from CONFIG in case it was loaded after initialization
        this.semanticSearchAPI = CONFIG.SEMANTIC_SEARCH_API_ENDPOINT;
        
        // Check if semantic search API is configured
        if (!this.semanticSearchAPI || 
            this.semanticSearchAPI === '' || 
            this.semanticSearchAPI.includes('YOUR_SEMANTIC_SEARCH_API_ENDPOINT_HERE')) {
            
            console.log('Service Worker: Semantic search API not configured, using simple text matching');
            return this.fallbackTextSearch(chunks, query, options);
        }

        try {
            const cacheKey = this.generateCacheKey(chunks, query, options);
            
            // Check cache (5 minute cache for search results)
            if (this.searchCache.has(cacheKey)) {
                const cached = this.searchCache.get(cacheKey);
                if (Date.now() - cached.timestamp < 300000) { // 5 minutes
                    console.log('Service Worker: Using cached semantic search results');
                    return cached.data;
                }
            }

            const authToken = await UserManager.getAuthToken();
            
            const requestBody = {
                action: 'search_chunks',
                chunks: chunks,
                query: query,
                top_k: options.top_k || 5,
                similarity_threshold: options.similarity_threshold || 0.7
            };
            
            console.log('Service Worker: Calling semantic search API with', chunks.length, 'chunks');
            console.log('Service Worker: Request body:', JSON.stringify(requestBody, null, 2));
            
            const response = await fetch(this.semanticSearchAPI, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': authToken ? `Bearer ${authToken}` : ''
                },
                body: JSON.stringify(requestBody)
            });
            
            console.log('Service Worker: API response status:', response.status, response.statusText);

            if (!response.ok) {
                throw new Error(`Semantic search API failed: ${response.status} - ${response.statusText}`);
            }

            const result = await response.json();
            console.log('Service Worker: Semantic search completed, found', result.relevant_chunks?.length || 0, 'relevant chunks');

            // Cache the result
            this.searchCache.set(cacheKey, {
                data: result,
                timestamp: Date.now()
            });

            // Cleanup cache if it gets too big
            if (this.searchCache.size > 50) {
                const oldestKey = this.searchCache.keys().next().value;
                this.searchCache.delete(oldestKey);
            }

            return result;

        } catch (error) {
            console.error('Service Worker: Semantic search failed, using fallback:', error.message);
            return this.fallbackTextSearch(chunks, query, options);
        }
    }

    fallbackTextSearch(chunks, query, options = {}) {
        console.log('🔄 Service Worker: Using fallback text search instead of semantic API');
        console.log('🔄 Service Worker: Fallback search for query:', query, 'in', chunks.length, 'chunks');
        
        const queryWords = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
        const results = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkLower = chunk.toLowerCase();
            let score = 0;

            // Simple keyword matching
            for (const word of queryWords) {
                const occurrences = (chunkLower.match(new RegExp(word, 'g')) || []).length;
                score += occurrences * (word.length / 10); // Weight by word length
            }

            if (score > 0) {
                results.push({
                    index: i,
                    chunk: chunk,
                    similarity: Math.min(score / 10, 1), // Normalize to 0-1
                    length: chunk.length
                });
            }
        }

        // Sort by similarity and apply threshold
        results.sort((a, b) => b.similarity - a.similarity);
        const threshold = options.similarity_threshold || 0.3; // Lower threshold for text search
        const relevant_chunks = results
            .filter(result => result.similarity >= threshold)
            .slice(0, options.top_k || 5);

        console.log('🔄 Service Worker: Fallback search completed, found', relevant_chunks.length, 'relevant chunks');
        
        return {
            query: query,
            total_chunks: chunks.length,
            relevant_chunks: relevant_chunks,
            top_similarity: relevant_chunks[0]?.similarity || 0,
            processing_stats: {
                chunks_processed: chunks.length,
                embeddings_generated: 0, // No embeddings in fallback
                relevant_found: relevant_chunks.length,
                api_method: 'Fallback Text Search',
                note: 'Semantic API not available - using keyword matching'
            },
            fallback_used: true
        };
    }

    generateCacheKey(chunks, query, options) {
        // Create a simple hash for caching
        const content = JSON.stringify({ 
            chunksHash: this.simpleHash(chunks.join('')), 
            query, 
            options 
        });
        return this.simpleHash(content);
    }

    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString(36);
    }
}

const semanticSearchManager = new SemanticSearchManager();

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
            
            console.log('Service Worker: Context menus cleared - cognitive dashboard moved to popup');

        } catch (error) {
            console.error('Service Worker: Failed to initialize context menus:', error);
        }
    }

    static setupContextMenuListener() {
        // Context menu listener no longer needed - cognitive dashboard moved to popup
        console.log('Service Worker: Context menu listener disabled - using popup instead');
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
                case 'GET_CONFIG':
                    console.log('📤 Service Worker: Sending config to content script');
                    
                    const configResponse = {
                        CONCEPT_API_ENDPOINT: CONFIG.CONCEPT_API_ENDPOINT,
                        WORD_API_ENDPOINT: CONFIG.WORD_API_ENDPOINT,
                        COGNITIVE_API_ENDPOINT: CONFIG.COGNITIVE_API_ENDPOINT,
                        USER_API_ENDPOINT: CONFIG.USER_API_ENDPOINT,
                        SEMANTIC_SEARCH_API_ENDPOINT: CONFIG.SEMANTIC_SEARCH_API_ENDPOINT,
                        success: true
                    };
                    
                    console.log('📋 Service Worker: Config response:', configResponse);
                    
                    if (sendResponse) {
                        sendResponse(configResponse);
                    }
                    
                    // Also send to content script
                    if (sender.tab?.id) {
                        try {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'CONFIG_LOADED',
                                config: configResponse
                            });
                            console.log('📤 Service Worker: Config also sent via message');
                        } catch (error) {
                            console.log('Service Worker: Could not send config message:', error.message);
                        }
                    }
                    break;

                case 'WORD_SELECTED':
                    await WordProcessor.handleWordSelection(request, sender);
                    break;

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

                case 'USER_REGISTER':
                    try {
                        const result = await UserManager.registerUser(request.userData);
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'USER_REGISTRATION_SUCCESS',
                                data: result,
                                requestId: request.requestId
                            });
                        }
                    } catch (error) {
                        console.error('Service Worker: User registration failed:', error);
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'USER_REGISTRATION_ERROR',
                                error: error.message,
                                requestId: request.requestId
                            });
                        }
                    }
                    break;

                case 'USER_AUTHENTICATE':
                    try {
                        const result = await UserManager.authenticateUser(request.credentials);
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'USER_AUTHENTICATION_SUCCESS',
                                data: result,
                                requestId: request.requestId
                            });
                        }
                    } catch (error) {
                        console.error('Service Worker: User authentication failed:', error);
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'USER_AUTHENTICATION_ERROR',
                                error: error.message,
                                requestId: request.requestId
                            });
                        }
                    }
                    break;

                case 'USER_PASSWORD_RESET':
                    try {
                        const result = await UserManager.resetPassword(request.email);
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'USER_PASSWORD_RESET_SUCCESS',
                                data: result,
                                requestId: request.requestId
                            });
                        }
                    } catch (error) {
                        console.error('Service Worker: Password reset failed:', error);
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'USER_PASSWORD_RESET_ERROR',
                                error: error.message,
                                requestId: request.requestId
                            });
                        }
                    }
                    break;

                case 'USER_PROFILE_UPDATE':
                    try {
                        const result = await UserManager.updateUserProfile(request.profileData);
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'USER_PROFILE_UPDATE_SUCCESS',
                                data: result,
                                requestId: request.requestId
                            });
                        }
                    } catch (error) {
                        console.error('Service Worker: Profile update failed:', error);
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'USER_PROFILE_UPDATE_ERROR',
                                error: error.message,
                                requestId: request.requestId
                            });
                        }
                    }
                    break;

                case 'GET_USER_PROFILE':
                    try {
                        const result = await UserManager.getUserProfile();
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'USER_PROFILE_DATA',
                                data: result,
                                requestId: request.requestId
                            });
                        }
                    } catch (error) {
                        console.error('Service Worker: Get user profile failed:', error);
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'USER_PROFILE_ERROR',
                                error: error.message,
                                requestId: request.requestId
                            });
                        }
                    }
                    break;

                case 'USER_TOKEN_VERIFY':
                    try {
                        const isValid = await UserManager.verifyToken();
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'USER_TOKEN_VERIFY_RESULT',
                                data: { isValid },
                                requestId: request.requestId
                            });
                        }
                    } catch (error) {
                        console.error('Service Worker: Token verification failed:', error);
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'USER_TOKEN_VERIFY_ERROR',
                                error: error.message,
                                requestId: request.requestId
                            });
                        }
                    }
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
                
                case 'SEMANTIC_SEARCH':
                    try {
                        const { chunks, query, options } = request;
                        console.log('Service Worker: Processing semantic search request');
                        
                        const searchResult = await semanticSearchManager.searchSemanticChunks(
                            chunks, 
                            query, 
                            options || {}
                        );
                        
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'SEMANTIC_SEARCH_RESULT',
                                data: searchResult,
                                requestId: request.requestId
                            });
                        }
                    } catch (error) {
                        console.error('Service Worker: Semantic search failed:', error);
                        if (sender.tab?.id) {
                            await chrome.tabs.sendMessage(sender.tab.id, {
                                type: 'SEMANTIC_SEARCH_ERROR',
                                error: error.message,
                                requestId: request.requestId
                            });
                        }
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
        // 检查端点
        if (!CONFIG.WORD_API_ENDPOINT) {
            console.log('Word API endpoint is empty!');
            throw new Error('Word API endpoint not configured');
        }
        
        if (CONFIG.WORD_API_ENDPOINT === 'https://your-api-domain.com/word-muncher') {
            console.log('Word API endpoint is still default placeholder!');
            throw new Error('Word API endpoint is placeholder');
        }
        
        const requestBody = {
            word: word,
            context: context,
            language: language
        };
        
        console.log('Request body:', JSON.stringify(requestBody, null, 2));
        
        const headers = {
            'Content-Type': 'application/json'
        };

        const authToken = await UserManager.getAuthToken();
        if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
            console.log('Auth token added (length:', authToken.length, ')');
        } else {
            console.log('No auth token');
        }
        
        console.log('Request headers:', headers);
        
        try {
            console.log('Making fetch request to:', CONFIG.WORD_API_ENDPOINT);
            const response = await fetch(CONFIG.WORD_API_ENDPOINT, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestBody)
            });
            
            console.log('Response status:', response.status);
            console.log('Response ok:', response.ok);
            console.log('Response headers:', Object.fromEntries(response.headers.entries()));
            
            if (!response.ok) {
                const errorText = await response.text();
                console.log('Error response text:', errorText);
                throw new Error(`API request failed ${response.status}: ${errorText}`);
            }
            
            const responseText = await response.text();
            console.log('Raw response (first 200 chars):', responseText.substring(0, 200));
            console.log('Response length:', responseText.length);
            
            try {
                const result = JSON.parse(responseText);
                console.log('JSON parsed successfully');
                console.log('Result structure:', Object.keys(result));
                console.log('Synonyms count:', result.synonyms?.length || 0);
                return result;
            } catch (parseError) {
                console.log('JSON parse error:', parseError.message);
                console.log('Problematic text:', responseText);
                throw parseError;
            }
            
        } catch (fetchError) {
            console.log('Fetch error:', fetchError.message);
            console.log('Error type:', fetchError.constructor.name);
            throw fetchError;
        }
    }

    static async callConceptAPI(original_text, user_understanding, context, auto_extract_context) {
        console.log('Service Worker: Concept API call started');
        console.log('Original text length:', original_text?.length || 0);
        console.log('Understanding length:', user_understanding?.length || 0);
        
        // Check endpoint
        if (!CONFIG.CONCEPT_API_ENDPOINT) {
            console.log('Concept API endpoint is empty!');
            throw new Error('Concept API endpoint not configured');
        }
        
        if (CONFIG.CONCEPT_API_ENDPOINT === 'https://your-api-domain.com/concept-muncher') {
            console.log('Concept API endpoint is still default placeholder!');
            throw new Error('Concept API endpoint is placeholder');
        }
        
        const requestBody = {
            original_text: original_text,
            user_understanding: user_understanding,
            context: context,
            auto_extract_context: auto_extract_context || false
        };
        
        console.log('Concept request body keys:', Object.keys(requestBody));
        
        const headers = {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache'
        };

        const authToken = await UserManager.getAuthToken();
        if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
            console.log('Concept auth token added');
        }
        
        try {
            console.log('Making concept fetch request...');
            const response = await fetch(CONFIG.CONCEPT_API_ENDPOINT, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestBody),
                cache: 'no-cache'
            });
            
            console.log('Concept response status:', response.status);
            console.log('Concept response ok:', response.ok);
            
            if (!response.ok) {
                const errorText = await response.text();
                console.log('❌ Concept error response:', errorText);
                throw new Error(`Concept analysis API request failed ${response.status}: ${errorText}`);
            }
            
            const responseText = await response.text();
            console.log('Concept raw response (first 200 chars):', responseText.substring(0, 200));
            
            try {
                const result = JSON.parse(responseText);
                console.log('Concept JSON parsed successfully');
                console.log('Concept result keys:', Object.keys(result));
                console.log('Similarity score:', result.overall_similarity);
                return result;
            } catch (parseError) {
                console.log('Concept JSON parse error:', parseError.message);
                console.log('Concept problematic text:', responseText);
                throw parseError;
            }
            
        } catch (fetchError) {
            console.log('Concept fetch error:', fetchError.message);
            throw fetchError;
        }
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

    // === New User API Methods ===

    /**
     * Register a new user
     * @param {Object} userData - User registration data
     * @param {string} userData.email - User email
     * @param {string} userData.password - User password
     * @param {string} userData.name - User display name
     * @returns {Promise<Object>} Registration result
     */
    static async registerUser(userData) {
        console.log('Service Worker: Registering user:', userData.email);
        
        if (!CONFIG.USER_API_ENDPOINT) {
            throw new Error('User API endpoint not configured');
        }

        try {
            const response = await fetch(`${CONFIG.USER_API_ENDPOINT}/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    email: userData.email,
                    password: userData.password,
                    name: userData.name || userData.email.split('@')[0],
                    timestamp: Date.now()
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'Registration failed' }));
                throw new Error(errorData.message || `Registration failed: ${response.status}`);
            }

            const result = await response.json();
            console.log('Service Worker: User registration successful:', result);

            // Auto-login after successful registration
            if (result.token) {
                await this.handleUserLogin({
                    email: userData.email,
                    token: result.token,
                    userId: result.userId || userData.email
                });
            }

            return result;

        } catch (error) {
            console.error('Service Worker: User registration failed:', error);
            throw error;
        }
    }

    /**
     * Authenticate user login
     * @param {Object} credentials - Login credentials
     * @param {string} credentials.email - User email
     * @param {string} credentials.password - User password
     * @returns {Promise<Object>} Authentication result
     */
    static async authenticateUser(credentials) {
        console.log('Service Worker: Authenticating user:', credentials.email);
        
        if (!CONFIG.USER_API_ENDPOINT) {
            throw new Error('User API endpoint not configured');
        }

        try {
            const response = await fetch(`${CONFIG.USER_API_ENDPOINT}/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    email: credentials.email,
                    password: credentials.password,
                    timestamp: Date.now()
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'Authentication failed' }));
                throw new Error(errorData.message || `Authentication failed: ${response.status}`);
            }

            const result = await response.json();
            console.log('Service Worker: User authentication successful');

            // Store login info
            if (result.token) {
                await this.handleUserLogin({
                    email: credentials.email,
                    token: result.token,
                    userId: result.userId || credentials.email
                });
            }

            return result;

        } catch (error) {
            console.error('Service Worker: User authentication failed:', error);
            throw error;
        }
    }

    /**
     * Reset user password
     * @param {string} email - User email
     * @returns {Promise<Object>} Reset result
     */
    static async resetPassword(email) {
        console.log('Service Worker: Resetting password for:', email);
        
        if (!CONFIG.USER_API_ENDPOINT) {
            throw new Error('User API endpoint not configured');
        }

        try {
            const response = await fetch(`${CONFIG.USER_API_ENDPOINT}/reset-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    email: email,
                    timestamp: Date.now()
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'Password reset failed' }));
                throw new Error(errorData.message || `Password reset failed: ${response.status}`);
            }

            const result = await response.json();
            console.log('Service Worker: Password reset successful');

            return result;

        } catch (error) {
            console.error('Service Worker: Password reset failed:', error);
            throw error;
        }
    }

    /**
     * Update user profile
     * @param {Object} profileData - Profile update data
     * @returns {Promise<Object>} Update result
     */
    static async updateUserProfile(profileData) {
        console.log('Service Worker: Updating user profile');
        
        if (!CONFIG.USER_API_ENDPOINT) {
            throw new Error('User API endpoint not configured');
        }

        const authToken = await this.getAuthToken();
        if (!authToken) {
            throw new Error('User not logged in');
        }

        try {
            const response = await fetch(`${CONFIG.USER_API_ENDPOINT}/profile`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify({
                    ...profileData,
                    timestamp: Date.now()
                })
            });

            if (!response.ok) {
                if (response.status === 401) {
                    // Token expired, logout user
                    await this.handleUserLogout();
                    throw new Error('Session expired, please login again');
                }
                
                const errorData = await response.json().catch(() => ({ message: 'Profile update failed' }));
                throw new Error(errorData.message || `Profile update failed: ${response.status}`);
            }

            const result = await response.json();
            console.log('Service Worker: Profile update successful');

            return result;

        } catch (error) {
            console.error('Service Worker: Profile update failed:', error);
            throw error;
        }
    }

    /**
     * Get user profile
     * @returns {Promise<Object>} User profile data
     */
    static async getUserProfile() {
        console.log('Service Worker: Getting user profile');
        
        if (!CONFIG.USER_API_ENDPOINT) {
            throw new Error('User API endpoint not configured');
        }

        const authToken = await this.getAuthToken();
        if (!authToken) {
            throw new Error('User not logged in');
        }

        try {
            const response = await fetch(`${CONFIG.USER_API_ENDPOINT}/profile`, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                }
            });

            if (!response.ok) {
                if (response.status === 401) {
                    // Token expired, logout user
                    await this.handleUserLogout();
                    throw new Error('Session expired, please login again');
                }
                
                const errorData = await response.json().catch(() => ({ message: 'Failed to get profile' }));
                throw new Error(errorData.message || `Failed to get profile: ${response.status}`);
            }

            const result = await response.json();
            console.log('Service Worker: Get profile successful');

            return result;

        } catch (error) {
            console.error('Service Worker: Get profile failed:', error);
            throw error;
        }
    }

    /**
     * Verify user token
     * @returns {Promise<boolean>} Token validity
     */
    static async verifyToken() {
        const authToken = await this.getAuthToken();
        if (!authToken || !CONFIG.USER_API_ENDPOINT) {
            return false;
        }

        try {
            const response = await fetch(`${CONFIG.USER_API_ENDPOINT}/verify`, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                }
            });

            if (!response.ok) {
                if (response.status === 401) {
                    await this.handleUserLogout();
                }
                return false;
            }

            return true;

        } catch (error) {
            console.error('Service Worker: Token verification failed:', error);
            return false;
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

chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('Service Worker: Extension installed/updated:', details.reason);
    
    await loadAPIConfig();
    await LifecycleManager.initialize();
    
    console.log('Service Worker: Initialization complete with AWS API endpoints');
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