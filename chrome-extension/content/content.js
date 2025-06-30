// ========== Word Munch Content Script ==========

// === Configuration Constants ===
const CONFIG = {
    CONCEPT_API_ENDPOINT: 'https://4gjsn9p4kc.execute-api.us-east-1.amazonaws.com/dev/concept-muncher',
    MIN_WORDS_FOR_CONCEPT: 6,
    MEMORY_CACHE_TIME: 3000
};

// === Global State Management ===
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
            console.log('Word Munch: Settings loaded:', this.extensionSettings);
            
        } catch (error) {
            console.error('Word Munch: Failed to load settings:', error);
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
        console.log('Word Munch: Cancel current request');
        
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

// === Event Listener Management ===
class EventManager {
    constructor() {
        this.selectionTimer = null;
        this.setupMainListeners();
    }

    setupMainListeners() {
        document.addEventListener('mouseup', this.handleTextSelection.bind(this));
        document.addEventListener('keyup', this.handleTextSelection.bind(this));
        document.addEventListener('dblclick', this.handleTextSelection.bind(this));
        
        // Chrome message listener
        chrome.runtime.onMessage.addListener(this.handleChromeMessage.bind(this));
    }

    handleTextSelection(event) {
        const selection = window.getSelection();
        const selectedText = selection.toString().trim();
        
        console.log('Word Munch: Text selection event triggered, selected text:', selectedText);

        // Fast processing of word selection in understanding analysis mode
        if (state.isConceptMode && state.highlightRanges && state.highlightRanges.length > 0) {
            if (selectedText && TextValidator.isValidWord(selectedText)) {
                console.log('Word Munch: Select word in highlight area, create independent word window');
                WidgetManager.createIndependentWordWindow(selectedText, selection);
                return;
            }
        }
        
        // Check if in reading mode
        const isInReaderMode = document.getElementById('word-munch-reader-container');
        if (isInReaderMode) {
            console.log('Word Munch: In reader mode, ensure text selection works normally');
            // In reading mode, we need to ensure that text selection is not interfered with by other events
            if (selectedText && selectedText.length > 0) {
                // Delay processing to ensure the selection event is completed
                setTimeout(() => {
                    this.processTextSelectionInReaderMode(selectedText, selection);
                }, 10);
                return;
            }
        }
        
        // Wait for settings to load before checking extension status
        if (!state.settingsLoaded) {
            console.log('Word Munch: Settings not loaded yet, delay processing');
            setTimeout(() => {
                this.handleTextSelection(event);
            }, 100);
            return;
        }
        
        // Check if extension is disabled
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: Extension disabled, skip processing');
            return;
        }
        
        // Process empty selection - but avoid triggering when normal selection is happening
        if (!selectedText || selectedText.length === 0) {
            // Only close the floating widget when not in understanding analysis mode and no selection is being processed
            if (!state.isConceptMode && !state.currentSelection) {
                console.log('Word Munch: Empty selection, close floating widget');
                WidgetManager.closeFloatingWidget();
            }
            return;
        }
        
        // Avoid processing the same text repeatedly - but check if the window really exists and is visible
        if (state.currentSelection && 
            state.currentSelection.text === selectedText && 
            state.floatingWidget && 
            state.floatingWidget.classList.contains('show')) {
            console.log('Word Munch: Duplicate selection of same text and widget visible, skip processing');
            return;
        }

        // Reduce debounce delay to avoid fast selection failure
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

    // 在阅读模式中处理文本选择
    processTextSelectionInReaderMode(selectedText, selection) {
        console.log('Word Munch: Text selection in reader mode:', selectedText);
        
        // 检查扩展是否启用
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: Extension disabled, skip processing in reader mode');
            return;
        }
        
        // 在阅读模式中，使用正常的处理逻辑
        this.processTextSelection({
            text: selectedText,
            selection: selection,
            range: selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null,
            timestamp: Date.now(),
            isInReaderMode: true // 标记这是来自阅读模式的选择
        });
    }

    processTextSelection(selectionData) {
        const { text, selection, range, isInReaderMode } = selectionData;
        
        console.log('Word Munch: Start processing text selection:', text, isInReaderMode ? '(Reader Mode)' : '');
        
        // 再次检查扩展状态（防止在防抖延迟期间状态改变）
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: Extension disabled during processing, cancel processing');
            return;
        }
        
        // 取消之前的请求但不关闭窗口
        state.cancelCurrentRequest();
        
        // 保存当前选择
        state.currentSelection = {
            text: text,
            selection: selection,
            range: range,
            isInReaderMode: isInReaderMode || false
        };
        
        console.log('Word Munch: Set current selection:', text);
        
        // 根据文本类型决定处理方式
        if (TextValidator.isValidWord(text)) {
            console.log('Word Munch: Identified as valid word, show word window');
            WidgetManager.showFloatingWidget(text, selection, 'word');
        } else if (TextValidator.isValidSentence(text) && state.extensionSettings.conceptMuncherEnabled) {
            console.log('Word Munch: Identified as valid sentence, show concept analysis window');
            WidgetManager.showFloatingWidget(text, selection, 'sentence');
        } else if (TextValidator.isValidSentence(text)) {
            console.log('Word Munch: Identified as sentence but concept analysis disabled, use word mode');
            WidgetManager.showFloatingWidget(text, selection, 'sentence');
        } else {
            console.log('Word Munch: Invalid text, close window');
            WidgetManager.closeFloatingWidget();
        }
    }

    handleChromeMessage(message, sender, sendResponse) {
        console.log('Word Munch: Received background message:', message.type);
        
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
                    console.log('Word Munch: Unknown message type:', message.type);
            }
            
            sendResponse({ received: true, timestamp: Date.now() });
        } catch (error) {
            console.error('Word Munch: Failed to handle background message:', error);
            sendResponse({ error: error.message });
        }
        
        return false;
    }

    addOutsideClickListener() {
        if (!state.outsideClickListenerActive) {
            document.addEventListener('click', this.handleOutsideClick.bind(this), true);
            state.outsideClickListenerActive = true;
            console.log('Word Munch: Outside click listener added');
        }
    }

    removeOutsideClickListener() {
        if (state.outsideClickListenerActive) {
            document.removeEventListener('click', this.handleOutsideClick.bind(this), true);
            state.outsideClickListenerActive = false;
            console.log('Word Munch: Outside click listener removed');
        }
    }

    handleOutsideClick(event) {
        console.log('Word Munch: Outside click event triggered, target:', event.target.tagName);
        
        if (state.isDragging || !state.floatingWidget) {
            console.log('Word Munch: Skip outside click handling - dragging or no widget');
            return;
        }
        
        // 如果点击的是浮动窗口内部，不关闭
        if (state.floatingWidget.contains(event.target)) {
            console.log('Word Munch: Click inside floating widget, do not close');
            return;
        }
        
        // 特别检查：如果是理解分析模式，确保输入框相关的点击不会关闭窗口
        if (state.isConceptMode) {
            const clickedElement = event.target;
            if (clickedElement.tagName === 'INPUT' || 
                clickedElement.tagName === 'TEXTAREA' ||
                clickedElement.contentEditable === 'true' ||
                clickedElement.closest('.concept-understanding-input-minimal') ||
                clickedElement.closest('.concept-content-minimal')) {
                console.log('Word Munch: Click in input area, do not close concept analysis window');
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
                console.log('Word Munch: Click within selected area, do not close');
                return;
            }
        }
        
        console.log('Word Munch: Confirmed outside click, close floating widget');
        WidgetManager.closeFloatingWidget();
    }
}

