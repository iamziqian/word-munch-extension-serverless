// ========== Word Munch Content Script - 重构版本 ==========

// === 配置常量 ===
const CONFIG = {
    CONCEPT_API_ENDPOINT: 'https://4gjsn9p4kc.execute-api.us-east-1.amazonaws.com/dev/concept-muncher',
    MIN_WORDS_FOR_CONCEPT: 10,
    MEMORY_CACHE_TIME: 3000
};

// === 全局状态管理 ===
class ContentScriptState {
    constructor() {
        this.selectedText = '';
        this.contextText = '';
        this.currentSelection = null;
        this.currentResult = null;
        this.currentSynonymIndex = 0;
        this.floatingWidget = null;
        this.highlightManager = null;
        this.isConceptMode = false;
        this.isDragging = false;
        this.outsideClickListenerActive = false;
        this.currentConceptAnalysis = null;
        this.currentRequestId = null;
        this.requestTimeout = null;
        this.pendingSelection = null;
        this.lastWordResult = null;
        this.lastWordText = null;
        this.lastResultTime = 0;
        this.highlightRanges = [];
        this.originalHighlightElements = [];
        this.scrollUpdateTimer = null;
        this.isScrollTracking = false;
        this.extensionSettings = {
            extensionEnabled: true,
            outputLanguage: 'english',
            notificationsEnabled: true,
            conceptMuncherEnabled: true
        };
        this.settingsLoaded = false; // 新增：标记设置是否已加载
    }

    async loadSettings() {
        try {
            const result = await chrome.storage.sync.get([
                'extensionEnabled', 
                'outputLanguage', 
                'notificationsEnabled', 
                'conceptMuncherEnabled'
            ]);
            
            // 只更新存在的设置，保留默认值
            if (result.extensionEnabled !== undefined) {
                this.extensionSettings.extensionEnabled = result.extensionEnabled;
            }
            if (result.outputLanguage !== undefined) {
                this.extensionSettings.outputLanguage = result.outputLanguage;
            }
            if (result.notificationsEnabled !== undefined) {
                this.extensionSettings.notificationsEnabled = result.notificationsEnabled;
            }
            if (result.conceptMuncherEnabled !== undefined) {
                this.extensionSettings.conceptMuncherEnabled = result.conceptMuncherEnabled;
            }
            
            this.settingsLoaded = true;
            console.log('Word Munch: 设置已加载:', this.extensionSettings);
            
        } catch (error) {
            console.error('Word Munch: 加载设置失败:', error);
            this.settingsLoaded = true; // 即使失败也标记为已尝试加载
        }
    }

    reset() {
        this.currentSelection = null;
        this.currentResult = null;
        this.currentSynonymIndex = 0;
        this.currentConceptAnalysis = null;
        this.isConceptMode = false;
        this.isDragging = false;
    }

    cancelCurrentRequest() {
        console.log('Word Munch: 取消当前请求');
        
        if (this.requestTimeout) {
            clearTimeout(this.requestTimeout);
            this.requestTimeout = null;
        }
        
        if (this.currentRequestId) {
            this.currentRequestId = null;
        }
    }
}

const state = new ContentScriptState();

// === 事件监听器管理 ===
class EventManager {
    constructor() {
        this.selectionTimer = null;
        this.setupMainListeners();
    }

    setupMainListeners() {
        document.addEventListener('mouseup', this.handleTextSelection.bind(this));
        document.addEventListener('keyup', this.handleTextSelection.bind(this));
        document.addEventListener('dblclick', this.handleTextSelection.bind(this));
        
        // Chrome 消息监听
        chrome.runtime.onMessage.addListener(this.handleChromeMessage.bind(this));
    }

    handleTextSelection(event) {
        const selection = window.getSelection();
        const selectedText = selection.toString().trim();
        
        console.log('Word Munch: 文本选择事件触发，选中文本:', selectedText);

        // 快速处理理解分析模式下的单词选择
        if (state.isConceptMode && state.highlightRanges && state.highlightRanges.length > 0) {
            if (selectedText && TextValidator.isValidWord(selectedText)) {
                console.log('Word Munch: 在高亮区域选择单词，创建独立词汇窗口');
                WidgetManager.createIndependentWordWindow(selectedText, selection);
                return;
            }
        }
        
        // 等待设置加载完成后再检查扩展状态
        if (!state.settingsLoaded) {
            console.log('Word Munch: 设置未加载完成，延迟处理');
            setTimeout(() => {
                this.handleTextSelection(event);
            }, 100);
            return;
        }
        
        // 检查扩展是否被禁用
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: 扩展已禁用，跳过处理');
            return;
        }
        
        // 处理空选择 - 但要避免在正常选择时误触发
        if (!selectedText || selectedText.length === 0) {
            // 只有在非理解分析模式且没有正在处理的选择时才关闭
            if (!state.isConceptMode && !state.currentSelection) {
                console.log('Word Munch: 空选择，关闭浮动窗口');
                WidgetManager.closeFloatingWidget();
            }
            return;
        }
        
        // 避免重复处理相同文本 - 但要检查窗口是否真的存在且可见
        if (state.currentSelection && 
            state.currentSelection.text === selectedText && 
            state.floatingWidget && 
            state.floatingWidget.classList.contains('show')) {
            console.log('Word Munch: 重复选择同一文本且窗口可见，跳过处理');
            return;
        }

        // 减少防抖延迟，避免快速选择失效
        if (this.selectionTimer) {
            clearTimeout(this.selectionTimer);
        }
        
        this.selectionTimer = setTimeout(() => {
            this.processTextSelection({
                text: selectedText,
                selection: selection,
                range: selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null,
                timestamp: Date.now()
            });
        }, 20); // 从50ms减少到20ms，提高响应速度
    }

    processTextSelection(selectionData) {
        const { text, selection, range } = selectionData;
        
        console.log('Word Munch: 开始处理文本选择:', text);
        
        // 再次检查扩展状态（防止在防抖延迟期间状态改变）
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: 处理时发现扩展已禁用，取消处理');
            return;
        }
        
        // 取消之前的请求但不关闭窗口
        state.cancelCurrentRequest();
        
        // 保存当前选择
        state.currentSelection = {
            text: text,
            selection: selection,
            range: range
        };
        
        console.log('Word Munch: 设置当前选择:', text);
        
        // 根据文本类型决定处理方式
        if (TextValidator.isValidWord(text)) {
            console.log('Word Munch: 识别为有效单词，显示词汇窗口');
            WidgetManager.showFloatingWidget(text, selection, 'word');
        } else if (TextValidator.isValidSentence(text) && state.extensionSettings.conceptMuncherEnabled) {
            console.log('Word Munch: 识别为有效句子，显示理解分析窗口');
            WidgetManager.showFloatingWidget(text, selection, 'sentence');
        } else if (TextValidator.isValidSentence(text)) {
            console.log('Word Munch: 识别为句子但理解分析已禁用，使用词汇模式');
            WidgetManager.showFloatingWidget(text, selection, 'sentence');
        } else {
            console.log('Word Munch: 无效文本，关闭窗口');
            WidgetManager.closeFloatingWidget();
        }
    }

    handleChromeMessage(message, sender, sendResponse) {
        console.log('Word Munch: 收到 background 消息:', message.type);
        
        try {
            switch (message.type) {
                case 'WORD_SIMPLIFIED':
                    MessageHandlers.handleWordSimplified(message.word, message.result);
                    break;
                case 'CONCEPT_ANALYZED':
                    MessageHandlers.handleConceptAnalyzed(message.original_text, message.result);
                    break;
                case 'SIMPLIFY_ERROR':
                    MessageHandlers.handleSimplifyError(message.word, message.error);
                    break;
                case 'CONCEPT_ANALYSIS_ERROR':
                    MessageHandlers.handleConceptAnalysisError(message.text, message.error);
                    break;
                case 'SETTINGS_UPDATED':
                    MessageHandlers.handleSettingsUpdated(message.settings);
                    break;
                default:
                    console.log('Word Munch: 未知消息类型:', message.type);
            }
            
            sendResponse({ received: true, timestamp: Date.now() });
        } catch (error) {
            console.error('Word Munch: 处理 background 消息失败:', error);
            sendResponse({ error: error.message });
        }
        
        return false;
    }

    addOutsideClickListener() {
        if (!state.outsideClickListenerActive) {
            document.addEventListener('click', this.handleOutsideClick.bind(this), true);
            state.outsideClickListenerActive = true;
            console.log('Word Munch: 外部点击监听器已添加');
        }
    }

    removeOutsideClickListener() {
        if (state.outsideClickListenerActive) {
            document.removeEventListener('click', this.handleOutsideClick.bind(this), true);
            state.outsideClickListenerActive = false;
            console.log('Word Munch: 外部点击监听器已移除');
        }
    }

    handleOutsideClick(event) {
        console.log('Word Munch: 外部点击事件触发，目标:', event.target.tagName);
        
        if (state.isDragging || !state.floatingWidget) {
            console.log('Word Munch: 跳过外部点击处理 - 拖拽中或无窗口');
            return;
        }
        
        // 如果点击的是浮动窗口内部，不关闭
        if (state.floatingWidget.contains(event.target)) {
            console.log('Word Munch: 点击在浮动窗口内部，不关闭');
            return;
        }
        
        // 特别检查：如果是理解分析模式，确保输入框相关的点击不会关闭窗口
        if (state.isConceptMode) {
            const clickedElement = event.target;
            if (clickedElement.tagName === 'INPUT' || 
                clickedElement.tagName === 'TEXTAREA' ||
                clickedElement.contentEditable === 'true' ||
                clickedElement.closest('.concept-understanding-input') ||
                clickedElement.closest('.concept-content')) {
                console.log('Word Munch: 点击在输入区域，不关闭理解分析窗口');
                return;
            }
        }
        
        // 检查是否点击在选中区域 - 给更大的容错空间
        if (state.currentSelection && state.currentSelection.range) {
            const rect = state.currentSelection.range.getBoundingClientRect();
            const padding = 10; // 增加容错空间
            
            if (event.clientX >= rect.left - padding && 
                event.clientX <= rect.right + padding && 
                event.clientY >= rect.top - padding && 
                event.clientY <= rect.bottom + padding) {
                console.log('Word Munch: 点击在选中区域内，不关闭');
                return;
            }
        }
        
        console.log('Word Munch: 确认外部点击，关闭浮动窗口');
        WidgetManager.closeFloatingWidget();
    }
}

