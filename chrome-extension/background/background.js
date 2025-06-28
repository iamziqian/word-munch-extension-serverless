// Chrome Extension Service Worker - Handle API calls and message passing
console.log('=== Service Worker: 启动 ===');

// === 配置常量 ===
const CONFIG = {
    WORD_API_ENDPOINT: 'https://4gjsn9p4kc.execute-api.us-east-1.amazonaws.com/dev/word-muncher',
    SENTENCE_API_ENDPOINT: 'https://4gjsn9p4kc.execute-api.us-east-1.amazonaws.com/dev/concept-muncher',
    MEMORY_CACHE_TIME: 5000, // 5秒内存缓存
    INDEXEDDB_CACHE_TIME: 24 * 60 * 60 * 1000, // 24小时 IndexedDB 缓存
    DB_NAME: 'WordMunchCache',
    DB_VERSION: 1,
    STORE_NAME: 'simplifiedResults'
};

// === L1 内存缓存 ===
const memoryCache = new Map();
const recentSelections = new Map();

// === IndexedDB 实例 ===
let db = null;

// === Service Worker 生命周期 ===
chrome.runtime.onInstalled.addListener((details) => {
    console.log('=== Service Worker: 扩展已安装 ===', details.reason);
    initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
    console.log('=== Service Worker: 浏览器启动 ===');
    initializeIndexedDB();
});

// === 消息处理 ===
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('=== Service Worker: 收到消息 ===', request.type);
    
    // 立即发送确认响应，避免通道关闭
    const immediateResponse = {
        received: true,
        timestamp: Date.now(),
        messageType: request.type
    };
    
    console.log('Service Worker: 立即发送确认');
    sendResponse(immediateResponse);
    
    // 异步处理业务逻辑，不依赖 sendResponse
    handleMessageAsync(request, sender);
    
    // 不返回 true，因为我们已经同步发送了响应
    return false;
});

// === 异步处理消息 ===
async function handleMessageAsync(request, sender) {
    try {
        console.log('Service Worker: 开始异步处理:', request.type);
        
        switch (request.type) {
            case 'WORD_SELECTED':
                console.log('Service Worker: 处理词汇选择:', request.word);
                await handleWordSelection(request, sender);
                break;
                
            case 'SENTENCE_SELECTED':
                console.log('Service Worker: 处理句子选择:', request.text?.substring(0, 50) + '...');
                await handleSentenceSelection(request, sender);
                break;
                
            case 'CONTENT_SCRIPT_READY':
                console.log('Service Worker: Content script 就绪:', request.url);
                break;
                
            case 'SETTINGS_UPDATED':
                console.log('Service Worker: 更新设置');
                await handleSettingsUpdate(request.settings);
                break;
                
            case 'CLEANUP_CACHE':
                console.log('Service Worker: 手动清理缓存');
                cleanupMemoryCache();
                await cleanupExpiredDBCache();
                break;

            case 'CLEAR_ALL_CACHE':
                console.log('Service Worker: 清理所有缓存');
                await clearAllCache();  
                break;

            case 'USER_LOGIN':
                console.log('Service Worker: 用户登录');
                await handleUserLogin(request.userInfo);
                break;

            case 'USER_LOGOUT':
                console.log('Service Worker: 用户登出');
                await handleUserLogout();
                break;
                
            default:
                console.log('Service Worker: 未知消息类型:', request.type);
        }
        
        console.log('Service Worker: 异步处理完成:', request.type);
        
    } catch (error) {
        console.error('Service Worker: 异步处理失败:', error);
        
        // 发送错误通知
        try {
            await chrome.notifications.create({
                type: 'basic',
                iconUrl: '/icons/icon48.png',
                title: 'Word Munch - 处理错误',
                message: `处理 ${request.type} 时出错: ${error.message}`
            });
        } catch (notificationError) {
            console.error('Service Worker: 发送错误通知失败:', notificationError);
        }
    }
}

