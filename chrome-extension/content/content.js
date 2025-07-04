let CONFIG = {
    CONCEPT_API_ENDPOINT: '', // Will be loaded from storage
    MIN_WORDS_FOR_CONCEPT: 6,
    MEMORY_CACHE_TIME: 3000
};

async function loadConfig() {
    console.log('🔧 Word Munch: Content script loading config...');
    
    try {
        const result = await chrome.storage.sync.get(['apiConfig']);
        
        if (result.apiConfig && result.apiConfig.CONCEPT_API_ENDPOINT) {
            CONFIG.CONCEPT_API_ENDPOINT = result.apiConfig.CONCEPT_API_ENDPOINT;
            console.log('✅ Word Munch: Content config loaded from storage!');
            
            // Check if it's still a placeholder
            if (CONFIG.CONCEPT_API_ENDPOINT.includes('your-api-domain.com')) {
                console.log('⚠️ Word Munch: API endpoint is still a placeholder');
            } else {
                console.log('✅ Word Munch: API endpoint looks correct');
            }
        } else {
            console.log('❌ Word Munch: No API config found in content script storage');
            
            // If storage is empty, try to get from background script
            console.log('🔄 Word Munch: Requesting config from background...');
            try {
                chrome.runtime.sendMessage({type: 'GET_CONFIG'}, (response) => {
                    if (response && response.CONCEPT_API_ENDPOINT) {
                        CONFIG.CONCEPT_API_ENDPOINT = response.CONCEPT_API_ENDPOINT;
                        console.log('✅ Word Munch: Config received from background');
                    }
                });
            } catch (error) {
                console.warn('Word Munch: Failed to get config from background:', error);
            }
        }
    } catch (error) {
        console.error('Word Munch: Failed to load config:', error);
    }
    
    console.log('📊 Word Munch: Final content config check:');
    console.log('   - CONCEPT_API:', CONFIG.CONCEPT_API_ENDPOINT ? '✅ SET' : '❌ EMPTY');
}

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
        this.settingsLoaded = false; // Mark if settings are loaded
    }

    async loadSettings() {
        try {
            const result = await chrome.storage.sync.get([
                'extensionEnabled', 
                'outputLanguage', 
                'notificationsEnabled', 
                'conceptMuncherEnabled'
            ]);     
            
            // Only update existing settings, keep default values
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
            this.settingsLoaded = true; // Even if failed, mark as loaded
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
        this.creatingIndependentWindow = false;
        this.lastProcessedEvent = null;
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
        
        console.log('Word Munch: Text selection event triggered, selected text:', selectedText, 'Event type:', event.type);

        // Check if this is triggered by independent widget button click
        if (window._wordMunchIndependentButtonClick) {
            console.log('Word Munch: Ignoring text selection during independent widget button click');
                return;
            }

        // CRITICAL: Prevent duplicate processing from multiple event types
        const currentTime = Date.now();
        const eventKey = `${selectedText}_${currentTime}`;
        
        if (this.lastProcessedEvent && currentTime - this.lastProcessedEvent.time < 100 && this.lastProcessedEvent.text === selectedText) {
            console.log('Word Munch: Duplicate event within 100ms for same text, ignoring:', event.type);
            return;
        }
        
        this.lastProcessedEvent = {
            text: selectedText,
            time: currentTime,
            type: event.type
        };

        // CRITICAL: Check if concept muncher input is currently focused
        if (window._conceptMuncherInputFocused) {
            console.log('Word Munch: Concept muncher input is focused, ignoring text selection event');
            return;
        }

        // CRITICAL: Check if selection is happening inside concept muncher window
        if (state.isConceptMode && state.floatingWidget) {
            const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
            if (range) {
                const container = range.commonAncestorContainer;
                const element = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
                
                // Check if the selection is within the concept muncher window
                if (state.floatingWidget.contains(element)) {
                    console.log('Word Munch: Text selection is within concept muncher window, ignoring global handler');
                    return;
                }
            }
        }

        // Relax the conditions, allowing any valid word to create an independent window in concept mode.
        if (state.isConceptMode && selectedText && TextValidator.isValidWord(selectedText)) {
            console.log('Word Munch: In concept mode, create independent word window for:', selectedText);
            
            // CRITICAL: Clear any pending selection timer to prevent duplicate processing
            if (this.selectionTimer) {
                clearTimeout(this.selectionTimer);
                this.selectionTimer = null;
                console.log('Word Munch: Cleared pending selection timer in concept mode');
            }
            
            // Mark that we're creating an independent window to prevent other processing
            this.creatingIndependentWindow = true;
            WidgetManager.createIndependentWordWindow(selectedText, selection);
            
            // Clear the flag after a short delay
            setTimeout(() => {
                this.creatingIndependentWindow = false;
            }, 100);
            
            return;
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
            if (!state.isConceptMode && !state.currentSelection && !window._conceptMuncherInputFocused) {
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
        }, 20); // Reduce from 50ms to 20ms, improve response speed
    }

    // Process text selection in reading mode
    processTextSelectionInReaderMode(selectedText, selection) {
        console.log('Word Munch: Text selection in reader mode:', selectedText);
        
        // Check if extension is enabled
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: Extension disabled, skip processing in reader mode');
            return;
        }
        
        // CRITICAL: Check if we're currently creating an independent window
        if (this.creatingIndependentWindow) {
            console.log('Word Munch: Currently creating independent window in reader mode, skip processing');
            return;
        }
        
        // Check concept mode in reading mode too
        if (state.isConceptMode && selectedText && TextValidator.isValidWord(selectedText)) {
            console.log('Word Munch: In reader mode + concept mode, create independent word window for:', selectedText);
            
            // Mark that we're creating an independent window
            this.creatingIndependentWindow = true;
            WidgetManager.createIndependentWordWindow(selectedText, selection);
            
            // Clear the flag after a short delay
            setTimeout(() => {
                this.creatingIndependentWindow = false;
            }, 100);
            
            return;
        }
        
        // Use normal processing logic in reading mode
        this.processTextSelection({
            text: selectedText,
            selection: selection,
            range: selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null,
            timestamp: Date.now(),
            isInReaderMode: true // Mark this as a selection from reading mode
        });
    }

    processTextSelection(selectionData) {
        const { text, selection, range, isInReaderMode } = selectionData;
        
        console.log('Word Munch: Start processing text selection:', text, isInReaderMode ? '(Reader Mode)' : '');
        
        // Check extension status again (prevent state change during debounce delay)
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: Extension disabled during processing, cancel processing');
            return;
        }
        
        // CRITICAL: Check if we're currently creating an independent window
        if (eventManager.creatingIndependentWindow) {
            console.log('Word Munch: Currently creating independent window, skip processing to avoid duplicates');
            return;
        }
        
        // CRITICAL FIX: If in concept mode and this is a valid word, skip processing
        // because independent window should have already been created
        if (state.isConceptMode && TextValidator.isValidWord(text)) {
            console.log('Word Munch: In concept mode with valid word, skip processing (independent window should exist)');
            return;
        }
        
        // Cancel previous request but do not close window
        state.cancelCurrentRequest();
        
        // Save current selection
        state.currentSelection = {
            text: text,
            selection: selection,
            range: range,
            isInReaderMode: isInReaderMode || false
        };
        
        console.log('Word Munch: Set current selection:', text);
        
        // Determine processing based on text type
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
            console.log('Word Munch: Invalid text');
            // Don't close concept window for invalid selections when in concept mode
            if (!state.isConceptMode) {
                console.log('Word Munch: Not in concept mode, close window');
                WidgetManager.closeFloatingWidget();
            } else {
                console.log('Word Munch: In concept mode, keep window open despite invalid selection');
            }
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

                    case 'SHOW_COGNITIVE_DASHBOARD':
                        console.log('Word Munch: Show cognitive dashboard for user:', message.userId);
                        console.log('Word Munch: Is anonymous:', message.isAnonymous);
                        
                        // New waiting mechanism
                        const waitForDashboard = (attempts = 0) => {
                            if (typeof window.cognitiveDashboard !== 'undefined' && window.cognitiveDashboard.showDashboard) {
                                console.log('Word Munch: Found cognitiveDashboard, showing dashboard...');
                                try {
                                    window.cognitiveDashboard.showDashboard(message.userId, message.isAnonymous);
                                    console.log('Word Munch: Dashboard show method called successfully');
                                    sendResponse({ success: true });
                                } catch (dashboardError) {
                                    console.error('Word Munch: Dashboard show failed:', dashboardError);
                                    sendResponse({ error: dashboardError.message });
                                }
                            } else if (attempts < 10) {
                                console.log(`Word Munch: Waiting for cognitiveDashboard... attempt ${attempts + 1}/10`);
                                setTimeout(() => waitForDashboard(attempts + 1), 200);
                            } else {
                                console.error('Word Munch: CognitiveDashboard not found after 2 seconds');
                                sendResponse({ 
                                    error: 'Dashboard not ready',
                                    suggestion: 'Please refresh the page and try again'
                                });
                            }
                        };
                        
                        // Start waiting immediately
                        waitForDashboard();
                        
                        // return true to keep message channel open
                        return true;
                    
                case 'COGNITIVE_PROFILE_DATA':
                    console.log('Word Munch: Received cognitive profile data');
                    cognitiveDashboard.handleProfileData(message.data, message.requestId);
                    break;
                    
                case 'COGNITIVE_PROFILE_ERROR':
                    console.log('Word Munch: Cognitive profile error:', message.error);
                    cognitiveDashboard.handleProfileError(message.error, message.requestId);
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
        
        // If clicked inside the floating window, do not close
        if (state.floatingWidget.contains(event.target)) {
            console.log('Word Munch: Click inside floating widget, do not close');
            return;
        }
        
        // CRITICAL FIX: Check if clicked inside any independent widget
        const independentWidgets = document.querySelectorAll('.independent-widget');
        for (const widget of independentWidgets) {
            if (widget.contains(event.target)) {
                console.log('Word Munch: Click inside independent widget, do not close concept window');
                return;
            }
        }
        
        // Special check: if in understanding analysis mode, ensure clicks on input fields do not close the window
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
        
        // Check if clicked in selected area - give more tolerance
        if (state.currentSelection && state.currentSelection.range) {
            const rect = state.currentSelection.range.getBoundingClientRect();
            const padding = 10; // Increase tolerance
            
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

// === Text validator ===
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
        
        // Fix: expand word length limit, support longer English words
        const wordRegex = /^[\p{L}]{1,20}$/u;  // Change from 1-10 to 1-20 characters
        const isValid = wordRegex.test(text);
        
        // Additional check: ensure it is a reasonable English word (allow common long words)
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

// === Improved window manager - optimize Concept Muncher positioning ===
class WidgetManager {
    static showFloatingWidget(text, selection, type) {
        console.log('Word Munch: Show floating widget:', text, type);
        
        const newSelection = {
            text: text,
            selection: selection,
            range: selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null
        };

        // Check if previous window needs to be cleaned up
        const needsCleanup = !state.floatingWidget || 
                           !state.currentSelection || 
                           state.currentSelection.text !== text;
        
        if (needsCleanup) {
            console.log('Word Munch: Need to cleanup previous widget');
            this.cleanupPreviousWidget();
        }
        
        // Reset selection state
        state.currentSelection = newSelection;
        console.log('Word Munch: Set current selection state:', text);
        
        // If window exists and is the same text, only restart processing
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
        
        // Create new window
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
        
        const widgetWidth = isConceptAnalysis ? 350 : 300; // Reduce Concept Muncher width
        const widgetHeight = isConceptAnalysis ? 280 : 200; // Reduce Concept Muncher height
        
        // ===== Improved smart position calculation =====
        let x, y;
        
        if (isConceptAnalysis) {
            // Concept Muncher: Display on the right side first, avoid遮挡文字
            console.log('Word Munch: Concept Muncher using right-side positioning');
            
            const position = this.calculateConceptWindowPosition(rect, widgetWidth, widgetHeight);
            x = position.x;
            y = position.y;
            
            console.log('Word Munch: Concept window position:', position);
            
        } else {
            // Word Muncher: Use the original logic (near the selection area)
            console.log('Word Munch: Word Muncher using selection area positioning');
            x = Math.min(rect.left, window.innerWidth - widgetWidth - 20);
            y = rect.bottom + 10 > window.innerHeight - 100 ? rect.top - 10 : rect.bottom + 10;
            
            // Boundary check
            x = Math.max(20, x);
            y = Math.max(20, Math.min(y, window.innerHeight - 200));
        }
        
        console.log('Word Munch: Final widget position:', { x, y, widgetWidth, isConceptAnalysis });
        
        state.floatingWidget.style.left = `${x}px`;
        state.floatingWidget.style.top = `${y}px`;
        state.floatingWidget.style.width = `${widgetWidth}px`;
        state.floatingWidget.style.position = 'fixed';
        state.floatingWidget.style.zIndex = '10000';
        
        // Use higher z-index in reading mode
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
        
        // Start processing
        if (isConceptAnalysis) {
            ConceptAnalyzer.fillContextInformation(text);
        } else {
            APIManager.startSimplification(text, 'word');
        }
    }

    /**
     * Calculate the best position of the Concept Muncher window
     * Priority: right > left > bottom > top > center
     */
    static calculateConceptWindowPosition(selectionRect, widgetWidth, widgetHeight) {
        const margin = 20; // Window margin
        const gap = 15; // Window and selection text gap
        
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // Basic information of the selection area
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
        
        // Position options (sorted by priority)
        const positionOptions = [
            // 1. Right side first - best choice
            {
                name: 'right',
                x: selectionRect.right + gap,
                y: Math.max(margin, selectionCenterY - widgetHeight / 2),
                priority: 1
            },
            
            // 2. Left side - second best choice
            {
                name: 'left',
                x: selectionRect.left - widgetWidth - gap,
                y: Math.max(margin, selectionCenterY - widgetHeight / 2),
                priority: 2
            },
            
            // 3. Bottom right corner
            {
                name: 'right-bottom',
                x: selectionRect.right + gap,
                y: selectionRect.bottom + gap,
                priority: 3
            },
            
            // 4. Bottom left corner
            {
                name: 'left-bottom',
                x: selectionRect.left - widgetWidth - gap,
                y: selectionRect.bottom + gap,
                priority: 4
            },
            
            // 5. Bottom center
            {
                name: 'bottom-center',
                x: Math.max(margin, selectionCenterX - widgetWidth / 2),
                y: selectionRect.bottom + gap,
                priority: 5
            },
            
            // 6. Top center
            {
                name: 'top-center',
                x: Math.max(margin, selectionCenterX - widgetWidth / 2),
                y: selectionRect.top - widgetHeight - gap,
                priority: 6
            },
            
            // 7. Screen center - last choice
            {
                name: 'center',
                x: viewportWidth / 2 - widgetWidth / 2,
                y: viewportHeight / 2 - widgetHeight / 2,
                priority: 7
            }
        ];
        
        // Check if each position is available
        for (const option of positionOptions) {
            const isValid = this.isPositionValid(option.x, option.y, widgetWidth, widgetHeight, margin);
            const overlapScore = this.calculateOverlapScore(option.x, option.y, widgetWidth, widgetHeight, selectionRect);
            
            console.log(`Word Munch: Position ${option.name}:`, {
                x: option.x,
                y: option.y,
                valid: isValid,
                overlapScore: overlapScore
            });
            
            if (isValid && overlapScore < 0.3) { // Overlap less than 30%
                return {
                    x: option.x,
                    y: option.y,
                    position: option.name,
                    overlapScore: overlapScore
                };
            }
        }
        
        // If all positions have problems, select the one with the smallest overlap
        const bestOption = positionOptions
            .map(option => ({
                ...option,
                overlapScore: this.calculateOverlapScore(option.x, option.y, widgetWidth, widgetHeight, selectionRect)
            }))
            .sort((a, b) => a.overlapScore - b.overlapScore)[0];
        
        // Ensure the final position is within the screen
        return {
            x: Math.max(margin, Math.min(bestOption.x, viewportWidth - widgetWidth - margin)),
            y: Math.max(margin, Math.min(bestOption.y, viewportHeight - widgetHeight - margin)),
            position: bestOption.name + '-fallback',
            overlapScore: bestOption.overlapScore
        };
    }
    
    /**
     * Check if the position is within the screen
     */
    static isPositionValid(x, y, width, height, margin) {
        return x >= margin && 
               y >= margin && 
               x + width <= window.innerWidth - margin && 
               y + height <= window.innerHeight - margin;
    }
    
    /**
     * Calculate the overlap between the window and the selection area (0-1, 0 means no overlap)
     */
    static calculateOverlapScore(windowX, windowY, windowWidth, windowHeight, selectionRect) {
        const windowRight = windowX + windowWidth;
        const windowBottom = windowY + windowHeight;
        const selectionRight = selectionRect.left + selectionRect.width;
        const selectionBottom = selectionRect.top + selectionRect.height;
        
        // Calculate the overlap area
        const overlapLeft = Math.max(windowX, selectionRect.left);
        const overlapTop = Math.max(windowY, selectionRect.top);
        const overlapRight = Math.min(windowRight, selectionRight);
        const overlapBottom = Math.min(windowBottom, selectionBottom);
        
        // If there is no overlap
        if (overlapLeft >= overlapRight || overlapTop >= overlapBottom) {
            return 0;
        }
        
        // Calculate the overlap area
        const overlapArea = (overlapRight - overlapLeft) * (overlapBottom - overlapTop);
        const selectionArea = selectionRect.width * selectionRect.height;
        
        // Return the overlap score (relative to the selection area)
        return selectionArea > 0 ? overlapArea / selectionArea : 0;
    }

    // === Other methods remain unchanged ===
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
        
        // Check if in reading mode
        const isInReaderMode = document.getElementById('word-munch-reader-container');
        
        const simplifyBtn = widget.querySelector('.wm-simplify-btn');
        if (simplifyBtn) {
            // Remove possible old event listeners
            simplifyBtn.replaceWith(simplifyBtn.cloneNode(true));
            const newSimplifyBtn = widget.querySelector('.wm-simplify-btn');
            
            // Use stronger event binding
            const handleSimplifyClick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('Word Munch: Simplify button clicked in reader mode:', isInReaderMode ? 'YES' : 'NO');
                ResultDisplayer.showNextSynonym();
            };
            
            newSimplifyBtn.addEventListener('click', handleSimplifyClick, { capture: true });
            
            // Add additional event listeners in reading mode
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
            // Same handling
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
            
            // Prevent text selection events within textarea from bubbling up
            understandingInput.addEventListener('mouseup', (e) => {
                e.stopPropagation();
                console.log('Word Munch: Text selection within understanding input prevented from bubbling');
            });
            
            understandingInput.addEventListener('keyup', (e) => {
                e.stopPropagation();
            });
            
            understandingInput.addEventListener('dblclick', (e) => {
                e.stopPropagation();
            });
            
            // Temporarily disable global text selection when focusing on input
            understandingInput.addEventListener('focus', () => {
                console.log('Word Munch: Understanding input focused, disabling global text selection');
                eventManager.removeOutsideClickListener();
                window._conceptMuncherInputFocused = true;
            });
            
            understandingInput.addEventListener('blur', () => {
                console.log('Word Munch: Understanding input blurred, re-enabling global text selection');
                window._conceptMuncherInputFocused = false;
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
        
        // Clear concept muncher input focus flag
        window._conceptMuncherInputFocused = false;
        
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
        // Create independent word window for understanding analysis mode
        console.log('Word Munch: Creating independent word window for:', selectedText);
        
        // Check if an independent window for the same word already exists to prevent duplicates
        const existingIndependentWidget = document.querySelector('.independent-widget .wm-header-text');
        if (existingIndependentWidget) {
            const existingText = existingIndependentWidget.textContent.replace(/[📝"]/g, '').replace(/\.\.\.$/, '').trim();
            if (existingText === selectedText || selectedText.includes(existingText)) {
                console.log('Word Munch: Independent window for this word already exists, skip creation');
                return;
            }
        }
        
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        
        const independentWidget = document.createElement('div');
        independentWidget.id = 'word-munch-independent-widget';
        independentWidget.className = 'word-munch-floating-widget independent-widget';
        
        // avoid overlapping with the concept window
        let widgetX = rect.left;
        let widgetY = rect.bottom + 10;
        
        // If there is a concept window, try to avoid overlapping.
        if (state.floatingWidget) {
            const conceptRect = state.floatingWidget.getBoundingClientRect();
            // If the positions may overlap, adjust the positions.
            if (Math.abs(widgetX - conceptRect.left) < 200 && Math.abs(widgetY - conceptRect.top) < 100) {
                widgetX = Math.min(conceptRect.right + 20, window.innerWidth - 300);
                if (widgetX + 300 > window.innerWidth) {
                    widgetX = Math.max(conceptRect.left - 320, 20);
                    if (widgetX < 20) {
                        widgetY = Math.max(conceptRect.bottom + 20, rect.bottom + 10);
                    }
                }
            }
        }
        
        // Boundary check
        widgetX = Math.max(20, Math.min(widgetX, window.innerWidth - 300));
        widgetY = Math.max(20, Math.min(widgetY, window.innerHeight - 200));
        
        independentWidget.style.left = `${widgetX}px`;
        independentWidget.style.top = `${widgetY}px`;
        independentWidget.style.position = 'fixed';
        independentWidget.style.zIndex = '10002'; // Higher than concept window
        independentWidget.style.width = '280px';
        
        // Check if in reader mode
        const isInReaderMode = document.getElementById('word-munch-reader-container');
        if (isInReaderMode) {
            independentWidget.style.zIndex = '2147483649'; // Higher than reader mode
            console.log('Word Munch: Independent widget in reader mode, using highest z-index');
        }
        
        independentWidget.innerHTML = ContentTemplates.createWordMuncherContent(selectedText);
        document.body.appendChild(independentWidget);
        
        // Set drag-and-drop function
        DragHandler.makeDraggable(independentWidget);
        
        // Bind event
        this.setupIndependentWidgetEvents(independentWidget, selectedText);
        
        // Show animation
        setTimeout(() => {
            independentWidget.classList.add('show');
        }, 10);
        
        // Automatic start simplified
        console.log('Word Munch: Starting simplification for independent widget:', selectedText);
        
        // Create a temporary status to handle this independent request
        const tempRequestId = Math.random().toString(36).substr(2, 9);
        independentWidget.setAttribute('data-request-id', tempRequestId);
        
        // Send simplified request
        const context = this.getContextAroundSelection(selection);
        
        // 使用独立的API调用方法，避免错误被路由到主窗口
        this.sendIndependentWidgetRequest(independentWidget, {
            type: 'WORD_SELECTED',
            word: selectedText,
            text: selectedText,
            context: context,
            url: window.location.href,
            title: document.title,
            requestId: tempRequestId,
            isIndependent: true
        });
        
        // Add timeout handling
        setTimeout(() => {
            if (independentWidget && independentWidget.parentNode) {
                const loadingEl = independentWidget.querySelector('.wm-loading');
                const errorEl = independentWidget.querySelector('.wm-error');
                
                if (loadingEl && loadingEl.style.display !== 'none') {
                    if (loadingEl) loadingEl.style.display = 'none';
                    if (errorEl) {
                        errorEl.innerHTML = `
                            <div style="margin-bottom: 8px;">Request timeout</div>
                            <button class="wm-btn wm-btn-primary wm-retry-btn" style="width: auto; padding: 6px 12px; font-size: 12px;">
                                Retry
                            </button>
                        `;
                        errorEl.classList.add('show');
                        
                        const retryBtn = errorEl.querySelector('.wm-retry-btn');
                        if (retryBtn) {
                            retryBtn.addEventListener('click', () => {
                                // Restart simplified
                                errorEl.classList.remove('show');
                                loadingEl.style.display = 'flex';
                                
                                const newRequestId = Math.random().toString(36).substr(2, 9);
                                independentWidget.setAttribute('data-request-id', newRequestId);
                                
                                this.sendIndependentWidgetRequest(independentWidget, {
                                    type: 'WORD_SELECTED',
                                    word: selectedText,
                                    text: selectedText,
                                    context: context,
                                    url: window.location.href,
                                    title: document.title,
                                    requestId: newRequestId,
                                    isIndependent: true
                                });
                            });
                        }
                    }
                }
            }
        }, 15000);
        
        console.log('Word Munch: Independent word window created successfully');
    }

    // 独立窗口专用的API请求方法
    static sendIndependentWidgetRequest(widget, message) {
        const messageId = Math.random().toString(36).substr(2, 9);
        message.messageId = messageId;
        message.timestamp = Date.now();
        
        console.log('Word Munch: Send independent widget request:', message.type, messageId);
        
        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Word Munch: Independent widget request failed:', chrome.runtime.lastError.message);
                    
                    if (widget && widget.parentNode) {
                        const loadingEl = widget.querySelector('.wm-loading');
                        const errorEl = widget.querySelector('.wm-error');
                        
                        if (loadingEl) loadingEl.style.display = 'none';
                        if (errorEl) {
                            let errorMessage = 'Connection failed';
                            if (chrome.runtime.lastError.message.includes('Extension context invalidated')) {
                                errorMessage = 'Extension needs refresh, please refresh page';
                            }
                            
                            errorEl.innerHTML = `
                                <div style="margin-bottom: 8px;">${errorMessage}</div>
                                <button class="wm-btn wm-btn-primary wm-retry-btn" style="width: auto; padding: 6px 12px; font-size: 12px;">
                                    Retry
                                </button>
                            `;
                            errorEl.classList.add('show');
                            
                            // 绑定重试按钮
                            const retryBtn = errorEl.querySelector('.wm-retry-btn');
                            if (retryBtn) {
                                retryBtn.addEventListener('click', () => {
                                    errorEl.classList.remove('show');
                                    if (loadingEl) loadingEl.style.display = 'flex';
                                    
                                    // 重新发送请求
                                    const newRequestId = Math.random().toString(36).substr(2, 9);
                                    widget.setAttribute('data-request-id', newRequestId);
                                    message.requestId = newRequestId;
                                    
                                    this.sendIndependentWidgetRequest(widget, message);
                                });
                            }
                        }
                    }
                    return;
                }
                
                if (response) {
                    console.log('Word Munch: Independent widget received background response:', response);
                    
                    if (response.received) {
                        console.log('Word Munch: Independent widget message received by background');
                    } else if (response.error) {
                        console.error('Word Munch: Independent widget background processing error:', response.error);
                        
                        if (widget && widget.parentNode) {
                            const requestId = widget.getAttribute('data-request-id');
                            this.handleIndependentWidgetResponse(requestId, null, response.error);
                        }
                    }
                } else {
                    console.warn('Word Munch: No response from background for independent widget');
                    
                    if (widget && widget.parentNode) {
                        const requestId = widget.getAttribute('data-request-id');
                        this.handleIndependentWidgetResponse(requestId, null, 'No response received');
                    }
                }
            });
        } catch (error) {
            console.error('Word Munch: Independent widget send message exception:', error);
            
            if (widget && widget.parentNode) {
                const requestId = widget.getAttribute('data-request-id');
                this.handleIndependentWidgetResponse(requestId, null, 'Failed to send request');
            }
        }
    }

    static setupIndependentWidgetEvents(widget, selectedText) {
        console.log('Word Munch: Setting up independent widget events for:', selectedText);
        
        // Bind close button
        const closeBtn = widget.querySelector('.wm-close-btn');
        if (closeBtn) {
            const handleCloseClick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                console.log('Word Munch: Closing independent widget');
                
                // 临时标记正在处理独立窗口按钮点击
                window._wordMunchIndependentButtonClick = true;
                setTimeout(() => {
                    window._wordMunchIndependentButtonClick = false;
                }, 100);
                
                // Remove window
                if (widget.parentNode) {
                    widget.classList.remove('show');
                    setTimeout(() => {
                        if (widget.parentNode) {
                            widget.parentNode.removeChild(widget);
                        }
                    }, 300);
                }
            };
            
            closeBtn.addEventListener('click', handleCloseClick, { capture: true });
            closeBtn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }, { capture: true });
            closeBtn.addEventListener('mouseup', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }, { capture: true });
        }
        
        // Bind simplify button
        const simplifyBtn = widget.querySelector('.wm-simplify-btn');
        if (simplifyBtn) {
            const handleSimplifyClick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation(); // 防止其他事件监听器处理这个事件
                console.log('Word Munch: Independent widget simplify button clicked');
                
                // 临时标记正在处理独立窗口按钮点击，防止意外的文本选择处理
                window._wordMunchIndependentButtonClick = true;
                setTimeout(() => {
                    window._wordMunchIndependentButtonClick = false;
                }, 100);
                
                // Switch to next synonym
                this.showNextSynonymForWidget(widget);
            };
            
            // 使用多种事件绑定方式确保事件被完全拦截
            simplifyBtn.addEventListener('click', handleSimplifyClick, { capture: true });
            simplifyBtn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }, { capture: true });
            simplifyBtn.addEventListener('mouseup', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }, { capture: true });
        }
        
        // Bind copy button
        const copyBtn = widget.querySelector('.wm-copy-btn');
        if (copyBtn) {
            const handleCopyClick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                console.log('Word Munch: Independent widget copy button clicked');
                
                // 临时标记正在处理独立窗口按钮点击
                window._wordMunchIndependentButtonClick = true;
                setTimeout(() => {
                    window._wordMunchIndependentButtonClick = false;
                }, 100);
                
                // Copy current synonym
                this.copySynonymForWidget(widget);
            };
            
            // 使用多种事件绑定方式确保事件被完全拦截
            copyBtn.addEventListener('click', handleCopyClick, { capture: true });
            copyBtn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }, { capture: true });
            copyBtn.addEventListener('mouseup', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }, { capture: true });
        }
        
        // Set click outside close logic (delay adding to avoid immediate trigger)
        setTimeout(() => {
            const handleOutsideClick = (e) => {
                // Skip if currently processing independent widget button click
                if (window._wordMunchIndependentButtonClick) {
                    console.log('Word Munch: Ignoring outside click during independent widget button processing');
                    return;
                }
                
                if (!widget.contains(e.target)) {
                    console.log('Word Munch: Outside click detected for independent widget');
                    
                    // 标记正在关闭独立窗口
                    window._wordMunchIndependentButtonClick = true;
                    setTimeout(() => {
                        window._wordMunchIndependentButtonClick = false;
                    }, 100);
                    
                    // Remove window
                    if (widget.parentNode) {
                        widget.classList.remove('show');
                        setTimeout(() => {
                            if (widget.parentNode) {
                                widget.parentNode.removeChild(widget);
                            }
                        }, 300);
                    }
                    
                    // Remove event listener
                    document.removeEventListener('click', handleOutsideClick, true);
                }
            };
            
            document.addEventListener('click', handleOutsideClick, true);
            
            // Store event handler reference for later cleanup
            widget._outsideClickHandler = handleOutsideClick;
        }, 500);
    }
    
    // Show next synonym for independent widget
    static showNextSynonymForWidget(widget) {
        const currentResult = widget._wordResult;
        if (!currentResult || !currentResult.synonyms || currentResult.synonyms.length === 0) {
            console.log('Word Munch: No synonyms available for independent widget');
            return;
        }
        
        let currentIndex = widget._synonymIndex || 0;
        const total = currentResult.synonyms.length;
        
        if (currentIndex < total - 1) {
            currentIndex++;
        } else {
            currentIndex = 0; // Loop back to the first
        }
        
        widget._synonymIndex = currentIndex;
        this.updateSynonymDisplayForWidget(widget, currentResult, currentIndex);
    }
    
    // Copy synonym for independent widget
    static copySynonymForWidget(widget) {
        const currentResult = widget._wordResult;
        const currentIndex = widget._synonymIndex || 0;
        
        if (!currentResult || !currentResult.synonyms || currentIndex >= currentResult.synonyms.length) {
            console.log('Word Munch: No synonym to copy for independent widget');
            return;
        }
        
        const synonym = currentResult.synonyms[currentIndex];
        const synonymText = typeof synonym === 'string' ? synonym : synonym.word || '';
        
        if (synonymText) {
            navigator.clipboard.writeText(synonymText).then(() => {
                console.log('Word Munch: Copied synonym from independent widget:', synonymText);
                
                const copyBtn = widget.querySelector('.wm-copy-btn');
                if (copyBtn) {
                    copyBtn.classList.add('success');
                    setTimeout(() => {
                        copyBtn.classList.remove('success');
                    }, 1000);
                }
            }).catch(err => {
                console.error('Word Munch: Copy failed for independent widget:', err);
            });
        }
    }
    
    // Update synonym display for independent widget
    static updateSynonymDisplayForWidget(widget, result, index) {
        const synonymEl = widget.querySelector('.wm-synonym');
        const simplifyBtn = widget.querySelector('.wm-simplify-btn');
        
        if (!synonymEl || !result.synonyms || index >= result.synonyms.length) {
            return;
        }
        
        const synonym = result.synonyms[index];
        const synonymText = typeof synonym === 'string' ? synonym : synonym.word || 'Simplification complete';
        
        synonymEl.textContent = synonymText;
        
        if (simplifyBtn) {
            const current = index + 1;
            const total = result.synonyms.length;
            
            simplifyBtn.classList.remove('wm-btn-loop', 'wm-btn-next');
            
            if (current < total) {
                simplifyBtn.disabled = false;
                simplifyBtn.innerHTML = '▶';
                simplifyBtn.title = `Simplify (${current}/${total})`;
                simplifyBtn.classList.add('wm-btn-next');
            } else {
                simplifyBtn.disabled = false;
                simplifyBtn.innerHTML = '↻';
                simplifyBtn.title = `Back to first (${current}/${total})`;
                simplifyBtn.classList.add('wm-btn-loop');
            }
        }
    }

    // Add method for handling independent widget API response
    static handleIndependentWidgetResponse(requestId, result, error = null) {
        const independentWidget = document.querySelector(`[data-request-id="${requestId}"]`);
        
        if (!independentWidget || !independentWidget.parentNode) {
            console.log('Word Munch: Independent widget not found for request:', requestId);
            return;
        }
        
        const loadingEl = independentWidget.querySelector('.wm-loading');
        const resultEl = independentWidget.querySelector('.wm-result');
        const errorEl = independentWidget.querySelector('.wm-error');
        
        if (error) {
            console.error('Word Munch: Independent widget error:', error);
            
            if (loadingEl) loadingEl.style.display = 'none';
            if (resultEl) resultEl.classList.remove('show');
            if (errorEl) {
                errorEl.innerHTML = `
                    <div style="margin-bottom: 8px;">${error}</div>
                    <button class="wm-btn wm-btn-primary wm-retry-btn" style="width: auto; padding: 6px 12px; font-size: 12px;">
                        Retry
                    </button>
                `;
                errorEl.classList.add('show');
                
                // Bind retry button event
                const retryBtn = errorEl.querySelector('.wm-retry-btn');
                if (retryBtn) {
                    retryBtn.addEventListener('click', () => {
                        errorEl.classList.remove('show');
                        loadingEl.style.display = 'flex';
                        
                        // Trigger the logic for re-requesting in createIndependentWordWindow
                    });
                }
            }
        } else if (result && result.synonyms && result.synonyms.length > 0) {
            console.log('Word Munch: Independent widget received result:', result);
            
            // Store result and index
            independentWidget._wordResult = result;
            independentWidget._synonymIndex = 0;
            
            if (loadingEl) loadingEl.style.display = 'none';
            if (errorEl) errorEl.classList.remove('show');
            if (resultEl) resultEl.classList.add('show');
            
            // Update display
            this.updateSynonymDisplayForWidget(independentWidget, result, 0);
            
            console.log('Word Munch: Independent widget result displayed successfully');
        } else {
            console.log('Word Munch: Independent widget received empty result');
            
            if (loadingEl) loadingEl.style.display = 'none';
            if (resultEl) resultEl.classList.remove('show');
            if (errorEl) {
                errorEl.classList.add('show');
                errorEl.textContent = 'No simplification results';
            }
        }
    }

    // Add method for getting context (moved from APIManager for independent use)
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
}

