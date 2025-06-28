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
CACHE_TTL = int(os.getenv('CACHE_TTL', '604800'))  # 7 days in seconds

def generate_cache_key(word: str) -> str:
    """Generate cache key based on word for optimal DynamoDB performance"""
    normalized_word = word.lower().strip()
    return f"{normalized_word}"

def get_cache_table():
    """Get the cache table"""
    dynamodb = boto3.resource('dynamodb')
    table_name = CACHE_TABLE_NAME or 'word-munch-cache'
    return dynamodb.Table(table_name)

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
            'model': 'meta.llama3-8b-instruct-v1:0',
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
    Word Muncher Lambda Handler
    Step-by-Step Vocabulary Simplification Service - Generate 5 Progressive Synonyms
    """
    logger.info(f"[{PROJECT_NAME}] Processing event: {event}")

    try:
        # Check Authorization header if present
        headers = event.get('headers', {}) or {}
        authorization = headers.get('Authorization') or headers.get('authorization')
        
        if authorization:
            logger.info(f"Authorization header present: {authorization[:20]}...")
            # TODO: Add proper token validation here
            # For now, just log the presence of the header
        
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
    Generate progressive synonyms for a given word using Bedrock with context
    """
    client = boto3.client("bedrock-runtime", region_name="us-east-1")
    
    # Using Llama 3 8B model for word simplification
    model_id = "meta.llama3-8b-instruct-v1:0"
    logger.info(f"Using model: {model_id} for word: {word} with context: {context} in {language}")
    
    # Build context-aware prompts - language parameter determines output language
    if context:
        prompt = f"""
        Generate 5 progressive synonyms for the word, from complex to simple.

        Word: "{word}"
        Context: "{context}"

        Requirements:
        1. Return only JSON array format, no explanations
        2. 5 synonyms progressing from complex to simple
        3. Each synonym should be a single word, no definitions
        4. Must fit the context
        5. Output language: {language.upper()}

        Format example: ["synonym1", "synonym2", "synonym3", "synonym4", "synonym5"]

        Now generate synonyms for "{word}" in {language.upper()}:
        """
    else:
        prompt = f"""
        Generate 5 progressive synonyms for the word, from complex to simple.

        Word: "{word}"

        Requirements:
        1. Return only JSON array format, no explanations
        2. 5 synonyms progressing from complex to simple
        3. Each synonym should be a single word, no definitions
        4. Output language: {language.upper()}

        Format example: ["synonym1", "synonym2", "synonym3", "synonym4", "synonym5"]

        Now generate synonyms for "{word}" in {language.upper()}:
        """
    
    # Embed the prompt in Llama 3's instruction format
    formatted_prompt = f"""
    <|begin_of_text|><|start_header_id|>user<|end_header_id|>
    {prompt}
    <|eot_id|>
    <|start_header_id|>assistant<|end_header_id|>
    """
    
    # Format the request payload using the model's native structure
    native_request = {
        "prompt": formatted_prompt,
        "max_gen_len": 200,  # reduce length to avoid too much explanation
        "temperature": 0.2,  # reduce temperature to improve consistency
    }
    
    # Convert the native request to JSON
    request = json.dumps(native_request)
    
    try:
        # Invoke the model with the request
        logger.info(f"Invoking model for word: {word} with context: {context} in {language}")
        response = client.invoke_model(modelId=model_id, body=request)
        
        # Decode the response body
        model_response = json.loads(response["body"].read())
        
        # Extract the response text
        response_text = model_response["generation"]
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

