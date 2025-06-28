// Content Script - 检测并简化网页词汇，浮动窗口显示简化结果

let selectedText = '';
let contextText = '';
let currentSelection = null;
let currentResult = null;
let currentSynonymIndex = 0;
let floatingWidget = null;
// 全局变量来跟踪事件监听器状态
let outsideClickListenerActive = false;
// 全局变量存储最近的结果
let lastWordResult = null;
let lastWordText = null;
let lastResultTime = 0;

// 新增：请求管理变量
let currentRequestId = null;
let requestTimeout = null;
let pendingSelection = null; // 用于存储待处理的选择

// 取消当前请求
function cancelCurrentRequest() {
    console.log('Word Munch: 取消当前请求');
    
    // 清除超时
    if (requestTimeout) {
        clearTimeout(requestTimeout);
        requestTimeout = null;
        console.log('Word Munch: 已清除请求超时');
    }
    
    // 标记当前请求为无效
    if (currentRequestId) {
        console.log('Word Munch: 标记请求为无效:', currentRequestId);
        currentRequestId = null;
    }
}

// 监听文本选择事件
document.addEventListener('mouseup', handleTextSelection);
document.addEventListener('keyup', handleTextSelection);
document.addEventListener('dblclick', handleTextSelection);

// 处理文本选择
function handleTextSelection(event) {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    
    console.log('Word Munch: 文本选择事件触发，选中文本:', selectedText);
    
    // 检查选中的文本是否为空
    if (!selectedText || selectedText.length === 0) {
        closeFloatingWidget();
        return;
    }
    
    // 如果选中的是同一个文本且浮动窗口已经存在，不重复处理
    if (currentSelection && currentSelection.text === selectedText && floatingWidget) {
        console.log('Word Munch: 重复选择同一文本，跳过处理');
        return;
    }

    console.log('Word Munch: 处理新的文本选择:', selectedText);
    
    // 创建新的选择对象
    const newSelection = {
        text: selectedText,
        selection: selection,
        range: selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null,
        timestamp: Date.now()
    };
    
    // 如果当前有正在处理的请求，标记为待处理
    if (currentRequestId) {
        console.log('Word Munch: 有正在处理的请求，标记新选择为待处理');
        pendingSelection = newSelection;
        return;
    }
    
    // 立即处理新选择
    processTextSelection(newSelection);
}

// 处理文本选择的核心逻辑
function processTextSelection(selectionData) {
    const { text, selection, range } = selectionData;
    
    console.log('Word Munch: 开始处理文本选择:', text);
    
    // 取消之前的请求
    cancelCurrentRequest();
    
    // 保存当前选择
    currentSelection = {
        text: text,
        selection: selection,
        range: range
    };
    
    console.log('Word Munch: 新的文本选择:', text);
    
    // 根据文本长度决定处理方式
    if (isValidWord(text)) {
        // 词汇简化（1-10个字符）
        showFloatingWidget(text, selection, 'word');
    } else if (isValidSentence(text)) {
        // 句子/段落简化（11-500个字符）
        showFloatingWidget(text, selection, 'sentence');
    } else {
        closeFloatingWidget();
    }
}