// === Content templates ===
class ContentTemplates {
    static createWordMuncherContent(text) {
        return `
            <div class="wm-header">
                <div class="wm-header-text drag-handle">
                    📝 "${text.length > 25 ? text.substring(0, 25) + '...' : text}"
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
                    <!-- Make cost display more subtle -->
                    <div class="concept-cost-minimal-improved">~$0.0002</div>
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

// === Drag handler ===
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

// === API manager ===
class APIManager {
    static startSimplification(text, type) {
        // Important: check extension status again before API call
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: Extension disabled, cancel API call');
            WidgetManager.closeFloatingWidget();
            return;
        }
        
        const context = state.currentSelection ? this.getContextAroundSelection(state.currentSelection.selection) : '';
        
        console.log('Word Munch: Start simplification:', text, type);
        
        // Check cache
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

// === Result displayer ===
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
            
            // If there is only one synonym, add a special prompt. 
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
                
                // Remove previous styles
                simplifyBtn.classList.remove('wm-btn-loop', 'wm-btn-next');
                
                if (current < total) {
                    // Not the last one, display the normal "Symplify"
                    simplifyBtn.disabled = false;
                    simplifyBtn.innerHTML = '▶';
                    simplifyBtn.title = `Symplify (${current}/${total})`;
                    simplifyBtn.classList.add('wm-btn-next');
                } else {
                    // The last one, display the loop prompt
                    simplifyBtn.disabled = false;
                    simplifyBtn.innerHTML = '↻';
                    simplifyBtn.title = `Back to first (${current}/${total})`;
                    simplifyBtn.classList.add('wm-btn-loop');
                }
            }
        }
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
            // Loop back to the first one
            state.currentSynonymIndex = 0;
            console.log('Word Munch: Looping back to first synonym');
            
            // Add loop animation effect
            this.showLoopAnimation();
        }
        
        this.updateSynonymDisplay();
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
        // Important: Check extension status before understanding analysis
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
                // Make cost display more subtle
                costElement.textContent = `~$${estimatedCost.toFixed(4)}`;
                costElement.style.fontSize = '11px';
                costElement.style.opacity = '0.6';
                costElement.style.color = '#6b7280'; // Use gray for cost display
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
        
        // Prioritize Claude's detailed feedback
        let suggestionsToShow = [];
        let suggestionsTitle = "💡 Key Suggestions";
        let isEssentiallyCorrect = false;
        
        if (analysis.detailed_feedback && analysis.detailed_feedback.actionable_suggestions) {
            // Use Claude's specific feedback
            suggestionsToShow = analysis.detailed_feedback.actionable_suggestions;
            suggestionsTitle = "🤖 AI Feedback";
            isEssentiallyCorrect = analysis.detailed_feedback.is_essentially_correct || false;
            console.log('Word Munch: Using Claude detailed feedback, essentially correct:', isEssentiallyCorrect);
        } else {
            // Fallback to generic suggestions
            suggestionsToShow = analysis.suggestions.slice(0, 2);
            console.log('Word Munch: Using generic suggestions');
        }
        
        // Build suggestions HTML - show all suggestions, no truncation
        const suggestionsHTML = suggestionsToShow.map(suggestion => 
            `<div class="suggestion-item">• ${suggestion}</div>`
        ).join('');
        
        // If Claude has detailed feedback, display more information
        let additionalFeedbackHTML = '';
        if (analysis.detailed_feedback) {
            const feedback = analysis.detailed_feedback;
            
            // Only show if there are genuine misunderstandings
            if (feedback.misunderstandings && feedback.misunderstandings.length > 0 && !isEssentiallyCorrect) {
                additionalFeedbackHTML += `
                    <div class="concept-key-gaps-improved">
                        <div class="gaps-header">
                            <span class="gaps-icon">⚠️</span>
                            <span class="gaps-title">Key Gaps</span>
                            ${feedback.cognitive_level ? `<span class="cognitive-level-badge">${feedback.cognitive_level}</span>` : ''}
                        </div>
                        <div class="gaps-content">
                            ${feedback.misunderstandings.map(gap => 
                                `<div class="gap-item">
                                    <span class="gap-bullet">•</span>
                                    <span class="gap-text">${gap}</span>
                                </div>`
                            ).join('')}
                        </div>
                    </div>
                `;
            } else if (isEssentiallyCorrect) {
                additionalFeedbackHTML += `
                    <div class="concept-encouragement-improved">
                        <div class="encouragement-header">
                            <span class="encouragement-icon">✅</span>
                            <span class="encouragement-title">Good Understanding</span>
                            ${feedback.cognitive_level ? `<span class="cognitive-level-badge success">${feedback.cognitive_level}</span>` : ''}
                        </div>
                        <div class="encouragement-content">
                            <span class="encouragement-text">Your grasp of the core concept is solid</span>
                        </div>
                    </div>
                `;
            }
        }
        
        // Adjust score display color
        let scoreColor = '#6366f1'; // Default blue
        if (isEssentiallyCorrect) {
            scoreColor = '#16a34a'; // Green for correct understanding
        } else if (scorePercentage < 30) {
            scoreColor = '#ef4444'; // Red for improvement needed
        }
        
        // Full result HTML
        const resultsHTML = `
            <div class="concept-score-minimal">
                <div class="score-circle" style="background: linear-gradient(135deg, ${scoreColor}, ${scoreColor}aa)">
                    <span class="score-number">${scorePercentage}%</span>
                </div>
                <div class="score-label">
                    ${isEssentiallyCorrect ? 'Good Understanding' : 'Understanding Match'}
                </div>
            </div>
            
            ${additionalFeedbackHTML}
            
            <div class="concept-suggestions-improved">
                <div class="suggestions-header">
                    <span class="suggestions-icon">💡</span>
                    <span class="suggestions-title">${suggestionsTitle}</span>
                </div>
                <div class="suggestions-content">
                    ${suggestionsToShow.map(suggestion => 
                        `<div class="suggestion-item-improved">
                            <span class="suggestion-bullet">→</span>
                            <span class="suggestion-text">${suggestion}</span>
                        </div>`
                    ).join('')}
                </div>
            </div>
            
            <!-- Move cost to bottom, make it more subtle -->
            <div class="concept-cost-final">
                <span class="cost-text">$${(actualCost * 100).toFixed(3)}¢</span>
            </div>
        `;
        
        resultsElement.innerHTML = resultsHTML;
        resultsElement.style.display = 'block';
        loadingElement.style.display = 'none';
        
        // Simplified highlight display
        if (analysis.segments) {
            HighlightManager.highlightOriginalText(analysis.segments);
        }
        
        if (isEssentiallyCorrect) {
            console.log('Word Munch: Understanding is essentially correct, adjusting highlight emphasis');
        }
    }
}

// === Highlight manager  ===
class HighlightManager {
    static highlightOriginalText(segments) {
        console.log('Word Munch: Start displaying scroll-following highlights on original text');
        
        this.clearOriginalHighlights();
        
        if (!state.currentSelection || !state.currentSelection.range) {
            console.log('Word Munch: No current selection, cannot highlight');
            return;
        }
        
        // Check if in reading mode
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

    // Highlight processing in reading mode
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
                    highlight.style.opacity = '0.4'; // Slightly more visible in reading mode
                    highlight.style.zIndex = '2147483649'; // Higher than reading mode and floating window
                    highlight.style.transition = 'all 0.1s ease-out';
                    
                    const colors = {
                        'excellent': '#059669',
                        'good': '#16a34a',
                        'fair': '#ca8a04',
                        'partial': '#ea580c',
                        'poor': '#ef4444'
                    };
                    highlight.style.backgroundColor = colors[segment.level] || '#6b7280';
                    
                    // Add highlight to reading container in reading mode
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

// === Message handler ===
class MessageHandlers {
    static handleWordSimplified(word, result) {
        console.log('Word Munch: Word simplification complete:', word, result);
        
        // 首先检查是否有活跃的独立窗口等待这个单词的结果
        const independentWidgets = document.querySelectorAll('.independent-widget[data-request-id]');
        for (const widget of independentWidgets) {
            const widgetText = widget.querySelector('.wm-header-text')?.textContent;
            // 改进匹配逻辑：检查单词是否包含在标题中，或者标题是否包含单词的开头部分
            if (widgetText && (widgetText.includes(word) || word.includes(widgetText.replace(/[📝"]/g, '').replace(/\.\.\.$/, '').trim()))) {
                console.log('Word Munch: Found matching independent widget for word:', word, 'title:', widgetText);
                const requestId = widget.getAttribute('data-request-id');
                WidgetManager.handleIndependentWidgetResponse(requestId, result);
                return;
            }
        }
        
        // 如果在concept mode且主窗口不是处理这个单词，则可能是独立窗口的响应
        if (state.isConceptMode && (!state.currentSelection || state.currentSelection.text !== word)) {
            console.log('Word Munch: In concept mode and no matching main window, checking for independent widgets');
            
            // 查找任何正在加载的独立窗口
            const loadingWidgets = document.querySelectorAll('.independent-widget .wm-loading[style*="flex"], .independent-widget .wm-loading:not([style*="none"])');
            if (loadingWidgets.length > 0) {
                console.log('Word Munch: Found loading independent widget, routing response to it');
                const loadingWidget = loadingWidgets[0].closest('.independent-widget');
                const requestId = loadingWidget.getAttribute('data-request-id');
                WidgetManager.handleIndependentWidgetResponse(requestId, result);
                return;
            }
        }
        
        // Handle main window response
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

        // Record cognitive data
        CognitiveDataRecorder.recordAnalysisResult(original_text, result).catch(error => {
            console.error('Word Munch: Failed to record cognitive data:', error);
        });
    }

    static handleSimplifyError(word, error) {
        console.error('Word Munch: Simplification failed:', word, error);
        
        // Check if there is an active independent widget waiting for this word result
        const independentWidgets = document.querySelectorAll('.independent-widget[data-request-id]');
        for (const widget of independentWidgets) {
            const widgetText = widget.querySelector('.wm-header-text')?.textContent;
            // 改进匹配逻辑：检查单词是否包含在标题中，或者标题是否包含单词的开头部分
            if (widgetText && (widgetText.includes(word) || word.includes(widgetText.replace(/[📝"]/g, '').replace(/\.\.\.$/, '').trim()))) {
                console.log('Word Munch: Found matching independent widget for error:', word, 'title:', widgetText);
                const requestId = widget.getAttribute('data-request-id');
                WidgetManager.handleIndependentWidgetResponse(requestId, null, error.message || error);
                return;
            }
        }
        
        // If in concept mode and main window is not handling this word, it might be an independent widget error
        if (state.isConceptMode && (!state.currentSelection || state.currentSelection.text !== word)) {
            console.log('Word Munch: In concept mode and no matching main window, checking for independent widgets for error');
            
            // Find any loading independent widgets
            const loadingWidgets = document.querySelectorAll('.independent-widget .wm-loading[style*="flex"], .independent-widget .wm-loading:not([style*="none"])');
            if (loadingWidgets.length > 0) {
                console.log('Word Munch: Found loading independent widget, routing error to it');
                const loadingWidget = loadingWidgets[0].closest('.independent-widget');
                const requestId = loadingWidget.getAttribute('data-request-id');
                WidgetManager.handleIndependentWidgetResponse(requestId, null, error.message || error);
                return;
            }
        }
        
        // Handle main window error
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
        
        // Update local settings status
        state.extensionSettings = { ...state.extensionSettings, ...settings };
        
        if (settings.hasOwnProperty('conceptMuncherEnabled')) {
            console.log('Word Munch: Concept analysis feature status:', settings.conceptMuncherEnabled);
        }
        
        // If extension is disabled, immediately close all windows and clear state
        if (!state.extensionSettings.extensionEnabled) {
            console.log('Word Munch: Extension disabled, immediately close all windows and clear state');
            WidgetManager.closeFloatingWidget();
            HighlightManager.clearOriginalHighlights();
            
            // Clear all timers and requests
            state.cancelCurrentRequest();
            
            // Reset all states
            state.reset();
            
            console.log('Word Munch: Cleanup complete after extension disabled');
        }
    }
}

// === 初始化 ===
const eventManager = new EventManager();

// Initialization after page load
document.addEventListener('DOMContentLoaded', async function() {
    console.log('Word Munch: Content script loaded');
    
    // Simple delay to give extension time to initialize
    await new Promise(resolve => setTimeout(resolve, 500));
    
    await loadConfig();
    await state.loadSettings();
    
    APIManager.sendMessageToBackground({
        type: 'CONTENT_SCRIPT_READY',
        url: window.location.href
    });

    ResultDisplayer.initializeStyles();
});

if (document.readyState !== 'loading') {
    console.log('Word Munch: Content script loaded (page already complete)');
    
    setTimeout(async () => {
        await loadConfig();
        await state.loadSettings();
        
        APIManager.sendMessageToBackground({
            type: 'CONTENT_SCRIPT_READY',
            url: window.location.href
        });
    }, 1000); // Give more time for extension to prepare
}

// Error handling
window.addEventListener('error', function(event) {
    console.error('Word Munch: Content script error:', event.error);
});

// Clean up resources
window.addEventListener('beforeunload', function() {
    console.log('Word Munch: Page unload, clear highlight resources');
    HighlightManager.stopScrollTracking();
    HighlightManager.clearOriginalHighlights();
});

console.log('Word Munch: Content script initialization complete');

// === Debug functions ===
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

// Debug function to get extension status
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

// Debug function to manually reload settings
window.reloadExtensionSettings = async function() {
    console.log('Word Munch: Manually reload settings');
    await state.loadSettings();
    console.log('Word Munch: Settings reload complete:', state.extensionSettings);
    return state.extensionSettings;
};

// === Simple reader mode ===
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

        // Bind paragraph click event - but avoid interfering with text selection
        container.querySelectorAll('.text-chunk').forEach((chunk, index) => {
            // Use mousedown instead of click, and check if it is text selection
            chunk.addEventListener('mousedown', (e) => {
                // Record the time and position of the mouse down
                chunk._mouseDownTime = Date.now();
                chunk._mouseDownX = e.clientX;
                chunk._mouseDownY = e.clientY;
            });
            
            chunk.addEventListener('mouseup', (e) => {
                // Check if it is a quick click (not text selection)
                const timeDiff = Date.now() - (chunk._mouseDownTime || 0);
                const distanceX = Math.abs(e.clientX - (chunk._mouseDownX || 0));
                const distanceY = Math.abs(e.clientY - (chunk._mouseDownY || 0));
                
                // If it is a quick click and the mouse movement distance is small, trigger focus
                if (timeDiff < 200 && distanceX < 5 && distanceY < 5) {
                    // Check if there is text selected
                    const selection = window.getSelection();
                    const selectedText = selection.toString().trim();
                    
                    // Only trigger paragraph focus when there is no selected text
                    if (!selectedText || selectedText.length === 0) {
                        console.log('Word Munch: Paragraph click focus, index:', index);
                        this.currentChunkIndex = index;
                        this.focusChunk(chunk, index);
                    } else {
                        console.log('Word Munch: Text selection detected, skip paragraph focus');
                    }
                }
            });
            
            // Double click to exit focus mode
            chunk.addEventListener('dblclick', (e) => {
                // Delay check to ensure double click does not interfere with text selection
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

// Initialize simple reader
const simpleReader = new SimpleReaderMode();

// === Cognitive Data Recorder ===
class CognitiveDataRecorder {
    static async recordAnalysisResult(originalText, result) {
        try {
            // Get user info from extension storage
            const userInfo = await this.getUserInfo();
            if (!userInfo) return;

            // Build cognitive data
            const cognitiveData = {
                original_text: originalText,
                analysis_result: result,
                timestamp: Date.now(),
                url: window.location.href,
                title: document.title,
                user_agent: navigator.userAgent
            };

            // Send to background script
            chrome.runtime.sendMessage({
                type: 'RECORD_COGNITIVE_DATA',
                userId: userInfo.userId || userInfo.email,
                data: cognitiveData
            });

        } catch (error) {
            console.error('Word Munch: Failed to record cognitive data:', error);
        }
    }

    static async getUserInfo() {
        return new Promise((resolve) => {
            chrome.storage.sync.get(['userEmail', 'userId', 'userToken'], (result) => {
                if (result.userEmail) {
                    resolve({
                        userId: result.userId || result.userEmail,
                        email: result.userEmail,
                        token: result.userToken
                    });
                } else {
                    resolve(null);
                }
            });
        });
    }
}

class CognitiveDashboard {
    constructor() {
        this.isVisible = false;
        this.dashboardContainer = null;
        this.currentRequestId = null;
        
        // Demo data for testing (replace with real data later)
        this.demoData = {
            total_analyses: 47,
            days_covered: 23,
            average_score: 76,
            
            cognitive_radar: {
                comprehension: 82,
                coverage: 68,
                depth: 85,
                accuracy: 74,
                analysis: 77,
                synthesis: 71
            },
            
            strengths: [
                '🎯 Excellent deep analysis - you excel at understanding complex concepts',
                '📊 Strong logical reasoning - great at identifying cause-and-effect relationships', 
                '🔍 High attention to detail - rarely miss important supporting evidence'
            ],
            
            weaknesses: [
                '📖 Information coverage could be broader - sometimes miss the bigger picture',
                '🔄 Synthesis skills need development - connecting ideas across different sections',
                '⚡ Reading efficiency - could benefit from faster initial comprehension'
            ],
            
            bloom_distribution: {
                'remember': 2,
                'understand': 15,
                'apply': 8,
                'analyze': 12,
                'evaluate': 7,
                'create': 3
            },
            
            personalized_suggestions: [
                {
                    icon: '🎯',
                    title: 'Strengthen Global Perspective',
                    description: 'Your detail analysis is excellent, but you could benefit from better overall comprehension',
                    action: 'Before diving into details, spend 30 seconds skimming the entire article to build a mental framework'
                },
                {
                    icon: '🔗',
                    title: 'Practice Information Synthesis', 
                    description: 'Work on connecting different parts of the article and relating them to your existing knowledge',
                    action: 'After reading each section, ask yourself: "How does this relate to what I just read?"'
                },
                {
                    icon: '💡',
                    title: 'Leverage Your Analytical Strength',
                    description: 'Your deep analysis ability is a major asset - continue building on this foundation',
                    action: 'Try analyzing more complex texts to further develop this strength'
                }
            ],
            
            error_patterns: {
                'main_idea': { 
                    label: 'Main Idea Understanding', 
                    count: 3, 
                    percentage: 28,
                    suggestion: 'Focus on thesis statements and topic sentences in each paragraph' 
                },
                'details': { 
                    label: 'Supporting Details', 
                    count: 2, 
                    percentage: 15,
                    suggestion: 'Your detail comprehension is strong - maintain this level' 
                },
                'inference': { 
                    label: 'Reading Between Lines', 
                    count: 5, 
                    percentage: 42,
                    suggestion: 'Practice identifying implied meanings and author intentions' 
                },
                'structure': { 
                    label: 'Text Organization', 
                    count: 2, 
                    percentage: 15,
                    suggestion: 'Pay attention to how authors structure their arguments' 
                }
            },
            
            isDemo: true
        };
        
        console.log('Word Munch: CognitiveDashboard initialized with enhanced demo data');
    }

    async showDashboard(userId, isAnonymous = false) {
        console.log('Word Munch: Show cognitive dashboard for user:', userId, 'Anonymous:', isAnonymous);
        
        if (this.isVisible) {
            this.hideDashboard();
            return;
        }

        try {
            this.createDashboard();
            this.isVisible = true;
            
            // If the user is anonymous, directly display the demonstration data.
            if (isAnonymous || userId === 'anonymous_user' || userId.includes('anonymous')) {
                console.log('Word Munch: Using demo data for anonymous user');
                
                const demoData = {
                    ...this.demoData,
                    isDemo: true,
                    isAnonymous: true
                };
                
                setTimeout(() => {
                    this.renderDashboard(demoData);
                }, 300);
            } else {
                // Logged-in user requests real data
                await this.requestCognitiveProfile(userId);
            }
            
        } catch (error) {
            console.error('Word Munch: Failed to show dashboard:', error);
            this.isVisible = false;
            if (this.dashboardContainer) {
                this.dashboardContainer.remove();
                this.dashboardContainer = null;
            }
        }
    }

    createDashboard() {
        console.log('Word Munch: Creating dashboard DOM...');
        
        // Clean up any existing dashboard.
        const existingDashboard = document.querySelector('.cognitive-dashboard-overlay');
        if (existingDashboard) {
            existingDashboard.remove();
        }
        
        this.dashboardContainer = document.createElement('div');
        this.dashboardContainer.className = 'cognitive-dashboard-overlay';
        this.dashboardContainer.innerHTML = this.generateDashboardHTML();
        
        // Ensure styles are loaded.
        this.addDashboardStyles();
        
        console.log('Word Munch: Appending dashboard to body...');
        document.body.appendChild(this.dashboardContainer);
        
        console.log('Word Munch: Binding events...');
        this.bindEvents();
        
        console.log('Word Munch: Triggering show animation...');
        setTimeout(() => {
            if (this.dashboardContainer) {
                this.dashboardContainer.classList.add('show');
                console.log('Word Munch: Show animation triggered');
            }
        }, 100);
    }

    async requestCognitiveProfile(userId, days = 30) {
        this.currentRequestId = Math.random().toString(36).substr(2, 9);
        
        try {
            chrome.runtime.sendMessage({
                type: 'GET_COGNITIVE_PROFILE',
                userId: userId,
                days: days,
                requestId: this.currentRequestId
            });

            setTimeout(() => {
                if (this.currentRequestId && this.isVisible) {
                    console.log('Word Munch: Request timeout, using demo data');
                    this.renderDashboard(this.demoData);
                }
            }, 10000);

        } catch (error) {
            console.error('Word Munch: Failed to request cognitive profile:', error);
            this.renderDashboard(this.demoData);
        }
    }

    handleProfileData(data, requestId) {
        if (requestId !== this.currentRequestId || !this.isVisible) {
            return;
        }

        this.currentRequestId = null;
        console.log('Word Munch: Received real cognitive profile data');
        this.renderDashboard(data);
    }

    handleProfileError(error, requestId) {
        if (requestId !== this.currentRequestId || !this.isVisible) {
            return;
        }

        this.currentRequestId = null;
        console.log('Word Munch: Profile error, using demo data:', error);
        this.renderDashboard(this.demoData);
    }

    renderDashboard(data) {
        if (!this.dashboardContainer) return;

        console.log('Word Munch: Rendering dashboard with data:', data);
        
        const dashboardHTML = this.generateDashboardHTML(data);
        this.dashboardContainer.innerHTML = dashboardHTML;
        this.bindEvents();
    }

    generateDashboardHTML(data = this.demoData) {
        const isAnonymous = data.isDemo || data.isAnonymous;
        
        return `
            <div class="cognitive-dashboard-content">
                <div class="dashboard-header">
                    <h2>🧠 Cognitive Growth Analysis</h2>
                    ${isAnonymous ? '<div class="experience-badge">🎯 Explore Edition</div>' : ''}
                    <div class="dashboard-controls">
                        <select class="time-range-select" ${isAnonymous ? 'disabled' : ''}>
                            <option value="7">Past 7 days</option>
                            <option value="30" selected>Past 30 days</option>
                            <option value="90">Past 90 days</option>
                        </select>
                        <button class="dashboard-close-btn">×</button>
                    </div>
                </div>
                
                ${isAnonymous ? `
                <div class="experience-notice">
                    <div class="experience-content">
                        <div class="experience-left">
                            <div class="experience-icon">🌟</div>
                            <div class="experience-text">
                                <div class="experience-title">Personalized Cognitive Analysis Preview</div>
                                <div class="experience-subtitle">
                                    Based on real user behavior patterns • 
                                    <a href="#" class="upgrade-link">
                                        Start tracking your real progress →
                                    </a>
                                </div>
                            </div>
                        </div>
                        <div class="experience-right">
                            <div class="value-points">
                                <div class="value-point">📈 Real-time progress</div>
                                <div class="value-point">🎯 Personalized suggestions</div>
                                <div class="value-point">🏆 Achievement tracking</div>
                            </div>
                        </div>
                    </div>
                </div>
                ` : ''}

                <div class="dashboard-tabs">
                    <button class="dashboard-tab active" data-tab="overview">📊 Cognitive Overview</button>
                    <button class="dashboard-tab" data-tab="growth">📈 Growth Journey</button>
                    <button class="dashboard-tab" data-tab="insights">💡 Intelligent Insights</button>
                    ${isAnonymous ? '<button class="dashboard-tab special-tab" data-tab="unlock">🚀 Unlock Full Version</button>' : ''}
                </div>

                <div class="dashboard-body">
                    <div class="dashboard-tab-content active" data-content="overview">
                        ${this.generateEnhancedOverviewTab(data)}
                    </div>
                    <div class="dashboard-tab-content" data-content="growth">
                        ${this.generateEnhancedGrowthTab(data)}
                    </div>
                    <div class="dashboard-tab-content" data-content="insights">
                        ${this.generateEnhancedInsightsTab(data)}
                    </div>
                    ${isAnonymous ? `
                    <div class="dashboard-tab-content" data-content="unlock">
                        ${this.generateUnlockTab()}
                    </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    generateEnhancedOverviewTab(data) {
        return `
            <div class="overview-hero">
                <div class="hero-message">
                    <div class="hero-icon">🎯</div>
                    <div class="hero-text">
                        <h3>Your Cognitive Ability Portrait</h3>
                        <p>Based on advanced understanding analysis algorithms, we present a comprehensive view of your cognitive development</p>
                    </div>
                </div>
            </div>

            <div class="overview-stats enhanced">
                <div class="stat-card primary">
                    <div class="stat-icon">📚</div>
                    <div class="stat-content">
                        <div class="stat-number">${data.total_analyses}</div>
                        <div class="stat-label">Deep Analysis</div>
                        <div class="stat-insight">Your learning is very dedicated!</div>
                    </div>
                </div>
                <div class="stat-card secondary">
                    <div class="stat-icon">🎯</div>
                    <div class="stat-content">
                        <div class="stat-number">${Math.round(data.cognitive_radar.comprehension)}%</div>
                        <div class="stat-label">Understanding Accuracy</div>
                        <div class="stat-insight">Surpasses 70% of users</div>
                    </div>
                </div>
                <div class="stat-card tertiary">
                    <div class="stat-icon">⚡</div>
                    <div class="stat-content">
                        <div class="stat-number">${data.days_covered}</div>
                        <div class="stat-label">Active Days</div>
                        <div class="stat-insight">Keep it up!</div>
                    </div>
                </div>
            </div>

            <div class="cognitive-radar-section">
                <div class="section-header">
                    <h3>🎯 Cognitive Ability Radar</h3>
                    <div class="section-subtitle">Multi-dimensional analysis of your learning characteristics</div>
                </div>
                <div class="radar-container">
                    ${this.generateRadarChart(data.cognitive_radar)}
                    <div class="radar-insights">
                        <div class="insight-item strength">
                            <div class="insight-label">Strongest Point</div>
                            <div class="insight-value">Deep analysis ${data.cognitive_radar.depth}%</div>
                        </div>
                        <div class="insight-item opportunity">
                            <div class="insight-label">Improvement Point</div>
                            <div class="insight-value">Information coverage ${data.cognitive_radar.coverage}%</div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="growth-preview">
                <div class="preview-header">
                    <h4>🚀 Want to see more?</h4>
                    <p>Unlock the full version, get personalized learning paths and real-time progress tracking</p>
                </div>
                <div class="preview-features">
                    <div class="feature-item">
                        <div class="feature-icon">📈</div>
                        <div class="feature-text">Detailed progress curve</div>
                    </div>
                    <div class="feature-item">
                        <div class="feature-icon">🎯</div>
                        <div class="feature-text">AI learning suggestions</div>
                    </div>
                    <div class="feature-item">
                        <div class="feature-icon">🏆</div>
                        <div class="feature-text">Achievement system</div>
                    </div>
                </div>
                <button class="preview-cta">
                    Start my cognitive growth journey →
                </button>
            </div>
        `;
    }

    generateEnhancedGrowthTab(data) {
        return `
            <div class="bloom-section">
                <h3>🎓 Cognitive Level Distribution (Bloom's Taxonomy)</h3>
                <div class="bloom-distribution">
                    ${Object.entries(data.bloom_distribution).map(([level, count]) => {
                        const percentage = Math.round((count / data.total_analyses) * 100);
                        const levelNames = {
                            'understand': 'Understand',
                            'analyze': 'Analyze', 
                            'apply': 'Apply',
                            'evaluate': 'Evaluate',
                            'create': 'Create',
                            'remember': 'Remember'
                        };
                        return `
                            <div class="bloom-item">
                                <div class="bloom-label">${levelNames[level] || level}</div>
                                <div class="bloom-bar">
                                    <div class="bloom-fill" style="width: ${percentage}%;"></div>
                                </div>
                                <div class="bloom-value">${count} (${percentage}%)</div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>

            <div class="milestones-section">
                <h3>🏆 Growth Milestones</h3>
                <div class="milestones">
                    ${this.generateMilestones(data)}
                </div>
            </div>
        `;
    }

    generateMilestones(data) {
        const milestones = [
            {
                icon: '🎯',
                title: 'Newbie',
                description: 'Complete the first understanding analysis',
                achieved: data.total_analyses >= 1
            },
            {
                icon: '📚',
                title: 'Explorer',
                description: 'Analyzed 10+ articles',
                achieved: data.total_analyses >= 10
            },
            {
                icon: '🧠',
                title: 'Deep Thinker',
                description: 'Average understanding accuracy reaches 80%',
                achieved: data.cognitive_radar.comprehension >= 80
            },
            {
                icon: '🏆',
                title: 'Master',
                description: 'High-accuracy analysis of 50+ articles',
                achieved: data.total_analyses >= 50 && data.cognitive_radar.comprehension >= 85
            }
        ];

        return milestones.map(milestone => `
            <div class="milestone ${milestone.achieved ? 'achieved' : 'pending'}">
                <div class="milestone-icon">${milestone.icon}</div>
                <div class="milestone-content">
                    <div class="milestone-title">${milestone.title}</div>
                    <div class="milestone-desc">${milestone.description}</div>
                </div>
                <div class="milestone-status">
                    ${milestone.achieved ? '✅' : '⏳'}
                </div>
            </div>
        `).join('');
    }

    generateEnhancedInsightsTab(data) {
        return `
            <div class="suggestions-section">
                <h3>💡 Personalized Improvement Suggestions</h3>
                <div class="suggestions">
                    ${data.personalized_suggestions.map((suggestion, index) => `
                        <div class="suggestion-card">
                            <div class="suggestion-icon">${suggestion.icon}</div>
                            <div class="suggestion-content">
                                <div class="suggestion-title">${suggestion.title}</div>
                                <div class="suggestion-desc">${suggestion.description}</div>
                                <div class="suggestion-action">${suggestion.action}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <div class="error-patterns-section">
                <h3>🔍 Understanding Blind Spots Analysis</h3>
                <div class="error-patterns">
                    ${Object.entries(data.error_patterns).map(([type, pattern], index) => `
                        <div class="error-pattern">
                            <div class="error-header">
                                <span class="error-type">${pattern.label}</span>
                                <span class="error-count">${pattern.count} times</span>
                            </div>
                            <div class="error-bar">
                                <div class="error-fill" style="width: ${pattern.percentage}%;"></div>
                            </div>
                            <div class="error-suggestion">${pattern.suggestion}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    generateUnlockTab() {
        return `
            <div class="unlock-section">
                <div class="unlock-hero">
                    <div class="unlock-animation">
                        <div class="unlock-icon">🚀</div>
                    </div>
                    <h3>Unlock Your Cognitive Growth Potential</h3>
                    <p>From now on, let every reading become a step towards growth</p>
                </div>
                
                <div class="upgrade-cta-section">
                    <div class="cta-content">
                        <div class="cta-text">
                            <h4>Start Your Cognitive Growth Journey Now</h4>
                            <p>Join thousands of users and become smarter together</p>
                        </div>
                        <div class="cta-actions">
                            <button class="primary-cta">
                                🚀 Start for Free
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    generateRadarChart(radar) {
        const skills = [
            { name: 'comprehension', value: radar.comprehension },
            { name: 'coverage', value: radar.coverage },
            { name: 'depth', value: radar.depth },
            { name: 'accuracy', value: radar.accuracy },
            { name: 'analysis', value: radar.analysis },
            { name: 'synthesis', value: radar.synthesis }
        ];

        const centerX = 120;
        const centerY = 120;
        const radius = 80;
        
        const points = skills.map((skill, index) => {
            const angle = (index * 60 - 90) * Math.PI / 180;
            const distance = (skill.value / 100) * radius;
            const x = centerX + Math.cos(angle) * distance;
            const y = centerY + Math.sin(angle) * distance;
            return `${x},${y}`;
        }).join(' ');

        const gridLevels = [20, 40, 60, 80, 100];
        const gridLines = gridLevels.map(level => {
            const levelPoints = skills.map((skill, index) => {
                const angle = (index * 60 - 90) * Math.PI / 180;
                const distance = (level / 100) * radius;
                const x = centerX + Math.cos(angle) * distance;
                const y = centerY + Math.sin(angle) * distance;
                return `${x},${y}`;
            }).join(' ');
            return `<polygon points="${levelPoints}" fill="none" stroke="#e5e7eb" stroke-width="1"/>`;
        }).join('');

        const axisLines = skills.map((skill, index) => {
            const angle = (index * 60 - 90) * Math.PI / 180;
            const endX = centerX + Math.cos(angle) * radius;
            const endY = centerY + Math.sin(angle) * radius;
            return `<line x1="${centerX}" y1="${centerY}" x2="${endX}" y2="${endY}" stroke="#d1d5db" stroke-width="1"/>`;
        }).join('');

        const labels = skills.map((skill, index) => {
            const angle = (index * 60 - 90) * Math.PI / 180;
            const labelDistance = radius + 25;
            const x = centerX + Math.cos(angle) * labelDistance;
            const y = centerY + Math.sin(angle) * labelDistance;
            
            return `
                <text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" 
                      font-size="11" fill="#374151" font-weight="500">
                    ${skill.name}
                </text>
                <text x="${x}" y="${y + 15}" text-anchor="middle" dominant-baseline="middle" 
                      font-size="10" fill="#6b7280" font-weight="600">
                    ${skill.value}%
                </text>
            `;
        }).join('');

        return `
            <svg width="240" height="240" class="radar-svg">
                ${gridLines}
                ${axisLines}
                <polygon points="${points}" fill="#6366f1" fill-opacity="0.2" stroke="#6366f1" stroke-width="1.5"/>
                ${skills.map((skill, index) => {
                    const angle = (index * 60 - 90) * Math.PI / 180;
                    const distance = (skill.value / 100) * radius;
                    const x = centerX + Math.cos(angle) * distance;
                    const y = centerY + Math.sin(angle) * distance;
                    return `<circle cx="${x}" cy="${y}" r="3" fill="#6366f1"/>`;
                }).join('')}
                ${labels}
            </svg>
        `;
    }

    bindEvents() {
        if (!this.dashboardContainer) return;
        
        // Click outside to close
        this.dashboardContainer.addEventListener('click', (e) => {
            if (e.target === this.dashboardContainer) {
                this.hideDashboard();
            }
        });

        // ESC key to close
        const handleEsc = (e) => {
            if (e.key === 'Escape' && this.isVisible) {
                this.hideDashboard();
                document.removeEventListener('keydown', handleEsc);
            }
        };
        document.addEventListener('keydown', handleEsc);

        // Close button
        const closeBtn = this.dashboardContainer.querySelector('.dashboard-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hideDashboard());
        }

        // Tab switching
        const tabs = this.dashboardContainer.querySelectorAll('.dashboard-tab');
        const contents = this.dashboardContainer.querySelectorAll('.dashboard-tab-content');

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const targetTab = tab.dataset.tab;
                
                tabs.forEach(t => t.classList.remove('active'));
                contents.forEach(c => c.classList.remove('active'));
                
                tab.classList.add('active');
                const targetContent = this.dashboardContainer.querySelector(`[data-content="${targetTab}"]`);
                if (targetContent) {
                    targetContent.classList.add('active');
                }
            });
        });

        // CTA button events
        const ctaButtons = this.dashboardContainer.querySelectorAll('.preview-cta, .primary-cta, .upgrade-link');
        ctaButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                alert('🚧 Registration feature under development, stay tuned!');
            });
        });
    }

