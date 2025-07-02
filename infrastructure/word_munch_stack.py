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
                "SERVICE_TYPE": "concept-muncher"
            }
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
        
        # DynamoDB Table Name
        CfnOutput(
            self, "CacheTableName",
            value=self.cache_table.table_name,
            description="Cache DynamoDB Table Name",
            export_name=f"{self.project_name}-cache-table-{self.env_name}"
        )

        # ============================================================================
        # CloudWatch Alarms for Lambda, API Gateway, Bedrock
        # ============================================================================

        # Word Muncher Lambda Invocations Alarm
        word_muncher_lambda_invocations_metric = self.word_muncher_lambda.metric_invocations(
            period=Duration.minutes(5),
            statistic="Sum"
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

        # Concept Muncher Lambda Invocations Alarm 
        concept_muncher_lambda_invocations_metric = self.concept_muncher_lambda.metric_invocations(
            period=Duration.minutes(5),
            statistic="Sum"
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

        # API Gateway Invocations Alarm
        api_invoke_metric = cloudwatch.Metric(
            namespace="AWS/WordMunchApiGateway",
            metric_name="Count",
            dimensions_map={
                "ApiName": f"{self.project_name}-api-{self.env_name}"
            },
            period=Duration.minutes(5),
            statistic="Sum"
        )
        api_alarm = cloudwatch.Alarm(
            self, "ApiGatewayInvocationsAlarm",
            metric=api_invoke_metric,
            threshold=100,  # Alarm if more than 100 invocations in 5 minutes
            evaluation_periods=1,
            datapoints_to_alarm=1,
            comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            alarm_description="Alarm when API Gateway invocations exceed 100 in 5 minutes"
        )

        # Bedrock InvocationCount Alarm (global, all models)
        bedrock_metric = cloudwatch.Metric(
            namespace="AWS/WordMunchBedrock",
            metric_name="InvocationCount",
            period=Duration.minutes(5),
            statistic="Sum"
        )
        bedrock_alarm = cloudwatch.Alarm(
            self, "BedrockInvocationAlarm",
            metric=bedrock_metric,
            threshold=100,  # Alarm if more than 100 invocations in 5 minutes
            evaluation_periods=1,
            datapoints_to_alarm=1,
            comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            alarm_description="Alarm when Bedrock invocations exceed 100 in 5 minutes"
        )

        # DynamoDB ConsumedReadCapacityUnits Alarm
        dynamodb_read_metric = cloudwatch.Metric(
            namespace="AWS/DynamoDB",
            metric_name="ConsumedReadCapacityUnits",
            dimensions_map={
                "TableName": self.cache_table.table_name
            },
            period=Duration.minutes(5),
            statistic="Sum"
        )
        dynamodb_read_alarm = cloudwatch.Alarm(
            self, "DynamoDBReadCapacityAlarm",
            metric=dynamodb_read_metric,
            threshold=100,  # Alarm if more than 100 read units in 5 minutes
            evaluation_periods=1,
            datapoints_to_alarm=1,
            comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            alarm_description="Alarm when DynamoDB ConsumedReadCapacityUnits exceed 100 in 5 minutes"
        )

        # DynamoDB ConsumedWriteCapacityUnits Alarm
        dynamodb_write_metric = cloudwatch.Metric(
            namespace="AWS/DynamoDB",
            metric_name="ConsumedWriteCapacityUnits",
            dimensions_map={
                "TableName": self.cache_table.table_name
            },
            period=Duration.minutes(5),
            statistic="Sum"
        )

        dynamodb_write_alarm = cloudwatch.Alarm(
            self, "DynamoDBWriteCapacityAlarm",
            metric=dynamodb_write_metric,
            threshold=500,  # allow normal cache operations but detect abnormal cases
            evaluation_periods=2,  # increase to 2 periods to avoid occasional peak triggers
            datapoints_to_alarm=2,  # need 2 consecutive data points to exceed threshold to alarm
            comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            alarm_description="Alarm when DynamoDB ConsumedWriteCapacityUnits exceed 500 in 10 minutes (2 consecutive periods)"
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
        api_alarm.add_alarm_action(cloudwatch_actions.SnsAction(alarm_topic))
        bedrock_alarm.add_alarm_action(cloudwatch_actions.SnsAction(alarm_topic))
        dynamodb_read_alarm.add_alarm_action(cloudwatch_actions.SnsAction(alarm_topic))
        dynamodb_write_alarm.add_alarm_action(cloudwatch_actions.SnsAction(alarm_topic))

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