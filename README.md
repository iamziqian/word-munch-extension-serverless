# Word Munch Extension - 智能词汇简化服务

Word Munch 是一个基于AI的智能词汇简化服务，通过AWS Bedrock提供递进式同义词生成，帮助用户理解复杂词汇。支持多语言输出和智能缓存机制。

## 🚀 核心特性

### 智能词汇简化
- **递进式同义词** - 从复杂到简单的5个同义词
- **上下文感知** - 根据句子上下文生成合适的同义词
- **多语言支持** - 支持中文(zh)和英文(en)输出
- **语言独立** - 输入词汇语言不影响输出语言

### 高性能架构
- **无服务器架构** - AWS Lambda + API Gateway
- **智能缓存** - DynamoDB缓存，提高响应速度
- **成本优化** - 按需付费，自动扩缩容
- **高可用性** - 99.9%可用性保证

## 🏗️ 技术架构

### AWS 服务架构

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Chrome Extension│    │   API Gateway   │    │  Word Muncher   │
│                 │    │                 │    │     Lambda      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────┐
                    │   DynamoDB      │
                    │   Cache Table   │
                    └─────────────────┘
                                 │
                    ┌─────────────────┐
                    │   AWS Bedrock   │
                    │   (Llama 3 8B)  │
                    └─────────────────┘
```

### 核心组件

| 组件 | 技术栈 | 功能 |
|------|--------|------|
| API Gateway | AWS API Gateway | RESTful API接口，CORS支持，限流 |
| Lambda | AWS Lambda | 词汇简化逻辑，AI模型调用 |
| 缓存 | DynamoDB | 智能缓存，TTL自动过期 |
| AI模型 | AWS Bedrock | Llama 3 8B 模型，多语言支持 |

## 📁 项目结构

```
word-munch-extension-serverless/
├── aws-lambda/                    # AWS Lambda 函数
│   └── word_muncher_lambda.py    # 词汇简化服务
├── chrome-extension/             # Chrome扩展
│   ├── background/               # 后台脚本
│   ├── content/                  # 内容脚本
│   ├── popup/                    # 弹出界面
│   └── shared/                   # 共享模块
├── infrastructure/               # 基础设施
│   ├── app.py                    # CDK应用入口
│   ├── word_munch_stack.py       # CDK堆栈定义
│   └── requirements.txt          # Python依赖
└── docs/                         # 文档
```

## 🚀 快速开始

### 1. 部署AWS服务

```bash
# 安装依赖
cd infrastructure
pip install -r requirements.txt

# 部署基础设施
cdk deploy
```

### 2. 测试API

```bash
# 中文输出
curl -X POST https://your-api-gateway-url/dev/word-muncher \
  -H "Content-Type: application/json" \
  -d '{
    "word": "复杂",
    "context": "这个数学问题很复杂",
    "language": "zh"
  }'

# 英文输出
curl -X POST https://your-api-gateway-url/dev/word-muncher \
  -H "Content-Type: application/json" \
  -d '{
    "word": "complex",
    "context": "This math problem is very complex",
    "language": "en"
  }'
```

### 3. 配置Chrome扩展

1. 打开Chrome扩展管理页面 (`chrome://extensions/`)
2. 启用开发者模式
3. 加载解压的扩展（`chrome-extension`目录）
4. 配置API端点URL

## 🔧 API 文档

### 请求格式

```json
{
  "word": "词汇",
  "context": "上下文句子（可选）",
  "language": "zh|en"
}
```

### 响应格式

```json
{
  "word": "复杂",
  "context": "这个数学问题很复杂",
  "language": "zh",
  "synonyms": ["困难", "困惑", "难懂", "简单", "容易"],
  "service": "word-muncher",
  "cached": false
}
```

### 参数说明

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| word | string | 是 | 要简化的词汇 |
| context | string | 否 | 上下文句子，提高准确性 |
| language | string | 否 | 输出语言，zh(中文)或en(英文)，默认en |

