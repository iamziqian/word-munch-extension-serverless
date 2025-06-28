#!/bin/bash

# Word Munch CDK 部署脚本
# 使用 AWS CDK 部署基础设施

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 配置变量
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
PROJECT_NAME="word-munch"
STACK_NAME="word-munch-infrastructure"

# 默认值
ENVIRONMENT="dev"
REGION="us-east-1"
DOMAIN_NAME=""
CERTIFICATE_ARN=""
FORCE_DEPLOY=false
SKIP_LAMBDA=false
SKIP_TESTS=false
VERBOSE=false
DEPLOY_MODE="full" # full, lambda-only, infrastructure-only, quick

# 打印带颜色的消息
print_message() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_header() {
    echo -e "${BLUE}================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}================================${NC}"
}

print_section() {
    echo -e "${CYAN}--- $1 ---${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_failure() {
    echo -e "${RED}✗ $1${NC}"
}

# 显示帮助信息
show_help() {
    echo ""
    echo -e "${BLUE}Word Munch CDK 部署脚本${NC}"
    echo ""
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  -e, --environment ENV     部署环境 (dev|staging|prod) [默认: dev]"
    echo "  -r, --region REGION       AWS区域 [默认: us-east-1]"
    echo "  -d, --domain DOMAIN       自定义域名 (可选)"
    echo "  -c, --certificate ARN     证书ARN (可选)"
    echo "  -f, --force               强制部署，跳过确认"
    echo "  -v, --verbose             详细输出"
    echo "  -h, --help                显示此帮助信息"
    echo ""
    echo "示例:"
    echo "  $0 -e dev -r us-east-1"
    echo "  $0 -e prod -d api.wordmunch.com -c arn:aws:acm:us-east-1:123456789012:certificate/xxx"
    echo ""
}

# 解析命令行参数
parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -e|--environment)
                ENVIRONMENT="$2"
                shift 2
                ;;
            -r|--region)
                REGION="$2"
                shift 2
                ;;
            -d|--domain)
                DOMAIN_NAME="$2"
                shift 2
                ;;
            -c|--certificate)
                CERTIFICATE_ARN="$2"
                shift 2
                ;;
            -f|--force)
                FORCE_DEPLOY=true
                shift
                ;;
            -v|--verbose)
                VERBOSE=true
                shift
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                print_error "未知参数: $1"
                show_help
                exit 1
                ;;
        esac
    done
}

# 检查AWS CLI是否安装
check_aws_cli() {
    print_section "检查 AWS CLI 安装"
    
    if ! command -v aws &> /dev/null; then
        print_failure "AWS CLI 未安装"
        echo ""
        echo -e "${RED}错误: AWS CLI 未安装或不在 PATH 中${NC}"
        echo ""
        echo "请安装 AWS CLI:"
        echo "  macOS: brew install awscli"
        echo "  Ubuntu: sudo apt install awscli"
        echo "  Windows: 下载并安装 AWS CLI MSI 安装程序"
        exit 1
    fi
    
    local aws_version=$(aws --version 2>/dev/null | cut -d' ' -f1)
    if [ -n "$aws_version" ]; then
        print_success "AWS CLI 已安装: $aws_version"
    else
        print_success "AWS CLI 已安装"
    fi
}

# 检查CDK CLI是否安装
check_cdk_cli() {
    print_section "检查 AWS CDK CLI 安装"
    
    if ! command -v cdk &> /dev/null; then
        print_failure "AWS CDK CLI 未安装"
        echo ""
        echo -e "${RED}错误: AWS CDK CLI 未安装或不在 PATH 中${NC}"
        echo ""
        echo "请安装 AWS CDK CLI:"
        echo "  npm install -g aws-cdk"
        exit 1
    fi
    
    local cdk_version=$(cdk --version 2>/dev/null)
    if [ -n "$cdk_version" ]; then
        print_success "AWS CDK CLI 已安装: $cdk_version"
    else
        print_success "AWS CDK CLI 已安装"
    fi
}

# 检查AWS凭证配置
check_aws_credentials() {
    print_section "检查 AWS 凭证配置"
    
    if ! aws sts get-caller-identity &> /dev/null; then
        print_failure "AWS 凭证未配置或无效"
        echo ""
        echo -e "${RED}错误: 无法验证 AWS 凭证${NC}"
        echo ""
        echo "请配置 AWS 凭证:"
        echo "  aws configure"
        echo "  或设置环境变量:"
        echo "    export AWS_ACCESS_KEY_ID=your_access_key"
        echo "    export AWS_SECRET_ACCESS_KEY=your_secret_key"
        echo "    export AWS_DEFAULT_REGION=$REGION"
        exit 1
    fi
    
    local account_id=$(aws sts get-caller-identity --query Account --output text)
    local user_arn=$(aws sts get-caller-identity --query Arn --output text)
    
    print_success "AWS 凭证验证成功"
    print_message "账户 ID: $account_id"
    print_message "用户 ARN: $user_arn"
}

# 激活Python虚拟环境
activate_venv() {
    print_section "激活 Python 虚拟环境"
    
    if [ ! -d "$SCRIPT_DIR/.venv" ]; then
        print_failure "虚拟环境不存在"
        echo ""
        echo -e "${RED}错误: 虚拟环境未创建${NC}"
        echo ""
        echo "请先创建虚拟环境:"
        echo "  cd $SCRIPT_DIR"
        echo "  python3 -m venv .venv"
        echo "  source .venv/bin/activate"
        echo "  pip install -r requirements.txt"
        exit 1
    fi
    
    source "$SCRIPT_DIR/.venv/bin/activate"
    print_success "虚拟环境已激活"
}