// === 文本验证器 ===
class TextValidator {
    static isValidWord(text) {
        if (!text || text.length === 0) {
            console.log('Word Munch: Text validation failed - empty text');
            return false;
        }
        
        if (/\s/.test(text)) {
            console.log('Word Munch: Text validation failed - contains spaces:', text);
            return false;
        }
        
        const wordCount = text.split(/\s+/).length;
        if (wordCount >= CONFIG.MIN_WORDS_FOR_CONCEPT) {
            console.log('Word Munch: Text validation failed - word count exceeds threshold:', wordCount, 'vs', CONFIG.MIN_WORDS_FOR_CONCEPT);
            return false;
        }
        
        // 修复：扩展词汇长度限制，支持更长的英文单词
        const wordRegex = /^[\p{L}]{1,20}$/u;  // 从1-10改为1-20字符
        const isValid = wordRegex.test(text);
        
        // 额外检查：确保是合理的英文单词（允许常见的长单词）
        if (!isValid && /^[a-zA-Z]+$/.test(text) && text.length <= 20) {
            console.log('Word Munch: Passed through English word alternative validation:', text);
            return true;
        }
        
        console.log('Word Munch: Text validation result:', text, '-> Valid word:', isValid, 'Length:', text.length);
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
// === 改进的窗口管理器 - 优化 Concept Muncher 定位 ===
class WidgetManager {
    static showFloatingWidget(text, selection, type) {
        console.log('Word Munch: Show floating widget:', text, type);
        
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
            console.log('Word Munch: Need to cleanup previous widget');
            this.cleanupPreviousWidget();
        }
        
        // 重新设置选择状态
        state.currentSelection = newSelection;
        console.log('Word Munch: Set current selection state:', text);
        
        // 如果窗口已存在且是相同文本，只需要重新开始处理
        if (state.floatingWidget && state.currentSelection.text === text) {
            console.log('Word Munch: Widget exists, restart processing');
            
            const wordCount = text.split(/\s+/).length;
            const isConceptAnalysis = wordCount >= CONFIG.MIN_WORDS_FOR_CONCEPT;
            state.isConceptMode = isConceptAnalysis;
            
            if (isConceptAnalysis && state.extensionSettings.conceptMuncherEnabled) {
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
        const isConceptAnalysis = wordCount >= CONFIG.MIN_WORDS_FOR_CONCEPT && 
                                  state.extensionSettings.conceptMuncherEnabled;
        state.isConceptMode = isConceptAnalysis;
        
        console.log('Word Munch: Widget mode decision - Word count:', wordCount, 'Min required:', CONFIG.MIN_WORDS_FOR_CONCEPT, 'Concept enabled:', state.extensionSettings.conceptMuncherEnabled, 'Final mode:', isConceptAnalysis ? 'concept' : 'word');
        
        const widgetWidth = isConceptAnalysis ? 350 : 300; // 减少 Concept Muncher 宽度
        const widgetHeight = isConceptAnalysis ? 280 : 200; // 减少 Concept Muncher 高度
        
        // ===== 改进的智能位置计算 =====
        let x, y;
        
        if (isConceptAnalysis) {
            // Concept Muncher: 优先显示在右边，避免遮挡文字
            console.log('Word Munch: Concept Muncher using right-side positioning');
            
            const position = this.calculateConceptWindowPosition(rect, widgetWidth, widgetHeight);
            x = position.x;
            y = position.y;
            
            console.log('Word Munch: Concept window position:', position);
            
        } else {
            // Word Muncher: 使用原来的逻辑（靠近选择区域）
            console.log('Word Munch: Word Muncher using selection area positioning');
            x = Math.min(rect.left, window.innerWidth - widgetWidth - 20);
            y = rect.bottom + 10 > window.innerHeight - 100 ? rect.top - 10 : rect.bottom + 10;
            
            // 边界检查
            x = Math.max(20, x);
            y = Math.max(20, Math.min(y, window.innerHeight - 200));
        }
        
        console.log('Word Munch: Final widget position:', { x, y, widgetWidth, isConceptAnalysis });
        
        state.floatingWidget.style.left = `${x}px`;
        state.floatingWidget.style.top = `${y}px`;
        state.floatingWidget.style.width = `${widgetWidth}px`;
        state.floatingWidget.style.position = 'fixed';
        state.floatingWidget.style.zIndex = '10000';
        
        // 在阅读模式中使用更高的 z-index
        const isInReaderMode = document.getElementById('word-munch-reader-container');
        if (isInReaderMode) {
            state.floatingWidget.style.zIndex = '2147483648';
            console.log('Word Munch: In reader mode, using higher z-index');
        }
        
        let content;
        if (isConceptAnalysis) {
            content = ContentTemplates.createConceptMuncherContent(text);
        } else {
            content = ContentTemplates.createWordMuncherContent(text);
        }
        
        state.floatingWidget.innerHTML = content;
        document.body.appendChild(state.floatingWidget);
        console.log('Word Munch: New floating widget added to DOM');
        
        DragHandler.makeDraggable(state.floatingWidget);
        
        // 显示动画
        setTimeout(() => {
            if (state.floatingWidget) {
                state.floatingWidget.classList.add('show');
                console.log('Word Munch: Trigger show animation');
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

    /**
     * 计算 Concept Muncher 窗口的最佳位置
     * 优先级：右边 > 左边 > 下方 > 上方 > 中心
     */
    static calculateConceptWindowPosition(selectionRect, widgetWidth, widgetHeight) {
        const margin = 20; // 窗口边缘留白
        const gap = 15; // 窗口与选择文本的间距
        
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // 选择区域的基本信息
        const selectionCenterX = selectionRect.left + selectionRect.width / 2;
        const selectionCenterY = selectionRect.top + selectionRect.height / 2;
        
        console.log('Word Munch: Selection rect:', {
            left: selectionRect.left,
            top: selectionRect.top,
            width: selectionRect.width,
            height: selectionRect.height,
            centerX: selectionCenterX,
            centerY: selectionCenterY
        });
        
        // 位置选项（按优先级排序）
        const positionOptions = [
            // 1. 右边优先 - 最佳选择
            {
                name: 'right',
                x: selectionRect.right + gap,
                y: Math.max(margin, selectionCenterY - widgetHeight / 2),
                priority: 1
            },
            
            // 2. 左边 - 次优选择
            {
                name: 'left',
                x: selectionRect.left - widgetWidth - gap,
                y: Math.max(margin, selectionCenterY - widgetHeight / 2),
                priority: 2
            },
            
            // 3. 右下角
            {
                name: 'right-bottom',
                x: selectionRect.right + gap,
                y: selectionRect.bottom + gap,
                priority: 3
            },
            
            // 4. 左下角
            {
                name: 'left-bottom',
                x: selectionRect.left - widgetWidth - gap,
                y: selectionRect.bottom + gap,
                priority: 4
            },
            
            // 5. 下方中心
            {
                name: 'bottom-center',
                x: Math.max(margin, selectionCenterX - widgetWidth / 2),
                y: selectionRect.bottom + gap,
                priority: 5
            },
            
            // 6. 上方中心
            {
                name: 'top-center',
                x: Math.max(margin, selectionCenterX - widgetWidth / 2),
                y: selectionRect.top - widgetHeight - gap,
                priority: 6
            },
            
            // 7. 屏幕中心 - 最后选择
            {
                name: 'center',
                x: viewportWidth / 2 - widgetWidth / 2,
                y: viewportHeight / 2 - widgetHeight / 2,
                priority: 7
            }
        ];
        
        // 检查每个位置是否可用
        for (const option of positionOptions) {
            const isValid = this.isPositionValid(option.x, option.y, widgetWidth, widgetHeight, margin);
            const overlapScore = this.calculateOverlapScore(option.x, option.y, widgetWidth, widgetHeight, selectionRect);
            
            console.log(`Word Munch: Position ${option.name}:`, {
                x: option.x,
                y: option.y,
                valid: isValid,
                overlapScore: overlapScore
            });
            
            if (isValid && overlapScore < 0.3) { // 重叠度小于30%
                return {
                    x: option.x,
                    y: option.y,
                    position: option.name,
                    overlapScore: overlapScore
                };
            }
        }
        
        // 如果所有位置都有问题，选择重叠度最小的
        const bestOption = positionOptions
            .map(option => ({
                ...option,
                overlapScore: this.calculateOverlapScore(option.x, option.y, widgetWidth, widgetHeight, selectionRect)
            }))
            .sort((a, b) => a.overlapScore - b.overlapScore)[0];
        
        // 确保最终位置在屏幕内
        return {
            x: Math.max(margin, Math.min(bestOption.x, viewportWidth - widgetWidth - margin)),
            y: Math.max(margin, Math.min(bestOption.y, viewportHeight - widgetHeight - margin)),
            position: bestOption.name + '-fallback',
            overlapScore: bestOption.overlapScore
        };
    }
    
    /**
     * 检查位置是否在屏幕范围内
     */
    static isPositionValid(x, y, width, height, margin) {
        return x >= margin && 
               y >= margin && 
               x + width <= window.innerWidth - margin && 
               y + height <= window.innerHeight - margin;
    }
    
    /**
     * 计算窗口与选择区域的重叠度（0-1，0表示无重叠）
     */
    static calculateOverlapScore(windowX, windowY, windowWidth, windowHeight, selectionRect) {
        const windowRight = windowX + windowWidth;
        const windowBottom = windowY + windowHeight;
        const selectionRight = selectionRect.left + selectionRect.width;
        const selectionBottom = selectionRect.top + selectionRect.height;
        
        // 计算重叠区域
        const overlapLeft = Math.max(windowX, selectionRect.left);
        const overlapTop = Math.max(windowY, selectionRect.top);
        const overlapRight = Math.min(windowRight, selectionRight);
        const overlapBottom = Math.min(windowBottom, selectionBottom);
        
        // 如果没有重叠
        if (overlapLeft >= overlapRight || overlapTop >= overlapBottom) {
            return 0;
        }
        
        // 计算重叠面积
        const overlapArea = (overlapRight - overlapLeft) * (overlapBottom - overlapTop);
        const selectionArea = selectionRect.width * selectionRect.height;
        
        // 返回重叠度（相对于选择区域的比例）
        return selectionArea > 0 ? overlapArea / selectionArea : 0;
    }

    // === 其他方法保持不变 ===
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
        if (!widget) return;
        
        // 检查是否在阅读模式中
        const isInReaderMode = document.getElementById('word-munch-reader-container');
        
        const simplifyBtn = widget.querySelector('.wm-simplify-btn');
        if (simplifyBtn) {
            // 移除可能存在的旧事件监听器
            simplifyBtn.replaceWith(simplifyBtn.cloneNode(true));
            const newSimplifyBtn = widget.querySelector('.wm-simplify-btn');
            
            // 使用更强的事件绑定
            const handleSimplifyClick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('Word Munch: Simplify button clicked in reader mode:', isInReaderMode ? 'YES' : 'NO');
                ResultDisplayer.showNextSynonym();
            };
            
            newSimplifyBtn.addEventListener('click', handleSimplifyClick, { capture: true });
            
            // 在阅读模式中添加额外的事件监听
            if (isInReaderMode) {
                newSimplifyBtn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                }, { capture: true });
                
                newSimplifyBtn.addEventListener('mouseup', handleSimplifyClick, { capture: true });
            }
        }
        
        const copyBtn = widget.querySelector('.wm-copy-btn');
        if (copyBtn) {
            // 同样的处理方式
            copyBtn.replaceWith(copyBtn.cloneNode(true));
            const newCopyBtn = widget.querySelector('.wm-copy-btn');
            
            const handleCopyClick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('Word Munch: Copy button clicked in reader mode:', isInReaderMode ? 'YES' : 'NO');
                ResultDisplayer.copySynonymToClipboard();
            };
            
            newCopyBtn.addEventListener('click', handleCopyClick, { capture: true });
            
            if (isInReaderMode) {
                newCopyBtn.addEventListener('mouseup', handleCopyClick, { capture: true });
            }
        }
    }    

    static setupConceptMuncherEvents(text) {
        const widget = state.floatingWidget;
        
        const understandingInput = widget.querySelector('.concept-understanding-input-minimal');
        const analyzeBtn = widget.querySelector('.concept-analyze-btn-minimal');
        
        if (understandingInput && analyzeBtn) {
            understandingInput.addEventListener('input', () => {
                const hasInput = understandingInput.value.trim().length > 0;
                analyzeBtn.disabled = !hasInput;
                
                const errorElement = widget.querySelector('.concept-error-minimal');
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
        console.log('Word Munch: Cleanup previous floating widget');
        
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
        console.log('Word Munch: Completely close floating widget');
        
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
                    <span>Simplifying...</span>
                </div>
                
                <div class="wm-result">
                    <div class="wm-synonym-container">
                        <div class="wm-synonym"></div>
                        <div class="wm-position-indicator" style="display: none;">
                            <div class="position-dots"></div>
                        </div>
                    </div>
                    <div class="wm-buttons">
                        <button class="wm-btn wm-btn-primary wm-simplify-btn" title="Next"></button>
                        <button class="wm-btn wm-btn-secondary wm-copy-btn" title="Copy"></button>
                    </div>
                </div>
                
                <div class="wm-error">
                    <!-- Error messages display here -->
                </div>
            </div>
        `;
    }    

    // Add position indicator update logic
    static updatePositionIndicator() {
        if (!state.floatingWidget || !state.currentResult || !state.currentResult.synonyms) {
            return;
        }
        
        const indicatorEl = state.floatingWidget.querySelector('.wm-position-indicator');
        const dotsContainer = state.floatingWidget.querySelector('.position-dots');
        
        if (!indicatorEl || !dotsContainer) return;
        
        const total = state.currentResult.synonyms.length;
        const current = state.currentSynonymIndex;
        
        // Only show indicator when there are multiple synonyms
        if (total > 1) {
            indicatorEl.style.display = 'block';
            
            // Create dots
            dotsContainer.innerHTML = '';
            for (let i = 0; i < total; i++) {
                const dot = document.createElement('div');
                dot.className = `position-dot ${i === current ? 'active' : ''}`;
                dot.title = `Synonym ${i + 1}`;
                dotsContainer.appendChild(dot);
            }
        } else {
            indicatorEl.style.display = 'none';
        }
    }

    static createConceptMuncherContent(text) {
        const displayText = text.length > 50 ? text.substring(0, 50) + '...' : text;
        const wordCount = text.split(/\s+/).length;
        
        return `
            <div class="wm-header concept-header">
                <div class="wm-header-text drag-handle">
                    🧠 Understanding (${wordCount} words)
                </div>
                <button class="wm-close-btn">×</button>
            </div>
            
            <div class="wm-content concept-content-minimal">
                <!-- Input section -->
                <div class="concept-input-minimal">
                    <textarea 
                        class="concept-understanding-input-minimal" 
                        placeholder="Your understanding in one sentence..."
                        rows="2"
                    ></textarea>
                </div>
                
                <!-- Action section -->
                <div class="concept-action-minimal">
                    <button class="wm-btn wm-btn-primary concept-analyze-btn-minimal" disabled>
                        Analyze Understanding
                    </button>
                    <div class="concept-cost-minimal">Cost: ~$0.0002</div>
                </div>
                
                <!-- Loading state -->
                <div class="concept-loading-minimal" style="display: none;">
                    <div class="wm-spinner"></div>
                    <span>Analyzing...</span>
                </div>
                
                <!-- Results - Minimal display -->
                <div class="concept-results-minimal" style="display: none;">
                    <!-- Results will be populated here -->
                </div>
                
                <!-- Error display -->
                <div class="concept-error-minimal" style="display: none;">
                    <!-- Error messages display here -->
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
            console.log('Word Munch: Extension disabled, cancel API call');
            WidgetManager.closeFloatingWidget();
            return;
        }
        
        const context = state.currentSelection ? this.getContextAroundSelection(state.currentSelection.selection) : '';
        
        console.log('Word Munch: Start simplification:', text, type);
        
        // 检查缓存
        const now = Date.now();
        if (state.lastWordText === text && state.lastWordResult && (now - state.lastResultTime) < 5000) {
            console.log('Word Munch: Use recent cached result for immediate display');
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
                console.warn('Word Munch: Simplification request timeout:', text);
                ResultDisplayer.showSimplificationError('Request timeout, please retry');
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
        
        console.log('Word Munch: Send message to background:', message.type, messageId);
        
        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    if (chrome.runtime.lastError.message.includes('Extension context invalidated')) {
                        console.log('Word Munch: Extension context invalidated, suggest page refresh');
                        ResultDisplayer.showSimplificationError('Extension needs refresh, please refresh page and retry');
                        return;
                    }
                    console.error('Word Munch: Message send failed:', chrome.runtime.lastError.message);
                    ResultDisplayer.showSimplificationError('Connection to extension failed, please retry');
                    return;
                }
                
                if (response) {
                    console.log('Word Munch: Received background response:', response);
                    
                    if (response.received) {
                        console.log('Word Munch: Message received by background');
                    } else if (response.error) {
                        console.error('Word Munch: Background processing error:', response.error);
                        ResultDisplayer.showSimplificationError(response.error);
                    }
                } else {
                    console.warn('Word Munch: No response from background');
                    ResultDisplayer.showSimplificationError('No response received, please retry');
                }
            });
        } catch (error) {
            if (error.message && error.message.includes('Extension context invalidated')) {
                console.log('Word Munch: Extension context invalidated, suggest page refresh');
                ResultDisplayer.showSimplificationError('Extension needs refresh, please refresh page and retry');
                return;
            }
            console.error('Word Munch: Send message exception:', error);
            ResultDisplayer.showSimplificationError('Failed to send request, please retry');
        }
    }
}

// === 结果显示器 ===
class ResultDisplayer {
    static showSimplificationResult(result) {
        if (!state.floatingWidget) {
            console.log('Word Munch: Floating widget does not exist, cannot display result');
            return;
        }
        
        console.log('Word Munch: Display simplification result:', result);
        
        state.currentResult = result;
        state.currentSynonymIndex = 0;
        
        const loadingEl = state.floatingWidget.querySelector('.wm-loading');
        const resultEl = state.floatingWidget.querySelector('.wm-result');
        const errorEl = state.floatingWidget.querySelector('.wm-error');
        
        if (result && result.synonyms && result.synonyms.length > 0) {
            console.log('Word Munch: Found', result.synonyms.length, 'synonyms');
            
            if (loadingEl) loadingEl.style.display = 'none';
            if (errorEl) errorEl.classList.remove('show');
            if (resultEl) resultEl.classList.add('show');
            
            this.updateSynonymDisplay();
            ContentTemplates.updatePositionIndicator();
            
            // 如果只有一个同义词，添加特殊提示
            if (result.synonyms.length === 1) {
                const simplifyBtn = state.floatingWidget.querySelector('.wm-simplify-btn');
                if (simplifyBtn) {
                    simplifyBtn.style.display = 'none';
                }
            }
        } else {
            console.log('Word Munch: No synonyms found');
            
            if (loadingEl) loadingEl.style.display = 'none';
            if (resultEl) resultEl.classList.remove('show');
            if (errorEl) {
                errorEl.classList.add('show');
                errorEl.textContent = 'No simplification results';
            }
        }
    }

