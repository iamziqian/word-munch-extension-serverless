// Initialize
document.addEventListener('DOMContentLoaded', function() {
    const extensionToggle = document.getElementById('extension-toggle');
    const outputLanguage = document.getElementById('output-language');
    const status = document.getElementById('status');
    
    // Set toggle event listener
    if (extensionToggle) {
        // Listen to checkbox change event
        extensionToggle.addEventListener('change', handleToggleChange);
        
        // Listen to container click (backup solution)
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
    
    // Set language selection event
    if (outputLanguage) {
        outputLanguage.addEventListener('change', function() {
            saveSettings();
            notifyBackground();
        });
    }
    
    // Load settings
    loadSettings();
    
    // Initialize user-related features
    // initializeUser();
    
    // Load statistics
    loadStatistics();
    
    // Handle toggle status change
    function handleToggleChange(event) {
        const isEnabled = event.target.checked;
        console.log('Toggle status changed:', isEnabled);
        
        // Update status display
        if (status) {
            status.textContent = isEnabled ? '扩展已启用' : '扩展已禁用';
            status.style.color = isEnabled ? '#28a745' : '#dc3545';
        }
        
        // Save settings
        saveSettings();
        notifyBackground();
    }
    
    // Save settings
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
    
    // Load settings
    function loadSettings() {
        if (!chrome?.storage) {
            return;
        }
        
        chrome.storage.sync.get(['extensionEnabled', 'outputLanguage'], function(result) {
            if (extensionToggle) {
                extensionToggle.checked = result.extensionEnabled !== false;
                // Update status display
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
    
    // Notify background script
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
    
    // Initialize user features
    // function initializeUser() {
    //     const loginBtn = document.getElementById('login-btn');
    //     const registerBtn = document.getElementById('register-btn');
    //     const logoutBtn = document.getElementById('logout-btn');
        
    //     if (loginBtn) {
    //         loginBtn.addEventListener('click', handleLogin);
    //     }
    //     if (registerBtn) {
    //         registerBtn.addEventListener('click', () => showMessage('Registration function not implemented yet', 'info'));
    //     }
    //     if (logoutBtn) {
    //         logoutBtn.addEventListener('click', handleLogout);
    //     }
        
    //     // Load user status
    //     loadUserInfo();
    // }
    
    // Handle login
    function handleLogin() {
        const emailInput = document.getElementById('email-input');
        const passwordInput = document.getElementById('password-input');
        
        if (!emailInput?.value || !passwordInput?.value) {
            showMessage('Please fill in email and password', 'error');
            return;
        }
        
        const email = emailInput.value.trim();
        
        // Simulate login
        chrome.storage.sync.set({
            userEmail: email,
            userToken: 'mock_token_' + Date.now()
        }, function() {
            showMessage('Login successful', 'success');
            loadUserInfo();
        });
    }
    
    // Handle logout
    function handleLogout() {
        chrome.storage.sync.remove(['userEmail', 'userToken'], function() {
            showMessage('Logged out successfully', 'success');
            loadUserInfo();
        });
    }
    
    // Load user information
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
    
    // Load statistics information
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
    
    // Show message prompt
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

    // 阅读模式按钮事件
    const readerModeBtn = document.getElementById('reader-mode-btn');
    if (readerModeBtn) {
        readerModeBtn.addEventListener('click', function() {
            chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        type: 'TOGGLE_READER_MODE'
                    }, function(response) {
                        if (chrome.runtime.lastError) {
                            console.error('Failed to send reading mode message:', chrome.runtime.lastError.message);
                            if (chrome.runtime.lastError.message.includes('Could not establish connection')) {
                                showMessage('Please refresh the page and try again', 'error');
                            }
                            // Remove other error prompts to avoid false reporting
                        } else {
                            // If there is no runtime error, close the popup (regardless of the response content)
                            console.log('Reading mode message sent');
                            window.close();
                        }
                    });
                }
            });
        });
    }
    
    // Focus mode setting
    const focusModes = document.querySelector('.focus-modes');
    const modeOptions = document.querySelectorAll('.mode-option');

    if (focusModes && modeOptions.length > 0) {
        // Load saved settings
        chrome.storage.sync.get(['focusMode'], function(result) {
            const savedMode = result.focusMode || 'balanced';
            selectFocusMode(savedMode);
        });
        
        // Bind mode selection event
        modeOptions.forEach(option => {
            option.addEventListener('click', function() {
                const mode = this.dataset.mode;
                selectFocusMode(mode);
                
                // Save settings
                chrome.storage.sync.set({ focusMode: mode });
                
                // Notify content script to update settings
                chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                    if (tabs[0]) {
                        chrome.tabs.sendMessage(tabs[0].id, {
                            type: 'UPDATE_FOCUS_MODE',
                            mode: mode
                        });
                    }
                });
            });
        });
    }

    // Select focus mode
    function selectFocusMode(mode) {
        // Update selected state
        modeOptions.forEach(option => {
            option.classList.toggle('active', option.dataset.mode === mode);
        });
        
        // Update preview effect
        const focusPreview = document.querySelector('.focus-preview');
        if (focusPreview) {
            focusPreview.setAttribute('data-mode', mode);
        }
        
        console.log('Word Munch: Select focus mode:', mode);
    }
});