import boto3
import json
import os
import logging
import time
from botocore.exceptions import ClientError
from typing import Optional, Dict, Any

# Configure logger
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Configure the environment variables
ENVIRONMENT = os.getenv('ENVIRONMENT')
PROJECT_NAME = os.getenv('PROJECT_NAME')
CACHE_TABLE_NAME = os.getenv('CACHE_TABLE_NAME')
SERVICE_TYPE = os.getenv('SERVICE_TYPE')

# Cache configuration
CACHE_ENABLED = os.getenv('CACHE_ENABLED', 'true').lower() == 'true'
CACHE_TTL = 604800   # 7 days in seconds

# Global variables for lazy loading - initialized as None
_bedrock_client = None
_dynamodb_resource = None
_cache_table = None

def get_bedrock_client():
    """Lazy load Bedrock client with connection reuse"""
    global _bedrock_client
    if _bedrock_client is None:
        logger.info("Initializing Bedrock client (lazy loading)...")
        _bedrock_client = boto3.client("bedrock-runtime", region_name="us-east-1")
        logger.info("Bedrock client initialized successfully")
    return _bedrock_client

def get_dynamodb_resource():
    """Lazy load DynamoDB resource with connection reuse"""
    global _dynamodb_resource
    if _dynamodb_resource is None:
        logger.info("Initializing DynamoDB resource (lazy loading)...")
        _dynamodb_resource = boto3.resource('dynamodb')
        logger.info("DynamoDB resource initialized successfully")
    return _dynamodb_resource

def get_cache_table():
    """Lazy load cache table with connection reuse"""
    global _cache_table
    if _cache_table is None:
        logger.info("Initializing cache table (lazy loading)...")
        dynamodb = get_dynamodb_resource()
        table_name = CACHE_TABLE_NAME or 'word-munch-cache'
        _cache_table = dynamodb.Table(table_name)
        logger.info(f"Cache table '{table_name}' initialized successfully")
    return _cache_table

def warm_up_function():
    """Ultra-lightweight warm-up function - only initializes clients"""
    try:
        logger.info("Starting warm-up process...")
        start_time = time.time()
        
        # Initialize all clients (lazy loading) - this is all we need
        bedrock_client = get_bedrock_client()
        dynamodb_resource = get_dynamodb_resource()
        cache_table = get_cache_table()
        
        # Skip all test operations to minimize warm-up time and cost
        # Clients are now initialized and ready for actual API calls
        logger.info("All clients initialized and ready")
        
        elapsed_time = (time.time() - start_time) * 1000
        logger.info(f"Warm-up completed successfully in {elapsed_time:.2f}ms")
        return True
        
    except Exception as e:
        logger.error(f"Warm-up failed: {e}")
        return False

def generate_cache_key(word: str) -> str:
    """Generate cache key based on word for optimal DynamoDB performance"""
    normalized_word = word.lower().strip()
    return f"{normalized_word}"

def check_cache(key: str) -> Optional[Dict[str, Any]]:
    """Check if the result exists in the cache"""
    try:
        table = get_cache_table()
        response = table.get_item(
            Key={'cacheKey': key}
        )
        
        if 'Item' not in response:
            return None
        
        item = response['Item']
        
        return {
            'data': item['data'],
            'timestamp': item['timestamp'],
            'ttl': item.get('ttl'),
            'provider': item.get('provider', ''),
            'model': item.get('model', '')
        }
        
    except ClientError as e:
        logger.error(f"Error checking cache: {e}")
        return None

def cache_result(key: str, data: Dict[str, Any]) -> bool:
    """Cache the result"""
    try:
        table = get_cache_table()
        now = int(time.time())
        ttl = now + CACHE_TTL
        
        item = {
            'cacheKey': key,
            'data': data,
            'timestamp': now,
            'ttl': ttl,
            'provider': 'bedrock',
            'model': 'amazon.nova-micro-v1:0',
            'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        }
        
        table.put_item(Item=item)
        logger.info(f"Cached result for key: {key}")
        return True
        
    except ClientError as e:
        logger.error(f"Error caching result: {e}")
        return False

def delete_cache(key: str) -> bool:
    """Delete cache item"""
    try:
        table = get_cache_table()
        table.delete_item(
            Key={'cacheKey': key}
        )
        logger.info(f"Deleted cache for key: {key}")
        return True
        
    except ClientError as e:
        logger.error(f"Error deleting cache: {e}")
        return False

def lambda_handler(event, context):
    """
    Word Muncher Lambda Handler with Warm-up Support
    Step-by-Step Vocabulary Simplification Service - Generate 5 Progressive Synonyms
    """
    # Handle warm-up requests (cost-optimized)
    if (event.get('source') == 'warmer' or 
        event.get('warmer') == True or
        event.get('source') == 'aws.events' or
        event.get('detail-type') == 'Scheduled Event'):
        
        logger.info("Received warm-up request")
        success = warm_up_function()
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'message': 'Function warmed up successfully',
                'success': success,
                'timestamp': int(time.time()),
                'service': 'word-muncher'
            })
        }
    
    logger.info(f"[{PROJECT_NAME}] Processing event: {event}")

    try:        
        # Parse request from API Gateway（body(word + context) + headers）
        body = {}
        if 'body' in event and event['body'] is not None:
            body = json.loads(event['body']) if isinstance(event['body'], str) else event['body']
        
        word = body.get('word', '')
        context = body.get('context', '')
        language = body.get('language', 'english')  # default to english
        
        if not word:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Missing required parameter: word'})
            }
        
        # Simplified security validation - align with frontend limits
        # Frontend already validates: 1-20 chars, no spaces
        if len(word) > 25:  # Slightly higher than frontend limit for security
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': 'Security check: Word length exceeds safe limit',
                    'note': 'Frontend validation should have caught this'
                })
            }
        
        # Context security check - frontend generates ~200 chars max
        if len(context) > 300:  # Buffer for security
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': 'Security check: Context too long',
                    'note': 'Frontend should limit context size'
                })
            }
        
        # Check cache if enabled
        cache_key = None
        cached_result = None
        
        if CACHE_ENABLED:
            # cache key with language information
            cache_key = f"{generate_cache_key(word)}:{language}"
            cached_result = check_cache(cache_key)
            
            if cached_result:
                logger.info(f"Cache hit for key: {cache_key}")
                return {
                    'statusCode': 200,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps({
                        'word': word,
                        'context': context,
                        'language': language,
                        'synonyms': cached_result['data'],
                        'service': 'word-muncher',
                        'cached': True,
                        'cache_key': cache_key
                    })
                }
            else:
                logger.info(f"Cache miss for key: {cache_key}")
        
        # Generate synonyms using Bedrock with context
        synonyms = generate_synonyms(word, context, language)
        
        # Cache result if enabled
        if CACHE_ENABLED and cache_key:
            cache_result(cache_key, synonyms)
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'word': word,
                'context': context,
                'language': language,
                'synonyms': synonyms,
                'service': 'word-muncher',
                'cached': False
            })
        }
        
    except Exception as e:
        logger.error(f"Lambda execution failed: {str(e)}", exc_info=True)
        return {
            'statusCode': 500,
            'body': json.dumps({'error': f'Internal server error: {str(e)}'})
        }

