// Initialize
document.addEventListener('DOMContentLoaded', function() {
    console.log('Word Munch: Popup script loaded');
    
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
    initializeUser();
    
    // Load statistics
    loadStatistics();
    
    // Handle toggle status change
    function handleToggleChange(event) {
        const isEnabled = event.target.checked;
        console.log('Toggle status changed:', isEnabled);
        
        // Update status display
        if (status) {
            status.textContent = isEnabled ? 'Extension Enabled' : 'Extension Disabled';
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
                    status.textContent = isEnabled ? 'Extension Enabled' : 'Extension Disabled';
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
    function initializeUser() {
        // Tab switching
        const loginTab = document.getElementById('login-tab');
        const registerTab = document.getElementById('register-tab');
        const loginContent = document.getElementById('login-content');
        const registerContent = document.getElementById('register-content');
        
        if (loginTab && registerTab) {
            loginTab.addEventListener('click', () => switchTab('login'));
            registerTab.addEventListener('click', () => switchTab('register'));
        }
        
        // Login functionality
        const loginBtn = document.getElementById('login-btn');
        if (loginBtn) {
            loginBtn.addEventListener('click', handleLogin);
        }
        
        // Register functionality  
        const registerBtn = document.getElementById('register-btn');
        if (registerBtn) {
            registerBtn.addEventListener('click', handleRegister);
        }
        
        // Logout functionality
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', handleLogout);
        }
        
        // Universal cognitive dashboard button (for all users)
        const universalDashboardBtn = document.getElementById('universal-dashboard-btn');
        if (universalDashboardBtn) {
            universalDashboardBtn.addEventListener('click', showUniversalCognitiveDashboard);
        }
        
        // Forgot password link
        const forgotLink = document.getElementById('forgot-password-link');
        if (forgotLink) {
            forgotLink.addEventListener('click', (e) => {
                e.preventDefault();
                handleForgotPassword();
            });
        }
        
        // Password confirmation validation
        const confirmPassword = document.getElementById('register-confirm');
        if (confirmPassword) {
            confirmPassword.addEventListener('input', validatePasswordMatch);
        }
        
        // Load user status
        loadUserInfo();
    }
    
    // Switch between login and register tabs
    function switchTab(tab) {
        const loginTab = document.getElementById('login-tab');
        const registerTab = document.getElementById('register-tab');
        const loginContent = document.getElementById('login-content');
        const registerContent = document.getElementById('register-content');
        
        // Update tab buttons
        loginTab.classList.toggle('active', tab === 'login');
        registerTab.classList.toggle('active', tab === 'register');
        
        // Update tab content
        loginContent.classList.toggle('active', tab === 'login');
        registerContent.classList.toggle('active', tab === 'register');
        
        // Clear any error messages
        clearFormErrors();
    }
    
    // Validate password match
    function validatePasswordMatch() {
        const password = document.getElementById('register-password');
        const confirm = document.getElementById('register-confirm');
        
        if (password && confirm && confirm.value) {
            if (password.value !== confirm.value) {
                confirm.setCustomValidity('Passwords do not match');
            } else {
                confirm.setCustomValidity('');
            }
        }
    }
    
    // Clear form errors
    function clearFormErrors() {
        const inputs = document.querySelectorAll('.input-field');
        inputs.forEach(input => {
            input.setCustomValidity('');
            input.classList.remove('error');
        });
    }
    
    // Handle user registration
    async function handleRegister() {
        const nameInput = document.getElementById('register-name');
        const emailInput = document.getElementById('register-email');
        const passwordInput = document.getElementById('register-password');
        const confirmInput = document.getElementById('register-confirm');
        const registerBtn = document.getElementById('register-btn');
        
        // Validate inputs
        if (!nameInput?.value?.trim()) {
            showMessage('Please enter your full name', 'error');
            nameInput?.focus();
            return;
        }
        
        if (!emailInput?.value?.trim()) {
            showMessage('Please enter your email address', 'error');
            emailInput?.focus();
            return;
        }
        
        if (!isValidEmail(emailInput.value.trim())) {
            showMessage('Please enter a valid email address', 'error');
            emailInput?.focus();
            return;
        }
        
        if (!passwordInput?.value || passwordInput.value.length < 8) {
            showMessage('Password must be at least 8 characters long', 'error');
            passwordInput?.focus();
            return;
        }
        
        if (passwordInput.value !== confirmInput?.value) {
            showMessage('Passwords do not match', 'error');
            confirmInput?.focus();
            return;
        }
        
        // Show loading state
        registerBtn.classList.add('loading');
        registerBtn.disabled = true;
        
        try {
            const userData = {
                name: nameInput.value.trim(),
                email: emailInput.value.trim(),
                password: passwordInput.value
            };
            
            // Call registration API
            const result = await callAuthAPI('register', userData);
            
            if (result.success) {
                // Save user info
                await chrome.storage.sync.set({
                    userEmail: result.user.email,
                    userName: result.user.name,
                    userToken: result.token,
                    userId: result.user.id
                });
                
                showMessage('Account created successfully! Welcome!', 'success');
                loadUserInfo();
                
                // Clear form
                nameInput.value = '';
                emailInput.value = '';
                passwordInput.value = '';
                confirmInput.value = '';
                
            } else {
                throw new Error(result.error || 'Registration failed');
            }
            
        } catch (error) {
            console.error('Registration error:', error);
            showMessage(error.message || 'Registration failed. Please try again.', 'error');
        } finally {
            registerBtn.classList.remove('loading');
            registerBtn.disabled = false;
        }
    }
    
    // Handle login
    async function handleLogin() {
        const emailInput = document.getElementById('login-email');
        const passwordInput = document.getElementById('login-password');
        const loginBtn = document.getElementById('login-btn');
        
        if (!emailInput?.value?.trim() || !passwordInput?.value) {
            showMessage('Please fill in email and password', 'error');
            return;
        }
        
        if (!isValidEmail(emailInput.value.trim())) {
            showMessage('Please enter a valid email address', 'error');
            emailInput?.focus();
            return;
        }
        
        // Show loading state
        loginBtn.classList.add('loading');
        loginBtn.disabled = true;
        
        try {
            const loginData = {
                email: emailInput.value.trim(),
                password: passwordInput.value
            };
        
            // Call login API
            const result = await callAuthAPI('login', loginData);
            
            if (result.success) {
                // Save user info
                await chrome.storage.sync.set({
                    userEmail: result.user.email,
                    userName: result.user.name,
                    userToken: result.token,
                    userId: result.user.id
                });
                
                showMessage('Welcome back!', 'success');
            loadUserInfo();
                
                // Clear form
                emailInput.value = '';
                passwordInput.value = '';
                
            } else {
                throw new Error(result.error || 'Login failed');
            }
            
        } catch (error) {
            console.error('Login error:', error);
            const userFriendlyMessage = error.message.includes('Invalid email or password')
                ? 'Invalid email or password. Please try again.'
                : 'Login failed. Please check your credentials.';
            showMessage(userFriendlyMessage, 'error');
        } finally {
            loginBtn.classList.remove('loading');
            loginBtn.disabled = false;
        }
    }
    
    // Handle logout
    async function handleLogout() {
        try {
            await chrome.storage.sync.remove(['userEmail', 'userName', 'userToken', 'userId']);
            showMessage('Signed out successfully', 'success');
            loadUserInfo();
        } catch (error) {
            console.error('Logout error:', error);
            showMessage('Logout failed', 'error');
        }
    }
    
    // Show universal cognitive dashboard (for all users including guests)
    async function showUniversalCognitiveDashboard() {
        try {
            // Get current active tab
            const tabs = await chrome.tabs.query({active: true, currentWindow: true});
            if (tabs[0]) {
                // Check if user is logged in
                const userInfo = await chrome.storage.sync.get(['userEmail', 'userToken', 'userId']);
                
                let userId = 'anonymous_user';
                let isAnonymous = true;
                
                if (userInfo.userEmail && userInfo.userToken) {
                    // User is logged in, use their ID
                    userId = userInfo.userId || userInfo.userEmail;
                    isAnonymous = false;
                }
                
                // Send message to content script to show dashboard
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'SHOW_COGNITIVE_DASHBOARD',
                    userId: userId,
                    isAnonymous: isAnonymous
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('Universal dashboard message error:', chrome.runtime.lastError.message);
                        if (chrome.runtime.lastError.message.includes('Could not establish connection')) {
                            showMessage('Please refresh the page and try again', 'error');
                        } else {
                            showMessage('Failed to open dashboard', 'error');
                        }
                    } else {
                        console.log('Universal dashboard message sent successfully');
                        window.close(); // Close popup after opening dashboard
                    }
                });
            }
        } catch (error) {
            console.error('Failed to show universal cognitive dashboard:', error);
            showMessage('Failed to open dashboard', 'error');
        }
    }
    
    // Validate email format
    function isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }
    
    // Call authentication API
    async function callAuthAPI(action, data) {
        // Get API configuration
        const config = await chrome.storage.sync.get(['apiConfig']);
        
        if (!config.apiConfig?.USER_API_ENDPOINT) {
            throw new Error('User API not configured. Please check extension settings.');
        }
        
        const response = await fetch(config.apiConfig.USER_API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                action: action,
                ...data
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error: ${response.status} - ${errorText}`);
        }
        
        return await response.json();
    }
    
    // Load user information
    function loadUserInfo() {
        if (!chrome?.storage) return;
        
        chrome.storage.sync.get(['userEmail', 'userName', 'userToken'], function(result) {
            const loginForm = document.getElementById('login-form');
            const userInfo = document.getElementById('user-info');
            const userEmail = document.getElementById('user-email');
            const userName = document.getElementById('user-name');
            const userAvatarText = document.getElementById('user-avatar-text');
            
            if (result.userEmail && result.userToken) {
                // User is logged in
                if (loginForm) loginForm.style.display = 'none';
                if (userInfo) userInfo.style.display = 'flex';
                
                if (userEmail) userEmail.textContent = result.userEmail;
                if (userName) userName.textContent = result.userName || 'User';
                if (userAvatarText) {
                    const name = result.userName || result.userEmail;
                    userAvatarText.textContent = name.charAt(0).toUpperCase();
                }
            } else {
                // User is not logged in
                if (loginForm) loginForm.style.display = 'block';
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

    // Reader mode button event
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

    async function handleForgotPassword() {
        showMessage('The "Forgot Password" feature is not yet implemented. Please check back later.', 'info');
    }
});