// === 文本验证器 ===
class TextValidator {
    static isValidWord(text) {
        if (!text || text.length === 0) {
            console.log('Word Munch: 文本验证失败 - 空文本');
            return false;
        }
        
        if (/\s/.test(text)) {
            console.log('Word Munch: 文本验证失败 - 包含空格:', text);
            return false;
        }
        
        const wordCount = text.split(/\s+/).length;
        if (wordCount >= CONFIG.MIN_WORDS_FOR_CONCEPT) {
            console.log('Word Munch: 文本验证失败 - 词汇数超过阈值:', wordCount, 'vs', CONFIG.MIN_WORDS_FOR_CONCEPT);
            return false;
        }
        
        const wordRegex = /^[\p{L}]{1,10}$/u;
        const isValid = wordRegex.test(text);
        console.log('Word Munch: 文本验证结果:', text, '-> 有效词汇:', isValid);
        return isValid;
    }

    static isValidSentence(text) {
        if (!text || text.length === 0) return false;
        
        const wordCount = text.split(/\s+/).length;
        if (wordCount < CONFIG.MIN_WORDS_FOR_CONCEPT) return false;
        if (text.length > 1000) return false;
        
        const hasValidContent = /[\p{L}]/u.test(text);
        return hasValidContent;
    }
}

// === 浮动窗口管理器 ===
class WidgetManager {
    static showFloatingWidget(text, selection, type) {
        console.log('Word Munch: 显示浮动窗口:', text, type);
        
        const newSelection = {
            text: text,
            selection: selection,
            range: selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null
        };

        // 检查是否需要清理之前的窗口
        const needsCleanup = !state.floatingWidget || 
                           !state.currentSelection || 
                           state.currentSelection.text !== text;
        
        if (needsCleanup) {
            console.log('Word Munch: 需要清理之前的窗口');
            this.cleanupPreviousWidget();
        }
        
        // 重新设置选择状态
        state.currentSelection = newSelection;
        console.log('Word Munch: 设置当前选择状态:', text);
        
        // 如果窗口已存在且是相同文本，只需要重新开始处理
        if (state.floatingWidget && state.currentSelection.text === text) {
            console.log('Word Munch: 窗口已存在，重新开始处理');
            
            const wordCount = text.split(/\s+/).length;
            const isConceptAnalysis = wordCount >= CONFIG.MIN_WORDS_FOR_CONCEPT;
            state.isConceptMode = isConceptAnalysis;
            
            if (isConceptAnalysis) {
                ConceptAnalyzer.fillContextInformation(text);
            } else {
                APIManager.startSimplification(text, 'word');
            }
            return;
        }
        
        // 创建新窗口
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        
        state.floatingWidget = document.createElement('div');
        state.floatingWidget.id = 'word-munch-widget';
        state.floatingWidget.className = 'word-munch-floating-widget';
        
        const wordCount = text.split(/\s+/).length;
        const isConceptAnalysis = wordCount >= CONFIG.MIN_WORDS_FOR_CONCEPT;
        state.isConceptMode = isConceptAnalysis;
        
        const widgetWidth = isConceptAnalysis ? 400 : 300;
        const x = Math.min(rect.left, window.innerWidth - widgetWidth);
        const y = rect.bottom + 10 > window.innerHeight ? rect.top - 10 : rect.bottom + 10;
        
        state.floatingWidget.style.left = `${x}px`;
        state.floatingWidget.style.top = `${y}px`;
        state.floatingWidget.style.width = `${widgetWidth}px`;
        state.floatingWidget.style.position = 'fixed';
        state.floatingWidget.style.zIndex = '10000';
        
        let content;
        if (isConceptAnalysis) {
            content = ContentTemplates.createConceptMuncherContent(text);
        } else {
            content = ContentTemplates.createWordMuncherContent(text);
        }
        
        state.floatingWidget.innerHTML = content;
        document.body.appendChild(state.floatingWidget);
        console.log('Word Munch: 新浮动窗口已添加到DOM');
        
        DragHandler.makeDraggable(state.floatingWidget);
        
        // 显示动画
        setTimeout(() => {
            if (state.floatingWidget) {
                state.floatingWidget.classList.add('show');
                console.log('Word Munch: 触发显示动画');
            }
        }, 10);
        
        this.setupWidgetEvents(text, type);
        
        // 开始处理
        if (isConceptAnalysis) {
            ConceptAnalyzer.fillContextInformation(text);
        } else {
            APIManager.startSimplification(text, 'word');
        }
    }

    static setupWidgetEvents(text, type) {
        const widget = state.floatingWidget;
        if (!widget) return;
        
        const closeBtn = widget.querySelector('.wm-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', this.closeFloatingWidget.bind(this));
        }
        
        if (state.isConceptMode) {
            this.setupConceptMuncherEvents(text);
        } else {
            this.setupWordMuncherEvents(text);
        }
        
        eventManager.removeOutsideClickListener();
        
        const delay = state.isConceptMode ? 800 : 300;
        setTimeout(() => {
            eventManager.addOutsideClickListener();
        }, delay);
    }

    static setupWordMuncherEvents(text) {
        const widget = state.floatingWidget;
        
        const simplifyBtn = widget.querySelector('.wm-simplify-btn');
        if (simplifyBtn) {
            simplifyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                ResultDisplayer.showNextSynonym();
            });
        }
        
        const copyBtn = widget.querySelector('.wm-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                ResultDisplayer.copySynonymToClipboard();
            });
        }
    }

    static setupConceptMuncherEvents(text) {
        const widget = state.floatingWidget;
        
        const understandingInput = widget.querySelector('.concept-understanding-input');
        const analyzeBtn = widget.querySelector('.concept-analyze-btn');
        
        if (understandingInput && analyzeBtn) {
            understandingInput.addEventListener('input', () => {
                const hasInput = understandingInput.value.trim().length > 0;
                analyzeBtn.disabled = !hasInput;
                
                const errorElement = widget.querySelector('.concept-error');
                if (errorElement) {
                    errorElement.style.display = 'none';
                }
            });
            
            understandingInput.addEventListener('focus', () => {
                eventManager.removeOutsideClickListener();
            });
            
            understandingInput.addEventListener('blur', () => {
                setTimeout(() => {
                    if (state.floatingWidget && state.isConceptMode) {
                        eventManager.addOutsideClickListener();
                    }
                }, 500);
            });
            
            analyzeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                ConceptAnalyzer.startConceptAnalysis(text);
            });
            
            understandingInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && e.ctrlKey && !analyzeBtn.disabled) {
                    e.preventDefault();
                    ConceptAnalyzer.startConceptAnalysis(text);
                }
            });
            
            setTimeout(() => {
                understandingInput.focus();
            }, 300);
        }
    }

    static cleanupPreviousWidget() {
        console.log('Word Munch: 清理之前的浮动窗口');
        
        state.cancelCurrentRequest();
        eventManager.removeOutsideClickListener();
        HighlightManager.clearOriginalHighlights();
        
        if (state.floatingWidget) {
            state.floatingWidget.classList.remove('show');
            
            if (state.floatingWidget.parentNode) {
                state.floatingWidget.parentNode.removeChild(state.floatingWidget);
            }
            state.floatingWidget = null;
        }
        
        state.currentResult = null;
        state.currentSynonymIndex = 0;
        state.currentConceptAnalysis = null;
        state.isConceptMode = false;
        state.isDragging = false;
    }

    static closeFloatingWidget() {
        console.log('Word Munch: 完全关闭浮动窗口');
        
        state.cancelCurrentRequest();
        state.pendingSelection = null;
        
        this.cleanupPreviousWidget();
        state.reset();
    }

    static createIndependentWordWindow(selectedText, selection) {
        // 为理解分析模式下的独立词汇窗口创建
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        
        const independentWidget = document.createElement('div');
        independentWidget.className = 'word-munch-floating-widget';
        independentWidget.style.left = `${rect.left}px`;
        independentWidget.style.top = `${rect.bottom + 10}px`;
        independentWidget.style.position = 'fixed';
        independentWidget.style.zIndex = '10001';
        
        independentWidget.innerHTML = ContentTemplates.createWordMuncherContent(selectedText);
        document.body.appendChild(independentWidget);
        
        setTimeout(() => {
            independentWidget.classList.add('show');
        }, 10);
        
        // 自动开始简化
        APIManager.startSimplification(selectedText, 'word');
    }
}