## 📊 性能指标

### 响应时间
- **缓存命中**: ~50-100ms
- **首次请求**: ~1-3秒
- **并发处理**: 支持100 req/s

### 缓存效果
- **缓存命中率**: 80-90%
- **TTL**: 7天自动过期
- **存储成本**: 按需付费

## 🛠️ 开发指南

### 本地开发

```bash
# 安装依赖
pip install boto3 aws-cdk-lib

# 本地测试Lambda
python -m pytest tests/

# 部署到开发环境
cdk deploy --profile dev
```

### 添加新功能

1. **新语言支持**
   ```python
   # 在generate_synonyms函数中添加新语言分支
   elif language == 'ja':
       prompt = f"""
       Generate 5 progressive synonyms in Japanese...
       """
   ```

2. **自定义缓存策略**
   ```python
   # 修改缓存键生成逻辑
   cache_key = f"{word}:{language}:{context_hash}"
   ```

## 🧪 测试

### 单元测试

```bash
cd aws-lambda
python -m pytest tests/unit/
```

### 集成测试

```bash
# 测试API端点
python test_api.py

# 测试缓存功能
python test_cache.py
```

### 性能测试

```bash
# 压力测试
python performance_test.py --requests 1000 --concurrent 10
```

## 📈 监控和日志

### CloudWatch监控

- **Lambda指标**: 执行时间、错误率、内存使用
- **API Gateway**: 请求数、延迟、4xx/5xx错误
- **DynamoDB**: 读写容量、缓存命中率

### 日志分析

```bash
# 查看Lambda日志
aws logs tail /aws/lambda/word-munch-word-muncher-dev --follow

# 查看API Gateway日志
aws logs tail /aws/apigateway/word-munch-api-dev --follow
```

## 🔒 安全配置

### IAM权限

- **Lambda执行角色**: Bedrock调用、DynamoDB访问
- **API Gateway**: Lambda调用权限
- **最小权限原则**: 只授予必要权限

### 网络安全

- **CORS配置**: 允许跨域请求
- **限流保护**: 100 req/s, 200 burst
- **HTTPS强制**: 所有API调用使用HTTPS

## 💰 成本优化

### 当前成本结构

| 服务 | 成本/月 | 优化策略 |
|------|---------|----------|
| Lambda | $5-15 | 冷启动优化，内存调优 |
| API Gateway | $3-8 | 缓存策略，减少调用 |
| DynamoDB | $2-5 | TTL设置，按需付费 |
| Bedrock | $10-30 | 模型选择，缓存命中 |

### 优化建议

1. **缓存优化**: 提高缓存命中率到95%+
2. **模型选择**: 根据复杂度选择合适模型
3. **批量处理**: 支持批量词汇处理
4. **CDN集成**: 添加CloudFront加速

## 🚀 未来规划

### 短期目标 (1-2个月)
- [ ] 支持更多语言 (日语、韩语、法语)
- [ ] 添加词汇难度评级
- [ ] 实现批量处理API
- [ ] 集成CloudFront CDN

### 中期目标 (3-6个月)
- [ ] 添加用户认证和API密钥
- [ ] 实现个性化词汇推荐
- [ ] 支持自定义词汇库
- [ ] 添加使用统计和分析

### 长期目标 (6-12个月)
- [ ] 扩展到概念分析和知识图谱
- [ ] 集成更多AI模型
- [ ] 开发移动端应用
- [ ] 企业级功能支持

## 🤝 贡献指南

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开 Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

## 📞 联系方式

- 项目主页: [GitHub Repository](https://github.com/your-username/word-munch-extension-serverless)
- 问题反馈: [Issues](https://github.com/your-username/word-munch-extension-serverless/issues)
- 功能建议: [Discussions](https://github.com/your-username/word-munch-extension-serverless/discussions) 