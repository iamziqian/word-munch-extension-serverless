# Word Munch CDK Infrastructure

这是 Word Munch Chrome Extension 后端基础设施的 AWS CDK 项目，使用 Python 编写。

## 🏗️ 项目结构

```
infrastructure/cdk/
├── app.py                          # CDK 应用入口
├── word_munch/
│   └── word_munch_stack.py         # 主栈定义
├── deploy.sh                       # 部署脚本
├── requirements.txt                # Python 依赖
├── setup.py                       # Python 包配置
├── cdk.json                       # CDK 配置
└── README.md                      # 本文档
```

## 🚀 快速开始

### 1. 前置要求

- Python 3.8+
- Node.js 14+
- AWS CLI
- AWS CDK CLI

### 2. 安装依赖

```bash
# 安装 AWS CDK CLI
npm install -g aws-cdk

# 创建并激活虚拟环境
python3 -m venv .venv
source .venv/bin/activate  # Linux/macOS
# 或
.venv\Scripts\activate     # Windows

# 安装 Python 依赖
pip install -r requirements.txt
```

### 3. 配置 AWS 凭证

```bash
# 方法1: 使用 AWS CLI 配置
aws configure

# 方法2: 设置环境变量
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_DEFAULT_REGION=us-east-1
```

### 4. 部署基础设施

```bash
# 使用部署脚本（推荐）
./deploy.sh -e dev -r us-east-1

# 或手动部署
cdk deploy
```

## 📋 部署选项

### 使用部署脚本

```bash
# 基本部署
./deploy.sh

# 指定环境
./deploy.sh -e prod

# 指定区域
./deploy.sh -r us-west-2

# 自定义域名
./deploy.sh -d api.wordmunch.com -c arn:aws:acm:us-east-1:123456789012:certificate/xxx

# 强制部署（跳过确认）
./deploy.sh -f

# 详细输出
./deploy.sh -v

# 查看帮助
./deploy.sh -h
```

### 手动 CDK 命令

```bash
# 合成 CloudFormation 模板
cdk synth

# 显示部署差异
cdk diff

# 部署
cdk deploy

# 销毁资源
cdk destroy

# 列出所有栈
cdk ls
```

## 🏛️ 基础设施组件

### Lambda 函数
- **vocabulary-service**: 词汇服务
- **sentence-service**: 句子服务  
- **paragraph-service**: 段落服务
- **knowledge-graph-service**: 知识图谱服务

### API Gateway
- REST API 端点
- CORS 支持
- 代理集成到 Lambda 函数

### DynamoDB
- 缓存表 (`word-munch-cache-{environment}`)
- 按需计费模式
- TTL 支持

### IAM
- Lambda 执行角色
- DynamoDB 访问权限
- CloudWatch 日志权限

### CloudWatch
- API Gateway 5XX 错误告警
- Lambda 函数错误告警

## 🔧 环境变量

| 变量名 | 默认值 | 描述 |
|--------|--------|------|
| `ENVIRONMENT` | `dev` | 部署环境 |
| `PROJECT_NAME` | `word-munch` | 项目名称 |
| `AWS_REGION` | `us-east-1` | AWS 区域 |
| `DOMAIN_NAME` | `''` | 自定义域名 |
| `CERTIFICATE_ARN` | `''` | SSL 证书 ARN |
| `LAMBDA_CODE_VERSION` | 时间戳 | Lambda 代码版本 |

## 🛠️ 开发

### 添加新的 Lambda 函数

1. 在 `word_munch_stack.py` 中的 `services` 列表添加服务名
2. 在 `aws-lambda/` 目录下创建对应的服务目录
3. 重新部署

### 修改基础设施

1. 编辑 `word_munch_stack.py`
2. 运行 `cdk diff` 查看变更
3. 运行 `cdk deploy` 部署

### 本地测试

```bash
# 合成模板并查看
cdk synth

# 验证模板
aws cloudformation validate-template --template-body file://cdk.out/WordMunchInfrastructure.template.json
```

## 📊 监控和日志

### CloudWatch 日志
- Lambda 函数日志: `/aws/lambda/word-munch-{service}-service-{environment}`
- API Gateway 日志: 通过 CloudWatch 指标

### 告警
- API Gateway 5XX 错误 > 5 次/5分钟
- Lambda 函数错误 > 5 次/5分钟

## 🔒 安全

- 所有资源都有适当的 IAM 权限
- DynamoDB 表使用最小权限原则
- API Gateway 支持 CORS 但无认证（可根据需要添加）

## 🧹 清理

```bash
# 销毁所有资源
cdk destroy

# 或使用部署脚本
./deploy.sh --destroy
```

## 📝 注意事项

1. **数据保护**: DynamoDB 表使用 `RETAIN` 策略，删除栈时不会删除数据
2. **成本优化**: 使用按需计费模式，适合开发环境
3. **版本控制**: Lambda 代码版本使用时间戳，确保每次部署都是新版本
4. **环境隔离**: 不同环境使用不同的资源名称和标签

## 🤝 贡献

1. Fork 项目
2. 创建功能分支
3. 提交更改
4. 推送到分支
5. 创建 Pull Request

## �� 许可证

MIT License
