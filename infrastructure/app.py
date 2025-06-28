#!/usr/bin/env python3
"""
Word Munch CDK Application
Chrome Extension Backend Infrastructure
"""

import os
from aws_cdk import App, Environment
from word_munch_stack import WordMunchStack

app = App()

# Get environment variables or use default values
environment = os.getenv('ENVIRONMENT', 'dev')
project_name = os.getenv('PROJECT_NAME', 'word-munch')
aws_region = os.getenv('AWS_REGION', 'us-east-1')
aws_account = os.getenv('AWS_ACCOUNT_ID', '302263048692')  # 使用实际的AWS账户ID

# Create aws environment
aws_env = Environment(
    account=aws_account,
    region=aws_region
)

# Create main stack
WordMunchStack(
    app, 
    f"{project_name}-infrastructure",
    environment=environment,
    project_name=project_name,
    env=aws_env,
    description=f"Word Munch Chrome Extension Backend Infrastructure - {environment.upper()} Environment"
)

# Add tags to the entire application
app.node.add_metadata("Project", project_name)
app.node.add_metadata("Environment", environment)
app.node.add_metadata("ManagedBy", "CDK")

app.synth()