    static updateSynonymDisplay() {
        console.log('Word Munch: updateSynonymDisplay called');
        
        if (!state.floatingWidget || !state.currentResult || !state.currentResult.synonyms) {
            console.log('Word Munch: Cannot update synonym display - missing data');
            return;
        }
        
        const synonymEl = state.floatingWidget.querySelector('.wm-synonym');
        const simplifyBtn = state.floatingWidget.querySelector('.wm-simplify-btn');
        
        if (synonymEl && state.currentResult.synonyms.length > state.currentSynonymIndex) {
            const synonym = state.currentResult.synonyms[state.currentSynonymIndex];
            const synonymText = typeof synonym === 'string' ? synonym : synonym.word || 'Simplification complete';
            
            synonymEl.textContent = synonymText;
            
            if (simplifyBtn) {
                const current = state.currentSynonymIndex + 1;
                const total = state.currentResult.synonyms.length;
                
                // 移除之前的样式类
                simplifyBtn.classList.remove('wm-btn-loop', 'wm-btn-next');
                
                if (current < total) {
                    // 不是最后一个，显示正常的"下一个"
                    simplifyBtn.disabled = false;
                    simplifyBtn.innerHTML = '▶';
                    simplifyBtn.title = `Next (${current}/${total})`;
                    simplifyBtn.classList.add('wm-btn-next');
                } else {
                    // 最后一个，显示循环提示
                    simplifyBtn.disabled = false;
                    simplifyBtn.innerHTML = '↻';
                    simplifyBtn.title = `Back to first (${current}/${total})`;
                    simplifyBtn.classList.add('wm-btn-loop');
                }
            }
        }
        
        // 更新位置指示器
        ContentTemplates.updatePositionIndicator();
    }

