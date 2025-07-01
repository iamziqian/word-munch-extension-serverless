#!/usr/bin/env python3
"""
Word Munch CDK Application
Chrome Extension Backend Infrastructure
"""

import os
from pathlib import Path
from aws_cdk import App, Environment
from word_munch_stack import WordMunchStack

# Load environment variables from .env file
def load_env_file():
    env_file = Path(__file__).parent / '.env'
    if env_file.exists():
        with open(env_file, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ[key] = value

# Load .env file
load_env_file()

app = App()

# Get environment variables or use default values
environment = os.getenv('ENVIRONMENT', 'dev')
project_name = os.getenv('PROJECT_NAME', 'word-munch')
aws_region = os.getenv('AWS_REGION', 'us-east-1')
aws_account = os.getenv('AWS_ACCOUNT_ID', 'YOUR_AWS_ACCOUNT_ID_HERE')  # Please replace it with your AWS account ID.

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