// === 内容模板 ===
class ContentTemplates {
    static createWordMuncherContent(text) {
        return `
            <div class="wm-header">
                <div class="wm-header-text drag-handle">
                    "${text.length > 25 ? text.substring(0, 25) + '...' : text}"
                </div>
                <button class="wm-close-btn">×</button>
            </div>
            
            <div class="wm-content">
                <div class="wm-loading">
                    <div class="wm-spinner"></div>
                    <span>简化中...</span>
                </div>
                
                <div class="wm-result">
                    <div class="wm-synonym"></div>
                    <div class="wm-buttons">
                        <button class="wm-btn wm-btn-primary wm-simplify-btn" title="换一个"></button>
                        <button class="wm-btn wm-btn-secondary wm-copy-btn" title="复制"></button>
                    </div>
                </div>
                
                <div class="wm-error">
                    <!-- 错误信息显示在这里 -->
                </div>
            </div>
        `;
    }

    static createConceptMuncherContent(text) {
        const displayText = text.length > 80 ? text.substring(0, 80) + '...' : text;
        const wordCount = text.split(/\s+/).length;
        
        return `
            <div class="wm-header concept-header">
                <div class="wm-header-text drag-handle">
                    🧠 理解分析 (${wordCount}词)
                </div>
                <button class="wm-close-btn">×</button>
            </div>
            
            <div class="wm-content concept-content">
                <!-- 选中文本显示 -->
                <div class="concept-selected-text">
                    <div class="concept-text-label">选中文本：</div>
                    <div class="concept-text-content">${this.escapeHtml(displayText)}</div>
                </div>
                
                <!-- 理解输入区 -->
                <div class="concept-input-section">
                    <div class="concept-input-label">💭 您的理解：</div>
                    <textarea 
                        class="concept-understanding-input" 
                        placeholder="请用一句话表达您对上述文本的理解..."
                        rows="3"
                    ></textarea>
                </div>
                
                <!-- 上下文信息 -->
                <div class="concept-context-section">
                    <div class="concept-context-label">🔍 上下文：</div>
                    <div class="concept-context-content">正在提取...</div>
                </div>
                
                <!-- 操作按钮 -->
                <div class="concept-buttons">
                    <button class="wm-btn wm-btn-primary concept-analyze-btn" disabled>
                        分析理解程度
                    </button>
                </div>
                
                <!-- 加载状态 -->
                <div class="concept-loading" style="display: none;">
                    <div class="wm-spinner"></div>
                    <span>AI正在分析理解程度...</span>
                </div>
                
                <!-- 分析结果 -->
                <div class="concept-results" style="display: none;">
                    <!-- 结果内容将在这里动态填充 -->
                </div>
                
                <!-- 错误信息 -->
                <div class="concept-error" style="display: none;">
                    <!-- 错误信息显示在这里 -->
                </div>
            </div>
        `;
    }

    static escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// === 拖拽处理器 ===
class DragHandler {
    static makeDraggable(element) {
        const dragHandle = element.querySelector('.drag-handle') || element.querySelector('.wm-header');
        
        if (!dragHandle) return;
        
        dragHandle.style.cursor = 'move';
        dragHandle.style.userSelect = 'none';
        
        let startX, startY, startLeft, startTop;
        
        dragHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            state.isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            
            const rect = element.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            
            eventManager.removeOutsideClickListener();
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!state.isDragging) return;
            
            e.preventDefault();
            
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            
            let newLeft = startLeft + deltaX;
            let newTop = startTop + deltaY;
            
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;
            const elementWidth = element.offsetWidth;
            const elementHeight = element.offsetHeight;
            
            newLeft = Math.max(0, Math.min(newLeft, windowWidth - elementWidth));
            newTop = Math.max(0, Math.min(newTop, windowHeight - elementHeight));
            
            element.style.left = `${newLeft}px`;
            element.style.top = `${newTop}px`;
        });
        
        document.addEventListener('mouseup', () => {
            if (state.isDragging) {
                state.isDragging = false;
                
                setTimeout(() => {
                    if (state.floatingWidget) {
                        eventManager.addOutsideClickListener();
                    }
                }, 300);
            }
        });
    }
}

// === API 管理器 ===
class APIManager {
    static startSimplification(text, type) {
        // 重要：在API调用前再次检查扩展状态
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: 扩展已禁用，取消API调用');
            WidgetManager.closeFloatingWidget();
            return;
        }
        
        const context = state.currentSelection ? this.getContextAroundSelection(state.currentSelection.selection) : '';
        
        console.log('Word Munch: 开始简化:', text, type);
        
        // 检查缓存
        const now = Date.now();
        if (state.lastWordText === text && state.lastWordResult && (now - state.lastResultTime) < 5000) {
            console.log('Word Munch: 使用最近的缓存结果立即显示');
            ResultDisplayer.showSimplificationResult(state.lastWordResult);
            return;
        }
        
        const requestId = Math.random().toString(36).substr(2, 9);
        state.currentRequestId = requestId;
        
        if (state.requestTimeout) {
            clearTimeout(state.requestTimeout);
        }
        
        state.requestTimeout = setTimeout(() => {
            if (state.currentRequestId === requestId && state.floatingWidget) {
                console.warn('Word Munch: 简化请求超时:', text);
                ResultDisplayer.showSimplificationError('请求超时，请重试');
                state.currentRequestId = null;
                state.requestTimeout = null;
            }
        }, 15000);
        
        this.sendMessageToBackground({
            type: type === 'word' ? 'WORD_SELECTED' : 'SENTENCE_SELECTED',
            word: text,
            text: text,
            context: context,
            url: window.location.href,
            title: document.title,
            requestId: requestId
        });
    }

    static getContextAroundSelection(selection) {
        if (!selection.rangeCount) return '';
        
        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        
        let textContent = '';
        
        if (container.nodeType === Node.TEXT_NODE) {
            textContent = container.parentElement ? container.parentElement.textContent : '';
        } else {
            textContent = container.textContent || '';
        }
        
        const selectedText = selection.toString();
        const selectedIndex = textContent.indexOf(selectedText);
        
        if (selectedIndex === -1) return '';
        
        let contextLength = 100;
        
        if (selectedText.length > 50) {
            contextLength = 50;
        } else if (selectedText.length > 20) {
            contextLength = 75;
        }
        
        const beforeContext = textContent.substring(Math.max(0, selectedIndex - contextLength), selectedIndex);
        const afterContext = textContent.substring(selectedIndex + selectedText.length, selectedIndex + selectedText.length + contextLength);
        
        return (beforeContext + selectedText + afterContext).trim();
    }

    static sendMessageToBackground(message) {
        const messageId = Math.random().toString(36).substr(2, 9);
        message.messageId = messageId;
        message.timestamp = Date.now();
        
        console.log('Word Munch: 发送消息到 background:', message.type, messageId);
        
        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    if (chrome.runtime.lastError.message.includes('Extension context invalidated')) {
                        console.log('Word Munch: 扩展上下文已失效，建议刷新页面');
                        ResultDisplayer.showSimplificationError('扩展需要刷新，请刷新页面后重试');
                        return;
                    }
                    console.error('Word Munch: 消息发送失败:', chrome.runtime.lastError.message);
                    ResultDisplayer.showSimplificationError('连接扩展失败，请重试');
                    return;
                }
                
                if (response) {
                    console.log('Word Munch: 收到 background 响应:', response);
                    
                    if (response.received) {
                        console.log('Word Munch: 消息已被 background 接收');
                    } else if (response.error) {
                        console.error('Word Munch: Background 处理错误:', response.error);
                        ResultDisplayer.showSimplificationError(response.error);
                    }
                } else {
                    console.warn('Word Munch: 未收到 background 响应');
                    ResultDisplayer.showSimplificationError('未收到响应，请重试');
                }
            });
        } catch (error) {
            if (error.message && error.message.includes('Extension context invalidated')) {
                console.log('Word Munch: 扩展上下文已失效，建议刷新页面');
                ResultDisplayer.showSimplificationError('扩展需要刷新，请刷新页面后重试');
                return;
            }
            console.error('Word Munch: 发送消息异常:', error);
            ResultDisplayer.showSimplificationError('发送请求失败，请重试');
        }
    }
}