# 安装依赖
install_dependencies() {
    print_section "安装 Python 依赖"
    
    if [ ! -f "$SCRIPT_DIR/requirements.txt" ]; then
        print_failure "requirements.txt 文件不存在"
        exit 1
    fi
    
    pip install -r requirements.txt
    print_success "依赖安装完成"
}

# 设置环境变量
setup_environment() {
    print_section "设置环境变量"
    
    export ENVIRONMENT="$ENVIRONMENT"
    export PROJECT_NAME="$PROJECT_NAME"
    export DOMAIN_NAME="$DOMAIN_NAME"
    export CERTIFICATE_ARN="$CERTIFICATE_ARN"
    export AWS_REGION="$REGION"
    export LAMBDA_CODE_VERSION="$(date +%Y%m%d-%H%M%S)"
    
    print_message "环境: $ENVIRONMENT"
    print_message "项目: $PROJECT_NAME"
    print_message "区域: $REGION"
    print_message "Lambda代码版本: $LAMBDA_CODE_VERSION"
    
    if [ -n "$DOMAIN_NAME" ]; then
        print_message "自定义域名: $DOMAIN_NAME"
    fi
    
    if [ -n "$CERTIFICATE_ARN" ]; then
        print_message "证书ARN: $CERTIFICATE_ARN"
    fi
}

# 合成CloudFormation模板
synthesize_template() {
    print_section "合成 CloudFormation 模板"
    
    cd "$SCRIPT_DIR"
    
    if [ "$VERBOSE" = true ]; then
        cdk synth --verbose
    else
        cdk synth
    fi
    
    print_success "CloudFormation 模板合成完成"
}

# 显示部署差异
show_diff() {
    print_section "显示部署差异"
    
    cd "$SCRIPT_DIR"
    
    if cdk diff &> /dev/null; then
        print_message "检测到基础设施变更:"
        cdk diff
    else
        print_message "未检测到基础设施变更"
    fi
}

# 确认部署
confirm_deployment() {
    if [ "$FORCE_DEPLOY" = true ]; then
        return 0
    fi
    
    echo ""
    echo -e "${YELLOW}即将部署到 AWS 账户:${NC}"
    aws sts get-caller-identity --query 'Account' --output text
    echo ""
    echo -e "${YELLOW}部署环境:${NC} $ENVIRONMENT"
    echo -e "${YELLOW}部署区域:${NC} $REGION"
    echo -e "${YELLOW}栈名称:${NC} $STACK_NAME"
    echo ""
    
    read -p "确认部署? (y/N): " -n 1 -r
    echo ""
    
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_warning "部署已取消"
        exit 0
    fi
}

# 部署基础设施
deploy_infrastructure() {
    print_section "部署基础设施"
    
    cd "$SCRIPT_DIR"
    
    if [ "$VERBOSE" = true ]; then
        cdk deploy --require-approval never --verbose
    else
        cdk deploy --require-approval never
    fi
    
    print_success "基础设施部署完成"
}

# 显示部署结果
show_deployment_results() {
    print_section "部署结果"
    
    cd "$SCRIPT_DIR"
    
    # 获取API Gateway URL
    local api_url=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --query 'Stacks[0].Outputs[?OutputKey==`ApiGatewayUrl`].OutputValue' \
        --output text 2>/dev/null || echo "N/A")
    
    # 获取DynamoDB表名
    local table_name=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --query 'Stacks[0].Outputs[?OutputKey==`CacheTableName`].OutputValue' \
        --output text 2>/dev/null || echo "N/A")
    
    echo ""
    echo -e "${GREEN}✓ 部署成功!${NC}"
    echo ""
    echo -e "${BLUE}部署信息:${NC}"
    echo "  栈名称: $STACK_NAME"
    echo "  环境: $ENVIRONMENT"
    echo "  区域: $REGION"
    echo ""
    echo -e "${BLUE}资源信息:${NC}"
    echo "  API Gateway URL: $api_url"
    echo "  DynamoDB 表: $table_name"
    echo ""
    echo -e "${BLUE}Lambda 函数:${NC}"
    for service in vocabulary sentence paragraph knowledge-graph; do
        local function_name="${PROJECT_NAME}-${service}-service-${ENVIRONMENT}"
        echo "  $service: $function_name"
    done
    echo ""
    echo -e "${BLUE}下一步:${NC}"
    echo "  1. 测试 API Gateway 端点"
    echo "  2. 验证 Lambda 函数"
    echo "  3. 检查 CloudWatch 日志"
    echo ""
}

# 主函数
main() {
    print_header "Word Munch CDK 部署"
    
    # 解析命令行参数
    parse_arguments "$@"
    
    # 检查前置条件
    check_aws_cli
    check_cdk_cli
    check_aws_credentials
    
    # 设置环境
    activate_venv
    install_dependencies
    setup_environment
    
    # 合成模板
    synthesize_template
    
    # 显示差异
    show_diff
    
    # 确认部署
    confirm_deployment
    
    # 部署基础设施
    deploy_infrastructure
    
    # 显示结果
    show_deployment_results
    
    print_header "部署完成"
}

# 执行主函数
main "$@" 