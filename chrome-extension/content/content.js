// Content Script - 修复消息发送问题

let selectedText = '';
let contextText = '';

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
        return;
    }
    
    // 根据文本长度决定处理方式
    if (isValidWord(selectedText)) {
        // 词汇简化（1-10个字符）
        handleWordSimplification(selectedText, selection);
    } else if (isValidSentence(selectedText)) {
        // 句子/段落简化（11-500个字符）
        handleSentenceSimplification(selectedText, selection);
    }
}

// 处理词汇简化 - 修复版本
function handleWordSimplification(word, selection) {
    // 获取上下文（选中文本周围的文本）
    const context = getContextAroundSelection(selection);
    
    console.log('Word Munch: 检测到选中词汇:', word);
    console.log('Word Munch: 上下文:', context);
    
    // 修复的消息发送方式
    sendMessageToBackground({
        type: 'WORD_SELECTED',
        word: word,
        context: context,
        url: window.location.href,
        title: document.title
    });
}

// 处理句子/段落简化 - 修复版本
function handleSentenceSimplification(text, selection) {
    // 对于句子/段落，获取选中文本前后的内容作为上下文
    const context = getContextAroundSelection(selection);
    
    console.log('Word Munch: 检测到选中句子/段落:', text);
    console.log('Word Munch: 上下文:', context);
    
    // 修复的消息发送方式
    sendMessageToBackground({
        type: 'SENTENCE_SELECTED',
        text: text,
        context: context,
        url: window.location.href,
        title: document.title
    });
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
    
    // 这里可以添加显示简化结果的UI逻辑
    // 例如：显示悬浮窗口、高亮显示等
    
    // 暂时显示一个简单的提示
    showSimpleToast(`${word}: ${getFirstSynonym(result)}`);
}

// 处理简化错误
function handleSimplifyError(word, error) {
    console.error('Word Munch: 简化失败:', word, error);
    
    // 显示错误提示
    showSimpleToast(`简化 "${word}" 失败: ${error}`, 'error');
}

// 处理设置更新
function handleSettingsUpdated(settings) {
    console.log('Word Munch: 设置已更新:', settings);
    
    // 这里可以根据新设置调整 content script 行为
    if (!settings.extensionEnabled) {
        console.log('Word Munch: 扩展已禁用');
    }
}

// 获取第一个同义词
function getFirstSynonym(result) {
    if (!result || !result.synonyms || result.synonyms.length === 0) {
        return '无简化结果';
    }
    
    const firstSynonym = result.synonyms[0];
    return typeof firstSynonym === 'string' ? firstSynonym : firstSynonym.word || '简化完成';
}

// 显示简单的 Toast 提示
function showSimpleToast(message, type = 'success') {
    // 检查是否已存在 toast
    const existingToast = document.getElementById('word-munch-toast');
    if (existingToast) {
        existingToast.remove();
    }
    
    // 创建 toast 元素
    const toast = document.createElement('div');
    toast.id = 'word-munch-toast';
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'error' ? '#f44336' : '#4caf50'};
        color: white;
        padding: 12px 16px;
        border-radius: 4px;
        font-size: 14px;
        font-family: Arial, sans-serif;
        z-index: 10000;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        max-width: 300px;
        word-wrap: break-word;
        opacity: 0;
        transform: translateX(100%);
        transition: all 0.3s ease;
    `;
    toast.textContent = message;
    
    // 添加到页面
    document.body.appendChild(toast);
    
    // 触发动画
    setTimeout(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(0)';
    }, 10);
    
    // 3秒后自动移除
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        
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