def generate_synonyms(word, context, language):
    """
    Generate progressive synonyms for a given word using Amazon Nova Micro with context
    """
    # Use lazy-loaded client
    bedrock_client = get_bedrock_client()
    
    # Using Amazon Nova Micro model for word simplification
    model_id = "amazon.nova-micro-v1:0"
    logger.info(f"Using model: {model_id} for word: {word} with context: {context} in {language}")
    
    # Build context-aware prompts - language parameter determines output language
    if context:
        prompt = f"""Word: "{word}"
Context: "{context}"

Generate 5 synonyms from simple to very simple and common. Must fit the context. Output language: {language.upper()}.
Return only JSON array: ["synonym1", "synonym2", "synonym3", "synonym4", "synonym5"]"""
    else:
        prompt = f"""Word: "{word}"

Generate 5 synonyms from simple to very simple and common. Output language: {language.upper()}.
Return only JSON array: ["synonym1", "synonym2", "synonym3", "synonym4", "synonym5"]"""
    
    # Create conversation using the official format
    conversation = [
        {
            "role": "user",
            "content": [{"text": prompt}],
        }
    ]
    
    try:
        # Invoke the model using converse API
        logger.info(f"Invoking model for word: {word} with context: {context} in {language}")
        response = bedrock_client.converse(
            modelId=model_id,
            messages=conversation,
            inferenceConfig={"maxTokens": 150, "temperature": 0.1, "topP": 0.9},
        )
        
        # Extract the response text using official format
        response_text = response["output"]["message"]["content"][0]["text"]
        logger.info(f"Raw model response: {response_text}")
        
        # Try to parse JSON response
        try:
            synonyms = json.loads(response_text)
            if isinstance(synonyms, list) and len(synonyms) >= 1:
                result = synonyms[:5]  # Return up to 5 synonyms
                logger.info(f"Generated synonyms for '{word}' with context '{context}' in {language}: {result}")
                return result
        except json.JSONDecodeError:
            # If not valid JSON, try to extract from text
            import re
            
            # try multiple patterns
            patterns = [
                r'\[(.*?)\]',  # match content in square brackets
                r'["""](.*?)["""]',  # match content in quotes
                r'([^，,、\s]+)',  # match non-delimiter content
            ]
            
            for pattern in patterns:
                matches = re.findall(pattern, response_text)
                if matches:
                    # clean up matches
                    synonyms = []
                    for match in matches:
                        # remove quotes, brackets, etc.
                        clean_match = re.sub(r'["""\[\]()（）]', '', match.strip())
                        if clean_match and len(clean_match) > 0:
                            synonyms.append(clean_match)
                    
                    if len(synonyms) >= 1:
                        result = synonyms[:5]
                        logger.info(f"Generated synonyms (parsed) for '{word}' with context '{context}' in {language}: {result}")
                        return result
            
            # if all patterns fail, use simple split
            synonyms = re.split(r'[,，、\s]+', response_text.strip())
            synonyms = [s.strip().strip('"\'[]()（）') for s in synonyms if s.strip() and len(s.strip()) > 0]
            result = synonyms[:5]
            logger.info(f"Generated synonyms (fallback) for '{word}' with context '{context}' in {language}: {result}")
            return result
        
        # If we reach here, something went wrong
        logger.warning(f"Failed to parse response for '{word}' in {language}: {response_text}")
        return []
        
    except (ClientError, Exception) as e:
        logger.error(f"ERROR: Can't invoke '{model_id}'. Reason: {e}")
        raise