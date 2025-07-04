// Example configuration file for API endpoints
// Copy this file to config.js and replace with your actual API endpoints
// DO NOT commit config.js to version control

const API_CONFIG = {
    WORD_API_ENDPOINT: 'YOUR_WORD_API_ENDPOINT_HERE',
    CONCEPT_API_ENDPOINT: 'YOUR_CONCEPT_API_ENDPOINT_HERE', 
    COGNITIVE_API_ENDPOINT: 'YOUR_COGNITIVE_API_ENDPOINT_HERE',
    USER_API_ENDPOINT: 'YOUR_USER_API_ENDPOINT_HERE',
    SEMANTIC_SEARCH_API_ENDPOINT: 'YOUR_SEMANTIC_SEARCH_API_ENDPOINT_HERE'
};

// Check if we're in a browser environment and load from localStorage if available
if (typeof window !== 'undefined' && window.localStorage) {
    const storedConfig = localStorage.getItem('wordMunchAPIConfig');
    if (storedConfig) {
        try {
            const parsed = JSON.parse(storedConfig);
            Object.assign(API_CONFIG, parsed);
        } catch (e) {
            console.warn('Failed to parse stored API config:', e);
        }
    }
}

export default API_CONFIG; 