// === 结果显示器 ===
class ResultDisplayer {
    static showSimplificationResult(result) {
        if (!state.floatingWidget) {
            console.log('Word Munch: 浮动窗口不存在，无法显示结果');
            return;
        }
        
        console.log('Word Munch: 显示简化结果:', result);
        
        state.currentResult = result;
        state.currentSynonymIndex = 0;
        
        const loadingEl = state.floatingWidget.querySelector('.wm-loading');
        const resultEl = state.floatingWidget.querySelector('.wm-result');
        const errorEl = state.floatingWidget.querySelector('.wm-error');
        
        if (result && result.synonyms && result.synonyms.length > 0) {
            console.log('Word Munch: 找到', result.synonyms.length, '个同义词');
            
            if (loadingEl) loadingEl.style.display = 'none';
            if (errorEl) errorEl.classList.remove('show');
            if (resultEl) resultEl.classList.add('show');
            
            this.updateSynonymDisplay();
        } else {
            console.log('Word Munch: 没有找到同义词');
            
            if (loadingEl) loadingEl.style.display = 'none';
            if (resultEl) resultEl.classList.remove('show');
            if (errorEl) {
                errorEl.classList.add('show');
                errorEl.textContent = '暂无简化结果';
            }
        }
    }

    static updateSynonymDisplay() {
        if (!state.floatingWidget || !state.currentResult || !state.currentResult.synonyms) {
            console.log('Word Munch: 无法更新同义词显示 - 缺少必要数据');
            return;
        }
        
        const synonymEl = state.floatingWidget.querySelector('.wm-synonym');
        const simplifyBtn = state.floatingWidget.querySelector('.wm-simplify-btn');
        
        if (synonymEl && state.currentResult.synonyms.length > state.currentSynonymIndex) {
            const synonym = state.currentResult.synonyms[state.currentSynonymIndex];
            const synonymText = typeof synonym === 'string' ? synonym : synonym.word || '简化完成';
            
            synonymEl.textContent = synonymText;
            
            if (simplifyBtn) {
                if (state.currentSynonymIndex < state.currentResult.synonyms.length - 1) {
                    simplifyBtn.disabled = false;
                    simplifyBtn.title = `换一个 (${state.currentSynonymIndex + 1}/${state.currentResult.synonyms.length})`;
                } else {
                    simplifyBtn.disabled = true;
                    simplifyBtn.title = '已是最后一个';
                }
            }
        }
    }

    static showNextSynonym() {
        console.log('Word Munch: 切换到下一个同义词');
        
        if (!state.currentResult || !state.currentResult.synonyms) {
            console.log('Word Munch: 没有可用的同义词');
            return;
        }
        
        if (state.currentSynonymIndex < state.currentResult.synonyms.length - 1) {
            state.currentSynonymIndex++;
            this.updateSynonymDisplay();
        } else {
            console.log('Word Munch: 已是最后一个同义词');
        }
    }

    static copySynonymToClipboard() {
        if (!state.currentResult || !state.currentResult.synonyms || state.currentSynonymIndex >= state.currentResult.synonyms.length) return;
        
        const synonym = state.currentResult.synonyms[state.currentSynonymIndex];
        const synonymText = typeof synonym === 'string' ? synonym : synonym.word || '';
        
        if (synonymText) {
            navigator.clipboard.writeText(synonymText).then(() => {
                const copyBtn = state.floatingWidget.querySelector('.wm-copy-btn');
                if (copyBtn) {
                    copyBtn.classList.add('success');
                    
                    setTimeout(() => {
                        copyBtn.classList.remove('success');
                    }, 1000);
                }
            }).catch(err => {
                console.error('复制失败:', err);
                this.showSimpleToast('复制失败', 'error');
            });
        }
    }

    static showSimplificationError(error) {
        if (!state.floatingWidget) return;
        
        const loadingEl = state.floatingWidget.querySelector('.wm-loading');
        const resultEl = state.floatingWidget.querySelector('.wm-result');
        const errorEl = state.floatingWidget.querySelector('.wm-error');
        
        if (loadingEl) loadingEl.style.display = 'none';
        if (resultEl) resultEl.classList.remove('show');
        if (errorEl) {
            errorEl.classList.add('show');
            
            errorEl.innerHTML = `
                <div style="margin-bottom: 8px;">${error || '简化失败'}</div>
                <button class="wm-btn wm-btn-primary wm-retry-btn" style="width: auto; padding: 6px 12px; font-size: 12px;">
                    重试
                </button>
            `;
            
            const retryBtn = errorEl.querySelector('.wm-retry-btn');
            if (retryBtn) {
                retryBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.retrySimplification();
                });
            }
        }
    }

    static retrySimplification() {
        if (!state.currentSelection) return;
        
        console.log('Word Munch: 重试简化:', state.currentSelection.text);
        
        const errorEl = state.floatingWidget?.querySelector('.wm-error');
        const loadingEl = state.floatingWidget?.querySelector('.wm-loading');
        
        if (errorEl) errorEl.classList.remove('show');
        if (loadingEl) loadingEl.style.display = 'flex';
        
        const text = state.currentSelection.text;
        const type = TextValidator.isValidWord(text) ? 'word' : 'sentence';
        
        APIManager.startSimplification(text, type);
    }

    static showSimpleToast(message, type = 'success') {
        const existingToast = document.getElementById('word-munch-toast');
        if (existingToast) {
            existingToast.remove();
        }
        
        const toast = document.createElement('div');
        toast.id = 'word-munch-toast';
        toast.className = `word-munch-toast ${type}`;
        toast.textContent = message;
        
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.classList.add('show');
        }, 10);
        
        setTimeout(() => {
            toast.classList.remove('show');
            
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }, 3000);
    }
}

// === 理解分析器 ===
class ConceptAnalyzer {
    static fillContextInformation(selectedText) {
        // 重要：在理解分析前检查扩展状态
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: 扩展已禁用，取消理解分析');
            WidgetManager.closeFloatingWidget();
            return;
        }
        