// === 词汇选择处理 ===
async function handleWordSelection(request, sender) {
    const { word, context, url, title } = request;
    
    try {
        // 检查扩展是否启用
        const settings = await getSettings();
        if (!settings.extensionEnabled) {
            console.log('Service Worker: 扩展已禁用');
            return;
        }
        
        // 生成统一的缓存键
        const memoryCacheKey = generateMemoryCacheKey('word', word, url);
        const dataCacheKey = generateDataCacheKey('word', word, settings.outputLanguage);
        const now = Date.now();
        
        // === L1 内存缓存检查 (5秒) ===
        if (recentSelections.has(memoryCacheKey)) {
            const lastTime = recentSelections.get(memoryCacheKey);
            if (now - lastTime < CONFIG.MEMORY_CACHE_TIME) {
                console.log('Service Worker: L1 内存缓存命中，跳过重复选择:', word);
                return;
            }
        }
        
        // 更新 L1 缓存
        recentSelections.set(memoryCacheKey, now);
        cleanupMemoryCache();
        
        // === 检查内存数据缓存 ===
        if (memoryCache.has(dataCacheKey)) {
            const cached = memoryCache.get(dataCacheKey);
            if (now - cached.timestamp < CONFIG.MEMORY_CACHE_TIME * 2) { // 内存缓存保持10秒
                console.log('Service Worker: 内存数据缓存命中');
                await showResult(cached.data, word, url);
                return;
            }
        }
        
        // === L2 IndexedDB 缓存检查 (24小时) ===
        const cachedResult = await getCachedResultFromDB('word', word, settings.outputLanguage);
        if (cachedResult) {
            console.log('Service Worker: L2 IndexedDB 缓存命中');
            await showResult(cachedResult, word, url);
            
            // 提升到内存缓存
            memoryCache.set(dataCacheKey, {
                data: cachedResult,
                timestamp: now
            });
            
            return;
        }
        
        console.log('Service Worker: 缓存未命中，调用 API');
        
        // === 调用 API ===
        const result = await callWordAPI(word, context, settings.outputLanguage);
        
        // === 缓存结果 ===
        await Promise.all([
            cacheResultToDB('word', word, settings.outputLanguage, result),
            cacheResultToMemory('word', word, settings.outputLanguage, result)
        ]);
        
        // === 显示结果 ===
        await showResult(result, word, url);
        await updateWordStats();
        
    } catch (error) {
        console.error('Service Worker: 词汇处理失败:', error);
        await showError(`处理词汇"${word}"失败: ${error.message}`);
    }
}

// === 句子选择处理 ===
async function handleSentenceSelection(request, sender) {
    const { text, context, url, title } = request;
    
    try {
        const settings = await getSettings();
        if (!settings.extensionEnabled) {
            console.log('Service Worker: 扩展已禁用');
            return;
        }
        
        // 生成统一的缓存键
        const memoryCacheKey = generateMemoryCacheKey('sentence', text, url);
        const dataCacheKey = generateDataCacheKey('sentence', text, settings.outputLanguage);
        const now = Date.now();
        
        // L1 内存缓存检查
        if (recentSelections.has(memoryCacheKey)) {
            const lastTime = recentSelections.get(memoryCacheKey);
            if (now - lastTime < CONFIG.MEMORY_CACHE_TIME) {
                console.log('Service Worker: L1 内存缓存命中，跳过重复选择');
                return;
            }
        }
        
        recentSelections.set(memoryCacheKey, now);
        cleanupMemoryCache();
        
        // 检查内存数据缓存
        if (memoryCache.has(dataCacheKey)) {
            const cached = memoryCache.get(dataCacheKey);
            if (now - cached.timestamp < CONFIG.MEMORY_CACHE_TIME * 2) {
                console.log('Service Worker: 内存数据缓存命中');
                await showResult(cached.data, text, url);
                return;
            }
        }
        
        // L2 IndexedDB 缓存检查
        const cachedResult = await getCachedResultFromDB('sentence', text, settings.outputLanguage);
        if (cachedResult) {
            console.log('Service Worker: L2 IndexedDB 缓存命中');
            await showResult(cachedResult, text, url);
            
            // 提升到内存缓存
            memoryCache.set(dataCacheKey, {
                data: cachedResult,
                timestamp: now
            });
            
            return;
        }
        
        // 暂时使用词汇 API 处理句子
        console.log('Service Worker: 使用词汇 API 处理句子');
        const result = await callWordAPI(text, context, settings.outputLanguage);
        
        await Promise.all([
            cacheResultToDB('sentence', text, settings.outputLanguage, result),
            cacheResultToMemory('sentence', text, settings.outputLanguage, result)
        ]);
        
        await showResult(result, text, url);
        await updateWordStats();
        
    } catch (error) {
        console.error('Service Worker: 句子处理失败:', error);
        await showError(`处理句子失败: ${error.message}`);
    }
}

