import json
import boto3
import math
import hashlib
import time
import os
from typing import List, Dict
import logging

# Logger configuration
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS client
bedrock_runtime = boto3.client('bedrock-runtime', region_name='us-east-1')

# Global variables for lazy loading
_cache_table = None
_cloudwatch_client = None

def get_cache_table():
    """Lazy load cache table"""
    global _cache_table
    if _cache_table is None:
        dynamodb = boto3.resource('dynamodb')
        cache_table_name = os.environ.get('CACHE_TABLE_NAME', 'word-munch-cache')
        _cache_table = dynamodb.Table(cache_table_name)
    return _cache_table

def get_cloudwatch_client():
    """Lazy load CloudWatch client"""
    global _cloudwatch_client
    if _cloudwatch_client is None:
        _cloudwatch_client = boto3.client('cloudwatch')
    return _cloudwatch_client

def lambda_handler(event, context):
    """
    Semantic search Lambda function
    Handles embedding generation and similarity matching for text chunks
    """
    try:
        # Handle warm-up requests from EventBridge
        if event.get('warmer'):
            logger.info("Lambda warm-up request received")
            return create_response(200, {'message': 'Lambda warmed up successfully'})
        
        # Parse request
        body = json.loads(event.get('body', '{}'))
        action = body.get('action')
        
        logger.info(f"Processing semantic search request: {action}")
        
        # Extract user information for rate limiting
        user_id = extract_user_id_from_event(event)
        is_anonymous = is_anonymous_user(event)
        
        # Rate limiting for anonymous users (3 times per day)
        if is_anonymous:
            rate_limit_result = check_semantic_search_rate_limit(user_id)
            if not rate_limit_result['allowed']:
                send_cloudwatch_metrics('anonymous', rate_limit_hit=True)
                
                return create_response(429, {
                    'error': 'Daily usage limit exceeded',
                    'message': 'Anonymous users are limited to 3 semantic searches per day',
                    'usage_count': rate_limit_result['current_count'],
                    'limit': rate_limit_result['daily_limit'],
                    'reset_time': rate_limit_result['reset_time'],
                    'error_code': 'RATE_LIMIT_EXCEEDED'
                })
        
        # Send CloudWatch metrics
        user_type = 'anonymous' if is_anonymous else 'registered'
        send_cloudwatch_metrics(user_type)
        
        if action == 'search_chunks':
            result = handle_semantic_search(body)
            
            # Record usage for anonymous users
            if is_anonymous and result['statusCode'] == 200:
                record_semantic_search_usage(user_id)
                
            return result
            
        elif action == 'generate_embeddings':
            result = handle_embedding_generation(body)
            
            # Record usage for anonymous users
            if is_anonymous and result['statusCode'] == 200:
                record_semantic_search_usage(user_id)
                
            return result
        else:
            return create_response(400, {'error': 'Invalid action'})
            
    except Exception as e:
        logger.error(f"Lambda execution error: {str(e)}")
        return create_response(500, {'error': f'Internal server error: {str(e)}'})

def handle_semantic_search(body: Dict) -> Dict:
    """
    Handle semantic search request using Titan Embeddings v2
    """
    try:
        chunks = body.get('chunks', [])
        query = body.get('query', '')
        top_k = body.get('top_k', 5)
        similarity_threshold = body.get('similarity_threshold', 0.7)
        
        if not chunks or not query:
            return create_response(400, {'error': 'Missing chunks or query'})
        
        logger.info(f"Searching among {len(chunks)} chunks for query: {query[:50]}...")
        
        # Prepare all texts for processing (query + chunks)
        all_texts = [query] + chunks
        
        # Generate embeddings using Titan v2
        all_embeddings = generate_batch_embeddings(all_texts)
        
        # Extract query embedding and chunk embeddings
        query_embedding = all_embeddings[0]
        chunk_embeddings = all_embeddings[1:]
        
        # Calculate similarity
        similarities = []
        for i, chunk_embedding in enumerate(chunk_embeddings):
            similarity = calculate_cosine_similarity(query_embedding, chunk_embedding)
            similarities.append({
                'index': i,
                'chunk': chunks[i],
                'similarity': similarity,
                'length': len(chunks[i])
            })
        
        # Sort by similarity and filter
        similarities.sort(key=lambda x: x['similarity'], reverse=True)
        relevant_chunks = [
            chunk for chunk in similarities 
            if chunk['similarity'] >= similarity_threshold
        ][:top_k]
        
        logger.info(f"Found {len(relevant_chunks)} relevant chunks above threshold {similarity_threshold}")
        
        return create_response(200, {
            'query': query,
            'total_chunks': len(chunks),
            'relevant_chunks': relevant_chunks,
            'top_similarity': relevant_chunks[0]['similarity'] if relevant_chunks else 0
        })
        
    except Exception as e:
        logger.error(f"Semantic search error: {str(e)}")
        return create_response(500, {'error': f'Semantic search failed: {str(e)}'})

