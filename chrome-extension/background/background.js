// ========== Chrome Extension Service Worker - 重构版本 ==========

console.log('=== Service Worker: 启动 ===');

// === 配置常量 ===
const CONFIG = {
    WORD_API_ENDPOINT: 'https://4gjsn9p4kc.execute-api.us-east-1.amazonaws.com/dev/word-muncher',
    CONCEPT_API_ENDPOINT: 'https://4gjsn9p4kc.execute-api.us-east-1.amazonaws.com/dev/concept-muncher',
    MEMORY_CACHE_TIME: 3000,
    INDEXEDDB_CACHE_TIME: 24 * 60 * 60 * 1000,
    DB_NAME: 'WordMunchCache',
    DB_VERSION: 1,
    STORE_NAME: 'simplifiedResults'
};

// === 全局状态管理 ===
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

// === Service Worker 生命周期管理 ===
class LifecycleManager {
    static async initialize() {
        console.log('Service Worker: 初始化扩展');
        
        try {
            await DatabaseManager.initializeIndexedDB();
            await this.setDefaultSettings();
            console.log('Service Worker: 初始化完成');
        } catch (error) {
            console.error('Service Worker: 初始化失败:', error);
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

// === 消息路由器 ===
class MessageRouter {
    static async handleMessage(request, sender) {
        console.log('Service Worker: 开始异步处理:', request.type);
        
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
                    console.log('Service Worker: Content script 就绪:', request.url);
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
                    console.log('Service Worker: 未知消息类型:', request.type);
            }
            
        } catch (error) {
            console.error('Service Worker: 异步处理失败:', error);
            await this.sendErrorToTab(sender, request, error.message);
            await NotificationManager.showError(`处理 ${request.type} 时出错: ${error.message}`);
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
                console.log('Service Worker: 无法发送错误到 content script:', error.message);
            }
        }
    }
}

// === 词汇处理器 ===
class WordProcessor {
    static async handleWordSelection(request, sender) {
        const { word, text, context, url, title } = request;
        const targetWord = word || text;
        
        try {
            const settings = await SettingsManager.getSettings();
            if (!settings.extensionEnabled) {
                console.log('Service Worker: 扩展已禁用');
                return;
            }
            
            const cacheKeys = CacheManager.generateCacheKeys('word', targetWord, url, settings.outputLanguage);
            const requestKey = `word_${targetWord}_${settings.outputLanguage}`;
            const now = Date.now();
            
            // 检查正在进行的请求
            if (serviceState.activeRequests.has(requestKey)) {
                console.log('Service Worker: 发现正在进行的相同请求，等待结果:', targetWord);
                try {
                    const result = await serviceState.activeRequests.get(requestKey);
                    await ResultManager.showWordResult(result, targetWord, url, sender.tab?.id);
                    return;
                } catch (error) {
                    console.error('Service Worker: 等待现有请求失败:', error);
                }
            }
            
            // 检查内存缓存
            if (CacheManager.checkRecentSelection(cacheKeys.memory, now)) {
                const cachedData = await CacheManager.getCachedData(cacheKeys.data);
                if (cachedData) {
                    console.log('Service Worker: 返回缓存的数据给重复请求');
                    await ResultManager.showWordResult(cachedData, targetWord, url, sender.tab?.id);
                    return;
                }
            }
            
            // 更新内存缓存
            serviceState.recentSelections.set(cacheKeys.memory, now);
            CacheManager.cleanupMemoryCache();
            
            // 检查数据缓存
            const cachedData = await CacheManager.getCachedData(cacheKeys.data);
            if (cachedData) {
                console.log('Service Worker: 内存数据缓存命中');
                await ResultManager.showWordResult(cachedData, targetWord, url, sender.tab?.id);
                return;
            }
            
            // 检查 IndexedDB 缓存
            const cachedResult = await DatabaseManager.getCachedResultFromDB('word', targetWord, settings.outputLanguage);
            if (cachedResult) {
                console.log('Service Worker: IndexedDB 缓存命中');
                await ResultManager.showWordResult(cachedResult, targetWord, url, sender.tab?.id);
                
                // 提升到内存缓存
                serviceState.memoryCache.set(cacheKeys.data, {
                    data: cachedResult,
                    timestamp: now
                });
                
                return;
            }
            
            console.log('Service Worker: 缓存未命中，调用 API');
            
            // 调用 API
            const apiPromise = APIManager.callWordAPI(targetWord, context, settings.outputLanguage);
            serviceState.activeRequests.set(requestKey, apiPromise);
            
            try {
                const result = await apiPromise;
                
                // 缓存结果
                await Promise.all([
                    DatabaseManager.cacheResultToDB('word', targetWord, settings.outputLanguage, result),
                    CacheManager.cacheResultToMemory('word', targetWord, settings.outputLanguage, result)
                ]);
                
                // 显示结果
                await ResultManager.showWordResult(result, targetWord, url, sender.tab?.id);
                await StatsManager.updateWordStats();
                
            } finally {
                serviceState.activeRequests.delete(requestKey);
            }
            
        } catch (error) {
            console.error('Service Worker: 词汇处理失败:', error);
            
            const requestKey = `word_${targetWord}_${(await SettingsManager.getSettings()).outputLanguage}`;
            serviceState.activeRequests.delete(requestKey);
            
            throw error;
        }
    }
}

