# Word Munch 新架构文档

## 概述

Word Munch 已重新设计为3个核心服务架构，提供更专业、更高效的AI辅助阅读体验。

## 新架构设计

### 🎯 核心服务

#### 1. Word Muncher Service
**功能**: 智能词汇简化
- 用户点击/选中难词
- 提供同义词替换
- 支持递进式简化（简化→更简化）
- 实时显示在原文位置

**API端点**: `/word-muncher`
**Prompt类型**:
- `default`: 基础词汇简化
- `progressive`: 递进式简化
- `contextual`: 上下文感知简化

#### 2. Concept Muncher Service
**功能**: 概念三要素分析
- 输入：用户选中的句子或者段落
- 输出结构化数据：
```json
{
  "subject": "主题-谁是主角",
  "attributes": ["属性1", "属性2", "属性3"],
  "summary": "一句话完整总结"
}
```

**API端点**: `/concept-muncher`
**Prompt类型**:
- `default`: 通用概念分析
- `technical`: 技术概念分析
- `educational`: 教育概念分析

#### 3. Concept Weaver Service
**功能**: 动态知识关联网络
- 基于当前概念生成知识关联网络
- 类型归类：NoSQL → Key-Value store
- 关联概念：MongoDB、Aurora、CAP定理
- 属性摘要：schema-less、可扩展、高性能
- 支持点击跳转，动态扩展知识网络

**API端点**: `/concept-weaver`
**Prompt类型**:
- `default`: 默认知识关联
- `hierarchical`: 层次化知识组织
- `network`: 网络化知识图谱

## 项目结构

```
aws-lambda/
├── word-muncher/           # 词汇简化服务
│   └── index.py
├── concept-muncher/        # 概念分析服务
│   └── index.py
├── concept-weaver/         # 知识关联服务
│   └── index.py
└── shared/
    ├── ai_client.py        # 通用AI客户端
    ├── bedrock_client.py   # AWS Bedrock客户端
    ├── model_selector.py   # 智能模型选择器
    ├── prompt_templates.py # 专业Prompt模板
    ├── cache.py           # 缓存模块
    └── requirements.txt   # 依赖列表
```

## 技术特性

### 🤖 AI模型选择
- **智能模型选择**: 根据任务复杂度自动选择最适合的Bedrock模型
- **成本优化**: 简单任务使用低成本模型，复杂任务使用高性能模型
- **多模型支持**: Llama 3、Titan、Claude 3系列

### 📝 Prompt工程
- **专业化模板**: 每个服务都有针对性的Prompt模板
- **多类型支持**: 支持不同场景的Prompt变体
- **格式标准化**: 确保AI响应格式的一致性

### 💾 缓存机制
- **智能缓存**: 基于输入内容的哈希缓存
- **TTL控制**: 不同服务使用不同的缓存时间
- **性能优化**: 减少重复AI调用，降低成本

### 🔍 监控告警
- **CloudWatch监控**: 错误率、执行时间、并发数监控
- **SNS告警**: 异常情况实时通知
- **性能指标**: 详细的性能分析

## API使用示例

### Word Muncher
```bash
curl -X POST https://your-api-gateway-url/word-muncher \
  -H "Content-Type: application/json" \
  -d '{
    "word": "sophisticated",
    "options": {
      "prompt_type": "default"
    }
  }'
```

### Concept Muncher
```bash
curl -X POST https://your-api-gateway-url/concept-muncher \
  -H "Content-Type: application/json" \
  -d '{
    "text": "DynamoDB is a fully managed NoSQL database service provided by AWS.",
    "options": {
      "prompt_type": "technical"
    }
  }'
```

### Concept Weaver
```bash
curl -X POST https://your-api-gateway-url/concept-weaver \
  -H "Content-Type: application/json" \
  -d '{
    "concept": "DynamoDB",
    "options": {
      "prompt_type": "default"
    }
  }'
```

## 部署指南

### 前置要求
- AWS CLI 配置
- AWS CDK 安装
- Python 3.11+
- 适当的AWS权限

### 快速部署
```bash
# 进入基础设施目录
cd infrastructure

# 运行部署脚本
./deploy_new_architecture.sh deploy

# 或者分步执行
./deploy_new_architecture.sh deploy
```

### 测试服务
```bash
# 测试所有服务
./deploy_new_architecture.sh test

# 或者手动测试
python3 test_new_architecture.py "your-api-gateway-url"
```

### 清理资源
```bash
# 清理所有资源
./deploy_new_architecture.sh cleanup
```

## 配置说明

### 环境变量
- `ENVIRONMENT`: 部署环境 (dev/prod)
- `PROJECT_NAME`: 项目名称
- `CACHE_TABLE_NAME`: DynamoDB缓存表名
- `LAMBDA_CODE_VERSION`: Lambda代码版本

### 服务配置
每个服务都有独立的配置：
- **超时时间**: 30秒
- **内存大小**: 512MB
- **并发限制**: 10个并发执行
- **缓存时间**: 1-4小时（根据服务类型）

## 监控和日志

### CloudWatch指标
- **错误率**: 监控服务错误
- **执行时间**: 监控性能
- **并发数**: 监控负载

### 日志位置
- Lambda函数日志: CloudWatch Logs
- API Gateway日志: CloudWatch Logs
- 应用日志: Lambda函数内部日志

## 故障排除

### 常见问题

1. **AI服务调用失败**
   - 检查Bedrock权限
   - 验证模型可用性
   - 检查网络连接

2. **缓存不工作**
   - 检查DynamoDB权限
   - 验证表名配置
   - 检查TTL设置

3. **API响应慢**
   - 检查Lambda内存配置
   - 监控并发执行数
   - 优化Prompt长度

### 调试命令
```bash
# 查看Lambda日志
aws logs tail /aws/lambda/word-munch-word-muncher-dev --follow

# 查看API Gateway日志
aws logs tail /aws/apigateway/word-munch-api-dev --follow

# 测试健康检查
curl https://your-api-gateway-url/word-muncher/health
```

## 版本历史

### v2.0.0 (新架构)
- ✅ 重构为3个核心服务
- ✅ 优化Prompt工程
- ✅ 智能模型选择
- ✅ 增强缓存机制
- ✅ 完善监控告警

### 未来计划
- 🔄 Chrome Extension集成
- 🔄 前端UI重新设计
- 🔄 更多AI模型支持
- 🔄 高级缓存策略

## 贡献指南

1. Fork项目
2. 创建功能分支
3. 提交更改
4. 创建Pull Request

## 许可证

MIT License 