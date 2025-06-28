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

// 监听文本选择事件
document.addEventListener('mouseup', handleTextSelection);
document.addEventListener('keyup', handleTextSelection);
document.addEventListener('dblclick', handleTextSelection);

// 处理文本选择
function handleTextSelection(event) {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    
    // 检查选中的文本是否为空
    if (!selectedText || selectedText.length === 0) {
        hideFloatingWidget();
        return;
    }
    
    // 如果选中的是同一个文本且浮动窗口已经存在，不重复处理
    if (currentSelection && currentSelection.text === selectedText && floatingWidget) {
        console.log('Word Munch: 重复选择同一文本，跳过处理');
        return;
    }

    // 保存当前选择
    currentSelection = {
        text: selectedText,
        selection: selection,
        range: selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null
    };
    
    console.log('Word Munch: 新的文本选择:', selectedText);
    
    // 根据文本长度决定处理方式
    if (isValidWord(selectedText)) {
        // 词汇简化（1-10个字符）
        showFloatingWidget(selectedText, selection, 'word');
    } else if (isValidSentence(selectedText)) {
        // 句子/段落简化（11-500个字符）
        showFloatingWidget(selectedText, selection, 'sentence');
    } else {
        hideFloatingWidget();
    }
}

// 显示浮动窗口
function showFloatingWidget(text, selection, type) {
    console.log('Word Munch: 显示浮动窗口:', text, type);
    
    // 先保存当前选择，避免在hideFloatingWidget中被重置
    const newSelection = {
        text: text,
        selection: selection,
        range: selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null
    };
    
    // 移除现有的浮动窗口和事件监听器
    hideFloatingWidget();
    
    // 重新设置选择状态（在hideFloatingWidget之后）
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
        floatingWidget.classList.add('show');
        console.log('Word Munch: 触发显示动画');
    }, 10);
    
    // 绑定事件
    setupWidgetEvents(text, type);
    
    // 自动开始简化
    startSimplification(text, type);
}

// 设置浮动窗口事件
function setupWidgetEvents(text, type) {
    const widget = floatingWidget;
    if (!widget) return;
    
    // 关闭按钮
    const closeBtn = widget.querySelector('.wm-close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeFloatingWidget); // 使用完全清理函数
    }
    
    // 换一个按钮
    const simplifyBtn = widget.querySelector('.wm-simplify-btn');
    if (simplifyBtn) {
        simplifyBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 防止事件冒泡
            showNextSynonym();
        });
    }
    
    // 复制按钮
    const copyBtn = widget.querySelector('.wm-copy-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 防止事件冒泡
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
        document.addEventListener('click', handleOutsideClick, true); // 使用捕获阶段
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
            return; // 点击在选中区域内，不关闭
        }
    }
    
    // 其他情况关闭浮动窗口
    console.log('Word Munch: 点击在外部，关闭浮动窗口');
    closeFloatingWidget(); // 使用完全清理函数
}

// 隐藏浮动窗口
function hideFloatingWidget() {
    console.log('Word Munch: 开始隐藏浮动窗口');
    
    if (floatingWidget) {
        floatingWidget.classList.remove('show');
        
        setTimeout(() => {
            if (floatingWidget && floatingWidget.parentNode) {
                floatingWidget.parentNode.removeChild(floatingWidget);
            }
            floatingWidget = null;
            console.log('Word Munch: 浮动窗口已从DOM移除');
        }, 200);
        
        // 移除外部点击监听器
        removeOutsideClickListener();
    }
    
    // 只重置部分状态，保留currentSelection直到新窗口创建
    currentResult = null;
    currentSynonymIndex = 0;
    console.log('Word Munch: 部分状态已重置');
}

// 完全清理浮动窗口和所有状态
function closeFloatingWidget() {
    console.log('Word Munch: 完全关闭浮动窗口');
    hideFloatingWidget();
    
    // 完全重置所有状态
    currentSelection = null;
    currentResult = null;
    currentSynonymIndex = 0;
    // 但保留最近结果的缓存，用于快速重新显示
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
    
    // 发送消息到 background
    sendMessageToBackground({
        type: type === 'word' ? 'WORD_SELECTED' : 'SENTENCE_SELECTED',
        word: text,
        text: text,
        context: context,
        url: window.location.href,
        title: document.title
    });
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
        
        // 更新按钮状态 - 极简版只改变透明度和鼠标样式
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
                // 极简版：直接改变样式类而不是文字
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
        errorEl.textContent = error || '简化失败，请重试';
    }
}

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
    
    // 保存最近的结果
    lastWordText = word;
    lastWordResult = result;
    lastResultTime = Date.now();
    
    // 确保不创建新的浮动窗口，只更新现有的
    if (floatingWidget && currentSelection && currentSelection.text === word) {
        console.log('Word Munch: 更新现有浮动窗口的结果');
        showSimplificationResult(result);
    } else {
        console.log('Word Munch: 浮动窗口状态不匹配，忽略结果');
        console.log('- floatingWidget存在:', !!floatingWidget);
        console.log('- currentSelection存在:', !!currentSelection);
        console.log('- 文本匹配:', currentSelection?.text === word);
    }
}

// 处理简化错误
function handleSimplifyError(word, error) {
    console.error('Word Munch: 简化失败:', word, error);
    
    // 在浮动窗口中显示错误
    showSimplificationError(error);
}

// 处理设置更新
function handleSettingsUpdated(settings) {
    console.log('Word Munch: 设置已更新:', settings);
    
    // 如果扩展被禁用，隐藏浮动窗口
    if (!settings.extensionEnabled) {
        console.log('Word Munch: 扩展已禁用');
        closeFloatingWidget(); // 使用完全清理函数
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