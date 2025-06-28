// 初始化
document.addEventListener('DOMContentLoaded', function() {
    const extensionToggle = document.getElementById('extension-toggle');
    const outputLanguage = document.getElementById('output-language');
    const status = document.getElementById('status');
    
    // 设置开关事件监听器
    if (extensionToggle) {
        // 监听checkbox change事件
        extensionToggle.addEventListener('change', handleToggleChange);
        
        // 监听容器点击（备用方案）
        const toggleContainer = extensionToggle.closest('.toggle-switch');
        if (toggleContainer) {
            toggleContainer.addEventListener('click', function(e) {
                if (e.target !== extensionToggle) {
                    extensionToggle.checked = !extensionToggle.checked;
                    handleToggleChange({ target: extensionToggle });
                }
            });
        }
    }
    
    // 设置语言选择事件
    if (outputLanguage) {
        outputLanguage.addEventListener('change', function() {
            saveSettings();
            notifyBackground();
        });
    }
    
    // 加载设置
    loadSettings();
    
    // 初始化用户相关功能
    // initializeUser();
    
    // 加载统计
    loadStatistics();
    
    // 处理开关状态改变
    function handleToggleChange(event) {
        const isEnabled = event.target.checked;
        console.log('开关状态改变:', isEnabled);
        
        // 更新状态显示
        if (status) {
            status.textContent = isEnabled ? '扩展已启用' : '扩展已禁用';
            status.style.color = isEnabled ? '#28a745' : '#dc3545';
        }
        
        // 保存设置
        saveSettings();
        notifyBackground();
    }
    
    // 保存设置
    function saveSettings() {
        if (!extensionToggle || !outputLanguage) return;
        
        const settings = {
            extensionEnabled: extensionToggle.checked,
            outputLanguage: outputLanguage.value
        };
        
        if (chrome?.storage) {
            chrome.storage.sync.set(settings);
        }
    }
    
    // 加载设置
    function loadSettings() {
        if (!chrome?.storage) {
            return;
        }
        
        chrome.storage.sync.get(['extensionEnabled', 'outputLanguage'], function(result) {
            if (extensionToggle) {
                extensionToggle.checked = result.extensionEnabled !== false;
                // 更新状态显示
                if (status) {
                    const isEnabled = extensionToggle.checked;
                    status.textContent = isEnabled ? '扩展已启用' : '扩展已禁用';
                    status.style.color = isEnabled ? '#28a745' : '#dc3545';
                }
            }
            
            if (outputLanguage) {
                outputLanguage.value = result.outputLanguage || 'english';
            }
        });
    }
    
    // 通知background脚本
    function notifyBackground() {
        if (!chrome?.runtime || !extensionToggle || !outputLanguage) return;
        
        const message = {
            type: 'SETTINGS_UPDATED',
            settings: {
                extensionEnabled: extensionToggle.checked,
                outputLanguage: outputLanguage.value
            }
        };
        
        chrome.runtime.sendMessage(message);
    }
    
    // 初始化用户功能
    // function initializeUser() {
    //     const loginBtn = document.getElementById('login-btn');
    //     const registerBtn = document.getElementById('register-btn');
    //     const logoutBtn = document.getElementById('logout-btn');
        
    //     if (loginBtn) {
    //         loginBtn.addEventListener('click', handleLogin);
    //     }
    //     if (registerBtn) {
    //         registerBtn.addEventListener('click', () => showMessage('注册功能暂未实现', 'info'));
    //     }
    //     if (logoutBtn) {
    //         logoutBtn.addEventListener('click', handleLogout);
    //     }
        
    //     // 加载用户状态
    //     loadUserInfo();
    // }
    
    // 处理登录
    function handleLogin() {
        const emailInput = document.getElementById('email-input');
        const passwordInput = document.getElementById('password-input');
        
        if (!emailInput?.value || !passwordInput?.value) {
            showMessage('请填写邮箱和密码', 'error');
            return;
        }
        
        const email = emailInput.value.trim();
        
        // 模拟登录
        chrome.storage.sync.set({
            userEmail: email,
            userToken: 'mock_token_' + Date.now()
        }, function() {
            showMessage('登录成功', 'success');
            loadUserInfo();
        });
    }
    
    // 处理退出登录
    function handleLogout() {
        chrome.storage.sync.remove(['userEmail', 'userToken'], function() {
            showMessage('已退出登录', 'success');
            loadUserInfo();
        });
    }
    
    // 加载用户信息
    function loadUserInfo() {
        if (!chrome?.storage) return;
        
        chrome.storage.sync.get(['userEmail', 'userToken'], function(result) {
            const loginForm = document.getElementById('login-form');
            const userInfo = document.getElementById('user-info');
            const userEmail = document.getElementById('user-email');
            const userAvatarText = document.getElementById('user-avatar-text');
            
            if (result.userEmail && result.userToken) {
                if (loginForm) loginForm.style.display = 'none';
                if (userInfo) userInfo.style.display = 'flex';
                if (userEmail) userEmail.textContent = result.userEmail;
                if (userAvatarText) userAvatarText.textContent = result.userEmail.charAt(0).toUpperCase();
            } else {
                if (loginForm) loginForm.style.display = 'flex';
                if (userInfo) userInfo.style.display = 'none';
            }
        });
    }
    
    // 加载统计信息
    function loadStatistics() {
        if (!chrome?.storage) return;
        
        chrome.storage.sync.get(['wordCounts'], function(result) {
            const counts = result.wordCounts || { today: 0, week: 0, total: 0 };
            
            const todayCount = document.getElementById('today-count');
            const weekCount = document.getElementById('week-count');
            const totalCount = document.getElementById('total-count');
            
            if (todayCount) todayCount.textContent = counts.today || 0;
            if (weekCount) weekCount.textContent = counts.week || 0;
            if (totalCount) totalCount.textContent = counts.total || 0;
        });
    }
    
    // 显示消息提示
    function showMessage(message, type = 'info') {
        const existingMessage = document.querySelector('.popup-message');
        if (existingMessage) {
            existingMessage.remove();
        }
        
        const messageEl = document.createElement('div');
        messageEl.className = 'popup-message';
        messageEl.textContent = message;
        messageEl.style.cssText = `
            position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
            padding: 8px 16px; border-radius: 6px; color: white; font-size: 12px;
            z-index: 10000; max-width: 280px; text-align: center;
            background: ${type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#17a2b8'};
        `;
        
        document.body.appendChild(messageEl);
        setTimeout(() => messageEl.remove(), 3000);
    }
});