        try {
            console.log('Word Munch: 开始提取上下文信息');
            
            const contextStrategy = this.determineContextStrategy(selectedText);
            console.log('Word Munch: Context策略:', contextStrategy);
            
            let contextInfo;
            
            switch (contextStrategy.type) {
                case 'full_context':
                    contextInfo = this.extractFullContext(selectedText);
                    break;
                case 'minimal_context':
                    contextInfo = this.extractMinimalContext(selectedText);
                    break;
                case 'no_context':
                    contextInfo = null;
                    break;
                case 'auto_extract':
                    contextInfo = 'auto_extract';
                    break;
                default:
                    contextInfo = null;
            }
            
            const costEstimate = this.estimateContextCost(contextStrategy, contextInfo);
            console.log('Word Munch: 成本估算:', costEstimate);
            
            const contextElement = state.floatingWidget?.querySelector('.concept-context-content');
            if (contextElement) {
                if (contextInfo === null) {
                    contextElement.textContent = '段落完整，无需上下文';
                    contextElement.style.fontStyle = 'italic';
                    contextElement.style.color = '#6b7280';
                } else if (contextInfo === 'auto_extract') {
                    contextElement.textContent = 'AI智能分析上下文';
                    contextElement.style.fontStyle = 'italic';
                    contextElement.style.color = '#8b5cf6';
                } else {
                    const displayText = contextInfo.length > 100 
                        ? contextInfo.substring(0, 97) + '...' 
                        : contextInfo;
                    contextElement.textContent = displayText;
                    contextElement.style.fontStyle = 'normal';
                    contextElement.style.color = '#374151';
                }
            }
            
            state.currentSelection.contextInfo = contextInfo;
            state.currentSelection.contextStrategy = contextStrategy;
            state.currentSelection.costEstimate = costEstimate;
            
        } catch (error) {
            console.error('Word Munch: 填充上下文信息失败:', error);
            const contextElement = state.floatingWidget?.querySelector('.concept-context-content');
            if (contextElement) {
                contextElement.textContent = '上下文提取失败';
            }
        }
    }

    static determineContextStrategy(selectedText) {
        const wordCount = selectedText.split(/\s+/).length;
        
        if (wordCount <= 5) {
            return {
                type: 'full_context',
                reason: '单词需要上下文',
                useContext: true,
                autoExtract: false,
                maxCost: 'low'
            };
        }
        
        if (wordCount >= 6 && wordCount <= 15) {
            return {
                type: 'minimal_context',
                reason: '短语需要基础上下文',
                useContext: true,
                autoExtract: false,
                maxCost: 'very_low'
            };
        }
        
        if (wordCount >= 16 && wordCount <= 40) {
            return {
                type: 'auto_extract',
                reason: '句子让AI自动分析',
                useContext: false,
                autoExtract: true,
                maxCost: 'medium'
            };
        }
        
        if (wordCount > 40) {
            return {
                type: 'no_context',
                reason: '段落无需额外上下文',
                useContext: false,
                autoExtract: false,
                maxCost: 'none'
            };
        }
        
        return {
            type: 'no_context',
            reason: '默认无上下文',
            useContext: false,
            autoExtract: false,
            maxCost: 'none'
        };
    }

    static extractFullContext(selectedText) {
        // 实现上下文提取逻辑
        return null; // 简化实现
    }

    static extractMinimalContext(selectedText) {
        // 实现最小上下文提取逻辑
        return null; // 简化实现
    }

    static estimateContextCost(contextStrategy, contextText) {
        let estimatedTokens = 50; // 基础prompt
        estimatedTokens += 20; // 用户理解
        estimatedTokens += Math.ceil(state.currentSelection?.text?.length / 4) || 0;
        
        if (contextText) {
            estimatedTokens += Math.ceil(contextText.length / 4);
        }
        
        if (contextStrategy.autoExtract) {
            estimatedTokens += 30;
        }
        
        return {
            estimatedTokens,
            estimatedCost: estimatedTokens * 0.00025,
            level: estimatedTokens < 100 ? 'low' : estimatedTokens < 200 ? 'medium' : 'high'
        };
    }

    static async startConceptAnalysis(originalText) {
        // 重要：在开始分析前检查扩展状态
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: 扩展已禁用，取消理解分析');
            WidgetManager.closeFloatingWidget();
            return;
        }
        
        const widget = state.floatingWidget;
        if (!widget) return;
        
        const understandingInput = widget.querySelector('.concept-understanding-input');
        const analyzeBtn = widget.querySelector('.concept-analyze-btn');
        const loadingElement = widget.querySelector('.concept-loading');
        const resultsElement = widget.querySelector('.concept-results');
        const errorElement = widget.querySelector('.concept-error');
        
        const userUnderstanding = understandingInput.value.trim();
        
        if (!userUnderstanding) {
            this.showConceptError('请输入您的理解');
            return;
        }
        
        try {
            analyzeBtn.disabled = true;
            loadingElement.style.display = 'block';
            resultsElement.style.display = 'none';
            errorElement.style.display = 'none';
            
            const contextStrategy = state.currentSelection.contextStrategy || { type: 'minimal_context', useContext: true, autoExtract: false };
            
            let finalContext = null;
            let autoExtractContext = false;
            
            switch (contextStrategy.type) {
                case 'full_context':
                case 'minimal_context':
                    finalContext = state.currentSelection.contextInfo;
                    autoExtractContext = false;
                    break;
                case 'no_context':
                    finalContext = null;
                    autoExtractContext = false;
                    break;
                case 'auto_extract':
                    finalContext = null;
                    autoExtractContext = true;
                    break;
            }
            
            this.sendConceptAnalysisMessage(originalText, userUnderstanding, finalContext, autoExtractContext);
            
        } catch (error) {
            console.error('Word Munch: 理解分析失败:', error);
            this.showConceptError(error.message);
            
            analyzeBtn.disabled = false;
            loadingElement.style.display = 'none';
        }
    }

    static sendConceptAnalysisMessage(originalText, userUnderstanding, context, autoExtractContext) {
        const messageId = Math.random().toString(36).substr(2, 9);
        const message = {
            type: 'CONCEPT_ANALYSIS',
            original_text: originalText,
            user_understanding: userUnderstanding,
            context: context,
            auto_extract_context: autoExtractContext,
            url: window.location.href,
            title: document.title,
            messageId: messageId,
            timestamp: Date.now(),
            cache_key: this.generateConceptCacheKey(originalText, userUnderstanding, context)
        };
        
        console.log('Word Munch: 发送理解分析消息到 background:', messageId);
        
        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    if (chrome.runtime.lastError.message.includes('Extension context invalidated')) {
                        console.log('Word Munch: 扩展上下文已失效，建议刷新页面');
                        this.showConceptError('扩展需要刷新，请刷新页面后重试');
                        return;
                    }
                    console.error('Word Munch: 理解分析消息发送失败:', chrome.runtime.lastError.message);
                    this.showConceptError('连接扩展失败，请重试');
                    return;
                }
                
                if (response) {
                    console.log('Word Munch: 收到 background 响应:', response);
                    
                    if (response.received) {
                        console.log('Word Munch: 理解分析消息已被 background 接收');
                    } else if (response.error) {
                        console.error('Word Munch: Background 处理错误:', response.error);
                        this.showConceptError(response.error);
                    }
                } else {
                    console.warn('Word Munch: 未收到 background 响应');
                    this.showConceptError('未收到响应，请重试');
                }
            });
        } catch (error) {
            if (error.message && error.message.includes('Extension context invalidated')) {
                console.log('Word Munch: 扩展上下文已失效，建议刷新页面');
                this.showConceptError('扩展需要刷新，请刷新页面后重试');
                return;
            }
            console.error('Word Munch: 发送理解分析消息异常:', error);
            this.showConceptError('发送请求失败，请重试');
        }
    }

    static generateConceptCacheKey(originalText, userUnderstanding, context) {
        const combinedText = `${originalText}||${userUnderstanding}||${context || ''}`;
        
        let hash = 0;
        for (let i = 0; i < combinedText.length; i++) {
            const char = combinedText.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        
        return Math.abs(hash).toString(36);
    }

    static showConceptError(message) {
        const widget = state.floatingWidget;
        if (!widget) return;
        
        const errorElement = widget.querySelector('.concept-error');
        if (errorElement) {
            errorElement.innerHTML = `
                <div class="concept-error-content">
                    ⚠️ ${message}
                </div>
            `;
            errorElement.style.display = 'block';
            
            setTimeout(() => {
                if (errorElement) {
                    errorElement.style.display = 'none';
                }
            }, 3000);
        }
    }

    static displayConceptResults(analysis) {
        const widget = state.floatingWidget;
        if (!widget) return;
        
        const resultsElement = widget.querySelector('.concept-results');
        if (!resultsElement) return;
        
        const scorePercentage = Math.round(analysis.overall_similarity * 100);
        const stats = analysis.analysis_stats;
        
        const resultsHTML = `
            <div class="concept-score-section">
                <div class="concept-score-card">
                    <div class="concept-score-value">${scorePercentage}%</div>
                    <div class="concept-score-label">理解相似度</div>
                </div>
                <div class="concept-stats">
                    <span class="concept-stat">📝 ${stats.total_segments}段</span>
                    <span class="concept-stat">✅ ${stats.high_similarity_count}优秀</span>
                    <span class="concept-stat">⚠️ ${stats.low_similarity_count}待提升</span>
                </div>
            </div>
            
            <div class="concept-suggestions">
                <div class="concept-suggestions-title">💡 改进建议</div>
                <ul class="concept-suggestions-list">
                    ${analysis.suggestions.map(suggestion => `<li>${suggestion}</li>`).join('')}
                </ul>
            </div>
            
            ${analysis.detailed_feedback ? this.renderConceptDetailedFeedback(analysis.detailed_feedback) : ''}
        `;
        
        resultsElement.innerHTML = resultsHTML;
        resultsElement.style.display = 'block';
        
        HighlightManager.highlightOriginalText(analysis.segments);
        
        if (widget) {
            widget.style.maxHeight = '80vh';
            widget.style.overflowY = 'auto';
        }
    }

    static renderConceptDetailedFeedback(feedback) {
        return `
            <div class="concept-detailed-feedback">
                <div class="concept-feedback-title">🎯 详细分析</div>
                
                <div class="concept-feedback-item">
                    <strong>🎓 认知层次:</strong> ${feedback.cognitive_level}
                </div>
                
                <div class="concept-feedback-item">
                    <strong>🚀 建议操作:</strong>
                    <ul>
                        ${feedback.actionable_suggestions.slice(0, 2).map(suggestion => `<li>${suggestion}</li>`).join('')}
                    </ul>
                </div>
            </div>
        `;
    }
}

// === 高亮管理器 ===
class HighlightManager {
    static highlightOriginalText(segments) {
        console.log('Word Munch: 开始在原文上显示滚动跟随高亮');
        
        this.clearOriginalHighlights();
        
        if (!state.currentSelection || !state.currentSelection.range) {
            console.log('Word Munch: 没有当前选择，无法高亮');
            return;
        }
        
        try {
            const originalRange = state.currentSelection.range;
            const originalText = state.currentSelection.text;
            
            state.highlightRanges = [];
            state.originalHighlightElements = [];
            
            let currentOffset = 0;
            segments.forEach((segment, index) => {
                const segmentStart = originalText.indexOf(segment.text, currentOffset);
                if (segmentStart === -1) return;
                
                try {
                    const segmentRange = document.createRange();
                    segmentRange.setStart(originalRange.startContainer, originalRange.startOffset + segmentStart);
                    segmentRange.setEnd(originalRange.startContainer, originalRange.startOffset + segmentStart + segment.text.length);
                    
                    const segmentRect = segmentRange.getBoundingClientRect();
                    
                    const highlight = document.createElement('div');
                    highlight.className = `word-munch-segment-highlight ${segment.level}`;
                    highlight.style.position = 'fixed';
                    highlight.style.left = `${segmentRect.left}px`;
                    highlight.style.top = `${segmentRect.top}px`;
                    highlight.style.width = `${segmentRect.width}px`;
                    highlight.style.height = `${segmentRect.height}px`;
                    highlight.style.pointerEvents = 'none';
                    highlight.style.borderRadius = '3px';
                    highlight.style.opacity = '0.3';
                    highlight.style.zIndex = '9999';
                    highlight.style.transition = 'all 0.1s ease-out';
                    
                    const colors = {
                        'excellent': '#059669',
                        'good': '#16a34a',
                        'fair': '#ca8a04',
                        'partial': '#ea580c',
                        'poor': '#ef4444'
                    };
                    highlight.style.backgroundColor = colors[segment.level] || '#6b7280';
                    
                    document.body.appendChild(highlight);
                    
                    const highlightInfo = {
                        element: highlight,
                        range: segmentRange.cloneRange(),
                        level: segment.level,
                        text: segment.text
                    };
                    
                    state.highlightRanges.push(highlightInfo);
                    state.originalHighlightElements.push(highlight);
                    
                    currentOffset = segmentStart + segment.text.length;
                    
                } catch (error) {
                    console.warn('Word Munch: 创建 segment 高亮失败:', error);
                }
            });
            
            console.log('Word Munch: 高亮创建完成，共', state.highlightRanges.length, '个高亮元素');
            
            this.startScrollTracking();
            
        } catch (error) {
            console.error('Word Munch: 原文高亮失败:', error);
        }
    }