def handle_embedding_generation(body: Dict) -> Dict:
    """
    Handle batch embedding generation request using Titan v2
    """
    try:
        texts = body.get('texts', [])
        
        if not texts:
            return create_response(400, {'error': 'Missing texts'})
        
        logger.info(f"Generating embeddings for {len(texts)} texts using Titan v2")
        
        # Generate embeddings using Titan v2
        embeddings = generate_batch_embeddings(texts)
        
        return create_response(200, {
            'embeddings': embeddings,
            'dimension': 1024,
            'count': len(embeddings)
        })
        
    except Exception as e:
        logger.error(f"Batch embedding generation error: {str(e)}")
        return create_response(500, {'error': f'Batch embedding generation failed: {str(e)}'})

def generate_batch_embeddings(texts: List[str]) -> List[List[float]]:
    """
    Generate embeddings for multiple texts using individual API calls
    """
    try:
        if not texts:
            return []
        
        all_embeddings = []
        
        for i, text in enumerate(texts):
            logger.info(f"Processing text {i+1}/{len(texts)}")
            
            try:
                embedding = generate_single_embedding(text)
                all_embeddings.append(embedding)
                
            except Exception as single_error:
                logger.error(f"Embedding generation failed for text {i+1}: {str(single_error)}")
                all_embeddings.append([0.0] * 1024)  # Zero vector fallback
        
        logger.info(f"Generated {len(all_embeddings)} embeddings")
        return all_embeddings
        
    except Exception as e:
        logger.error(f"Embedding generation failed: {str(e)}")
        return [[0.0] * 1024 for _ in texts]

def generate_single_embedding(text: str) -> List[float]:
    """
    Generate single text embedding using Amazon Titan Embeddings v2
    """
    try:
        # Titan v2 limits: 8,192 tokens OR 50,000 characters
        max_chars = 50000
        
        # Truncate text if it exceeds the limit
        if len(text) > max_chars:
            text = text[:max_chars]
            logger.warning(f"Text truncated to {max_chars} characters (Titan v2 limit)")
        
        # Prepare request body
        request_body = {
            "inputText": text,
            "dimensions": 1024,
            "normalize": True
        }
        
        # Call Bedrock Runtime
        response = bedrock_runtime.invoke_model(
            modelId='amazon.titan-embed-text-v2:0',
            contentType='application/json',
            accept='application/json',
            body=json.dumps(request_body)
        )
        
        # Parse response
        response_body = json.loads(response['body'].read())
        embedding = list(response_body['embedding'])
        
        return embedding
        
    except Exception as e:
        logger.error(f"Single embedding generation failed: {str(e)}")
        raise e

def calculate_cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """
    Calculate cosine similarity between two vectors
    """
    try:
        if len(vec1) != len(vec2):
            logger.error(f"Vector length mismatch: {len(vec1)} vs {len(vec2)}")
            return 0.0
        
        # Calculate dot product
        dot_product = sum(a * b for a, b in zip(vec1, vec2))
        
        # Calculate norms
        norm1 = math.sqrt(sum(a * a for a in vec1))
        norm2 = math.sqrt(sum(b * b for b in vec2))
        
        if norm1 == 0 or norm2 == 0:
            return 0.0
        
        similarity = dot_product / (norm1 * norm2)
        return similarity
        
    except Exception as e:
        logger.error(f"Cosine similarity calculation failed: {str(e)}")
        return 0.0