// === IndexedDB 管理 ===
async function initializeIndexedDB() {
    console.log('Service Worker: 初始化 IndexedDB');
    
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
        
        request.onerror = () => {
            console.error('Service Worker: IndexedDB 打开失败:', request.error);
            reject(request.error);
        };
        
        request.onsuccess = () => {
            db = request.result;
            console.log('Service Worker: IndexedDB 初始化成功');
            
            db.onerror = (event) => {
                console.error('Service Worker: IndexedDB 错误:', event.target.error);
            };
            
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            console.log('Service Worker: 升级 IndexedDB 结构');

            // 删除旧的对象存储
            if (database.objectStoreNames.contains(CONFIG.STORE_NAME)) {
                database.deleteObjectStore(CONFIG.STORE_NAME);
                console.log('Service Worker: 删除旧的对象存储');
            }

            // 保留用户相关的结构，但现在都用匿名用户
            const store = database.createObjectStore(CONFIG.STORE_NAME, { 
                keyPath: ['userId', 'type', 'textHash', 'language'] // 保留完整结构
            });
    
            // 创建索引（保留用户相关索引）
            store.createIndex('userId', 'userId', { unique: false });
            store.createIndex('type', 'type', { unique: false });
            store.createIndex('language', 'language', { unique: false });
            store.createIndex('timestamp', 'timestamp', { unique: false });
            store.createIndex('textHash', 'textHash', { unique: false });
            
            console.log('Service Worker: IndexedDB 对象存储创建成功');
        };
    });
}

async function getCachedResultFromDB(type, text, language) {
    try {
        if (!db) {
            await initializeIndexedDB();
        }
        
        const cacheKey = await generateDBCacheKey(type, text, language);
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([CONFIG.STORE_NAME], 'readonly');
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
                        deleteCachedResultFromDB(cacheKey);
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

async function cacheResultToDB(type, text, language, data) {
    try {
        if (!db) {
            await initializeIndexedDB();
        }

        const userInfo = await getUserInfo();
        const userId = userInfo ? userInfo.userId : 'anonymous';

        const textHash = await hashString(text);
        
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
            const transaction = db.transaction([CONFIG.STORE_NAME], 'readwrite');
            const store = transaction.objectStore(CONFIG.STORE_NAME);
            const request = store.put(cacheData);
            
            request.onsuccess = () => {
                console.log('Service Worker: 结果已缓存到 IndexedDB');
                resolve();
            };
            
            request.onerror = () => {
                console.error('Service Worker: IndexedDB 缓存失败:', request.error);
                resolve(); // 不阻塞主流程
            };
        });
        
    } catch (error) {
        console.error('Service Worker: IndexedDB 缓存失败:', error);
    }
}

async function deleteCachedResultFromDB(cacheKey) {
    try {
        if (!db) return;
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([CONFIG.STORE_NAME], 'readwrite');
            const store = transaction.objectStore(CONFIG.STORE_NAME);
            const request = store.delete(cacheKey);
            
            request.onsuccess = () => {
                console.log('Service Worker: IndexedDB 缓存已删除');
                resolve();
            };
            
            request.onerror = () => {
                console.error('Service Worker: 删除 IndexedDB 缓存失败:', request.error);
                resolve(); // 不阻塞主流程
            };
        });
        
    } catch (error) {
        console.error('Service Worker: 删除 IndexedDB 缓存失败:', error);
    }
}

// === 内存缓存管理 ===
async function cacheResultToMemory(type, text, language, data) {
    const cacheKey = generateDataCacheKey(type, text, language);
    memoryCache.set(cacheKey, {
        data: data,
        timestamp: Date.now()
    });
    
    console.log('Service Worker: 结果已缓存到内存');
    
    // 限制内存缓存大小
    if (memoryCache.size > 100) {
        const oldestKey = memoryCache.keys().next().value;
        memoryCache.delete(oldestKey);
    }
}

function cleanupMemoryCache() {
    const now = Date.now();
    
    // 清理过期的重复选择记录
    for (const [key, timestamp] of recentSelections.entries()) {
        if (now - timestamp > CONFIG.MEMORY_CACHE_TIME) {
            recentSelections.delete(key);
        }
    }
    
    // 清理过期的内存缓存
    for (const [key, value] of memoryCache.entries()) {
        if (now - value.timestamp > CONFIG.MEMORY_CACHE_TIME * 2) { // 内存缓存保持10秒
            memoryCache.delete(key);
        }
    }
}

// === 缓存键生成 ===
function generateMemoryCacheKey(type, text, url) {
    // 用于防重复的内存键（包含URL）
    return `memory_${type}_${text}_${url}`;

}

function generateDataCacheKey(type, text, language) {
    // 用于数据缓存的键（不包含URL）
    return `${type}_${text}_${language}`;
}

async function generateDBCacheKey(type, text, language) {
    // IndexedDB 主键数组（保留用户结构）
    const userInfo = await getUserInfo();
    const userId = userInfo ? userInfo.userId : 'anonymous';
    const textHash = await hashString(text);
    return [userId, type, textHash, language];
}