// === 理解分析处理器 ===
class ConceptProcessor {
    static async handleConceptAnalysis(request, sender) {
        const { original_text, user_understanding, context, auto_extract_context, cache_key } = request;
        
        try {
            const settings = await SettingsManager.getSettings();
            if (!settings.extensionEnabled) {
                console.log('Service Worker: 扩展已禁用');
                return;
            }
            
            const uniqueCacheKey = cache_key || this.generateUniqueCacheKey(original_text, user_understanding, context);
            const dataCacheKey = `concept_${uniqueCacheKey}_${settings.outputLanguage}`;
            const requestKey = `concept_analysis_${uniqueCacheKey}`;
            const now = Date.now();
            
            console.log('Service Worker: 理解分析缓存键:', dataCacheKey);
            
            // 检查正在进行的请求
            if (serviceState.activeRequests.has(requestKey)) {
                console.log('Service Worker: 发现正在进行的相同理解分析请求，等待结果');
                try {
                    const result = await serviceState.activeRequests.get(requestKey);
                    await ResultManager.showConceptResult(result, original_text, request.url, sender.tab?.id);
                    return;
                } catch (error) {
                    console.error('Service Worker: 等待现有理解分析请求失败:', error);
                }
            }
            
            // 检查短期缓存（5分钟）
            const shortCacheTime = 5 * 60 * 1000;
            const cachedData = await CacheManager.getCachedData(dataCacheKey);
            if (cachedData) {
                const cacheAge = now - (cachedData.timestamp || 0);
                if (cacheAge < shortCacheTime) {
                    console.log('Service Worker: 理解分析短期缓存命中');
                    await ResultManager.showConceptResult(cachedData.data, original_text, request.url, sender.tab?.id);
                    return;
                } else {
                    serviceState.memoryCache.delete(dataCacheKey);
                    console.log('Service Worker: 清理过期的理解分析缓存');
                }
            }
            
            console.log('Service Worker: 理解分析直接调用 API');
            
            // 调用 API
            const apiPromise = APIManager.callConceptAPI(original_text, user_understanding, context, auto_extract_context);
            serviceState.activeRequests.set(requestKey, apiPromise);
            
            try {
                const result = await apiPromise;
                
                // 短期缓存结果
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
            console.error('Service Worker: 理解分析处理失败:', error);
            
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

// === API 管理器 ===
class APIManager {
    static async callWordAPI(word, context, language) {
        console.log('Service Worker: 调用词汇 API:', { word: word.substring(0, 20) });
        
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
        
        console.log('Service Worker: API 响应状态:', response.status);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API 请求失败 ${response.status}: ${errorText}`);
        }
        
        const result = await response.json();
        console.log('Service Worker: API 成功响应');
        
        return result;
    }

    static async callConceptAPI(original_text, user_understanding, context, auto_extract_context) {
        console.log('Service Worker: 调用理解分析 API');
        
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
        
        console.log('Service Worker: 理解分析 API 响应状态:', response.status);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Service Worker: API 错误响应:', errorText);
            throw new Error(`理解分析API请求失败 ${response.status}: ${errorText}`);
        }
        
        const result = await response.json();
        console.log('Service Worker: 理解分析 API 成功响应，相似度:', result.overall_similarity);
        
        return result;
    }
}

// === 缓存管理器 ===
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
        
        console.log('Service Worker: 结果已缓存到内存');
        
        if (serviceState.memoryCache.size > 100) {
            const oldestKey = serviceState.memoryCache.keys().next().value;
            serviceState.memoryCache.delete(oldestKey);
        }
    }

    static cleanupMemoryCache() {
        const now = Date.now();
        
        // 清理过期的重复选择记录
        for (const [key, timestamp] of serviceState.recentSelections.entries()) {
            if (now - timestamp > CONFIG.MEMORY_CACHE_TIME) {
                serviceState.recentSelections.delete(key);
            }
        }
        
        // 清理过期的内存缓存
        for (const [key, value] of serviceState.memoryCache.entries()) {
            let maxAge = CONFIG.MEMORY_CACHE_TIME * 3;
            
            if (key.startsWith('concept_')) {
                maxAge = 5 * 60 * 1000; // 理解分析缓存5分钟
            }
            
            if (now - value.timestamp > maxAge) {
                serviceState.memoryCache.delete(key);
            }
        }
    }

    static async clearAllCache() {
        try {
            serviceState.clearMemory();
            console.log('Service Worker: 内存缓存已清理');
            
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
                        console.log(`Service Worker: IndexedDB 缓存已清理，删除 ${deletedCount} 条记录`);
                    }
                };

                request.onerror = () => {
                    console.error('Service Worker: 清理 IndexedDB 失败:', request.error);
                };
            }
        } catch (error) {
            console.error('Service Worker: 清理缓存失败:', error);
        }
    }
}

// === 数据库管理器 ===
class DatabaseManager {
    static async initializeIndexedDB() {
        console.log('Service Worker: 初始化 IndexedDB');
        
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
            
            request.onerror = () => {
                console.error('Service Worker: IndexedDB 打开失败:', request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                serviceState.db = request.result;
                console.log('Service Worker: IndexedDB 初始化成功');
                
                serviceState.db.onerror = (event) => {
                    console.error('Service Worker: IndexedDB 错误:', event.target.error);
                };
                
                resolve(serviceState.db);
            };
            
            request.onupgradeneeded = (event) => {
                const database = event.target.result;
                console.log('Service Worker: 升级 IndexedDB 结构');

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
                
                console.log('Service Worker: IndexedDB 对象存储创建成功');
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
                            console.log('Service Worker: IndexedDB 缓存有效');
                            resolve(cachedData.data);
                        } else {
                            console.log('Service Worker: IndexedDB 缓存已过期，删除');
                            this.deleteCachedResultFromDB(cacheKey);
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                };
                
                request.onerror = () => {
                    console.error('Service Worker: 读取 IndexedDB 失败:', request.error);
                    resolve(null);
                };
            });
            
        } catch (error) {
            console.error('Service Worker: IndexedDB 查询失败:', error);
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
                    console.log('Service Worker: 结果已缓存到 IndexedDB');
                    resolve();
                };
                
                request.onerror = () => {
                    console.error('Service Worker: IndexedDB 缓存失败:', request.error);
                    resolve();
                };
            });
            
        } catch (error) {
            console.error('Service Worker: IndexedDB 缓存失败:', error);
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
                    console.log('Service Worker: IndexedDB 缓存已删除');
                    resolve();
                };
                
                request.onerror = () => {
                    console.error('Service Worker: 删除 IndexedDB 缓存失败:', request.error);
                    resolve();
                };
            });
            
        } catch (error) {
            console.error('Service Worker: 删除 IndexedDB 缓存失败:', error);
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
                        console.log(`Service Worker: 清理了 ${deletedCount} 个过期的 IndexedDB 缓存`);
                    }
                }
            };
        } catch (error) {
            console.error('Service Worker: 清理 IndexedDB 过期缓存失败:', error);
        }
    }
}

// === 结果管理器 ===
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
                    console.log('Service Worker: 结果已发送到指定标签页');
                    return;
                } catch (error) {
                    console.log('Service Worker: 发送到指定标签页失败，尝试当前活跃标签页');
                }
            }
            
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0] && TabManager.isValidTab(tabs[0])) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'WORD_SIMPLIFIED',
                    word: text,
                    result: result
                }).catch((error) => {
                    console.log('Service Worker: 无法发送到 content script:', error.message);
                });
            }
        } catch (error) {
            console.error('Service Worker: 显示结果失败:', error);
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
                    console.log('Service Worker: 理解分析结果已发送到指定标签页');
                    return;
                } catch (error) {
                    console.log('Service Worker: 发送到指定标签页失败，尝试当前活跃标签页');
                }
            }
            
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0] && TabManager.isValidTab(tabs[0])) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'CONCEPT_ANALYZED',
                    original_text: original_text,
                    result: result
                }).catch((error) => {
                    console.log('Service Worker: 无法发送理解分析结果到 content script:', error.message);
                });
            }
        } catch (error) {
            console.error('Service Worker: 显示理解分析结果失败:', error);
        }
    }
}

// === 通知管理器 ===
class NotificationManager {
    static async showNotification(word, result) {
        try {
            const settings = await SettingsManager.getSettings();
            if (!settings.notificationsEnabled) return;
            
            const synonyms = result.synonyms || [];
            const firstSynonym = synonyms.length > 0 ? synonyms[0] : '处理完成';
            
            await chrome.notifications.create({
                type: 'basic',
                iconUrl: '/icons/icon48.png',
                title: `Word Munch - ${word}`,
                message: typeof firstSynonym === 'string' ? firstSynonym : firstSynonym.word || '简化完成'
            });
        } catch (error) {
            console.error('Service Worker: 显示通知失败:', error);
        }
    }

    static async showError(message) {
        try {
            await chrome.notifications.create({
                type: 'basic',
                iconUrl: '/icons/icon48.png',
                title: 'Word Munch - 错误',
                message: message
            });
        } catch (error) {
            console.error('Service Worker: 显示错误通知失败:', error);
        }
    }
}

// === 统计管理器 ===
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
            console.log('Service Worker: 统计已更新:', counts);
        } catch (error) {
            console.error('Service Worker: 更新统计失败:', error);
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
            console.log('Service Worker: 理解分析统计已更新:', counts);
        } catch (error) {
            console.error('Service Worker: 更新理解分析统计失败:', error);
        }
    }
}

// === 设置管理器 ===
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
            console.error('Service Worker: 获取设置失败:', error);
            return defaults;
        }
    }

    static async handleSettingsUpdate(newSettings) {
        try {
            await chrome.storage.sync.set(newSettings);
            console.log('Service Worker: 设置已更新:', newSettings);
            
            const tabs = await chrome.tabs.query({});
            for (const tab of tabs) {
                if (TabManager.isValidTab(tab)) {
                    chrome.tabs.sendMessage(tab.id, {
                        type: 'SETTINGS_UPDATED',
                        settings: newSettings
                    }).catch(() => {
                        // 忽略发送失败
                    });
                }
            }
        } catch (error) {
            console.error('Service Worker: 处理设置更新失败:', error);
        }
    }
}

// === 用户管理器 ===
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
            console.error('Service Worker: 获取用户信息失败:', error);
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

            console.log('Service Worker: 用户登录成功:', userInfo.email);

        } catch (error) {
            console.error('Service Worker: 处理用户登录失败:', error);
            throw error;
        }
    }

    static async handleUserLogout() {
        try {
            await CacheManager.clearAllCache();
            await chrome.storage.sync.remove(['userEmail', 'userToken', 'userId']);
            console.log('Service Worker: 用户登出成功');

        } catch (error) {
            console.error('Service Worker: 处理用户登出失败:', error);
            throw error;
        }
    }
}

// === 标签页管理器 ===
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
            console.log('Service Worker: 标签页加载完成:', tab.url);
            
            try {
                const settings = await SettingsManager.getSettings();
                chrome.tabs.sendMessage(tabId, {
                    type: 'SETTINGS_UPDATED',
                    settings: settings
                }).catch(() => {
                    // 忽略发送失败
                });
            } catch (error) {
                // 忽略错误
            }
        }
    }
}

// === 事件监听器设置 ===
chrome.runtime.onInstalled.addListener((details) => {
    console.log('=== Service Worker: 扩展已安装 ===', details.reason);
    LifecycleManager.initialize();
});

chrome.runtime.onStartup.addListener(() => {
    console.log('=== Service Worker: 浏览器启动 ===');
    DatabaseManager.initializeIndexedDB();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('=== Service Worker: 收到消息 ===', request.type);
    
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

console.log('=== Service Worker: 脚本加载完成 ===');