    hideDashboard() {
        if (!this.isVisible) return;

        this.isVisible = false;
        this.currentRequestId = null;
        
        if (this.dashboardContainer) {
            this.dashboardContainer.classList.add('hide');
            
            setTimeout(() => {
                if (this.dashboardContainer && this.dashboardContainer.parentNode) {
                    this.dashboardContainer.parentNode.removeChild(this.dashboardContainer);
                    this.dashboardContainer = null;
                }
            }, 300);
        }
    }

    addDashboardStyles() {
        if (document.getElementById('cognitive-dashboard-styles')) return;
    
        const styles = document.createElement('style');
        styles.id = 'cognitive-dashboard-styles';
        styles.textContent = `
            /* 🎨 Cognitive Dashboard */
            
            .cognitive-dashboard-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0, 0, 0, 0.4);
                backdrop-filter: blur(8px);
                z-index: 2147483647;
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 0;
                visibility: hidden;
                transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            }
            .cognitive-dashboard-overlay.show { 
                opacity: 1; 
                visibility: visible; 
            }
            .cognitive-dashboard-overlay.hide { 
                opacity: 0; 
                visibility: hidden; 
                transform: scale(0.96); 
            }
            
            .cognitive-dashboard-content {
                width: 90vw; 
                max-width: 900px; 
                height: 88vh; 
                max-height: 720px;
                background: white; 
                border-radius: 16px;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
                display: flex; 
                flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
                transform: scale(0.95); 
                transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                overflow: hidden;
            }
            .cognitive-dashboard-overlay.show .cognitive-dashboard-content { 
                transform: scale(1); 
            }
            
            /* 🎯 Header - Indigo */ 
            .dashboard-header {
                padding: 20px 24px;
                background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
                color: white;
                display: flex; 
                justify-content: space-between; 
                align-items: center;
                border-radius: 16px 16px 0 0;
                position: relative;
            }
            
            .dashboard-header h2 { 
                margin: 0; 
                font-size: 18px; 
                font-weight: 600;
                letter-spacing: -0.01em;
            }
            
            .experience-badge {
                background: rgba(255, 255, 255, 0.2);
                color: white;
                padding: 4px 12px;
                border-radius: 12px;
                font-size: 12px;
                font-weight: 500;
                border: 1px solid rgba(255, 255, 255, 0.3);
                margin-left: 12px;
            }
            
            .dashboard-controls { 
                display: flex; 
                align-items: center; 
                gap: 12px; 
            }
            
            .time-range-select {
                padding: 6px 12px;
                border: 1px solid rgba(255, 255, 255, 0.3);
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.1);
                color: white;
                font-size: 12px;
                cursor: pointer;
                outline: none;
            }
            .time-range-select:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            
            .dashboard-close-btn {
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                color: white;
                font-size: 18px;
                width: 32px;
                height: 32px;
                border-radius: 8px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s ease;
            }
            .dashboard-close-btn:hover { 
                background: rgba(255, 255, 255, 0.2); 
            }
            
            /* 💡 Demo Notice - Soft orange banner */
            .experience-notice {
                background: #f59e0b;
                padding: 16px 24px;
                color: white;
                font-size: 13px;
                border-bottom: 1px solid rgba(0, 0, 0, 0.08);
            }
            
            .experience-content {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
            }
            
            .experience-left {
                display: flex;
                align-items: center;
                gap: 12px;
                flex: 1;
            }
            
            .experience-icon {
                font-size: 16px;
            }
            
            .experience-title {
                font-size: 14px;
                font-weight: 600;
                margin-bottom: 2px;
            }
            
            .experience-subtitle {
                font-size: 12px;
                opacity: 0.95;
            }
            
            .upgrade-link {
                color: #fed7aa;
                text-decoration: none;
                font-weight: 500;
                border-bottom: 1px solid transparent;
                transition: border-color 0.2s ease;
            }
            .upgrade-link:hover {
                border-bottom-color: #fed7aa;
            }
            
            .experience-right {
                display: flex;
                gap: 8px;
            }
            
            .value-point {
                background: rgba(255, 255, 255, 0.15);
                padding: 4px 8px;
                border-radius: 8px;
                font-size: 11px;
                font-weight: 500;
                white-space: nowrap;
            }
            
            /* 📊 Tabs - Simple tab design */
            .dashboard-tabs {
                display: flex;
                background: #f8fafc;
                border-bottom: 1px solid #e2e8f0;
                padding: 0 24px;
            }
            
            .dashboard-tab {
                flex: 1;
                padding: 12px 16px;
                border: none;
                background: none;
                cursor: pointer;
                font-size: 13px;
                font-weight: 500;
                color: #64748b;
                border-bottom: 2px solid transparent;
                transition: all 0.2s ease;
                text-align: center;
            }
            .dashboard-tab:hover { 
                color: #475569;
                background: rgba(99, 102, 241, 0.04);
            }
            .dashboard-tab.active { 
                color: #6366f1;
                background: white;
                border-bottom-color: #6366f1;
                font-weight: 600;
            }
            
            .special-tab {
                background: #fb7185;
                color: white !important;
                font-weight: 600 !important;
                border-radius: 8px 8px 0 0;
                margin: 2px;
                position: relative;
                overflow: hidden;
            }
            .special-tab::after {
                content: '✨';
                position: absolute;
                right: 8px;
                top: 50%;
                transform: translateY(-50%);
                font-size: 10px;
            }
            
            /* 📄 Content Area */
            .dashboard-body { 
                flex: 1; 
                overflow-y: auto; 
                background: #fafbfc;
            }
            
            .dashboard-tab-content { 
                padding: 24px; 
                display: none; 
                animation: fadeIn 0.3s ease;
            }
            .dashboard-tab-content.active { 
                display: block; 
            }
            
            @keyframes fadeIn { 
                from { opacity: 0; transform: translateY(8px); } 
                to { opacity: 1; transform: translateY(0); } 
            }
            
            /* 🎯 Overview Stats - Card design */
            .overview-hero {
                background: white;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                border: 1px solid #e2e8f0;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
            }
            
            .hero-message {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            
            .hero-icon {
                font-size: 24px;
                background: #f1f5f9;
                width: 48px;
                height: 48px;
                border-radius: 12px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .hero-text h3 {
                margin: 0 0 4px 0;
                font-size: 16px;
                font-weight: 600;
                color: #1e293b;
            }
            
            .hero-text p {
                margin: 0;
                font-size: 13px;
                color: #64748b;
                line-height: 1.4;
            }
            
            .overview-stats.enhanced {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 16px;
                margin-bottom: 24px;
            }
            
            .stat-card {
                background: white;
                border-radius: 12px;
                padding: 20px;
                border: 1px solid #e2e8f0;
                display: flex;
                align-items: center;
                gap: 12px;
                transition: all 0.2s ease;
                position: relative;
                overflow: hidden;
            }
            
            .stat-card::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                height: 2px;
            }
            
            .stat-card.primary::before {
                background: linear-gradient(90deg, #6366f1, #4f46e5);
            }
            .stat-card.secondary::before {
                background: linear-gradient(90deg, #06b6d4, #0891b2);
            }
            .stat-card.tertiary::before {
                background: linear-gradient(90deg, #10b981, #059669);
            }
            
            .stat-card:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
                border-color: #cbd5e1;
            }
            
            .stat-icon {
                font-size: 20px;
                width: 40px;
                height: 40px;
                background: #f1f5f9;
                border-radius: 10px;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            }
            
            .stat-content {
                flex: 1;
            }
            
            .stat-number {
                font-size: 24px;
                font-weight: 700;
                color: #1e293b;
                margin-bottom: 2px;
                line-height: 1;
            }
            
            .stat-label {
                font-size: 13px;
                color: #64748b;
                font-weight: 500;
                margin-bottom: 2px;
            }
            
            .stat-insight {
                font-size: 11px;
                color: #16a34a;
                font-weight: 500;
            }
            
            /* 🎯 Radar Chart Section */
            .cognitive-radar-section {
                background: white;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                border: 1px solid #e2e8f0;
            }
            
            .section-header {
                margin-bottom: 16px;
            }
            
            .section-header h3 {
                margin: 0 0 4px 0;
                font-size: 16px;
                font-weight: 600;
                color: #1e293b;
            }
            
            .section-subtitle {
                font-size: 13px;
                color: #64748b;
            }
            
            .radar-container {
                display: flex;
                align-items: center;
                gap: 24px;
            }
            
            .radar-chart {
                background: #f8fafc;
                border-radius: 12px;
                padding: 16px;
                flex-shrink: 0;
            }
            
            .radar-insights {
                flex: 1;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            
            .insight-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                border-radius: 8px;
                border: 1px solid #e2e8f0;
            }
            
            .insight-item.strength {
                background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
                border-color: #bbf7d0;
            }
            
            .insight-item.opportunity {
                background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
                border-color: #fcd34d;
            }
            
            .insight-label {
                font-size: 12px;
                color: #64748b;
                font-weight: 500;
            }
            
            .insight-value {
                font-size: 13px;
                font-weight: 600;
                color: #1e293b;
            }
            
            /* 🚀 Growth Preview */
            .growth-preview {
                background: #fef3c7;
                border-radius: 12px;
                padding: 20px;
                text-align: center;
                border: 1px solid #fcd34d;
            }
            
            .preview-header h4 {
                margin: 0 0 4px 0;
                font-size: 16px;
                font-weight: 600;
                color: #92400e;
            }
            
            .preview-header p {
                margin: 0 0 16px 0;
                font-size: 13px;
                color: #b45309;
            }
            
            .preview-features {
                display: flex;
                justify-content: center;
                gap: 16px;
                margin: 16px 0;
            }
            
            .feature-item {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 6px;
            }
            
            .feature-icon {
                font-size: 16px;
                width: 32px;
                height: 32px;
                background: white;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            }
            
            .feature-text {
                font-size: 11px;
                font-weight: 500;
                color: #92400e;
            }
            
            .preview-cta {
                background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
                color: white;
                border: none;
                padding: 10px 20px;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            }
            .preview-cta:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
            }
            
            /* 📊 Bloom Distribution */
            .bloom-section {
                background: white;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                border: 1px solid #e2e8f0;
            }
            
            .bloom-section h3 {
                margin: 0 0 16px 0;
                font-size: 16px;
                font-weight: 600;
                color: #1e293b;
            }
            
            .bloom-distribution {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            
            .bloom-item {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            
            .bloom-label {
                font-weight: 500;
                color: #475569;
                min-width: 60px;
                font-size: 13px;
            }
            
            .bloom-bar {
                flex: 1;
                height: 6px;
                background: #f1f5f9;
                border-radius: 3px;
                overflow: hidden;
            }
            
            .bloom-fill {
                height: 100%;
                background: linear-gradient(90deg, #6366f1, #4f46e5);
                border-radius: 3px;
                transition: width 0.8s ease;
            }
            
            .bloom-value {
                font-size: 12px;
                color: #64748b;
                font-weight: 500;
                min-width: 50px;
                text-align: right;
            }
            
            /* 🏆 Milestones */
            .milestones-section {
                background: white;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                border: 1px solid #e2e8f0;
            }
            
            .milestones-section h3 {
                margin: 0 0 16px 0;
                font-size: 16px;
                font-weight: 600;
                color: #1e293b;
            }
            
            .milestones {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            
            .milestone {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 16px;
                border-radius: 10px;
                border: 1px solid #e2e8f0;
                transition: all 0.2s ease;
            }
            
            .milestone.achieved {
                background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
                border-color: #bbf7d0;
            }
            
            .milestone.pending {
                background: #f8fafc;
                opacity: 0.7;
            }
            
            .milestone-icon {
                font-size: 20px;
                width: 40px;
                height: 40px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 10px;
                background: white;
                border: 1px solid #e2e8f0;
                flex-shrink: 0;
            }
            
            .milestone.achieved .milestone-icon {
                background: #dcfce7;
                border-color: #bbf7d0;
            }
            
            .milestone-content {
                flex: 1;
            }
            
            .milestone-title {
                font-weight: 600;
                font-size: 14px;
                color: #1e293b;
                margin-bottom: 2px;
            }
            
            .milestone-desc {
                font-size: 12px;
                color: #64748b;
            }
            
            .milestone-status {
                font-size: 16px;
            }
            
            /* 💡 Suggestions */
            .suggestions-section {
                background: white;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                border: 1px solid #e2e8f0;
            }
            
            .suggestions-section h3 {
                margin: 0 0 16px 0;
                font-size: 16px;
                font-weight: 600;
                color: #1e293b;
            }
            
            .suggestions {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            
            .suggestion-card {
                display: flex;
                gap: 12px;
                padding: 16px;
                background: linear-gradient(135deg, #eef2ff 0%, #dbeafe 100%) !important;
                border-radius: 10px;
                color: #373a53 !important;
                transition: transform 0.2s ease;
            }
            
            .suggestion-card:hover {
                transform: translateY(-1px);
            }
            
            .suggestion-icon {
                font-size: 18px;
                width: 36px;
                height: 36px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.2);
                border-radius: 8px;
                flex-shrink: 0;
            }
            
            .suggestion-content {
                flex: 1;
            }
            
            .suggestion-title {
                font-weight: 600;
                font-size: 14px;
                margin-bottom: 4px;
            }
            
            .suggestion-desc {
                font-size: 12px;
                opacity: 0.95;
                margin-bottom: 8px;
                line-height: 1.4;
            }
            
            .suggestion-action {
                font-size: 11px;
                padding: 4px 8px;
                background: rgba(255, 255, 255, 0.2);
                border-radius: 4px;
                display: inline-block;
                font-weight: 500;
            }
            
            /* 🔍 Error Patterns */
            .error-patterns-section {
                background: white;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                border: 1px solid #e2e8f0;
            }
            
            .error-patterns-section h3 {
                margin: 0 0 16px 0;
                font-size: 16px;
                font-weight: 600;
                color: #1e293b;
            }
            
            .error-patterns {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            
            .error-pattern {
                padding: 16px;
                background: #fef2f2;
                border-radius: 10px;
                border-left: 3px solid #ef4444;
            }
            
            .error-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
            }
            
            .error-type {
                font-weight: 600;
                color: #dc2626;
                font-size: 13px;
            }
            
            .error-count {
                font-size: 11px;
                color: #64748b;
                background: white;
                padding: 2px 6px;
                border-radius: 4px;
                font-weight: 500;
            }
            
            .error-bar {
                height: 4px;
                background: #fecaca;
                border-radius: 2px;
                margin-bottom: 8px;
                overflow: hidden;
            }
            
            .error-fill {
                height: 100%;
                background: linear-gradient(90deg, #ef4444, #f87171);
                border-radius: 2px;
                transition: width 0.8s ease;
            }
            
            .error-suggestion {
                font-size: 12px;
                color: #7f1d1d;
                line-height: 1.4;
            }
            
            /* 🚀 Unlock Section */
            .unlock-section {
                padding: 32px 24px;
                text-align: center;
            }
            
            .unlock-hero {
                margin-bottom: 24px;
            }
            
            .unlock-animation {
                position: relative;
                margin-bottom: 16px;
            }
            
            .unlock-icon {
                font-size: 32px;
                display: inline-block;
                animation: float 3s ease-in-out infinite;
            }
            
            @keyframes float {
                0%, 100% { transform: translateY(0); }
                50% { transform: translateY(-6px); }
            }
            
            .unlock-hero h3 {
                margin: 0 0 8px 0;
                font-size: 18px;
                font-weight: 700;
                color: #1e293b;
            }
            
            .unlock-hero p {
                margin: 0;
                font-size: 14px;
                color: #64748b;
            }
            
            .upgrade-cta-section {
                background: white;
                border-radius: 12px;
                padding: 24px;
                border: 1px solid #e2e8f0;
            }
            
            .cta-text h4 {
                margin: 0 0 4px 0;
                font-size: 16px;
                font-weight: 600;
                color: #1e293b;
            }
            
            .cta-text p {
                margin: 0 0 16px 0;
                font-size: 13px;
                color: #64748b;
            }
            
            .primary-cta {
                background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            }
            .primary-cta:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
            }
            
            /* 📱 Responsive Design */
            @media (max-width: 768px) {
                .cognitive-dashboard-content {
                    width: 95vw;
                    height: 92vh;
                    border-radius: 12px;
                }
                
                .dashboard-header {
                    padding: 16px 20px;
                    border-radius: 12px 12px 0 0;
                }
                
                .dashboard-header h2 {
                    font-size: 16px;
                }
                
                .dashboard-tab-content {
                    padding: 20px 16px;
                }
                
                .overview-stats.enhanced {
                    grid-template-columns: 1fr;
                    gap: 12px;
                }
                
                .radar-container {
                    flex-direction: column;
                    gap: 16px;
                }
                
                .preview-features {
                    flex-direction: column;
                    align-items: center;
                    gap: 12px;
                }
                
                .experience-content {
                    flex-direction: column;
                    text-align: center;
                    gap: 12px;
                }
                
                .value-point {
                    font-size: 10px;
                }
            }
        `;
        
        document.head.appendChild(styles);
        console.log('🎨 Enhanced dashboard styles applied');
    }
}

window.cognitiveDashboard = new CognitiveDashboard();

console.log('Word Munch: CognitiveDashboard loaded');