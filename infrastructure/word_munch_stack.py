import os
from aws_cdk import (
    Stack,
    aws_lambda as _lambda,
    aws_apigateway as apigw,
    aws_dynamodb as ddb,
    aws_iam as iam,
    Duration,
    RemovalPolicy,
    CfnOutput,
    Tags,
)
from constructs import Construct
from datetime import datetime


class WordMunchStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        # Get parameters from kwargs, use default values if not provided
        self.env_name = kwargs.pop('environment', 'dev')
        self.project_name = kwargs.pop('project_name', 'word-munch')
        
        super().__init__(scope, construct_id, **kwargs)

        # Get project root directory path and lambda directory path
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        lambda_dir = os.path.join(project_root, 'aws-lambda')

        # ============================================================================
        # DynamoDB Tables
        # {
        #   "cacheKey": "string",     # 必需：缓存键（主键）
        #   "data": "string",         # 可选：缓存数据
        #   "ttl": "number"           # 可选：过期时间戳
        # }
        # ============================================================================
        
        self.cache_table = ddb.Table(
            self, "CacheTable",
            table_name=f"{self.project_name}-cache-{self.env_name}",
            partition_key=ddb.Attribute(
                name="cacheKey",
                type=ddb.AttributeType.STRING
            ),
            billing_mode=ddb.BillingMode.PAY_PER_REQUEST,
            time_to_live_attribute="ttl",
            removal_policy=RemovalPolicy.DESTROY,
        )
        
        # Add tags
        self._apply_common_tags(self.cache_table, {"Purpose": "cache"})

        # ============================================================================
        # IAM Roles and Policies
        # ============================================================================
        
        # DynamoDB Access Policy
        dynamodb_policy = iam.Policy(
            self, "DynamoDBAccessPolicy",
            policy_name="DynamoDBAccess",
            statements=[
                iam.PolicyStatement(
                    effect=iam.Effect.ALLOW,
                    actions=[
                        "dynamodb:GetItem",
                        "dynamodb:PutItem",
                        "dynamodb:UpdateItem",
                        "dynamodb:DeleteItem",
                        "dynamodb:Query",
                        "dynamodb:Scan",
                        "dynamodb:BatchWriteItem",
                        "dynamodb:DescribeTable",
                    ],
                    resources=[
                        self.cache_table.table_arn,
                        f"{self.cache_table.table_arn}/index/*"
                    ]
                )
            ]
        )

        # Lambda Execution Role
        self.lambda_execution_role = iam.Role(
            self, "LambdaExecutionRole",
            role_name=f"{self.project_name}-lambda-execution-role-{self.env_name}",
            assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
            managed_policies=[
                iam.ManagedPolicy.from_aws_managed_policy_name("service-role/AWSLambdaBasicExecutionRole"), # cloudwatch logs
            ]
        )
        # grant lambda role to access dynamodb
        dynamodb_policy.attach_to_role(self.lambda_execution_role)

        # Bedrock Access Policy
        bedrock_policy = iam.Policy(
            self, "BedrockAccessPolicy",
            policy_name="BedrockAccess",
            statements=[
                iam.PolicyStatement(
                    effect=iam.Effect.ALLOW,
                    actions=[
                        "bedrock:InvokeModel",
                        "bedrock:InvokeModelWithResponseStream"
                    ],
                    resources=["arn:aws:bedrock:us-east-1::foundation-model/*"]
                )
            ]
        )
        # grant lambda role to access bedrock
        bedrock_policy.attach_to_role(self.lambda_execution_role)

        # ============================================================================
        # Lambda Functions - word-muncher
        # ============================================================================
        
        # Word Muncher Lambda Function
        self.word_muncher_lambda = _lambda.Function(
            self, "WordMuncherLambda",
            function_name=f"{self.project_name}-word-muncher-{self.env_name}",
            description="Word Muncher Step-by-Step Vocabulary Simplification Service",
            runtime=_lambda.Runtime.PYTHON_3_11,
            code=_lambda.Code.from_asset(lambda_dir),
            handler="word_muncher_lambda.lambda_handler",
            timeout=Duration.seconds(30),
            memory_size=512,
            role=self.lambda_execution_role,
            environment={
                "ENVIRONMENT": self.env_name,
                "PROJECT_NAME": self.project_name,
                "CACHE_TABLE_NAME": self.cache_table.table_name,
                "CACHE_ENABLED": "true",
                "SERVICE_TYPE": "word-muncher"
            }
        )
        
        # Add tags
        self._apply_common_tags(self.word_muncher_lambda, {
            "Service": "word-muncher",
            "Purpose": "vocabulary-simplification"
        })

        # ============================================================================
        # Lambda Functions - concept-muncher
        # ============================================================================

        # Concept Muncher Lambda Function
        self.concept_muncher_lambda = _lambda.Function(
            self, "ConceptMuncherLambda",
            function_name=f"{self.project_name}-concept-muncher-{self.env_name}",
            description="Concept Muncher Text Comprehension Analysis Service with Semantic Similarity",
            runtime=_lambda.Runtime.PYTHON_3_11,
            code=_lambda.Code.from_asset(lambda_dir),
            handler="concept_muncher_lambda.lambda_handler",
            timeout=Duration.seconds(60), # Increase timeout for longer processing
            memory_size=1024, # Increase memory for processing embedded vector calculations
            role=self.lambda_execution_role,
            environment={
                "ENVIRONMENT": self.env_name,
                "PROJECT_NAME": self.project_name,
                "CACHE_TABLE_NAME": self.cache_table.table_name,
                "CACHE_ENABLED": "true",
                "SERVICE_TYPE": "concept-muncher"
            }
        )

        # Add tags
        self._apply_common_tags(self.concept_muncher_lambda, {
            "Service": "concept-muncher",
            "Purpose": "text-comprehension-analysis"
        })

        # ============================================================================
        # API Gateway
        # 1. trigger lambda function
        # 2. traffic: CORS, Throttling, Validation
        # ============================================================================
        
        # Create API Gateway
        self.api = apigw.RestApi(
            self, "WordMunchAPI",
            rest_api_name=f"{self.project_name}-api-{self.env_name}",
            description="Word Munch AI Services API",
            default_cors_preflight_options=apigw.CorsOptions( # CORS policy
                allow_origins=apigw.Cors.ALL_ORIGINS, # allow all origins
                allow_methods=apigw.Cors.ALL_METHODS, # allow all methods
                allow_headers=["Content-Type", "Authorization"], # allow headers
                max_age=Duration.seconds(300) # max age
            ),
            deploy_options=apigw.StageOptions( # Throttling policy
                stage_name=self.env_name,
                throttling_rate_limit=100, # 100 requests per second
                throttling_burst_limit=200, # 200 requests per second
                metrics_enabled=True # enable metrics
            )
        )
        
        # Add tags
        self._apply_common_tags(self.api, {"Purpose": "api-gateway"})

        # ============================================================================
        # API Gateway Resources and Methods
        # ============================================================================
        
        # Word Muncher API Endpoint
        word_muncher_resource = self.api.root.add_resource("word-muncher")
        
        # Integrate with Lambda function
        word_muncher_integration = apigw.LambdaIntegration(
            self.word_muncher_lambda
        )
        
        # POST method for word-muncher
        word_muncher_resource.add_method(
            "POST",
            word_muncher_integration,
            authorization_type=apigw.AuthorizationType.NONE, # no authorization
            api_key_required=False,
            request_models={
                "application/json": apigw.Model.EMPTY_MODEL
            },
            method_responses=[
                apigw.MethodResponse(
                    status_code="200",
                    response_models={
                        "application/json": apigw.Model.EMPTY_MODEL
                    }
                ),
                apigw.MethodResponse(
                    status_code="400", # client error
                    response_models={
                        "application/json": apigw.Model.ERROR_MODEL
                    }
                ),
                apigw.MethodResponse(
                    status_code="500", # server error
                    response_models={
                        "application/json": apigw.Model.ERROR_MODEL
                    }
                )
            ]
        )
        print("Created API endpoint: /word-muncher")

        # Concept Muncher API Endpoint
        concept_muncher_resource = self.api.root.add_resource("concept-muncher")
        
        # Integrate with Lambda function
        concept_muncher_integration = apigw.LambdaIntegration(
            self.concept_muncher_lambda
        )

        # POST method for concept-muncher
        concept_muncher_resource.add_method(
            "POST",
            concept_muncher_integration,
            authorization_type=apigw.AuthorizationType.NONE, # no authorization
            api_key_required=False,
            request_models={
                "application/json": apigw.Model.EMPTY_MODEL
            },
            method_responses=[
                apigw.MethodResponse(
                    status_code="200",
                    response_models={
                        "application/json": apigw.Model.EMPTY_MODEL
                    }
                ),
                apigw.MethodResponse(
                    status_code="400", # client error
                    response_models={
                        "application/json": apigw.Model.ERROR_MODEL
                    }
                ),
                apigw.MethodResponse(
                    status_code="500", # server error
                    response_models={
                        "application/json": apigw.Model.ERROR_MODEL
                    }
                )
            ]
        )
        print("Created API endpoint: /concept-muncher")

        # ============================================================================
        # Outputs
        # ============================================================================
        
        # API Gateway URL
        CfnOutput(
            self, "ApiGatewayUrl",
            value=self.api.url,
            description="API Gateway URL",
            export_name=f"{self.project_name}-api-url-{self.env_name}"
        )
        
        # Word Muncher URL
        CfnOutput(
            self, "WordMuncherUrl",
            value=f"{self.api.url}word-muncher",
            description="Word Muncher Service URL - 递进式词汇简化服务",
            export_name=f"{self.project_name}-word-muncher-url-{self.env_name}"
        )

        # Concept Muncher URL
        CfnOutput(
            self, "ConceptMuncherUrl",
            value=f"{self.api.url}concept-muncher",
            description="Concept Muncher Service URL - 文本理解程度分析服务",
            export_name=f"{self.project_name}-concept-muncher-url-{self.env_name}"
        )
        
        # DynamoDB表名
        CfnOutput(
            self, "CacheTableName",
            value=self.cache_table.table_name,
            description="Cache DynamoDB Table Name",
            export_name=f"{self.project_name}-cache-table-{self.env_name}"
        ) 


    def _apply_common_tags(self, resource, additional_tags=None):
        """Apply common tags to a resource"""
        common_tags = {
            "Environment": self.env_name,
            "Project": self.project_name,
            "CostCenter": "AI-Services",
            "ManagedBy": "CDK",
            "CreatedDate": datetime.now().strftime('%Y-%m-%d')
        }
        
        # Add additional tags if provided
        if additional_tags:
            common_tags.update(additional_tags)
        
        # Apply all tags
        for key, value in common_tags.items():
            Tags.of(resource).add(key, value) 