def extract_user_id_from_event(event):
    """Extract user ID from event"""
    headers = event.get('headers', {})
    auth_header = headers.get('Authorization', '')
    
    # For registered users, use JWT token
    if auth_header.startswith('Bearer '):
        return 'user_' + hashlib.md5(auth_header.encode()).hexdigest()[:8]
    
    # For anonymous users, try to get client-generated anonymous ID from request body
    try:
        if isinstance(event.get('body'), str):
            body = json.loads(event['body'])
        else:
            body = event.get('body', {})
        
        # Check if frontend provided anonymous_user_id
        anonymous_id = body.get('anonymous_user_id')
        if anonymous_id and isinstance(anonymous_id, str) and len(anonymous_id) > 0:
            # Validate and sanitize the anonymous ID
            clean_id = ''.join(c for c in anonymous_id if c.isalnum() or c in '-_')[:50]
            if len(clean_id) >= 8:  # Minimum length requirement
                return f'anon_{clean_id}'
        
    except (json.JSONDecodeError, TypeError, AttributeError):
        pass
    
    # Fallback: use a combination of User-Agent and other stable headers
    user_agent = headers.get('User-Agent', 'unknown')
    accept_language = headers.get('Accept-Language', '')
    accept_encoding = headers.get('Accept-Encoding', '')
    
    # Create a more stable fingerprint
    fingerprint_data = f"{user_agent}|{accept_language}|{accept_encoding}"
    fingerprint_hash = hashlib.md5(fingerprint_data.encode()).hexdigest()[:12]
    
    return f'anon_{fingerprint_hash}'

def is_anonymous_user(event):
    """Check if the user is anonymous (no Authorization header)"""
    headers = event.get('headers', {})
    auth_header = headers.get('Authorization', '')
    
    # Primary check: no Bearer token
    if auth_header.startswith('Bearer '):
        return False
    
    # Secondary check: if anonymous_user_id is provided in request body
    try:
        if isinstance(event.get('body'), str):
            body = json.loads(event['body'])
        else:
            body = event.get('body', {})
        
        anonymous_id = body.get('anonymous_user_id')
        if anonymous_id and isinstance(anonymous_id, str):
            return True  # Has anonymous ID, definitely anonymous
            
    except (json.JSONDecodeError, TypeError, AttributeError):
        pass
    
    return True  # Default to anonymous if no Bearer token

def check_semantic_search_rate_limit(user_id):
    """Check if anonymous user has exceeded daily semantic search rate limit (3 times)"""
    try:
        cache_table = get_cache_table()
        if not cache_table:
            logger.warning("Cache table not available, allowing request")
            return {'allowed': True, 'current_count': 0, 'daily_limit': 3, 'reset_time': get_tomorrow_timestamp()}
        
        # Generate today's rate limit key
        today = time.strftime('%Y-%m-%d')
        rate_limit_key = f"rate_limit_semantic_search_{user_id}_{today}"
        
        # Try to get current usage count
        response = cache_table.get_item(Key={'cacheKey': rate_limit_key})
        
        current_count = 0
        if 'Item' in response:
            try:
                data = json.loads(response['Item']['data'])
                current_count = data.get('count', 0)
            except (json.JSONDecodeError, KeyError):
                current_count = 0
        
        daily_limit = 3  # Anonymous users limited to 3 searches per day
        allowed = current_count < daily_limit
        
        logger.info(f"Anonymous user {user_id[:8]}... semantic search usage check: {current_count}/{daily_limit}")
        
        return {
            'allowed': allowed,
            'current_count': current_count,
            'daily_limit': daily_limit,
            'reset_time': get_tomorrow_timestamp()
        }
        
    except Exception as e:
        logger.error(f"Rate limit check failed for user {user_id}: {e}")
        # On error, allow the request but log the issue
        return {'allowed': True, 'current_count': 0, 'daily_limit': 3, 'reset_time': get_tomorrow_timestamp()}