    static showNextSynonym() {
        console.log('Word Munch: showNextSynonym called');
        
        if (!state.currentResult || !state.currentResult.synonyms) {
            console.log('Word Munch: No available synonyms');
            if (state.currentSelection && state.currentSelection.text) {
                console.log('Word Munch: Retry API request for:', state.currentSelection.text);
                APIManager.startSimplification(state.currentSelection.text, 'word');
            }
            return;
        }
        
        const total = state.currentResult.synonyms.length;
        
        if (state.currentSynonymIndex < total - 1) {
            state.currentSynonymIndex++;
            console.log('Word Munch: Moving to synonym index:', state.currentSynonymIndex);
        } else {
            // 循环回到第一个
            state.currentSynonymIndex = 0;
            console.log('Word Munch: Looping back to first synonym');
            
            // 添加循环动画效果
            this.showLoopAnimation();
        }
        
        this.updateSynonymDisplay();
        ContentTemplates.updatePositionIndicator();
    }

    // Add loop animation effect
    static showLoopAnimation() {
        const synonymEl = state.floatingWidget?.querySelector('.wm-synonym');
        if (synonymEl) {
            synonymEl.style.transform = 'scale(0.95)';
            synonymEl.style.opacity = '0.7';
            
            setTimeout(() => {
                synonymEl.style.transform = 'scale(1)';
                synonymEl.style.opacity = '1';
            }, 150);
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
                console.error('Copy failed:', err);
                this.showSimpleToast('Copy failed', 'error');
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
                <div style="margin-bottom: 8px;">${error || 'Simplification failed'}</div>
                <button class="wm-btn wm-btn-primary wm-retry-btn" style="width: auto; padding: 6px 12px; font-size: 12px;">
                    Retry
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
        
        console.log('Word Munch: Retry simplification:', state.currentSelection.text);
        
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

    static initializeStyles() {
        // Add any additional styles you want to apply when styles are initialized
        console.log('Word Munch: Styles initialized');
    }
}

// === Minimal Concept Analyzer ===
class ConceptAnalyzer {
    static fillContextInformation(selectedText) {
        // 重要：在理解分析前检查扩展状态
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: Extension disabled, cancel concept analysis');
            WidgetManager.closeFloatingWidget();
            return;
        }
        
        try {
            console.log('Word Munch: Start filling context information');
            
            // Simple cost estimation
            const wordCount = selectedText.split(/\s+/).length;
            const estimatedCost = Math.max(0.0002, wordCount * 0.00003);
            
            const costElement = state.floatingWidget?.querySelector('.concept-cost-minimal');
            if (costElement) {
                costElement.textContent = `Cost: ~$${estimatedCost.toFixed(4)}`;
                
                // Color code by cost
                if (estimatedCost > 0.001) {
                    costElement.style.color = '#dc2626'; // Red for high cost
                } else if (estimatedCost > 0.0005) {
                    costElement.style.color = '#f59e0b'; // Orange for medium cost
                } else {
                    costElement.style.color = '#16a34a'; // Green for low cost
                }
            }
            
            // Store simplified context strategy
            state.currentSelection.contextStrategy = { type: 'user_only' };
            state.currentSelection.costEstimate = { estimatedCost };
            
        } catch (error) {
            console.error('Word Munch: Failed to fill context information:', error);
            const costElement = state.floatingWidget?.querySelector('.concept-cost-minimal');
            if (costElement) {
                costElement.textContent = 'Cost estimation failed';
            }
        }
    }

    static async startConceptAnalysis(originalText) {
        if (!state.extensionSettings.extensionEnabled) {
            WidgetManager.closeFloatingWidget();
            return;
        }
        
        const widget = state.floatingWidget;
        if (!widget) return;
        
        const understandingInput = widget.querySelector('.concept-understanding-input-minimal');
        const analyzeBtn = widget.querySelector('.concept-analyze-btn-minimal');
        const loadingElement = widget.querySelector('.concept-loading-minimal');
        const resultsElement = widget.querySelector('.concept-results-minimal');
        const errorElement = widget.querySelector('.concept-error-minimal');
        
        const userUnderstanding = understandingInput.value.trim();
        
        if (!userUnderstanding) {
            this.showConceptError('Please enter your understanding');
            return;
        }
        
        try {
            analyzeBtn.disabled = true;
            loadingElement.style.display = 'flex';
            resultsElement.style.display = 'none';
            errorElement.style.display = 'none';
            
            this.sendConceptAnalysisMessage(originalText, userUnderstanding, null, false);
            
        } catch (error) {
            console.error('Word Munch: Analysis failed:', error);
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
            cost_level: 'low',
            url: window.location.href,
            title: document.title,
            messageId: messageId,
            timestamp: Date.now(),
            cache_key: this.generateConceptCacheKey(originalText, userUnderstanding, context)
        };
        
        console.log('Word Munch: Sending analysis message:', messageId);
        
        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    this.showConceptError('Connection failed, please retry');
                    return;
                }
                
                if (response?.received) {
                    console.log('Word Munch: Message received by background');
                } else if (response?.error) {
                    this.showConceptError(response.error);
                }
            });
        } catch (error) {
            this.showConceptError('Failed to send request');
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
        
        const errorElement = widget.querySelector('.concept-error-minimal');
        const analyzeBtn = widget.querySelector('.concept-analyze-btn-minimal');
        const loadingElement = widget.querySelector('.concept-loading-minimal');
        
        if (errorElement) {
            errorElement.innerHTML = `⚠️ ${message}`;
            errorElement.style.display = 'block';
            
            setTimeout(() => {
                if (errorElement) {
                    errorElement.style.display = 'none';
                }
            }, 3000);
        }
        
        if (analyzeBtn) analyzeBtn.disabled = false;
        if (loadingElement) loadingElement.style.display = 'none';
    }

    static displayConceptResults(analysis) {
        const widget = state.floatingWidget;
        if (!widget) return;
        
        const resultsElement = widget.querySelector('.concept-results-minimal');
        const loadingElement = widget.querySelector('.concept-loading-minimal');
        
        if (!resultsElement) return;
        
        const scorePercentage = Math.round(analysis.overall_similarity * 100);
        const actualCost = analysis.actual_cost || state.currentSelection.costEstimate?.estimatedCost || 0;
        
        // Minimal results display
        const resultsHTML = `
            <div class="concept-score-minimal">
                <div class="score-circle">
                    <span class="score-number">${scorePercentage}%</span>
                </div>
                <div class="score-label">Understanding Match</div>
            </div>
            
            <div class="concept-suggestions-minimal">
                <div class="suggestion-title">💡 Key Suggestions</div>
                ${analysis.suggestions.slice(0, 2).map(suggestion => 
                    `<div class="suggestion-item">• ${suggestion}</div>`
                ).join('')}
            </div>
            
            <div class="concept-cost-info-minimal">
                Cost: $${(actualCost * 100).toFixed(3)}¢
            </div>
        `;
        
        resultsElement.innerHTML = resultsHTML;
        resultsElement.style.display = 'block';
        loadingElement.style.display = 'none';
        
        // Simplified highlighting
        if (analysis.segments) {
            HighlightManager.highlightOriginalText(analysis.segments);
        }
    }
}