async function hashString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
}

// === API 调用 ===
async function callWordAPI(word, context, language) {
    console.log('Service Worker: 调用词汇 API:', { word: word.substring(0, 20) });
    
    const requestBody = {
        word: word,
        context: context,
        language: language
    };

    const headers = {
        'Content-Type': 'application/json'
    };

    // 保留认证接口以便将来扩展
    const authToken = await getAuthToken();
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

// === 用户相关函数（保留接口，暂时返回默认值）===
async function getUserInfo() {
    // 暂时返回 null，将来可以轻松替换为真实的用户信息获取逻辑
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

async function getAuthToken() {
    // 保留认证接口以便将来扩展
    const userInfo = await getUserInfo();
    return userInfo ? userInfo.token : null;
}

// === 用户管理函数（保留接口，为将来扩展准备）===
async function handleUserLogin(userInfo) {
    try {
        // 将来在这里处理用户登录逻辑
        await chrome.storage.sync.set({
            userEmail: userInfo.email,
            userToken: userInfo.token,
            userId: userInfo.userId || userInfo.email
        });

        console.log('Service Worker: 用户登录成功:', userInfo.email);

        // 登录后可以做一些初始化工作，比如同步缓存等

    } catch (error) {
        console.error('Service Worker: 处理用户登录失败:', error);
        throw error;
    }
}

async function handleUserLogout() {
    try {
        // 清理用户相关的缓存
        await clearAllCache();

        // 清理用户信息
        await chrome.storage.sync.remove(['userEmail', 'userToken', 'userId']);
        console.log('Service Worker: 用户登出成功');

    } catch (error) {
        console.error('Service Worker: 处理用户登出失败:', error);
        throw error;
    }
}

// === 工具函数 ===
async function getSettings() {
    const defaults = {
        extensionEnabled: true,
        outputLanguage: 'english',
        notificationsEnabled: true
    };
    
    try {
        const result = await chrome.storage.sync.get(Object.keys(defaults));
        return { ...defaults, ...result };
    } catch (error) {
        console.error('Service Worker: 获取设置失败:', error);
        return defaults;
    }
}


// === 结果显示 ===
async function showResult(result, text, url) {
    try {
        await showNotification(text, result);
        
        // 发送到当前活跃标签页
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0] && isValidTab(tabs[0])) {
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

async function showError(message) {
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

async function showNotification(word, result) {
    try {
        const settings = await getSettings();
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

// === 统计管理 ===
async function updateWordStats() {
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

// === 设置管理 ===
async function handleSettingsUpdate(newSettings) {
    try {
        await chrome.storage.sync.set(newSettings);
        console.log('Service Worker: 设置已更新:', newSettings);
        
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            if (isValidTab(tab)) {
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

// === 缓存清理 ===
async function clearAllCache() {
    try {
        // 清理内存缓存
        memoryCache.clear();
        recentSelections.clear();
        console.log('Service Worker: 内存缓存已清理');
        
         // 清理 IndexedDB - 按用户清理（保留用户隔离逻辑）
        if (db) {
            const userInfo = await getUserInfo();
            const userId = userInfo ? userInfo.userId : 'anonymous';
            
            const transaction = db.transaction([CONFIG.STORE_NAME], 'readwrite');
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

async function cleanupExpiredDBCache() {
    try {
        if (!db) return;
        
        const cutoffTime = Date.now() - CONFIG.INDEXEDDB_CACHE_TIME;
        const transaction = db.transaction([CONFIG.STORE_NAME], 'readwrite');
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

// === 标签页管理 ===
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && isValidTab(tab)) {
        console.log('Service Worker: 标签页加载完成:', tab.url);
        
        try {
            const settings = await getSettings();
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
});

function isValidTab(tab) {
    return tab.url && 
           !tab.url.startsWith('chrome://') && 
           !tab.url.startsWith('chrome-extension://') && 
           !tab.url.startsWith('edge://') && 
           !tab.url.startsWith('about:');
}

// === 初始化 ===
async function initializeExtension() {
    console.log('Service Worker: 初始化扩展');
    
    try {
        // 初始化 IndexedDB
        await initializeIndexedDB();
        
        // 设置默认配置
        const defaults = {
            extensionEnabled: true,
            outputLanguage: 'english',
            notificationsEnabled: true,
            wordCounts: {
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
        
        console.log('Service Worker: 初始化完成');
    } catch (error) {
        console.error('Service Worker: 初始化失败:', error);
    }
}

console.log('=== Service Worker: 脚本加载完成 ===');