// 显示浮动窗口
function showFloatingWidget(text, selection, type) {
    console.log('Word Munch: 显示浮动窗口:', text, type);
    
    // 先保存当前选择，避免在cleanupPreviousWidget中被重置
    const newSelection = {
        text: text,
        selection: selection,
        range: selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null
    };
    
    // 取消当前请求
function cancelCurrentRequest() {
    console.log('Word Munch: 取消当前请求');
    
    // 清除超时
    if (requestTimeout) {
        clearTimeout(requestTimeout);
        requestTimeout = null;
        console.log('Word Munch: 已清除请求超时');
    }
    
    // 标记当前请求为无效
    if (currentRequestId) {
        console.log('Word Munch: 标记请求为无效:', currentRequestId);
        currentRequestId = null;
    }
}

// 清理之前的浮动窗口（但不重置选择状态）
    cleanupPreviousWidget();
    
    // 重新设置选择状态（在cleanupPreviousWidget之后）
    currentSelection = newSelection;
    console.log('Word Munch: 设置当前选择:', currentSelection.text);
    
    // 获取选择区域的位置
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    
    console.log('Word Munch: 选择区域位置:', rect);
    
    // 创建浮动窗口
    floatingWidget = document.createElement('div');
    floatingWidget.id = 'word-munch-widget';
    floatingWidget.className = 'word-munch-floating-widget';
    
    // 计算位置
    const x = Math.min(rect.left, window.innerWidth - 300);
    const y = rect.bottom + 10 > window.innerHeight ? rect.top - 10 : rect.bottom + 10;
    
    floatingWidget.style.left = `${x}px`;
    floatingWidget.style.top = `${y}px`;
    
    console.log('Word Munch: 浮动窗口位置:', x, y);
    
    // 创建极简内容结构
    const content = `
        <div class="wm-header">
            <div class="wm-header-text">
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
    
    floatingWidget.innerHTML = content;
    
    // 添加到页面
    document.body.appendChild(floatingWidget);
    console.log('Word Munch: 浮动窗口已添加到DOM');
    
    // 触发显示动画
    setTimeout(() => {
        if (floatingWidget) { // 确保窗口还存在
            floatingWidget.classList.add('show');
            console.log('Word Munch: 触发显示动画');
        }
    }, 10);
    
    // 绑定事件
    setupWidgetEvents(text, type);
    
    // 自动开始简化
    startSimplification(text, type);
}

// 清理之前的浮动窗口（但不重置选择状态）
function cleanupPreviousWidget() {
    console.log('Word Munch: 清理之前的浮动窗口');
    
    // 取消当前请求
    cancelCurrentRequest();
    
    // 移除外部点击监听器
    removeOutsideClickListener();
    
    // 移除现有的浮动窗口
    if (floatingWidget) {
        floatingWidget.classList.remove('show');
        
        // 立即移除，不等待动画
        if (floatingWidget.parentNode) {
            floatingWidget.parentNode.removeChild(floatingWidget);
        }
        floatingWidget = null;
        console.log('Word Munch: 之前的浮动窗口已清理');
    }
    
    // 重置结果相关状态，但保留选择状态
    currentResult = null;
    currentSynonymIndex = 0;
}

// 设置浮动窗口事件
function setupWidgetEvents(text, type) {
    const widget = floatingWidget;
    if (!widget) return;
    
    // 关闭按钮
    const closeBtn = widget.querySelector('.wm-close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeFloatingWidget);
    }
    
    // 换一个按钮
    const simplifyBtn = widget.querySelector('.wm-simplify-btn');
    if (simplifyBtn) {
        simplifyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showNextSynonym();
        });
    }
    
    // 复制按钮
    const copyBtn = widget.querySelector('.wm-copy-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            copySynonymToClipboard();
        });
    }
    
    // 确保先移除旧的事件监听器
    removeOutsideClickListener();
    
    // 延迟添加外部点击监听器，避免立即触发
    setTimeout(() => {
        addOutsideClickListener();
    }, 300);
}

// 添加外部点击监听器
function addOutsideClickListener() {
    if (!outsideClickListenerActive) {
        document.addEventListener('click', handleOutsideClick, true);
        outsideClickListenerActive = true;
        console.log('Word Munch: 外部点击监听器已添加');
    }
}

// 移除外部点击监听器
function removeOutsideClickListener() {
    if (outsideClickListenerActive) {
        document.removeEventListener('click', handleOutsideClick, true);
        outsideClickListenerActive = false;
        console.log('Word Munch: 外部点击监听器已移除');
    }
}

// 处理外部点击
function handleOutsideClick(event) {
    console.log('Word Munch: 外部点击事件触发');
    
    // 防止在选择文本时触发关闭
    if (!floatingWidget) {
        console.log('Word Munch: 浮动窗口不存在，跳过');
        return;
    }
    
    // 如果点击的是浮动窗口内部，不关闭
    if (floatingWidget.contains(event.target)) {
        console.log('Word Munch: 点击在浮动窗口内部，不关闭');
        return;
    }
    
    // 如果点击的是选中的文本区域，不关闭
    if (currentSelection && currentSelection.range) {
        const rect = currentSelection.range.getBoundingClientRect();
        const clickX = event.clientX;
        const clickY = event.clientY;
        
        console.log('Word Munch: 检查点击位置:', {
            click: { x: clickX, y: clickY },
            selection: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        });
        
        // 给选中区域一些容错空间
        const padding = 5;
        if (clickX >= rect.left - padding && 
            clickX <= rect.right + padding && 
            clickY >= rect.top - padding && 
            clickY <= rect.bottom + padding) {
            console.log('Word Munch: 点击在选中区域内，不关闭');
            return;
        }
    }
    
    // 其他情况关闭浮动窗口
    console.log('Word Munch: 点击在外部，关闭浮动窗口');
    closeFloatingWidget();
}

// 隐藏浮动窗口（保持向后兼容）
function hideFloatingWidget() {
    cleanupPreviousWidget();
    
    // 只重置部分状态，保留currentSelection直到新窗口创建
    console.log('Word Munch: 部分状态已重置');
}

// 完全清理浮动窗口和所有状态
function closeFloatingWidget() {
    console.log('Word Munch: 完全关闭浮动窗口');
    
    // 取消当前请求
    cancelCurrentRequest();
    
    // 清除待处理选择
    pendingSelection = null;
    
    cleanupPreviousWidget();
    
    // 完全重置所有状态
    currentSelection = null;
    currentResult = null;
    currentSynonymIndex = 0;
    console.log('Word Munch: 所有状态已清理（保留结果缓存）');
}

// 开始简化
function startSimplification(text, type) {
    const context = currentSelection ? getContextAroundSelection(currentSelection.selection) : '';
    
    console.log('Word Munch: 开始简化:', text, type);
    
    // 检查是否有最近的结果可以立即显示（5秒内）
    const now = Date.now();
    if (lastWordText === text && lastWordResult && (now - lastResultTime) < 5000) {
        console.log('Word Munch: 使用最近的缓存结果立即显示');
        showSimplificationResult(lastWordResult);
        return;
    }
    
    // 生成请求ID
    const requestId = Math.random().toString(36).substr(2, 9);
    currentRequestId = requestId;
    
    // 清除之前的超时
    if (requestTimeout) {
        clearTimeout(requestTimeout);
    }
    
    // 设置15秒超时
    requestTimeout = setTimeout(() => {
        if (currentRequestId === requestId && floatingWidget) {
            console.warn('Word Munch: 简化请求超时:', text);
            showSimplificationError('请求超时，请重试');
            
            // 清理超时状态
            currentRequestId = null;
            requestTimeout = null;
        }
    }, 15000);
    
    // 发送消息到 background
    sendMessageToBackground({
        type: type === 'word' ? 'WORD_SELECTED' : 'SENTENCE_SELECTED',
        word: text,
        text: text,
        context: context,
        url: window.location.href,
        title: document.title,
        requestId: requestId
    });
}

// 处理待处理的选择
function processPendingSelection() {
    if (pendingSelection) {
        console.log('Word Munch: 处理待处理的选择:', pendingSelection.text);
        const selection = pendingSelection;
        pendingSelection = null; // 清除待处理状态
        
        // 延迟一点处理，确保当前操作完成
        setTimeout(() => {
            processTextSelection(selection);
        }, 100);
    }
}

// 显示简化结果
function showSimplificationResult(result) {
    if (!floatingWidget) {
        console.log('Word Munch: 浮动窗口不存在，无法显示结果');
        return;
    }
    
    console.log('Word Munch: 显示简化结果:', result);
    
    currentResult = result;
    currentSynonymIndex = 0;
    
    const loadingEl = floatingWidget.querySelector('.wm-loading');
    const resultEl = floatingWidget.querySelector('.wm-result');
    const errorEl = floatingWidget.querySelector('.wm-error');
    
    if (result && result.synonyms && result.synonyms.length > 0) {
        console.log('Word Munch: 找到', result.synonyms.length, '个同义词');
        
        // 显示成功结果
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) errorEl.classList.remove('show');
        if (resultEl) resultEl.classList.add('show');
        
        updateSynonymDisplay();
    } else {
        console.log('Word Munch: 没有找到同义词');
        
        // 显示错误
        if (loadingEl) loadingEl.style.display = 'none';
        if (resultEl) resultEl.classList.remove('show');
        if (errorEl) {
            errorEl.classList.add('show');
            errorEl.textContent = '暂无简化结果';
        }
    }
}

// 更新同义词显示
function updateSynonymDisplay() {
    if (!floatingWidget || !currentResult || !currentResult.synonyms) {
        console.log('Word Munch: 无法更新同义词显示 - 缺少必要数据');
        return;
    }
    
    const synonymEl = floatingWidget.querySelector('.wm-synonym');
    const simplifyBtn = floatingWidget.querySelector('.wm-simplify-btn');
    
    console.log('Word Munch: 更新同义词显示，当前索引:', currentSynonymIndex, '总数:', currentResult.synonyms.length);
    
    if (synonymEl && currentResult.synonyms.length > currentSynonymIndex) {
        const synonym = currentResult.synonyms[currentSynonymIndex];
        const synonymText = typeof synonym === 'string' ? synonym : synonym.word || '简化完成';
        
        synonymEl.textContent = synonymText;
        console.log('Word Munch: 显示同义词:', synonymText);
        
        // 更新按钮状态
        if (simplifyBtn) {
            if (currentSynonymIndex < currentResult.synonyms.length - 1) {
                simplifyBtn.disabled = false;
                simplifyBtn.title = `换一个 (${currentSynonymIndex + 1}/${currentResult.synonyms.length})`;
                console.log('Word Munch: 按钮状态 - 可点击');
            } else {
                simplifyBtn.disabled = true;
                simplifyBtn.title = '已是最后一个';
                console.log('Word Munch: 按钮状态 - 已禁用（最后一个）');
            }
        }
    }
}

// 显示下一个同义词
function showNextSynonym() {
    console.log('Word Munch: 切换到下一个同义词');
    console.log('- currentResult存在:', !!currentResult);
    console.log('- 当前索引:', currentSynonymIndex);
    console.log('- 同义词数量:', currentResult?.synonyms?.length || 0);
    
    if (!currentResult || !currentResult.synonyms) {
        console.log('Word Munch: 没有可用的同义词');
        return;
    }
    
    if (currentSynonymIndex < currentResult.synonyms.length - 1) {
        currentSynonymIndex++;
        console.log('Word Munch: 显示同义词索引:', currentSynonymIndex);
        updateSynonymDisplay();
    } else {
        console.log('Word Munch: 已是最后一个同义词');
    }
}

// 复制同义词到剪贴板
function copySynonymToClipboard() {
    if (!currentResult || !currentResult.synonyms || currentSynonymIndex >= currentResult.synonyms.length) return;
    
    const synonym = currentResult.synonyms[currentSynonymIndex];
    const synonymText = typeof synonym === 'string' ? synonym : synonym.word || '';
    
    if (synonymText) {
        navigator.clipboard.writeText(synonymText).then(() => {
            const copyBtn = floatingWidget.querySelector('.wm-copy-btn');
            if (copyBtn) {
                copyBtn.classList.add('success');
                
                setTimeout(() => {
                    copyBtn.classList.remove('success');
                }, 1000);
            }
        }).catch(err => {
            console.error('复制失败:', err);
            showSimpleToast('复制失败', 'error');
        });
    }
}

// 显示简化错误
function showSimplificationError(error) {
    if (!floatingWidget) return;
    
    const loadingEl = floatingWidget.querySelector('.wm-loading');
    const resultEl = floatingWidget.querySelector('.wm-result');
    const errorEl = floatingWidget.querySelector('.wm-error');
    
    if (loadingEl) loadingEl.style.display = 'none';
    if (resultEl) resultEl.classList.remove('show');
    if (errorEl) {
        errorEl.classList.add('show');
        
        // 创建重试按钮，使用事件监听器而不是内联onclick
        errorEl.innerHTML = `
            <div style="margin-bottom: 8px;">${error || '简化失败'}</div>
            <button class="wm-btn wm-btn-primary wm-retry-btn" style="width: auto; padding: 6px 12px; font-size: 12px;">
                重试
            </button>
        `;
        
        // 绑定重试按钮事件
        const retryBtn = errorEl.querySelector('.wm-retry-btn');
        if (retryBtn) {
            retryBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                retrySimplification();
            });
        }
    }
}

// 添加重试函数
function retrySimplification() {
    if (!currentSelection) return;
    
    console.log('Word Munch: 重试简化:', currentSelection.text);
    
    // 重置错误状态
    const errorEl = floatingWidget?.querySelector('.wm-error');
    const loadingEl = floatingWidget?.querySelector('.wm-loading');
    
    if (errorEl) errorEl.classList.remove('show');
    if (loadingEl) loadingEl.style.display = 'flex';
    
    // 判断类型并重新开始简化
    const text = currentSelection.text;
    const type = isValidWord(text) ? 'word' : 'sentence';
    
    startSimplification(text, type);
}

// 在全局作用域添加重试函数，供内联点击使用（保留向后兼容）
window.retrySimplification = retrySimplification;

// === 修复的消息发送函数 ===
function sendMessageToBackground(message) {
    // 添加消息ID以便追踪
    const messageId = Math.random().toString(36).substr(2, 9);
    message.messageId = messageId;
    message.timestamp = Date.now();
    
    console.log('Word Munch: 发送消息到 background:', message.type, messageId);
    
    try {
        chrome.runtime.sendMessage(message, (response) => {
            // 检查是否有运行时错误
            if (chrome.runtime.lastError) {
                console.error('Word Munch: 消息发送失败:', chrome.runtime.lastError.message);
                return;
            }
            
            // 检查是否收到响应
            if (response) {
                console.log('Word Munch: 收到 background 响应:', response);
                
                if (response.received) {
                    console.log('Word Munch: 消息已被 background 接收');
                } else if (response.error) {
                    console.error('Word Munch: Background 处理错误:', response.error);
                }
            } else {
                console.warn('Word Munch: 未收到 background 响应');
            }
        });
    } catch (error) {
        console.error('Word Munch: 发送消息异常:', error);
    }
}

// 监听来自 background 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Word Munch: 收到 background 消息:', message.type);
    
    try {
        switch (message.type) {
            case 'WORD_SIMPLIFIED':
                handleWordSimplified(message.word, message.result);
                break;
                
            case 'SIMPLIFY_ERROR':
                handleSimplifyError(message.word, message.error);
                break;
                
            case 'SETTINGS_UPDATED':
                handleSettingsUpdated(message.settings);
                break;
                
            default:
                console.log('Word Munch: 未知消息类型:', message.type);
        }
        
        // 发送确认响应
        sendResponse({ received: true, timestamp: Date.now() });
        
    } catch (error) {
        console.error('Word Munch: 处理 background 消息失败:', error);
        sendResponse({ error: error.message });
    }
    
    // 不返回 true，因为我们同步处理消息
    return false;
});

// 处理词汇简化结果
function handleWordSimplified(word, result) {
    console.log('Word Munch: 词汇简化完成:', word, result);
    
    // 检查这个结果是否对应当前的请求
    if (!floatingWidget || !currentSelection || currentSelection.text !== word) {
        console.log('Word Munch: 结果不匹配当前状态，忽略:', {
            hasWidget: !!floatingWidget,
            hasSelection: !!currentSelection,
            currentText: currentSelection?.text,
            resultWord: word
        });
        return;
    }
    
    // 清除超时
    if (requestTimeout) {
        clearTimeout(requestTimeout);
        requestTimeout = null;
    }
    
    // 保存最近的结果
    lastWordText = word;
    lastWordResult = result;
    lastResultTime = Date.now();
    
    console.log('Word Munch: 更新现有浮动窗口的结果');
    showSimplificationResult(result);
    
    // 重置请求ID
    currentRequestId = null;
    
    // 处理待处理的选择
    processPendingSelection();
}

// 处理简化错误
function handleSimplifyError(word, error) {
    console.error('Word Munch: 简化失败:', word, error);
    
    // 检查这个错误是否对应当前的请求
    if (!floatingWidget || !currentSelection || currentSelection.text !== word) {
        console.log('Word Munch: 错误不匹配当前状态，忽略:', {
            hasWidget: !!floatingWidget,
            hasSelection: !!currentSelection,
            currentText: currentSelection?.text,
            errorWord: word
        });
        return;
    }
    
    // 清除超时
    if (requestTimeout) {
        clearTimeout(requestTimeout);
        requestTimeout = null;
    }
    
    // 重置请求ID
    currentRequestId = null;
    
    // 在浮动窗口中显示错误
    showSimplificationError(error);
    
    // 处理待处理的选择
    processPendingSelection();
}

// 处理设置更新
function handleSettingsUpdated(settings) {
    console.log('Word Munch: 设置已更新:', settings);
    
    // 如果扩展被禁用，隐藏浮动窗口
    if (!settings.extensionEnabled) {
        console.log('Word Munch: 扩展已禁用');
        closeFloatingWidget();
    }
}

// 显示简单的 Toast 提示（保留用于其他提示）
function showSimpleToast(message, type = 'success') {
    // 检查是否已存在 toast
    const existingToast = document.getElementById('word-munch-toast');
    if (existingToast) {
        existingToast.remove();
    }
    
    // 创建 toast 元素
    const toast = document.createElement('div');
    toast.id = 'word-munch-toast';
    toast.className = `word-munch-toast ${type}`;
    toast.textContent = message;
    
    // 添加到页面
    document.body.appendChild(toast);
    
    // 触发动画
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);
    
    // 3秒后自动移除
    setTimeout(() => {
        toast.classList.remove('show');
        
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, 3000);
}

// 检查是否为有效词汇
function isValidWord(text) {
    if (!text || text.length === 0) {
        return false;
    }
    
    // 检查是否包含空格、换行符、制表符等空白字符
    if (/\s/.test(text)) {
        return false;
    }
    
    // 检查是否为多语言词汇（1-10个字符）
    // 支持各种语言的字母和字符，但不包含数字、标点符号等
    const wordRegex = /^[\p{L}]{1,10}$/u;
    if (wordRegex.test(text)) {
        return true;
    }
    
    return false;
}

// 检查是否为有效句子/段落
function isValidSentence(text) {
    if (!text || text.length === 0) {
        return false;
    }
    
    // 句子/段落长度限制：11-500个字符
    if (text.length < 11 || text.length > 500) {
        return false;
    }
    
    // 检查是否包含有效的文本内容（至少包含一些字母或中文字符）
    const hasValidContent = /[\p{L}]/u.test(text);
    if (!hasValidContent) {
        return false;
    }
    
    return true;
}

// 获取选中文本周围的上下文
function getContextAroundSelection(selection) {
    if (!selection.rangeCount) return '';
    
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    
    // 获取包含选中文本的完整文本节点
    let textContent = '';
    
    if (container.nodeType === Node.TEXT_NODE) {
        // 如果是文本节点，获取父元素的文本内容
        textContent = container.parentElement ? container.parentElement.textContent : '';
    } else {
        // 如果是元素节点，获取其文本内容
        textContent = container.textContent || '';
    }
    
    // 如果文本内容太长，截取选中文本前后的部分
    const selectedText = selection.toString();
    const selectedIndex = textContent.indexOf(selectedText);
    
    if (selectedIndex === -1) return '';
    
    // 根据选中文本的长度决定获取多少上下文
    let contextLength = 100; // 默认前后各100字符
    
    if (selectedText.length > 50) {
        // 如果选中的文本较长，减少上下文长度
        contextLength = 50;
    } else if (selectedText.length > 20) {
        // 中等长度，适中的上下文
        contextLength = 75;
    }
    
    // 获取选中文本前后各contextLength个字符作为上下文
    const beforeContext = textContent.substring(Math.max(0, selectedIndex - contextLength), selectedIndex);
    const afterContext = textContent.substring(selectedIndex + selectedText.length, selectedIndex + selectedText.length + contextLength);
    
    return (beforeContext + selectedText + afterContext).trim();
}

// 页面加载完成后的初始化
document.addEventListener('DOMContentLoaded', function() {
    console.log('Word Munch: Content script 已加载');
    
    // 通知 background script content script 已准备就绪
    sendMessageToBackground({
        type: 'CONTENT_SCRIPT_READY',
        url: window.location.href
    });
});

// 如果页面已经加载完成（script 加载较晚的情况）
if (document.readyState === 'loading') {
    // DOM 还在加载中，等待 DOMContentLoaded
} else {
    // DOM 已经加载完成
    console.log('Word Munch: Content script 已加载（页面已完成）');
    
    // 延迟通知，确保 background script 已准备好
    setTimeout(() => {
        sendMessageToBackground({
            type: 'CONTENT_SCRIPT_READY',
            url: window.location.href
        });
    }, 100);
}

// 错误处理
window.addEventListener('error', function(event) {
    console.error('Word Munch: Content script 错误:', event.error);
});

console.log('Word Munch: Content script 初始化完成');