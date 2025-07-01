# API配置说明

## 保护您的API密钥

为了避免API密钥暴露在GitHub上，请按以下步骤操作：

### 步骤1：配置API端点

编辑 `config.js` 文件，将占位符替换为您的真实API端点：

```javascript
const API_CONFIG = {
    WORD_API_ENDPOINT: 'https://your-actual-api-gateway.amazonaws.com/dev/word-muncher',
    CONCEPT_API_ENDPOINT: 'https://your-actual-api-gateway.amazonaws.com/dev/concept-muncher', 
    COGNITIVE_API_ENDPOINT: 'https://your-actual-api-gateway.amazonaws.com/dev/cognitive-profile'
};
```

### 步骤2：确保安全

- ✅ `config.js` 文件已被添加到 `.gitignore`，不会被提交到GitHub
- ✅ 使用 `config.example.js` 作为模板
- ❌ 不要在代码中硬编码真实的API端点

### 开发时快速配置

在浏览器控制台运行以下代码：

```javascript
const apiConfig = {
    WORD_API_ENDPOINT: 'https://your-api-endpoint',
    CONCEPT_API_ENDPOINT: 'https://your-api-endpoint',
    COGNITIVE_API_ENDPOINT: 'https://your-api-endpoint'
};
localStorage.setItem('wordMunchAPIConfig', JSON.stringify(apiConfig));
``` 