// === 高亮管理器 ===
class HighlightManager {
    static highlightOriginalText(segments) {
        console.log('Word Munch: Start displaying scroll-following highlights on original text');
        
        this.clearOriginalHighlights();
        
        if (!state.currentSelection || !state.currentSelection.range) {
            console.log('Word Munch: No current selection, cannot highlight');
            return;
        }
        
        // 检查是否在阅读模式中
        const isInReaderMode = document.getElementById('word-munch-reader-container');
        if (isInReaderMode) {
            console.log('Word Munch: In reader mode, use special highlight logic');
            this.highlightInReaderMode(segments);
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
                    console.warn('Word Munch: Failed to create segment highlight:', error);
                }
            });
            
            console.log('Word Munch: Highlight creation complete,', state.highlightRanges.length, 'highlight elements');
            
            this.startScrollTracking();
            
        } catch (error) {
            console.error('Word Munch: Original text highlighting failed:', error);
        }
    }

    // 在阅读模式中的高亮处理
    static highlightInReaderMode(segments) {
        console.log('Word Munch: Create highlights in reader mode');
        
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
                    highlight.className = `word-munch-segment-highlight ${segment.level} reader-mode-highlight`;
                    highlight.style.position = 'fixed';
                    highlight.style.left = `${segmentRect.left}px`;
                    highlight.style.top = `${segmentRect.top}px`;
                    highlight.style.width = `${segmentRect.width}px`;
                    highlight.style.height = `${segmentRect.height}px`;
                    highlight.style.pointerEvents = 'none';
                    highlight.style.borderRadius = '3px';
                    highlight.style.opacity = '0.4'; // 在阅读模式中稍微明显一些
                    highlight.style.zIndex = '2147483649'; // 比阅读模式和浮动窗口都高
                    highlight.style.transition = 'all 0.1s ease-out';
                    
                    const colors = {
                        'excellent': '#059669',
                        'good': '#16a34a',
                        'fair': '#ca8a04',
                        'partial': '#ea580c',
                        'poor': '#ef4444'
                    };
                    highlight.style.backgroundColor = colors[segment.level] || '#6b7280';
                    
                    // 在阅读模式中，将高亮添加到阅读容器中
                    const readerContainer = document.getElementById('word-munch-reader-container');
                    if (readerContainer) {
                        readerContainer.appendChild(highlight);
                    } else {
                        document.body.appendChild(highlight);
                    }
                    
                    const highlightInfo = {
                        element: highlight,
                        range: segmentRange.cloneRange(),
                        level: segment.level,
                        text: segment.text,
                        isInReaderMode: true
                    };
                    
                    state.highlightRanges.push(highlightInfo);
                    state.originalHighlightElements.push(highlight);
                    
                    currentOffset = segmentStart + segment.text.length;
                    
                } catch (error) {
                    console.warn('Word Munch: Failed to create reader mode segment highlight:', error);
                }
            });
            
            console.log('Word Munch: Reader mode highlight creation complete,', state.highlightRanges.length, 'highlight elements');
            
            this.startScrollTracking();
            
        } catch (error) {
            console.error('Word Munch: Reader mode highlighting failed:', error);
        }
    }

    static startScrollTracking() {
        if (state.isScrollTracking) return;
        
        state.isScrollTracking = true;
        console.log('Word Munch: Start zero-delay scroll tracking');
        
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
        console.log('Word Munch: Stop scroll tracking');
        
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
                console.warn('Word Munch: Failed to update highlight position:', error);
                if (highlightInfo.element) {
                    highlightInfo.element.style.opacity = '0';
                }
            }
        });
    }

    static clearOriginalHighlights() {
        console.log('Word Munch: Clear original text highlights');
        
        this.stopScrollTracking();
        
        state.originalHighlightElements.forEach(element => {
            if (element.parentNode) {
                element.parentNode.removeChild(element);
            }
        });
        state.originalHighlightElements = [];
        state.highlightRanges = [];
        
        console.log('Word Munch: Original text highlights cleared');
    }
}