def record_semantic_search_usage(user_id):
    """Record semantic search usage for anonymous user"""
    try:
        cache_table = get_cache_table()
        if not cache_table:
            logger.warning("Cache table not available, cannot record usage")
            return
        
        # Generate today's rate limit key
        today = time.strftime('%Y-%m-%d')
        rate_limit_key = f"rate_limit_semantic_search_{user_id}_{today}"
        
        # Try to get current usage count
        response = cache_table.get_item(Key={'cacheKey': rate_limit_key})
        
        current_count = 0
        if 'Item' in response:
            try:
                data = json.loads(response['Item']['data'])
                current_count = data.get('count', 0)
            except (json.JSONDecodeError, KeyError):
                current_count = 0
        
        # Increment count
        new_count = current_count + 1
        
        # Calculate TTL for tomorrow midnight (auto cleanup)
        tomorrow_timestamp = get_tomorrow_timestamp()
        
        # Store updated count
        cache_table.put_item(
            Item={
                'cacheKey': rate_limit_key,
                'data': json.dumps({
                    'count': new_count,
                    'user_id': user_id,
                    'date': today,
                    'last_used': int(time.time())
                }, ensure_ascii=False),
                'ttl': tomorrow_timestamp,
                'timestamp': int(time.time()),
                'provider': 'rate_limiter',
                'model': 'semantic_search_daily_limit'
            }
        )
        
        logger.info(f"Recorded semantic search usage for anonymous user {user_id[:8]}...: {new_count}/3")
        
    except Exception as e:
        logger.warning(f"Failed to record usage for anonymous user {user_id}: {e}")

def get_tomorrow_timestamp():
    """Get timestamp for tomorrow midnight UTC"""
    import datetime
    tomorrow = datetime.date.today() + datetime.timedelta(days=1)
    tomorrow_midnight = datetime.datetime.combine(tomorrow, datetime.time.min)
    return int(tomorrow_midnight.timestamp())

def send_cloudwatch_metrics(user_type: str, rate_limit_hit: bool = False):
    """Send usage metrics to CloudWatch"""
    try:
        cloudwatch = get_cloudwatch_client()
        
        # Prepare metric data
        metric_data = [
            {
                'MetricName': 'SemanticSearchInvocations',
                'Dimensions': [
                    {
                        'Name': 'Service',
                        'Value': 'semantic-search'
                    },
                    {
                        'Name': 'Environment',
                        'Value': os.environ.get('ENVIRONMENT', 'dev')
                    }
                ],
                'Value': 1,
                'Unit': 'Count'
            }
        ]
        
        # Add user type specific metrics
        if user_type == 'anonymous':
            metric_data.append({
                'MetricName': 'AnonymousUsers',
                'Dimensions': [
                    {
                        'Name': 'Service', 
                        'Value': 'semantic-search'
                    },
                    {
                        'Name': 'Environment',
                        'Value': os.environ.get('ENVIRONMENT', 'dev')
                    }
                ],
                'Value': 1,
                'Unit': 'Count'
            })
        else:
            metric_data.append({
                'MetricName': 'RegisteredUsers',
                'Dimensions': [
                    {
                        'Name': 'Service',
                        'Value': 'semantic-search'
                    },
                    {
                        'Name': 'Environment',
                        'Value': os.environ.get('ENVIRONMENT', 'dev')
                    }
                ],
                'Value': 1,
                'Unit': 'Count'
            })
        
        # Add rate limit metric if applicable
        if rate_limit_hit:
            metric_data.append({
                'MetricName': 'RateLimitHits',
                'Dimensions': [
                    {
                        'Name': 'Service',
                        'Value': 'semantic-search'
                    },
                    {
                        'Name': 'Environment',
                        'Value': os.environ.get('ENVIRONMENT', 'dev')
                    }
                ],
                'Value': 1,
                'Unit': 'Count'
            })
        
        # Send metrics to CloudWatch
        cloudwatch.put_metric_data(
            Namespace='WordMunch/SemanticSearch',
            MetricData=metric_data
        )
        
        logger.info(f"Sent metrics to CloudWatch: user_type={user_type}")
        
    except Exception as e:
        logger.warning(f"Failed to send metrics to CloudWatch: {e}")

def create_response(status_code: int, body: Dict) -> Dict:
    """
    Create standardized API response
    """
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            'Access-Control-Allow-Methods': 'POST,OPTIONS'
        },
        'body': json.dumps(body, ensure_ascii=False)
    } 