    static startScrollTracking() {
        if (state.isScrollTracking) return;
        
        state.isScrollTracking = true;
        console.log('Word Munch: 开始零延迟滚动跟踪');
        
        function instantUpdate() {
            this.updateAllHighlightPositions();
        }
        
        const updateHandler = state.highlightRanges.length <= 5 ? 
            instantUpdate.bind(this) : 
            (() => {
                let pending = false;
                return () => {
                    if (!pending) {
                        pending = true;
                        setTimeout(() => {
                            this.updateAllHighlightPositions();
                            pending = false;
                        }, 1);
                    }
                };
            })();
        
        window.addEventListener('scroll', updateHandler, { passive: true });
        window.addEventListener('resize', updateHandler, { passive: true });
        window.highlightScrollHandler = updateHandler;
    }

    static stopScrollTracking() {
        if (!state.isScrollTracking) return;
        
        state.isScrollTracking = false;
        console.log('Word Munch: 停止滚动跟踪');
        
        if (window.highlightScrollHandler) {
            window.removeEventListener('scroll', window.highlightScrollHandler);
            window.removeEventListener('resize', window.highlightScrollHandler);
            window.highlightScrollHandler = null;
        }
        
        if (state.scrollUpdateTimer) {
            clearTimeout(state.scrollUpdateTimer);
            state.scrollUpdateTimer = null;
        }
    }

    static updateAllHighlightPositions() {
        if (!state.highlightRanges || state.highlightRanges.length === 0) {
            return;
        }
        
        state.highlightRanges.forEach((highlightInfo, index) => {
            try {
                const newRect = highlightInfo.range.getBoundingClientRect();
                
                const isVisible = newRect.top < window.innerHeight && 
                               newRect.bottom > 0 && 
                               newRect.width > 0 && 
                               newRect.height > 0;
                
                if (isVisible) {
                    highlightInfo.element.style.left = `${newRect.left}px`;
                    highlightInfo.element.style.top = `${newRect.top}px`;
                    highlightInfo.element.style.width = `${newRect.width}px`;
                    highlightInfo.element.style.height = `${newRect.height}px`;
                    highlightInfo.element.style.opacity = '0.3';
                    highlightInfo.element.style.display = 'block';
                } else {
                    highlightInfo.element.style.opacity = '0';
                }
                
            } catch (error) {
                console.warn('Word Munch: 更新高亮位置失败:', error);
                if (highlightInfo.element) {
                    highlightInfo.element.style.opacity = '0';
                }
            }
        });
    }

    static clearOriginalHighlights() {
        console.log('Word Munch: 清理原文高亮');
        
        this.stopScrollTracking();
        
        state.originalHighlightElements.forEach(element => {
            if (element.parentNode) {
                element.parentNode.removeChild(element);
            }
        });
        state.originalHighlightElements = [];
        state.highlightRanges = [];
        
        console.log('Word Munch: 原文高亮已清理');
    }
}

// === 消息处理器 ===
class MessageHandlers {
    static handleWordSimplified(word, result) {
        console.log('Word Munch: 词汇简化完成:', word, result);
        
        if (!state.floatingWidget || !state.currentSelection || state.currentSelection.text !== word) {
            console.log('Word Munch: 结果不匹配当前状态，忽略');
            return;
        }
        
        if (state.requestTimeout) {
            clearTimeout(state.requestTimeout);
            state.requestTimeout = null;
        }
        
        state.lastWordText = word;
        state.lastWordResult = result;
        state.lastResultTime = Date.now();
        
        ResultDisplayer.showSimplificationResult(result);
        state.currentRequestId = null;
    }

    static handleConceptAnalyzed(original_text, result) {
        console.log('Word Munch: 理解分析完成:', original_text, result);
        
        if (!state.floatingWidget || !state.currentSelection || !state.isConceptMode || state.currentSelection.text !== original_text) {
            console.log('Word Munch: 理解分析结果不匹配当前状态，忽略');
            return;
        }
        
        state.currentConceptAnalysis = result;
        ConceptAnalyzer.displayConceptResults(result);
        
        const loadingElement = state.floatingWidget.querySelector('.concept-loading');
        if (loadingElement) {
            loadingElement.style.display = 'none';
        }
    }

    static handleSimplifyError(word, error) {
        console.error('Word Munch: 简化失败:', word, error);
        
        if (!state.floatingWidget || !state.currentSelection || state.currentSelection.text !== word) {
            console.log('Word Munch: 错误不匹配当前状态，忽略');
            return;
        }
        
        if (state.requestTimeout) {
            clearTimeout(state.requestTimeout);
            state.requestTimeout = null;
        }
        
        state.currentRequestId = null;
        ResultDisplayer.showSimplificationError(error);
    }

    static handleConceptAnalysisError(text, error) {
        console.error('Word Munch: 理解分析失败:', text, error);
        
        if (!state.floatingWidget || !state.currentSelection || !state.isConceptMode || state.currentSelection.text !== text) {
            console.log('Word Munch: 理解分析错误不匹配当前状态，忽略');
            return;
        }
        
        ConceptAnalyzer.showConceptError(error);
        
        const loadingElement = state.floatingWidget.querySelector('.concept-loading');
        if (loadingElement) {
            loadingElement.style.display = 'none';
        }
        
        const analyzeBtn = state.floatingWidget.querySelector('.concept-analyze-btn');
        if (analyzeBtn) {
            analyzeBtn.disabled = false;
        }
    }

    static handleSettingsUpdated(settings) {
        console.log('Word Munch: 设置已更新:', settings);
        
        // 更新本地设置状态
        state.extensionSettings = { ...state.extensionSettings, ...settings };
        
        if (settings.hasOwnProperty('conceptMuncherEnabled')) {
            console.log('Word Munch: 理解分析功能状态:', settings.conceptMuncherEnabled);
        }
        
        // 如果扩展被禁用，立即关闭所有窗口和清理状态
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: 扩展已禁用，立即关闭所有窗口和清理状态');
            WidgetManager.closeFloatingWidget();
            HighlightManager.clearOriginalHighlights();
            
            // 清理所有定时器和请求
            state.cancelCurrentRequest();
            
            // 重置所有状态
            state.reset();
            
            console.log('Word Munch: 扩展禁用后清理完成');
        }
    }
}

// === 初始化 ===
const eventManager = new EventManager();

// 页面加载完成后的初始化
document.addEventListener('DOMContentLoaded', async function() {
    console.log('Word Munch: Content script 已加载');
    
    // 首先加载设置
    await state.loadSettings();
    
    // 通知 background script content script 已准备就绪
    APIManager.sendMessageToBackground({
        type: 'CONTENT_SCRIPT_READY',
        url: window.location.href
    });
});

if (document.readyState !== 'loading') {
    console.log('Word Munch: Content script 已加载（页面已完成）');
    
    // 立即加载设置
    state.loadSettings().then(() => {
        setTimeout(() => {
            APIManager.sendMessageToBackground({
                type: 'CONTENT_SCRIPT_READY',
                url: window.location.href
            });
        }, 100);
    });
}

// 错误处理
window.addEventListener('error', function(event) {
    console.error('Word Munch: Content script 错误:', event.error);
});

// 清理资源
window.addEventListener('beforeunload', function() {
    console.log('Word Munch: 页面卸载，清理高亮资源');
    HighlightManager.stopScrollTracking();
    HighlightManager.clearOriginalHighlights();
});

console.log('Word Munch: Content script 初始化完成');

// === 调试函数 ===
window.debugHighlights = function() {
    console.log('Word Munch: 高亮调试信息:');
    console.log('- 滚动跟踪状态:', state.isScrollTracking);
    console.log('- 高亮数量:', state.highlightRanges.length);
    console.log('- 高亮元素数量:', state.originalHighlightElements.length);
    console.log('- 高亮数据:', state.highlightRanges);
    
    HighlightManager.updateAllHighlightPositions();
    
    return {
        tracking: state.isScrollTracking,
        highlightCount: state.highlightRanges.length,
        elementCount: state.originalHighlightElements.length
    };
};