// === 消息处理器 ===
class MessageHandlers {
    static handleWordSimplified(word, result) {
        console.log('Word Munch: Word simplification complete:', word, result);
        
        if (!state.floatingWidget || !state.currentSelection || state.currentSelection.text !== word) {
            console.log('Word Munch: Result does not match current state, ignore');
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
        console.log('Word Munch: Concept analysis complete:', original_text, result);
        
        if (!state.floatingWidget || !state.currentSelection || !state.isConceptMode || state.currentSelection.text !== original_text) {
            console.log('Word Munch: Concept analysis result does not match current state, ignore');
            return;
        }
        
        state.currentConceptAnalysis = result;
        ConceptAnalyzer.displayConceptResults(result);
        
        const loadingElement = state.floatingWidget.querySelector('.concept-loading-minimal');
        if (loadingElement) {
            loadingElement.style.display = 'none';
        }
    }

    static handleSimplifyError(word, error) {
        console.error('Word Munch: Simplification failed:', word, error);
        
        if (!state.floatingWidget || !state.currentSelection || state.currentSelection.text !== word) {
            console.log('Word Munch: Error does not match current state, ignore');
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
        console.error('Word Munch: Concept analysis failed:', text, error);
        
        if (!state.floatingWidget || !state.currentSelection || !state.isConceptMode || state.currentSelection.text !== text) {
            console.log('Word Munch: Concept analysis error does not match current state, ignore');
            return;
        }
        
        ConceptAnalyzer.showConceptError(error);
        
        const loadingElement = state.floatingWidget.querySelector('.concept-loading-minimal');
        if (loadingElement) {
            loadingElement.style.display = 'none';
        }
        
        const analyzeBtn = state.floatingWidget.querySelector('.concept-analyze-btn-minimal');
        if (analyzeBtn) {
            analyzeBtn.disabled = false;
        }
    }

    static handleSettingsUpdated(settings) {
        console.log('Word Munch: Settings updated:', settings);
        
        // 更新本地设置状态
        state.extensionSettings = { ...state.extensionSettings, ...settings };
        
        if (settings.hasOwnProperty('conceptMuncherEnabled')) {
            console.log('Word Munch: Concept analysis feature status:', settings.conceptMuncherEnabled);
        }
        
        // 如果扩展被禁用，立即关闭所有窗口和清理状态
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: Extension disabled, immediately close all windows and clear state');
            WidgetManager.closeFloatingWidget();
            HighlightManager.clearOriginalHighlights();
            
            // 清理所有定时器和请求
            state.cancelCurrentRequest();
            
            // 重置所有状态
            state.reset();
            
            console.log('Word Munch: Cleanup complete after extension disabled');
        }
    }
}

// === 初始化 ===
const eventManager = new EventManager();

// 页面加载完成后的初始化
document.addEventListener('DOMContentLoaded', async function() {
    console.log('Word Munch: Content script loaded');
    
    // 首先加载设置
    await state.loadSettings();
    
    // 通知 background script content script 已准备就绪
    APIManager.sendMessageToBackground({
        type: 'CONTENT_SCRIPT_READY',
        url: window.location.href
    });

    // 在内容脚本主入口处添加：
    ResultDisplayer.initializeStyles();
});

if (document.readyState !== 'loading') {
    console.log('Word Munch: Content script loaded (page already complete)');
    
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
    console.error('Word Munch: Content script error:', event.error);
});

