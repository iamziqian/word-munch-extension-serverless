import os
from aws_cdk import (
    Stack,
    aws_lambda as _lambda,
    aws_apigateway as apigw,
    aws_dynamodb as ddb,
    aws_iam as iam,
    aws_sqs as sqs,
    aws_lambda_event_sources as lambda_event_sources,
    Duration,
    RemovalPolicy,
    CfnOutput,
    Tags,
    aws_cloudwatch as cloudwatch,
    aws_sns as sns,
    aws_sns_subscriptions as subs,
    aws_cloudwatch_actions as cloudwatch_actions,
    aws_events as events,
    aws_events_targets as targets
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
        #   "cacheKey": "string",     # Necessities: Cache Key (Primary Key)
        #   "data": "string",         # Optional: Cache data
        #   "ttl": "number"           # Optional: Expiration timestamp
        # }

        # {
        #   "userId": "string",       # Necessities: User ID (Primary Key)
        #   "name": "string",         # Optional: User name
        #   "email": "string",        # Optional: User email
        #   "password": "string",     # Optional: User password
        #   "lastLogin": "string",    # Optional: Last login timestamp
        #   "loginAttempts": "number" # Optional: Login attempts
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

        # Users Table for authentication
        self.users_table = ddb.Table(
            self, "UsersTable",
            table_name=f"{self.project_name}-users-{self.env_name}",
            partition_key=ddb.Attribute(
                name="email",
                type=ddb.AttributeType.STRING
            ),
            billing_mode=ddb.BillingMode.PAY_PER_REQUEST,
            removal_policy=RemovalPolicy.DESTROY,
            point_in_time_recovery=True,  # Enable backup for user data
        )
        
        # Add tags
        self._apply_common_tags(self.users_table, {"Purpose": "user-auth"})

        # ============================================================================
        # SQS Queue for Cognitive Data Processing
        # ============================================================================
        
        # Dead Letter Queue for failed cognitive data processing
        self.cognitive_dlq = sqs.Queue(
            self, "CognitiveDLQ",
            queue_name=f"{self.project_name}-cognitive-dlq-{self.env_name}",
            retention_period=Duration.days(14),  # Keep failed messages for 14 days
            visibility_timeout=Duration.seconds(300)
        )
        
        # Main cognitive data processing queue
        self.cognitive_data_queue = sqs.Queue(
            self, "CognitiveDataQueue", 
            queue_name=f"{self.project_name}-cognitive-data-{self.env_name}",
            visibility_timeout=Duration.seconds(300),  # 5 minutes for processing
            retention_period=Duration.days(7),  # Keep messages for 7 days
            dead_letter_queue=sqs.DeadLetterQueue(
                max_receive_count=3,  # Retry failed messages 3 times
                queue=self.cognitive_dlq
            )
        )
        
        # Add tags
        self._apply_common_tags(self.cognitive_data_queue, {"Purpose": "cognitive-processing"})
        self._apply_common_tags(self.cognitive_dlq, {"Purpose": "cognitive-processing-dlq"})

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
                        f"{self.cache_table.table_arn}/index/*",
                        self.users_table.table_arn,
                        f"{self.users_table.table_arn}/index/*"
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

        # SQS Access Policy - Allow Lambda functions to send/receive SQS messages
        sqs_policy = iam.Policy(
            self, "SQSAccessPolicy",
            policy_name="SQSAccess",
            statements=[
                iam.PolicyStatement(
                    effect=iam.Effect.ALLOW,
                    actions=[
                        "sqs:SendMessage",
                        "sqs:ReceiveMessage",
                        "sqs:DeleteMessage",
                        "sqs:GetQueueAttributes"
                    ],
                    resources=[
                        f"arn:aws:sqs:{Stack.of(self).region}:{Stack.of(self).account}:{self.project_name}-*-{self.env_name}"
                    ]
                )
            ]
        )
        # grant lambda role to access SQS
        sqs_policy.attach_to_role(self.lambda_execution_role)

        # CloudWatch Custom Metrics Policy - Allow Lambda functions to send custom metrics
        cloudwatch_policy = iam.Policy(
            self, "CloudWatchCustomMetricsPolicy",
            policy_name="CloudWatchCustomMetrics",
            statements=[
                iam.PolicyStatement(
                    effect=iam.Effect.ALLOW,
                    actions=[
                        "cloudwatch:PutMetricData"
                    ],
                    resources=["*"]
                )
            ]
        )
        # grant lambda role to send custom metrics to CloudWatch
        cloudwatch_policy.attach_to_role(self.lambda_execution_role)

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
        # EventBridge for Lambda Warm-up (Word Muncher)
        # ============================================================================
        
        # Create EventBridge Rule for Word Muncher warm-up
        word_muncher_warmup_rule = events.Rule(
            self, "WordMuncherWarmupRule",
            rule_name=f"{self.project_name}-word-muncher-warmup-{self.env_name}",
            description="Warm-up Word Muncher Lambda every 3 minutes to prevent cold starts",
            schedule=events.Schedule.rate(Duration.minutes(3)),
            enabled=True
        )
        
        # Add Word Muncher Lambda as target
        word_muncher_warmup_rule.add_target(
            targets.LambdaFunction(
                self.word_muncher_lambda,
                event=events.RuleTargetInput.from_object({
                    "warmer": True,
                    "source": "aws.events",
                    "detail-type": "Scheduled Event",
                    "time": events.Schedule.rate(Duration.minutes(3)).expression_string
                })
            )
        )
        
        # Add tags to the warmup rule
        self._apply_common_tags(word_muncher_warmup_rule, {
            "Service": "word-muncher",
            "Purpose": "lambda-warmup"
        })

        print(f"Created EventBridge rule: {word_muncher_warmup_rule.rule_name}")
        print("Word Muncher Lambda will be warmed up every 3 minutes")

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
                "SERVICE_TYPE": "concept-muncher",
                "COGNITIVE_QUEUE_URL": self.cognitive_data_queue.queue_url
            }
        )
        
        # Create Lambda Version for Blue-Green Deployment - default latest version
        self.concept_muncher_version = _lambda.Version(
            self, "ConceptMuncherVersion",
            lambda_=self.concept_muncher_lambda,
            removal_policy=RemovalPolicy.RETAIN  # Keep old versions for rollback
        )
        
        # Create Blue Alias (Production)
        self.concept_muncher_blue_alias = _lambda.Alias(
            self, "ConceptMuncherBlueAlias",
            alias_name="blue",
            version=self.concept_muncher_version # point to latest version
        )
        
        # Create Green Alias (Staging/New Version) - initially points to same version
        self.concept_muncher_green_alias = _lambda.Alias(
            self, "ConceptMuncherGreenAlias",
            alias_name="green",
            version=self.concept_muncher_version # point to latest version
        )
        
        # Create Production Alias - initially 100% traffic goes to blue
        self.concept_muncher_prod_alias = _lambda.Alias(
            self, "ConceptMuncherProdAlias",
            alias_name="prod",
            version=self.concept_muncher_version
        )

        # Add tags
        self._apply_common_tags(self.concept_muncher_lambda, {
            "Service": "concept-muncher",
            "Purpose": "text-comprehension-analysis"
        })

        # ============================================================================
        # EventBridge for Lambda Warm-up (Concept Muncher)
        # ============================================================================
        
        # Create EventBridge Rule for Concept Muncher warm-up
        concept_muncher_warmup_rule = events.Rule(
            self, "ConceptMuncherWarmupRule",
            rule_name=f"{self.project_name}-concept-muncher-warmup-{self.env_name}",
            description="Warm-up Concept Muncher Lambda every 3 minutes to prevent cold starts",
            schedule=events.Schedule.rate(Duration.minutes(3)),
            enabled=True
        )
        
        # Add Concept Muncher Lambda as target
        concept_muncher_warmup_rule.add_target(
            targets.LambdaFunction(
                self.concept_muncher_lambda,
                event=events.RuleTargetInput.from_object({
                    "warmer": True,
                    "source": "aws.events",
                    "detail-type": "Scheduled Event",
                    "time": events.Schedule.rate(Duration.minutes(3)).expression_string
                })
            )
        )
        
        # Add tags to the warmup rule
        self._apply_common_tags(concept_muncher_warmup_rule, {
            "Service": "concept-muncher",
            "Purpose": "lambda-warmup"
        })

        print(f"Created EventBridge rule: {concept_muncher_warmup_rule.rule_name}")
        print("Concept Muncher Lambda will be warmed up every 3 minutes")

        # ============================================================================
        # Lambda Functions - cognitive-profile
        # ============================================================================
        
        # Cognitive Profile Lambda Function
        self.cognitive_profile_lambda = _lambda.Function(
            self, "CognitiveProfileLambda",
            function_name=f"{self.project_name}-cognitive-profile-{self.env_name}",
            description="Cognitive Profile Service for Text Comprehension Analysis",
            runtime=_lambda.Runtime.PYTHON_3_11,
            code=_lambda.Code.from_asset(lambda_dir),
            handler="cognitive_profile_lambda.lambda_handler",
            timeout=Duration.seconds(60),       
            memory_size=1024,
            role=self.lambda_execution_role,
            environment={
                "ENVIRONMENT": self.env_name,
                "PROJECT_NAME": self.project_name,
                "CACHE_TABLE_NAME": self.cache_table.table_name,
                "CACHE_ENABLED": "true",
                "SERVICE_TYPE": "cognitive-profile"
            }
        )
        
        # Add tags
        self._apply_common_tags(self.cognitive_profile_lambda, {
            "Service": "cognitive-profile",
            "Purpose": "cognitive-profile"
        })

        # Add SQS event source to cognitive profile Lambda
        self.cognitive_profile_lambda.add_event_source(
            lambda_event_sources.SqsEventSource(
                self.cognitive_data_queue,
                batch_size=10,  # Process up to 10 messages at once
                max_batching_window=Duration.seconds(5),  # Wait max 5 seconds to fill batch
                report_batch_item_failures=True  # Enable partial batch failure handling
            )
        )

        # ============================================================================
        # Lambda Functions - semantic-search
        # ============================================================================
        
        # Semantic Search Lambda Function
        self.semantic_search_lambda = _lambda.Function(
            self, "SemanticSearchLambda",
            function_name=f"{self.project_name}-semantic-search-{self.env_name}",
            description="Semantic Search Service using Amazon Titan Embeddings v2",
            runtime=_lambda.Runtime.PYTHON_3_11,
            code=_lambda.Code.from_asset(lambda_dir),
            handler="semantic_search_lambda.lambda_handler",
            timeout=Duration.seconds(120),  # A longer timeout time is used for embedding generation
            memory_size=1024,  # More memory for vector calculations
            role=self.lambda_execution_role,
            environment={
                "ENVIRONMENT": self.env_name,
                "PROJECT_NAME": self.project_name,
                "CACHE_TABLE_NAME": self.cache_table.table_name,
                "CACHE_ENABLED": "true",
                "SERVICE_TYPE": "semantic-search"
            }
        )
        
        # Add tags
        self._apply_common_tags(self.semantic_search_lambda, {
            "Service": "semantic-search",
            "Purpose": "embedding-vector-search"
        })

        # ============================================================================
        # Lambda Functions - user-auth
        # ============================================================================

        # Create a Lambda Layer for PyJWT
        pyjwt_layer = _lambda.LayerVersion(
            self, "PyJWTLayer",
            layer_version_name=f"{self.project_name}-pyjwt-layer-{self.env_name}",
            code=_lambda.Code.from_asset(os.path.join(lambda_dir, 'layers', 'jwt-layer')),
            compatible_runtimes=[_lambda.Runtime.PYTHON_3_11],
            description="Layer for PyJWT library"
        )

        # User Authentication Lambda Function
        self.user_auth_lambda = _lambda.Function(
            self, "UserAuthLambda",
            function_name=f"{self.project_name}-user-auth-{self.env_name}",
            description="User Authentication Service",
            runtime=_lambda.Runtime.PYTHON_3_11,
            code=_lambda.Code.from_asset(lambda_dir),
            handler="user_auth_lambda.lambda_handler",
            timeout=Duration.seconds(30),
            memory_size=512,
            environment={
                "ENVIRONMENT": self.env_name,
                "PROJECT_NAME": self.project_name,
                "USERS_TABLE_NAME": self.users_table.table_name,
                "JWT_SECRET": "word-munch-secret-key-change-in-production",
                "JWT_EXPIRY_DAYS": "30"
            },
            role=self.lambda_execution_role,
            layers=[pyjwt_layer]
        )

        # Add tags
        self._apply_common_tags(self.user_auth_lambda, {
            "Service": "user-auth", 
            "Purpose": "authentication"
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
        
        # Integrate with Lambda Prod Alias (for Blue-Green deployment)
        concept_muncher_integration = apigw.LambdaIntegration(
            self.concept_muncher_prod_alias
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

        # Cognitive Profile API Endpoint
        cognitive_profile_resource = self.api.root.add_resource("cognitive-profile")
        
        # Integrate with Lambda function
        cognitive_profile_integration = apigw.LambdaIntegration(
            self.cognitive_profile_lambda
        )

        # POST method for cognitive-profile
        cognitive_profile_resource.add_method(
            "POST",
            cognitive_profile_integration,
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
        print("Created API endpoint: /cognitive-profile")   

        # User Authentication API Endpoint
        user_auth_resource = self.api.root.add_resource("user-auth")
        
        # Integrate with Lambda function
        user_auth_integration = apigw.LambdaIntegration(
            self.user_auth_lambda
        )

        # POST method for user-auth
        user_auth_resource.add_method(
            "POST",
            user_auth_integration,
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
        print("Created API endpoint: /user-auth")

        # Semantic Search API Endpoint
        semantic_search_resource = self.api.root.add_resource("semantic-search")
        
        # Integrate with Lambda function
        semantic_search_integration = apigw.LambdaIntegration(
            self.semantic_search_lambda
        )

        # POST method for semantic-search
        semantic_search_resource.add_method(
            "POST",
            semantic_search_integration,
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
        print("Created API endpoint: /semantic-search")

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
            description="Word Muncher Service URL - Step-by-Step Vocabulary Simplification Service",
            export_name=f"{self.project_name}-word-muncher-url-{self.env_name}"
        )

        # Concept Muncher URL
        CfnOutput(
            self, "ConceptMuncherUrl",
            value=f"{self.api.url}concept-muncher",
            description="Concept Muncher Service URL - Text Comprehension Analysis Service",
            export_name=f"{self.project_name}-concept-muncher-url-{self.env_name}"
        )
        
        # Cognitive Profile URL
        CfnOutput(
            self, "CognitiveProfileUrl",
            value=f"{self.api.url}cognitive-profile",
            description="Cognitive Profile Service URL - User Cognitive Analysis Service",
            export_name=f"{self.project_name}-cognitive-profile-url-{self.env_name}"
        )
        
        # User Authentication URL
        CfnOutput(
            self, "UserAuthUrl",
            value=f"{self.api.url}user-auth",
            description="User Authentication Service URL - Registration and Login Service",
            export_name=f"{self.project_name}-user-auth-url-{self.env_name}"
        )
        
        # Semantic Search URL
        CfnOutput(
            self, "SemanticSearchUrl",
            value=f"{self.api.url}semantic-search",
            description="Semantic Search Service URL - Intelligent Chunk Matching using Amazon Titan Embeddings v2",
            export_name=f"{self.project_name}-semantic-search-url-{self.env_name}"
        )
        
        # DynamoDB Table Name
        CfnOutput(
            self, "CacheTableName",
            value=self.cache_table.table_name,
            description="Cache DynamoDB Table Name",
            export_name=f"{self.project_name}-cache-table-{self.env_name}"
        )
        
        # Users Table Name
        CfnOutput(
            self, "UsersTableName",
            value=self.users_table.table_name,
            description="Users DynamoDB Table Name",
            export_name=f"{self.project_name}-users-table-{self.env_name}"
        )
        
        # Cognitive Data Queue URL
        CfnOutput(
            self, "CognitiveQueueUrl",
            value=self.cognitive_data_queue.queue_url,
            description="Cognitive Data Processing SQS Queue URL",
            export_name=f"{self.project_name}-cognitive-queue-url-{self.env_name}"
        )

        # CloudWatch Dashboard URL
        CfnOutput(
            self, "AnalyticsDashboardUrl",
            value=f"https://console.aws.amazon.com/cloudwatch/home?region={self.region}#dashboards:name={self.project_name}-user-analytics-{self.env_name}",
            description="CloudWatch Analytics Dashboard URL - User Invocation Analytics (Excluding Warm-up)",
            export_name=f"{self.project_name}-analytics-dashboard-url-{self.env_name}"
        )

        # ============================================================================
        # CloudWatch Alarms for Lambda, API Gateway, Bedrock
        # ============================================================================

        # Word Muncher Lambda Invocations Alarm (excluding warm-up)
        word_muncher_lambda_invocations_metric = self.word_muncher_lambda.metric_invocations(
            period=Duration.minutes(5),
            statistic="Sum",
            dimensions_map={
                "warmer": "false"  # Exclude warm-up invocations
            }
        )
        word_muncher_lambda_alarm = cloudwatch.Alarm(
            self, "WordMuncherLambdaInvocationsAlarm",
            metric=word_muncher_lambda_invocations_metric,
            threshold=100,  # Alarm if more than 100 invocations in 5 minutes
            evaluation_periods=1,
            datapoints_to_alarm=1,
            comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            alarm_description="Alarm when Lambda invocations exceed 100 in 5 minutes"
        )

        # Concept Muncher Lambda Invocations Alarm (excluding warm-up)
        concept_muncher_lambda_invocations_metric = self.concept_muncher_lambda.metric_invocations(
            period=Duration.minutes(5),
            statistic="Sum",
            dimensions_map={
                "warmer": "false"  # Exclude warm-up invocations
            }
        )
        concept_muncher_lambda_alarm = cloudwatch.Alarm(
            self, "ConceptMuncherLambdaInvocationsAlarm",
            metric=concept_muncher_lambda_invocations_metric,
            threshold=100,  # Alarm if more than 100 invocations in 5 minutes
            evaluation_periods=1,
            datapoints_to_alarm=1,
            comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            alarm_description="Alarm when Concept Muncher Lambda invocations exceed 100 in 5 minutes"
        )

        # Semantic Search Lambda Invocations Alarm (excluding warm-up)
        semantic_search_lambda_invocations_metric = self.semantic_search_lambda.metric_invocations(
            period=Duration.minutes(5),
            statistic="Sum",
            dimensions_map={
                "warmer": "false"  # Exclude warm-up invocations
            }
        )
        semantic_search_lambda_alarm = cloudwatch.Alarm(
            self, "SemanticSearchLambdaInvocationsAlarm",
            metric=semantic_search_lambda_invocations_metric,
            threshold=50,  # Alarm if more than 50 invocations in 5 minutes (lower threshold due to cost)
            evaluation_periods=1,
            datapoints_to_alarm=1,
            comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            alarm_description="Alarm when Semantic Search Lambda invocations exceed 50 in 5 minutes"
        )

        # =========================================================================
        # SNS Topic for Alarm Notifications
        # =========================================================================
        alarm_topic = sns.Topic(
            self, "AlarmNotificationTopic",
            display_name="Word Munch Alarm Notifications"
        )
        # Subscribe to email
        alarm_topic.add_subscription(subs.EmailSubscription("violetfu0212@gmail.com"))

        # Bind all alarms to SNS Topic
        word_muncher_lambda_alarm.add_alarm_action(cloudwatch_actions.SnsAction(alarm_topic))
        concept_muncher_lambda_alarm.add_alarm_action(cloudwatch_actions.SnsAction(alarm_topic))
        semantic_search_lambda_alarm.add_alarm_action(cloudwatch_actions.SnsAction(alarm_topic))

        # =========================================================================
        # CloudWatch Dashboard for User Invocation Analytics
        # =========================================================================
        
        # Create CloudWatch Dashboard
        dashboard = cloudwatch.Dashboard(
            self, "UserInvocationDashboard",
            dashboard_name=f"{self.project_name}-user-analytics-{self.env_name}",
            period_override=cloudwatch.PeriodOverride.AUTO,
            start="-PT24H"  # Show last 24 hours by default
        )
        
        # Word Muncher User Invocations Widget (excluding warm-up)
        word_muncher_user_invocations_widget = cloudwatch.GraphWidget(
            title="Word Muncher - User Invocations (Excluding Warm-up)",
            left=[
                cloudwatch.Metric(
                    namespace="AWS/Lambda",
                    metric_name="Invocations",
                    dimensions_map={
                        "FunctionName": self.word_muncher_lambda.function_name
                    },
                    statistic="Sum",
                    label="All Invocations"
                ),
                # Create a custom metric to track only user invocations
                cloudwatch.MathExpression(
                    expression="m1",
                    label="User Invocations Only",
                    using_metrics={
                        "m1": cloudwatch.Metric(
                            namespace="WordMunch/Analytics",
                            metric_name="UserInvocations",
                            dimensions_map={
                                "Service": "word-muncher",
                                "Environment": self.env_name
                            },
                            statistic="Sum"
                        )
                    }
                )
            ],
            width=12,
            height=6,
            period=Duration.minutes(5)
        )
        
        # Concept Muncher User Invocations Widget (excluding warm-up)
        concept_muncher_user_invocations_widget = cloudwatch.GraphWidget(
            title="Concept Muncher - User Invocations (Excluding Warm-up)",
            left=[
                cloudwatch.Metric(
                    namespace="AWS/Lambda",
                    metric_name="Invocations", 
                    dimensions_map={
                        "FunctionName": self.concept_muncher_lambda.function_name
                    },
                    statistic="Sum",
                    label="All Invocations"
                ),
                cloudwatch.MathExpression(
                    expression="m1",
                    label="User Invocations Only",
                    using_metrics={
                        "m1": cloudwatch.Metric(
                            namespace="WordMunch/Analytics",
                            metric_name="UserInvocations",
                            dimensions_map={
                                "Service": "concept-muncher",
                                "Environment": self.env_name
                            },
                            statistic="Sum"
                        )
                    }
                )
            ],
            width=12,
            height=6,
            period=Duration.minutes(5)
        )
        
        # Semantic Search User Invocations Widget (excluding warm-up)
        semantic_search_user_invocations_widget = cloudwatch.GraphWidget(
            title="Semantic Search - User Invocations (Excluding Warm-up)",
            left=[
                cloudwatch.Metric(
                    namespace="AWS/Lambda",
                    metric_name="Invocations",
                    dimensions_map={
                        "FunctionName": self.semantic_search_lambda.function_name
                    },
                    statistic="Sum",
                    label="All Invocations"
                ),
                cloudwatch.MathExpression(
                    expression="m1",
                    label="User Invocations Only",
                    using_metrics={
                        "m1": cloudwatch.Metric(
                            namespace="WordMunch/SemanticSearch",
                            metric_name="SemanticSearchInvocations",
                            dimensions_map={
                                "Service": "semantic-search",
                                "Environment": self.env_name
                            },
                            statistic="Sum"
                        )
                    }
                )
            ],
            width=12,
            height=6,
            period=Duration.minutes(5)
        )
        
        # Lambda Duration Comparison Widget
        lambda_duration_widget = cloudwatch.GraphWidget(
            title="Lambda Function Duration Comparison",
            left=[
                cloudwatch.Metric(
                    namespace="AWS/Lambda",
                    metric_name="Duration",
                    dimensions_map={
                        "FunctionName": self.word_muncher_lambda.function_name
                    },
                    statistic="Average",
                    label="Word Muncher Avg Duration"
                ),
                cloudwatch.Metric(
                    namespace="AWS/Lambda", 
                    metric_name="Duration",
                    dimensions_map={
                        "FunctionName": self.concept_muncher_lambda.function_name
                    },
                    statistic="Average",
                    label="Concept Muncher Avg Duration"
                ),
                cloudwatch.Metric(
                    namespace="AWS/Lambda",
                    metric_name="Duration",
                    dimensions_map={
                        "FunctionName": self.semantic_search_lambda.function_name
                    },
                    statistic="Average",
                    label="Semantic Search Avg Duration"
                )
            ],
            width=12,
            height=6,
            period=Duration.minutes(5)
        )
        
        # Error Rate Widget
        lambda_errors_widget = cloudwatch.GraphWidget(
            title="Lambda Function Error Rates",
            left=[
                cloudwatch.Metric(
                    namespace="AWS/Lambda",
                    metric_name="Errors",
                    dimensions_map={
                        "FunctionName": self.word_muncher_lambda.function_name
                    },
                    statistic="Sum",
                    label="Word Muncher Errors"
                ),
                cloudwatch.Metric(
                    namespace="AWS/Lambda",
                    metric_name="Errors", 
                    dimensions_map={
                        "FunctionName": self.concept_muncher_lambda.function_name
                    },
                    statistic="Sum",
                    label="Concept Muncher Errors"
                ),
                cloudwatch.Metric(
                    namespace="AWS/Lambda",
                    metric_name="Errors",
                    dimensions_map={
                        "FunctionName": self.semantic_search_lambda.function_name
                    },
                    statistic="Sum",
                    label="Semantic Search Errors"
                )
            ],
            width=12,
            height=6,
            period=Duration.minutes(5)
        )
        
        # Usage Statistics Widget (Custom Metrics)
        usage_stats_widget = cloudwatch.GraphWidget(
            title="User Activity Statistics",
            left=[
                cloudwatch.Metric(
                    namespace="WordMunch/Analytics",
                    metric_name="AnonymousUsers",
                    dimensions_map={
                        "Environment": self.env_name
                    },
                    statistic="Sum",
                    label="Anonymous User Requests"
                ),
                cloudwatch.Metric(
                    namespace="WordMunch/Analytics", 
                    metric_name="RegisteredUsers",
                    dimensions_map={
                        "Environment": self.env_name
                    },
                    statistic="Sum",
                    label="Registered User Requests"
                ),
                cloudwatch.Metric(
                    namespace="WordMunch/Analytics",
                    metric_name="RateLimitHits",
                    dimensions_map={
                        "Environment": self.env_name
                    },
                    statistic="Sum",
                    label="Rate Limit Hits"
                )
            ],
            width=12,
            height=6,
            period=Duration.minutes(15)
        )
        
        # Semantic Search Specific Metrics Widget
        semantic_search_stats_widget = cloudwatch.GraphWidget(
            title="Semantic Search - User Types & Rate Limiting",
            left=[
                cloudwatch.Metric(
                    namespace="WordMunch/SemanticSearch",
                    metric_name="AnonymousUsers",
                    dimensions_map={
                        "Service": "semantic-search",
                        "Environment": self.env_name
                    },
                    statistic="Sum",
                    label="Anonymous User Searches"
                ),
                cloudwatch.Metric(
                    namespace="WordMunch/SemanticSearch",
                    metric_name="RegisteredUsers",
                    dimensions_map={
                        "Service": "semantic-search",
                        "Environment": self.env_name
                    },
                    statistic="Sum",
                    label="Registered User Searches"
                ),
                cloudwatch.Metric(
                    namespace="WordMunch/SemanticSearch",
                    metric_name="RateLimitHits",
                    dimensions_map={
                        "Service": "semantic-search",
                        "Environment": self.env_name
                    },
                    statistic="Sum",
                    label="Rate Limit Hits (Anonymous)"
                )
            ],
            width=12,
            height=6,
            period=Duration.minutes(15)
        )
        
        # Add widgets to dashboard
        dashboard.add_widgets(
            word_muncher_user_invocations_widget,
            concept_muncher_user_invocations_widget,
            semantic_search_user_invocations_widget,
            lambda_duration_widget,
            lambda_errors_widget,
            usage_stats_widget,
            semantic_search_stats_widget
        )
        
        # Add tags to dashboard
        self._apply_common_tags(dashboard, {
            "Purpose": "user-analytics",
            "Service": "monitoring"
        })

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