window.getConceptMuncherStatus = function() {
    return {
        isConceptMode: state.isConceptMode,
        hasConceptAnalysis: !!state.currentConceptAnalysis,
        isEnabled: state.extensionSettings.conceptMuncherEnabled,
        currentSelection: state.currentSelection?.text?.substring(0, 50) + '...',
        hasFloatingWidget: !!state.floatingWidget
    };
};

// 新增：获取扩展状态的调试函数
window.getExtensionStatus = function() {
    return {
        settingsLoaded: state.settingsLoaded,
        extensionEnabled: state.extensionSettings.extensionEnabled,
        allSettings: state.extensionSettings,
        hasCurrentSelection: !!state.currentSelection,
        hasFloatingWidget: !!state.floatingWidget,
        isConceptMode: state.isConceptMode
    };
};

// 新增：手动重新加载设置的函数
window.reloadExtensionSettings = async function() {
    console.log('Word Munch: 手动重新加载设置');
    await state.loadSettings();
    console.log('Word Munch: 设置重新加载完成:', state.extensionSettings);
    return state.extensionSettings;
};

// === 简单阅读模式 ===
class SimpleReaderMode {
    constructor() {
        this.isReaderActive = false;
        this.originalScrollPosition = 0;
        this.isChunkedMode = false;
        this.isColorMode = false;
        this.focusMode = 'balanced';
        this.chunks = [];
        this.currentChunkIndex = -1;
        this.keyboardHandler = null;
        this.keyPressTimer = null;
        this.loadFocusSettings();
        this.setupReaderMessageListener();
    }