// 清理资源
window.addEventListener('beforeunload', function() {
    console.log('Word Munch: Page unload, clear highlight resources');
    HighlightManager.stopScrollTracking();
    HighlightManager.clearOriginalHighlights();
});

console.log('Word Munch: Content script initialization complete');

// === 调试函数 ===
window.debugHighlights = function() {
    console.log('Word Munch: Highlight debug info:');
    console.log('- Scroll tracking status:', state.isScrollTracking);
    console.log('- Highlight count:', state.highlightRanges.length);
    console.log('- Highlight element count:', state.originalHighlightElements.length);
    console.log('- Highlight data:', state.highlightRanges);
    
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
    console.log('Word Munch: Manually reload settings');
    await state.loadSettings();
    console.log('Word Munch: Settings reload complete:', state.extensionSettings);
    return state.extensionSettings;
};

// === 简单阅读模式 ===
class SimpleReaderMode {
    constructor() {
        this.isReaderActive = false;
        this.originalScrollPosition = 0;
        this.isChunkedMode = false;
        this.isColorMode = false;
        this.isFocusMode = false;
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
                console.log('Word Munch: Load focus mode settings:', this.focusMode);
            });
        }
    }

    setupReaderMessageListener() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.type === 'TOGGLE_READER_MODE') {
                console.log('Word Munch: Received reader mode toggle message');
                try {
                    this.toggleReaderMode();
                    sendResponse({ success: true });
                } catch (error) {
                    console.error('Word Munch: Reader mode toggle failed:', error);
                    sendResponse({ success: false, error: error.message });
                }
                return false;
            }
            
            if (message.type === 'CHECK_READER_STATUS') {
                console.log('Word Munch: Check reader mode status:', this.isReaderActive);
                sendResponse({ 
                    isReaderActive: this.isReaderActive,
                    success: true 
                });
                return false;
            }

            if (message.type === 'UPDATE_FOCUS_MODE') {
                this.focusMode = message.mode;
                console.log('Word Munch: Update focus mode to:', this.focusMode);
                
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
            console.log('Word Munch: Activate simple reader mode');
            
            if (typeof Readability === 'undefined') {
                console.error('Word Munch: Readability library not loaded');
                alert('Readability library not loaded, please refresh page and retry');
                return;
            }

            if (typeof isProbablyReaderable === 'function') {
                const isReadable = isProbablyReaderable(document);
                console.log('Word Munch: Page readability check:', isReadable);
                
                if (!isReadable) {
                    const proceed = confirm('Current page may not be suitable for reader mode, continue?');
                    if (!proceed) return;
                }
            }

            if (typeof state.floatingWidget !== 'undefined' && state.floatingWidget) {
                console.log('Word Munch: Close existing floating widget');
                WidgetManager.closeFloatingWidget();
            }

            this.originalScrollPosition = window.scrollY;
            console.log('Word Munch: Save scroll position:', this.originalScrollPosition);

            const documentClone = document.cloneNode(true);
            this.fixRelativeUrls(documentClone);
            
            const reader = new Readability(documentClone, {
                debug: false,
                charThreshold: 200,
                keepClasses: false
            });

            const article = reader.parse();

            if (!article || !article.textContent || article.textContent.trim().length === 0) {
                console.error('Word Munch: Cannot extract article content');
                alert('Cannot extract article content');
                return;
            }

            this.chunks = await this.createTextChunks(article.textContent);
            this.originalArticleContent = article.content;
            this.renderSimpleReader(article);
            this.isReaderActive = true;
            
            console.log('Word Munch: Simple reader mode activated');

        } catch (error) {
            console.error('Word Munch: Failed to activate reader mode:', error);
            alert('Reader mode startup failed: ' + error.message);
        }
    }

    renderSimpleReader(article) {
        console.log('Word Munch: Start rendering reader');
        
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
                            <button id="exitReaderBtn" class="exit-btn">← Exit Reading</button>
                        </div>
                        <div class="right-controls">
                            <button id="chunkToggleBtn" class="control-btn">📑 Chunk Mode</button>
                            <button id="colorToggleBtn" class="control-btn" style="display:none;">🌈 Color Mode</button>
                        </div>
                    </div>
                    
                    <h1 class="article-title">${article.title}</h1>
                    ${article.byline ? `<div class="article-byline">Author: ${article.byline}</div>` : ''}
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
        console.log('Word Munch: Exit reader mode');
        
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
        console.log('Word Munch: Create text chunks');
        
        try {
            if (typeof window.createFiveLanguageChunker === 'function') {
                const semanticChunker = window.createFiveLanguageChunker({
                    targetLength: 600,
                    maxLength: 800,
                    minLength: 150
                });
                
                const chunks = await semanticChunker.createChunks(textContent);
                console.log('Word Munch: Semantic chunking complete,', chunks.length, 'chunks');
                return chunks;
            }
        } catch (error) {
            console.error('Word Munch: Semantic chunking failed, use original method:', error);
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
            const testChunk = currentChunk + (currentChunk ? ' ' : '') + sentence + '.';
            
            if (testChunk.length > targetLength && currentChunk) {
                if (testChunk.length < maxLength) {
                    currentChunk = testChunk.slice(0, -1);
                } else {
                    chunks.push(currentChunk + '.');
                    currentChunk = sentence;
                }
            } else {
                currentChunk = testChunk.slice(0, -1);
            }
        }

        if (currentChunk.trim()) {
            chunks.push(currentChunk + '.');
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
            chunkToggleBtn.textContent = '📄 Normal Mode';
            chunkToggleBtn.classList.add('active');
            if (colorToggleBtn) colorToggleBtn.style.display = 'block';
            
            this.currentChunkIndex = -1;
            this.isFocusMode = false;
        } else {
            this.renderNormalContent(readerContent);
            chunkToggleBtn.textContent = '📑 Chunk Mode';
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

        // 绑定段落点击事件 - 但要避免干扰文本选择
        container.querySelectorAll('.text-chunk').forEach((chunk, index) => {
            // 使用 mousedown 而不是 click，并检查是否是文本选择
            chunk.addEventListener('mousedown', (e) => {
                // 记录鼠标按下的时间和位置
                chunk._mouseDownTime = Date.now();
                chunk._mouseDownX = e.clientX;
                chunk._mouseDownY = e.clientY;
            });
            
            chunk.addEventListener('mouseup', (e) => {
                // 检查是否是快速点击（非文本选择）
                const timeDiff = Date.now() - (chunk._mouseDownTime || 0);
                const distanceX = Math.abs(e.clientX - (chunk._mouseDownX || 0));
                const distanceY = Math.abs(e.clientY - (chunk._mouseDownY || 0));
                
                // 如果是快速点击且鼠标移动距离很小，才触发聚焦
                if (timeDiff < 200 && distanceX < 5 && distanceY < 5) {
                    // 检查是否有文本被选中
                    const selection = window.getSelection();
                    const selectedText = selection.toString().trim();
                    
                    // 只有在没有选中文本时才触发段落聚焦
                    if (!selectedText || selectedText.length === 0) {
                        console.log('Word Munch: Paragraph click focus, index:', index);
                        this.currentChunkIndex = index;
                        this.focusChunk(chunk, index);
                    } else {
                        console.log('Word Munch: Text selection detected, skip paragraph focus');
                    }
                }
            });
            
            // 双击退出专注模式
            chunk.addEventListener('dblclick', (e) => {
                // 延迟检查，确保双击不会干扰文本选择
                setTimeout(() => {
                    if (this.isFocusMode) {
                        this.exitFocusMode();
                    }
                }, 50);
            });
        });

        this.currentChunkIndex = -1;
        container.classList.remove('focus-mode');
        this.isFocusMode = false;
        
        console.log('Word Munch: Chunked content rendering complete, text selection enabled');
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
            colorToggleBtn.textContent = '⚪ Unified Color';
            colorToggleBtn.classList.add('active');
        } else {
            readerContent.classList.remove('color-mode');
            colorToggleBtn.textContent = '🌈 Color Mode';
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