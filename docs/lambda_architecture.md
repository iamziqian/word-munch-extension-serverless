# Word Munch - AWS Lambda Architecture

Three AWS Lambda functions power a comprehensive text comprehension and vocabulary assistance system:

## 1. Word Muncher Lambda (`word_muncher_lambda.py`)

**Purpose**: Step-by-step vocabulary simplification service

**Functionality**:
- Generates 5 progressive synonyms for complex words (increasingly simple)
- Uses AWS Bedrock with Llama 3 8B model for AI-powered word simplification
- Supports multiple languages (defaults to English)
- Includes context-aware processing for better synonym generation

**Configuration**:
- 30-second timeout, 512MB memory
- Integrates with DynamoDB for caching results
- 7-day cache TTL for performance optimization

## 2. Concept Muncher Lambda (`concept_muncher_lambda.py`)

**Purpose**: Text comprehension analysis service with semantic similarity

**Functionality**:
- Analyzes user understanding of text through semantic similarity
- Performs intelligent text segmentation (phrase-level for single sentences, sentence-level for multiple sentences)
- Uses embeddings to calculate cosine similarity between original text and user understanding
- **Smart Claude Haiku integration**: Only invokes Claude 3 Haiku when similarity score is too low
- Provides detailed feedback and suggestions for improvement
- Asynchronously records cognitive data for profile building

**Configuration**:
- 60-second timeout, 1024MB memory (higher for processing embeddings)
- Tiered caching strategy (30 days for embeddings, 7 days for segments)
- Integrates with cognitive profile service

## 3. Cognitive Profile Lambda (`cognitive_profile_lambda.py`)

**Purpose**: Cognitive profile service for long-term learning analytics

**Functionality**:
- Records and analyzes user comprehension patterns over time
- Builds comprehensive cognitive profiles with metrics like:
  - **Coverage analysis**: how well content is understood
  - **Depth analysis**: thinking level and critical analysis
  - **Accuracy analysis**: misconceptions and partial understandings
  - **Pattern analysis**: learning consistency and improvement potential
- Provides personalized suggestions based on learning patterns
- Tracks Bloom's taxonomy levels and cognitive development

**Configuration**:
- 60-second timeout, 1024MB memory
- 90-day TTL for cognitive data, 24-hour cache for profiles