    loadFocusSettings() {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.sync.get(['focusMode'], (result) => {
                this.focusMode = result.focusMode || 'balanced';
                console.log('Word Munch: 加载专注模式设置:', this.focusMode);
            });
        }
    }

    setupReaderMessageListener() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.type === 'TOGGLE_READER_MODE') {
                console.log('Word Munch: 收到阅读模式切换消息');
                try {
                    this.toggleReaderMode();
                    sendResponse({ success: true });
                } catch (error) {
                    console.error('Word Munch: 阅读模式切换失败:', error);
                    sendResponse({ success: false, error: error.message });
                }
                return false;
            }
            
            if (message.type === 'CHECK_READER_STATUS') {
                console.log('Word Munch: 检查阅读模式状态:', this.isReaderActive);
                sendResponse({ 
                    isReaderActive: this.isReaderActive,
                    success: true 
                });
                return false;
            }

            if (message.type === 'UPDATE_FOCUS_MODE') {
                this.focusMode = message.mode;
                console.log('Word Munch: 更新专注模式为:', this.focusMode);
                
                if (this.isFocusMode) {
                    this.applyFocusMode();
                }
                sendResponse({ success: true });
                return false;
            }
            
            return false;
        });
    }

    async toggleReaderMode() {
        if (this.isReaderActive) {
            this.exitReaderMode();
        } else {
            await this.activateReaderMode();
        }
    }

    async activateReaderMode() {
        try {
            console.log('Word Munch: 激活简单阅读模式');
            
            if (typeof Readability === 'undefined') {
                console.error('Word Munch: Readability 库未加载');
                alert('Readability 库未加载，请刷新页面重试');
                return;
            }

            if (typeof isProbablyReaderable === 'function') {
                const isReadable = isProbablyReaderable(document);
                console.log('Word Munch: 页面可读性检查:', isReadable);
                
                if (!isReadable) {
                    const proceed = confirm('当前页面可能不适合阅读模式，是否继续？');
                    if (!proceed) return;
                }
            }

            if (typeof state.floatingWidget !== 'undefined' && state.floatingWidget) {
                console.log('Word Munch: 关闭现有浮动窗口');
                WidgetManager.closeFloatingWidget();
            }

            this.originalScrollPosition = window.scrollY;
            console.log('Word Munch: 保存滚动位置:', this.originalScrollPosition);

            const documentClone = document.cloneNode(true);
            this.fixRelativeUrls(documentClone);
            
            const reader = new Readability(documentClone, {
                debug: false,
                charThreshold: 200,
                keepClasses: false
            });

            const article = reader.parse();

            if (!article || !article.textContent || article.textContent.trim().length === 0) {
                console.error('Word Munch: 无法提取文章内容');
                alert('无法提取文章内容');
                return;
            }

            this.chunks = await this.createTextChunks(article.textContent);
            this.originalArticleContent = article.content;
            this.renderSimpleReader(article);
            this.isReaderActive = true;
            
            console.log('Word Munch: 简单阅读模式已激活');

        } catch (error) {
            console.error('Word Munch: 激活阅读模式失败:', error);
            alert('阅读模式启动失败：' + error.message);
        }
    }

    renderSimpleReader(article) {
        console.log('Word Munch: 开始渲染阅读器');
        
        const readerContainer = document.createElement('div');
        readerContainer.id = 'word-munch-reader-container';
        readerContainer.innerHTML = this.getReaderContentHTML(article);
        
        document.body.appendChild(readerContainer);
        
        Array.from(document.body.children).forEach(child => {
            if (child.id !== 'word-munch-reader-container' && 
                !child.id?.includes('word-munch') &&
                !child.classList?.contains('word-munch-floating-widget') &&
                !child.classList?.contains('word-munch-tooltip') &&
                !child.classList?.contains('word-munch-toast') &&
                !child.classList?.contains('word-munch-highlight')) {
                child.style.display = 'none';
            }
        });
        
        this.bindExitEvent();
    }

    getReaderContentHTML(article) {
        return `
            <div class="reader-container">
                <div class="reader-header">
                    <div class="header-controls">
                        <div class="left-controls">
                            <button id="exitReaderBtn" class="exit-btn">← 退出阅读</button>
                        </div>
                        <div class="right-controls">
                            <button id="chunkToggleBtn" class="control-btn">📑 分段模式</button>
                            <button id="colorToggleBtn" class="control-btn" style="display:none;">🌈 彩色分段</button>
                        </div>
                    </div>
                    
                    <h1 class="article-title">${article.title}</h1>
                    ${article.byline ? `<div class="article-byline">作者：${article.byline}</div>` : ''}
                </div>
                
                <div class="reader-content" id="readerContent">
                    ${article.content}
                </div>
            </div>
        `;
    }

    bindExitEvent() {
        this.removeKeyboardListener();
        
        const exitBtn = document.getElementById('exitReaderBtn');
        if (exitBtn) {
            exitBtn.addEventListener('click', () => this.exitReaderMode());
        }

        const chunkToggleBtn = document.getElementById('chunkToggleBtn');
        if (chunkToggleBtn) {
            chunkToggleBtn.addEventListener('click', () => this.toggleChunkedMode());
        }

        const colorToggleBtn = document.getElementById('colorToggleBtn');
        if (colorToggleBtn) {
            colorToggleBtn.addEventListener('click', () => this.toggleColorMode());
        }

        this.keyboardHandler = (e) => {
            if (this.keyPressTimer) return;
            
            if (e.key === 'Escape') {
                if (this.isFocusMode) {
                    this.exitFocusMode();
                } else {
                    this.exitReaderMode();
                }
                return;
            }
            
            if (this.isChunkedMode && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                e.stopPropagation();
                
                this.keyPressTimer = setTimeout(() => {
                    this.keyPressTimer = null;
                }, 200);
                
                this.navigateChunks(e.key === 'ArrowDown' ? 'next' : 'prev');
            }
        };

        document.addEventListener('keydown', this.keyboardHandler);
    }

    removeKeyboardListener() {
        if (this.keyboardHandler) {
            document.removeEventListener('keydown', this.keyboardHandler);
            this.keyboardHandler = null;
        }
        
        if (this.keyPressTimer) {
            clearTimeout(this.keyPressTimer);
            this.keyPressTimer = null;
        }
    }

    exitReaderMode() {
        console.log('Word Munch: 退出阅读模式');
        
        this.removeKeyboardListener();
        
        const readerContainer = document.getElementById('word-munch-reader-container');
        if (readerContainer) {
            readerContainer.remove();
        }
        
        Array.from(document.body.children).forEach(child => {
            if (child.style.display === 'none' && 
                !child.id?.includes('word-munch') &&
                !child.classList?.contains('word-munch-floating-widget') &&
                !child.classList?.contains('word-munch-tooltip') &&
                !child.classList?.contains('word-munch-toast') &&
                !child.classList?.contains('word-munch-highlight')) {
                child.style.display = '';
            }
        });
        
        setTimeout(() => {
            window.scrollTo(0, this.originalScrollPosition);
        }, 100);
        
        this.isReaderActive = false;
        this.isChunkedMode = false;
        this.isColorMode = false;
        this.isFocusMode = false;
        this.currentChunkIndex = -1;
    }

    async createTextChunks(textContent) {
        console.log('Word Munch: 创建文本分段');
        
        try {
            if (typeof window.createFiveLanguageChunker === 'function') {
                const semanticChunker = window.createFiveLanguageChunker({
                    targetLength: 600,
                    maxLength: 800,
                    minLength: 150
                });
                
                const chunks = await semanticChunker.createChunks(textContent);
                console.log('Word Munch: 语义分段完成，共', chunks.length, '段');
                return chunks;
            }
        } catch (error) {
            console.error('Word Munch: 语义分段失败，使用原始方法:', error);
        }
        
        return this.createTextChunksOriginal(textContent);
    }

    createTextChunksOriginal(textContent) {
        const cleanText = textContent.replace(/\s+/g, ' ').trim();
        
        const sentences = cleanText
            .split(/[.!?。！？；;]\s+/)
            .map(s => s.trim())
            .filter(s => s.length > 15);

        const chunks = [];
        let currentChunk = '';
        const targetLength = 600;
        const maxLength = 800;

        for (const sentence of sentences) {
            const testChunk = currentChunk + (currentChunk ? ' ' : '') + sentence + '。';
            
            if (testChunk.length > targetLength && currentChunk) {
                if (testChunk.length < maxLength) {
                    currentChunk = testChunk.slice(0, -1);
                } else {
                    chunks.push(currentChunk + '。');
                    currentChunk = sentence;
                }
            } else {
                currentChunk = testChunk.slice(0, -1);
            }
        }

        if (currentChunk.trim()) {
            chunks.push(currentChunk + '。');
        }

        const rawChunks = chunks.filter(chunk => chunk.length > 50);
        return this.optimizeChunkCount(rawChunks);
    }

    optimizeChunkCount(chunks) {
        const totalText = chunks.join(' ').length;
        const idealChunkCount = Math.max(5, Math.min(8, Math.ceil(totalText / 500)));
        
        if (chunks.length <= idealChunkCount) {
            return chunks;
        }
        
        const optimized = [];
        let currentMerged = '';
        
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const testMerged = currentMerged + (currentMerged ? ' ' : '') + chunk;
            
            if (testMerged.length <= 700 && optimized.length < idealChunkCount - 1) {
                currentMerged = testMerged;
            } else {
                if (currentMerged) {
                    optimized.push(currentMerged);
                    currentMerged = chunk;
                } else {
                    optimized.push(chunk);
                }
            }
        }
        
        if (currentMerged) {
            optimized.push(currentMerged);
        }
        
        return optimized;
    }

    toggleChunkedMode() {
        this.isChunkedMode = !this.isChunkedMode;
        const readerContent = document.getElementById('readerContent');
        const chunkToggleBtn = document.getElementById('chunkToggleBtn');
        const colorToggleBtn = document.getElementById('colorToggleBtn');

        if (this.isChunkedMode) {
            this.renderChunkedContent(readerContent);
            chunkToggleBtn.textContent = '📄 普通模式';
            chunkToggleBtn.classList.add('active');
            if (colorToggleBtn) colorToggleBtn.style.display = 'block';
            
            this.currentChunkIndex = -1;
            this.isFocusMode = false;
        } else {
            this.renderNormalContent(readerContent);
            chunkToggleBtn.textContent = '📑 分段模式';
            chunkToggleBtn.classList.remove('active');
            if (colorToggleBtn) {
                colorToggleBtn.style.display = 'none';
                this.isColorMode = false;
                readerContent.classList.remove('color-mode');
            }
            
            this.exitFocusMode();
        }
    }

    renderChunkedContent(container) {
        const chunkedHTML = this.chunks.map((chunk, index) => `
            <div class="text-chunk" data-chunk-index="${index}">
                <div class="chunk-number">${index + 1}</div>
                <div class="chunk-text">${chunk}</div>
            </div>
        `).join('');

        container.innerHTML = chunkedHTML;
        container.classList.add('chunked-mode');

        container.querySelectorAll('.text-chunk').forEach((chunk, index) => {
            chunk.addEventListener('click', () => {
                this.currentChunkIndex = index;
                this.focusChunk(chunk, index);
            });
            
            chunk.addEventListener('dblclick', () => {
                if (this.isFocusMode) {
                    this.exitFocusMode();
                }
            });
        });

        this.currentChunkIndex = -1;
        container.classList.remove('focus-mode');
        this.isFocusMode = false;
    }

    renderNormalContent(container) {
        if (this.originalArticleContent) {
            container.innerHTML = this.originalArticleContent;
            container.classList.remove('chunked-mode', 'color-mode', 'focus-mode');
            this.currentChunkIndex = -1;
            this.isFocusMode = false;
        }
    }

    navigateChunks(direction) {
        const chunks = document.querySelectorAll('.text-chunk');
        if (chunks.length === 0) return;

        let newIndex;
        
        if (direction === 'next') {
            newIndex = (this.currentChunkIndex + 1) % chunks.length;
        } else {
            newIndex = this.currentChunkIndex <= 0 ? chunks.length - 1 : this.currentChunkIndex - 1;
        }

        this.focusChunkByIndex(newIndex);
    }

    focusChunkByIndex(index) {
        const chunks = document.querySelectorAll('.text-chunk');
        if (index < 0 || index >= chunks.length) return;

        this.currentChunkIndex = index;
        this.focusChunk(chunks[index], index);
    }

    focusChunk(chunkElement, index) {
        const readerContent = document.getElementById('readerContent');
        
        document.querySelectorAll('.text-chunk').forEach(chunk => {
            chunk.classList.remove('focused');
        });
        
        chunkElement.classList.add('focused');
        
        if (readerContent) {
            readerContent.classList.add('focus-mode');
            this.applyFocusMode();
            this.isFocusMode = true;
        }
        
        chunkElement.scrollIntoView({ 
            behavior: 'smooth', 
            block: 'center' 
        });
    }

    applyFocusMode() {
        const readerContent = document.getElementById('readerContent');
        if (!readerContent) return;
        
        readerContent.classList.remove('focus-gentle', 'focus-balanced', 'focus-focused', 'focus-minimal');
        readerContent.classList.add(`focus-${this.focusMode}`);
        this.updateAdjacentChunks();
    }

    updateAdjacentChunks() {
        const chunks = document.querySelectorAll('.text-chunk');
        
        chunks.forEach(chunk => chunk.classList.remove('adjacent'));
        
        if (this.currentChunkIndex >= 0 && this.currentChunkIndex < chunks.length) {
            if (this.currentChunkIndex > 0) {
                chunks[this.currentChunkIndex - 1].classList.add('adjacent');
            }
            if (this.currentChunkIndex < chunks.length - 1) {
                chunks[this.currentChunkIndex + 1].classList.add('adjacent');
            }
        }
    }

    exitFocusMode() {
        const readerContent = document.getElementById('readerContent');
        
        document.querySelectorAll('.text-chunk').forEach(chunk => {
            chunk.classList.remove('focused', 'adjacent');
        });
        
        if (readerContent) {
            readerContent.classList.remove('focus-mode', 'focus-gentle', 'focus-balanced', 'focus-focused', 'focus-minimal');
            this.isFocusMode = false;
        }
        
        this.currentChunkIndex = -1;
    }

    toggleColorMode() {
        this.isColorMode = !this.isColorMode;
        const readerContent = document.getElementById('readerContent');
        const colorToggleBtn = document.getElementById('colorToggleBtn');

        if (this.isColorMode) {
            readerContent.classList.add('color-mode');
            colorToggleBtn.textContent = '⚪ 统一颜色';
            colorToggleBtn.classList.add('active');
        } else {
            readerContent.classList.remove('color-mode');
            colorToggleBtn.textContent = '🌈 彩色分段';
            colorToggleBtn.classList.remove('active');
        }
    }

    fixRelativeUrls(doc) {
        const baseUrl = window.location.origin + window.location.pathname;
        const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        
        const images = doc.querySelectorAll('img[src]');
        images.forEach(img => {
            const src = img.getAttribute('src');
            if (src && !src.startsWith('http') && !src.startsWith('data:')) {
                if (src.startsWith('/')) {
                    img.setAttribute('src', window.location.origin + src);
                } else if (src.startsWith('./') || !src.includes('/')) {
                    img.setAttribute('src', baseDir + src.replace('./', ''));
                }
            }
        });
        
        const lazyImages = doc.querySelectorAll('img[data-src]');
        lazyImages.forEach(img => {
            const dataSrc = img.getAttribute('data-src');
            if (dataSrc) {
                if (!dataSrc.startsWith('http') && !dataSrc.startsWith('data:')) {
                    if (dataSrc.startsWith('/')) {
                        img.setAttribute('src', window.location.origin + dataSrc);
                    } else {
                        img.setAttribute('src', baseDir + dataSrc.replace('./', ''));
                    }
                } else {
                    img.setAttribute('src', dataSrc);
                }
                img.removeAttribute('data-src');
            }
        });
        
        const links = doc.querySelectorAll('a[href]');
        links.forEach(link => {
            const href = link.getAttribute('href');
            if (href && !href.startsWith('http') && !href.startsWith('#') && !href.startsWith('mailto:')) {
                if (href.startsWith('/')) {
                    link.setAttribute('href', window.location.origin + href);
                } else {
                    link.setAttribute('href', baseDir + href.replace('./', ''));
                }
            }
        });
    }
}

// 初始化简单阅读器
const simpleReader = new SimpleReaderMode();