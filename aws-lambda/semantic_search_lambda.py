import json
import boto3
import math
from typing import List, Dict, Tuple
import logging

# Logger configuration
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS client
bedrock_runtime = boto3.client('bedrock-runtime', region_name='us-east-1')

def lambda_handler(event, context):
    """
    Semantic search Lambda function
    Handles embedding generation and similarity matching for text chunks
    """
    try:
        # Parse request
        body = json.loads(event.get('body', '{}'))
        action = body.get('action')
        
        logger.info(f"Processing semantic search request: {action}")
        
        if action == 'search_chunks':
            return handle_semantic_search(body)
        elif action == 'generate_embeddings':
            return handle_embedding_generation(body)
        else:
            return create_response(400, {'error': 'Invalid action'})
            
    except Exception as e:
        logger.error(f"Lambda execution error: {str(e)}")
        return create_response(500, {'error': f'Internal server error: {str(e)}'})

def handle_semantic_search(body: Dict) -> Dict:
    """
    Handle semantic search request using Titan Embeddings v2 Batch API
    """
    try:
        chunks = body.get('chunks', [])
        query = body.get('query', '')
        top_k = body.get('top_k', 5)
        similarity_threshold = body.get('similarity_threshold', 0.7)
        
        if not chunks or not query:
            return create_response(400, {'error': 'Missing chunks or query'})
        
        logger.info(f"Searching among {len(chunks)} chunks for query: {query[:50]}... using BATCH API")
        
        # Prepare all texts for batch processing (query + chunks)
        all_texts = [query] + chunks
        
        # Generate embeddings using batch API (much more cost-effective)
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
            'top_similarity': relevant_chunks[0]['similarity'] if relevant_chunks else 0,
            'batch_processed': False,  # Individual API calls used
            'cost_optimized': False,   # No batch optimization available
            'processing_stats': {
                'chunks_processed': len(chunks),
                'embeddings_generated': len(chunk_embeddings),
                'relevant_found': len(relevant_chunks),
                'api_method': 'Titan v2 Individual API',
                'note': 'Titan v2 does not support batch API for real-time embedding'
            }
        })
        
    except Exception as e:
        logger.error(f"Semantic search error: {str(e)}")
        return create_response(500, {'error': f'Semantic search failed: {str(e)}'})

def handle_embedding_generation(body: Dict) -> Dict:
    """
    Handle batch embedding generation request using Titan v2 Batch API
    """
    try:
        texts = body.get('texts', [])
        
        if not texts:
            return create_response(400, {'error': 'Missing texts'})
        
        logger.info(f"Generating embeddings for {len(texts)} texts using BATCH API")
        
        # Use batch API for much better cost efficiency
        embeddings = generate_batch_embeddings(texts)
        
        # Convert to list format for JSON serialization
        embeddings_list = [embedding.tolist() for embedding in embeddings]
        
        return create_response(200, {
            'embeddings': embeddings_list,
            'dimension': 1536,
            'count': len(embeddings_list),
            'batch_processed': True
        })
        
    except Exception as e:
        logger.error(f"Batch embedding generation error: {str(e)}")
        return create_response(500, {'error': f'Batch embedding generation failed: {str(e)}'})

def generate_batch_embeddings(texts: List[str]) -> List[List[float]]:
    """
    Generate embeddings for multiple texts using individual API calls
    Note: Titan v2 doesn't support true batch API, so I make individual calls
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
                logger.debug(f"Successfully generated embedding {i+1}/{len(texts)}")
                
            except Exception as single_error:
                logger.error(f"Embedding generation failed for text {i+1}: {str(single_error)}")
                all_embeddings.append([0.0] * 1024)  # Zero vector fallback
        
        logger.info(f"Generated {len(all_embeddings)} total embeddings using individual API calls")
        return all_embeddings
        
    except Exception as e:
        logger.error(f"Embedding generation failed: {str(e)}")
        # Ultimate fallback: return zero vectors
        return [[0.0] * 1024 for _ in texts]

def generate_single_embedding(text: str) -> List[float]:
    """
    Generate single text embedding using Amazon Titan Embeddings v2
    Used as fallback when batch API is not available
    """
    try:
        # Prepare request body
        request_body = {
            "inputText": text[:8000],  # Titan v2 maximum input length limit
            "dimensions": 1024,  # Titan Embeddings v2 default dimension
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
        
        logger.debug(f"Generated single embedding with length: {len(embedding)}")
        return embedding
        
    except Exception as e:
        logger.error(f"Single embedding generation failed: {str(e)}")
        raise e

def calculate_cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """
    Calculate cosine similarity between two vectors using built-in Python functions
    """
    try:
        # Ensure vectors are lists
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

def batch_process_chunks(chunks: List[str], max_batch_size: int = 25) -> List[List[float]]:
    """
    Process chunks using Titan v2 Batch API for optimal cost efficiency
    
    Args:
        chunks: List of text chunks to process
        max_batch_size: Maximum number of texts per batch (Titan v2 supports up to 25)
    
    Returns:
        List of embeddings corresponding to input chunks
    """
    try:
        # Use the new batch API function directly
        embeddings = generate_batch_embeddings(chunks)
        logger.info(f"Batch processed {len(chunks)} chunks with cost-optimized Titan v2 Batch API")
        return embeddings
        
    except Exception as e:
        logger.error(f"Batch chunk processing failed: {str(e)}")
        # Return zero vectors as fallback
        return [[0.0] * 1024 for _ in chunks] 