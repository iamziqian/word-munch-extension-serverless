import json
import boto3
import hashlib
import time
import re
import os
import threading
import logging
import datetime
from typing import List, Dict, Tuple, Any
from decimal import Decimal

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Global variables for lazy loading - initialized as None
_bedrock_client = None
_dynamodb_resource = None
_sqs_client = None
_cache_table = None
_cloudwatch_client = None

def get_bedrock_client():
    """Lazy load Bedrock client with connection reuse"""
    global _bedrock_client
    if _bedrock_client is None:
        logger.info("Initializing Bedrock client (lazy loading)...")
        _bedrock_client = boto3.client('bedrock-runtime', region_name='us-east-1')
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

def get_sqs_client():
    """Lazy load SQS client with connection reuse"""
    global _sqs_client
    if _sqs_client is None:
        logger.info("Initializing SQS client (lazy loading)...")
        _sqs_client = boto3.client('sqs', region_name='us-east-1')
        logger.info("SQS client initialized successfully")
    return _sqs_client

def get_cloudwatch_client():
    """Lazy load CloudWatch client with connection reuse"""
    global _cloudwatch_client
    if _cloudwatch_client is None:
        logger.info("Initializing CloudWatch client (lazy loading)...")
        _cloudwatch_client = boto3.client('cloudwatch', region_name='us-east-1')
        logger.info("CloudWatch client initialized successfully")
    return _cloudwatch_client

def get_cache_table():
    """Lazy load cache table with connection reuse"""
    global _cache_table
    if _cache_table is None:
        logger.info("Initializing cache table (lazy loading)...")
        dynamodb = get_dynamodb_resource()
        cache_table_name = os.environ.get('CACHE_TABLE_NAME')
        if cache_table_name:
            _cache_table = dynamodb.Table(cache_table_name)
            logger.info(f"Cache table '{cache_table_name}' initialized successfully")
        else:
            logger.warning("CACHE_TABLE_NAME environment variable not set")
    return _cache_table

def warm_up_function():
    """Ultra-lightweight warm-up function - only initializes clients"""
    try:
        logger.info("Starting warm-up process...")
        start_time = time.time()
        
        # Initialize all clients (lazy loading) - this is all we need
        bedrock_client = get_bedrock_client()
        dynamodb_resource = get_dynamodb_resource()
        sqs_client = get_sqs_client()
        cache_table = get_cache_table()
        cloudwatch_client = get_cloudwatch_client()
        
        # Skip all test operations to minimize warm-up time and cost
        # Clients are now initialized and ready for actual API calls
        logger.info("All clients initialized and ready")
        
        elapsed_time = (time.time() - start_time) * 1000
        logger.info(f"Warm-up completed successfully in {elapsed_time:.2f}ms")
        return True
        
    except Exception as e:
        logger.error(f"Warm-up failed: {e}")
        return False

def record_cognitive_data_async(user_id: str, analysis_data: Dict):
    """Asynchronously record cognitive data via SQS to the cognitive profile service"""
    def make_request():
        try:
            # Use lazy-loaded SQS client
            sqs_client = get_sqs_client()
            
            # Get SQS queue URL from environment
            queue_url = os.environ.get('COGNITIVE_QUEUE_URL')
            if not queue_url:
                logger.warning("COGNITIVE_QUEUE_URL environment variable not set")
                return
            
            # Prepare message for SQS
            message_body = {
                'action': 'record_analysis',
                'user_id': user_id,
                'analysis_data': analysis_data,
                'timestamp': int(time.time()),
                'source': 'concept-muncher'
            }
            
            # Send message to SQS queue
            response = sqs_client.send_message(
                QueueUrl=queue_url,
                MessageBody=json.dumps(message_body, ensure_ascii=False),
                MessageAttributes={
                    'action': {
                        'StringValue': 'record_analysis',
                        'DataType': 'String'
                    },
                    'user_id': {
                        'StringValue': user_id,
                        'DataType': 'String'
                    }
                }
            )
            
            logger.info(f"Cognitive data sent to SQS for user {user_id}, MessageId: {response.get('MessageId')}")
            
        except Exception as e:
            logger.warning(f"Failed to send cognitive data to SQS: {e}")
    
    # Run in background thread to not block response
    thread = threading.Thread(target=make_request)
    thread.daemon = True
    thread.start()

class TextComprehensionAnalyzer:
    def __init__(self):
        # Use lazy-loaded clients instead of creating new ones
        self.bedrock = None  # Will be initialized on first use
        self.dynamodb = None  # Will be initialized on first use
        self.cache_table_name = os.environ.get('CACHE_TABLE_NAME')
        self.cache_table = None  # Will be initialized on first use
        self.cache_enabled = os.environ.get('CACHE_ENABLED', 'true').lower() == 'true'
        
        # Cache Master's tiered TTL strategy
        self.cache_ttl = {
            'embedding_original': 2592000,    # 30 days - Original text embeddings (highest value)
            'segments': 2592000,              # 30 days - Text segmentation results (high stability)
            'embedding_segment': 604800,      # 7 days - Segment embeddings (medium value)
            'sentence_skeleton': 1209600,     # 14 days - Sentence skeleton extraction (medium-high value)
        }
    
    def _get_bedrock_client(self):
        """Get Bedrock client with lazy loading"""
        if self.bedrock is None:
            self.bedrock = get_bedrock_client()
        return self.bedrock
    
    def _get_cache_table(self):
        """Get cache table with lazy loading"""
        if self.cache_table is None:
            self.cache_table = get_cache_table()
        return self.cache_table
        
    def get_cache_key(self, prefix: str, content: str) -> str:
        """Generate standardized cache key"""
        content_hash = hashlib.md5(content.encode('utf-8')).hexdigest()
        return f"{prefix}_{content_hash}"
    
    def get_cached_data(self, cache_key: str) -> Any:
        """Generic cache read method"""
        if not self.cache_enabled:
            return None
        
        cache_table = self._get_cache_table()
        if not cache_table:
            return None
            
        try:
            response = cache_table.get_item(Key={'cacheKey': cache_key})
            if 'Item' in response:
                logger.info(f"Cache HIT: {cache_key[:20]}...")
                return json.loads(response['Item']['data'])
        except Exception as e:
            logger.warning(f"Cache read error for {cache_key}: {e}")
        
        logger.info(f"Cache MISS: {cache_key[:20]}...")    
        return None
    
    def set_cached_data(self, cache_key: str, data: Any, ttl_type: str):
        """Generic cache write method"""
        if not self.cache_enabled:
            return
        
        cache_table = self._get_cache_table()
        if not cache_table:
            return
            
        try:
            ttl_seconds = self.cache_ttl.get(ttl_type, 604800)  # Default 7 days
            cache_table.put_item(
                Item={
                    'cacheKey': cache_key,
                    'data': json.dumps(data, ensure_ascii=False),
                    'ttl': int(time.time()) + ttl_seconds
                }
            )
            logger.info(f"Cache SET: {cache_key[:20]}... (TTL: {ttl_seconds}s)")
        except Exception as e:
            logger.warning(f"Cache write error for {cache_key}: {e}")
    
    def segment_text(self, text: str) -> List[Dict[str, Any]]:
        """
        Intelligent Text Segmentation: Use phrase to segment a single sentence, use sentence to segment multiple sentences.
        Cache strategy: High-value cache, 30-day TTL
        """
        cache_key = self.get_cache_key('segments', text)
    
        # Try cache read
        cached_segments = self.get_cached_data(cache_key)
        if cached_segments:
            return cached_segments
        
        # Determine whether it is a single sentence
        is_single_sentence = self._is_single_sentence(text)
        
        if is_single_sentence:
            # segment by phrase
            segments = self._perform_phrase_segmentation(text)
        else:
            # segment by sentence
            segments = self._perform_text_segmentation(text)
        
        # Cache results
        self.set_cached_data(cache_key, segments, 'segments')
        
        return segments
    
    def _is_single_sentence(self, text: str) -> bool:
        """
        Determine if the text is a single sentence
        Rules:
        1. Only one sentence ending symbol (.!?)
        2. Or no sentence ending symbol
        3. Or total word count less than 20
        """
        # Clean text
        text = text.strip()
        
        # Count sentence ending symbols (excluding decimal points)
        sentence_endings = re.findall(r'(?<!\d)[.!?。！？](?!\d)', text)
        
        # Count words
        word_count = len(text.split())
        
        # Determine conditions
        if len(sentence_endings) <= 1 and word_count <= 20:
            return True
        elif len(sentence_endings) == 0:
            return True
        else:
            return False

    
    def _perform_phrase_segmentation(self, text: str) -> List[Dict[str, Any]]:
        """
        Execute phrase-level segmentation
        Based on grammar structure and punctuation for more granular segmentation
        """
        segments = []
        
        # Phrase segmentation rules:
        # 1. Comma, semicolon, colon
        # 2. Conjunction (and, but, or, however, therefore, etc.)
        # 3. Prepositional phrase
        # 4. Keyword split point
        
        # Segmentation pattern
        phrase_patterns = [
            r'[,;:]',  # Punctuation
            r'\s+(?:and|but|or|however|therefore|moreover|furthermore|additionally|consequently)\s+',  # Conjunction
            r'\s+(?:in|on|at|by|for|with|through|during|after|before|since|until)\s+',  # Preposition
            r'\s+(?:such as|for example|including|like)\s+',  # Example word
        ]
        
        # Merge all patterns
        combined_pattern = '|'.join(f'({pattern})' for pattern in phrase_patterns)
        
        # Execute segmentation
        parts = re.split(combined_pattern, text)
        
        current_pos = 0
        current_phrase = ""
        
        for part in parts:
            if part is None:
                continue
                
            part = part.strip()
            if not part:
                continue
            
            # If it is a separator, end the current phrase
            if re.match(combined_pattern, part):
                if current_phrase:
                    # Add current phrase
                    start_pos = text.find(current_phrase, current_pos)
                    if start_pos == -1:
                        start_pos = current_pos
                    end_pos = start_pos + len(current_phrase)
                    
                    segments.append({
                        "text": current_phrase.strip(),
                        "start": start_pos,
                        "end": end_pos,
                        "type": "phrase",  # Mark as phrase type
                        "level": "primary"
                    })
                    
                    current_pos = end_pos
                    current_phrase = ""
            else:
                # Accumulate phrase content
                if current_phrase:
                    current_phrase += " " + part
                else:
                    current_phrase = part
        
        # Process the last phrase
        if current_phrase:
            start_pos = text.find(current_phrase, current_pos)
            if start_pos == -1:
                start_pos = current_pos
            end_pos = start_pos + len(current_phrase)
            
            segments.append({
                "text": current_phrase.strip(),
                "start": start_pos,
                "end": end_pos,
                "type": "phrase",
                "level": "primary"
            })
        
        # If the segmentation result is too few, use the backup solution
        if len(segments) < 2:
            segments = self._fallback_phrase_segmentation(text)
        
        logger.info(f"Phrase segmented text into {len(segments)} phrases")
        return segments
    
    def _fallback_phrase_segmentation(self, text: str) -> List[Dict[str, Any]]:
        """
        Backup phrase segmentation scheme: based on word count
        """
        words = text.split()
        if len(words) <= 3:
            # Too short, as a whole as a phrase
            return [{
                "text": text,
                "start": 0,
                "end": len(text),
                "type": "phrase",
                "level": "primary"
            }]
        
        # Split into 2-3 phrases based on word count
        segments = []
        words_per_phrase = max(3, len(words) // 2)
        
        current_pos = 0
        for i in range(0, len(words), words_per_phrase):
            phrase_words = words[i:i + words_per_phrase]
            phrase_text = " ".join(phrase_words)
            
            start_pos = text.find(phrase_text, current_pos)
            if start_pos == -1:
                start_pos = current_pos
            end_pos = start_pos + len(phrase_text)
            
            segments.append({
                "text": phrase_text,
                "start": start_pos,
                "end": end_pos,
                "type": "phrase",
                "level": "primary"
            })
            
            current_pos = end_pos
        
        return segments

    def _perform_text_segmentation(self, text: str) -> List[Dict[str, Any]]:
        """Execute actual text segmentation - DECIMAL FIXED"""
        segments = []
            
        # Use negative lookbehind and lookahead to avoid splitting on decimals
        # (?<!\d)\.(?!\d) means: period that's not preceded by digit and not followed by digit
        sentence_parts = re.split(r'(?<!\d)\.(?!\d)|[!?。！？]', text)
        
        current_pos = 0
        for part in sentence_parts:
            sentence = part.strip()
            if not sentence:
                continue
            
            # Find sentence position in original text
            start_pos = text.find(sentence, current_pos)
            if start_pos == -1:
                start_pos = current_pos
            end_pos = start_pos + len(sentence)
            
            segments.append({
                "text": sentence,
                "start": start_pos,
                "end": end_pos,
                "type": "sentence",
                "level": "primary"
            })
            
            current_pos = end_pos
        
        logger.info(f"Segmented text into {len(segments)} sentences (decimal-safe)")
        return segments

    def extract_context_automatically(self, text: str) -> Dict[str, Any]:
        """
        Automatically extract context from text using Claude 3 Haiku
        This helps when context is not explicitly provided
        """
        try:
            bedrock = self._get_bedrock_client()
            
            system_prompt = "You are a text analysis expert. Extract key contextual information and respond only in valid JSON format."
            
            user_content = f"""Analyze this text and extract context:

{text[:500]}{"..." if len(text) > 500 else ""}

Return JSON with:
- topic: main subject
- domain: field (science/politics/literature/business/etc)
- tone: author's tone (objective/critical/optimistic/etc)
- text_type: format (article/essay/report/story/etc)
- context_summary: brief summary for comprehension analysis"""
            
            body = json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 300,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_content}]
            })
            
            response = bedrock.invoke_model(
                body=body,
                modelId="anthropic.claude-3-haiku-20240307-v1:0"
            )
            
            response_body = json.loads(response.get('body').read())
            claude_response = response_body['content'][0]['text']
            
            try:
                context_data = json.loads(claude_response)
                context_string = f"Topic: {context_data.get('topic', 'General')} | Domain: {context_data.get('domain', 'General')} | Type: {context_data.get('text_type', 'Text')}"
                return {
                    "extracted_context": context_string,
                    "context_details": context_data
                }
            except json.JSONDecodeError:
                return {
                    "extracted_context": "General text analysis context",
                    "context_details": {"raw_response": claude_response}
                }
                
        except Exception as e:
            logger.error(f"Context extraction error: {e}")
            return {
                "extracted_context": "General comprehension analysis",
                "context_details": {}
            }
    
    def get_text_embedding(self, text: str, cache_type: str = 'embedding_segment') -> List[float]:
        """
        Get text embeddings - Cache Master version
        cache_type: 'embedding_original' | 'embedding_segment' | 'no_cache'
        """
        # No cache cases (like user understanding text)
        if cache_type == 'no_cache':
            return self._call_embedding_api(text)
        
        cache_key = self.get_cache_key(cache_type, text)
        
        # Try cache read
        cached_embedding = self.get_cached_data(cache_key)
        if cached_embedding:
            return cached_embedding
        
        # Call API for embeddings
        embedding = self._call_embedding_api(text)
        
        # Cache results
        self.set_cached_data(cache_key, embedding, cache_type)
        
        return embedding
    
    def _call_embedding_api(self, text: str) -> List[float]:
        """Call Bedrock Titan Embeddings API"""
        try:
            bedrock = self._get_bedrock_client()
            
            body = json.dumps({
                "inputText": text,
                "dimensions": 1024,
                "normalize": True
            })
            
            response = bedrock.invoke_model(
                modelId="amazon.titan-embed-text-v2:0",
                body=body,
                contentType="application/json",
                accept="application/json"
            )
            
            response_body = json.loads(response['body'].read())
            return response_body['embedding']
            
        except Exception as e:
            logger.error(f"Embedding API error: {e}")
            raise
    
    def calculate_cosine_similarity(self, vec1: List[float], vec2: List[float]) -> float:
        """Calculate cosine similarity"""
        import math
        
        dot_product = sum(a * b for a, b in zip(vec1, vec2))
        magnitude1 = math.sqrt(sum(a * a for a in vec1))
        magnitude2 = math.sqrt(sum(a * a for a in vec2))
        
        if magnitude1 == 0 or magnitude2 == 0:
            return 0.0
        
        return dot_product / (magnitude1 * magnitude2)
    
    def analyze_comprehension(self, original_text: str, user_understanding: str, context: str = None, auto_extract_context: bool = False) -> Dict[str, Any]:
        """
        Optimized understanding analysis - smarter Claude trigger logic
        Skeleton extraction is handled separately via skeleton-only API
        """
        logger.info("Starting comprehension analysis...")
        
        # Auto-extract context if requested and not provided
        extracted_context_info = None
        if auto_extract_context and not context:
            context_result = self.extract_context_automatically(original_text)
            context = context_result["extracted_context"]
            extracted_context_info = context_result["context_details"]
            logger.info(f"Auto-extracted context: {context}")
        
        # 1. Text segmentation (high-value cache - 30 days)
        segments = self.segment_text(original_text)
        logger.info(f"Segmented into {len(segments)} parts")
        
        # Note: Skeleton extraction is now handled separately via skeleton-only API
        
        # 3. User understanding embeddings (no cache - personalized content)
        enhanced_user_text = self._enhance_user_understanding(user_understanding, context)
        user_embedding = self.get_text_embedding(enhanced_user_text, cache_type='no_cache')
        
        # 4. Calculate segment similarities
        segment_similarities = []
        for i, segment in enumerate(segments):
            # Cache strategy decision:
            # - Original segments without context: use 'embedding_original' (30-day cache)
            # - Enhanced segments with context: use 'embedding_segment' (7-day cache)
            
            if context:
                enhanced_segment = self._enhance_segment_with_context(segment['text'], original_text, context)
                segment_embedding = self.get_text_embedding(enhanced_segment, cache_type='embedding_segment')
            else:
                # Original segment embeddings - highest value cache
                segment_embedding = self.get_text_embedding(segment['text'], cache_type='embedding_original')
            
            similarity = self.calculate_cosine_similarity(user_embedding, segment_embedding)
            
            # Classify similarity levels
            level, color = self._classify_similarity(similarity)
            
            segment_similarities.append({
                **segment,
                "similarity": float(similarity),
                "level": level,
                "color": color
            })
            
            logger.info(f"Segment {i+1}: similarity={similarity:.3f}, level={level}")
        
        # 5. Calculate overall similarity
        overall_similarity = sum(s['similarity'] for s in segment_similarities) / len(segment_similarities)
        
        # 6. Smartly determine if Claude detailed feedback is needed
        needs_claude_feedback = self._should_trigger_claude_feedback(
            overall_similarity, 
            segment_similarities, 
            user_understanding, 
            original_text
        )
        
        # 7. Generate suggestions
        suggestions = self._generate_smart_suggestions(segment_similarities, overall_similarity)
        
        logger.info(f"Analysis complete. Overall similarity: {overall_similarity:.3f}, Needs Claude: {needs_claude_feedback}")
        
        result = {
            "overall_similarity": float(overall_similarity),
            "segments": segment_similarities,
            "suggestions": suggestions,
            "needs_detailed_feedback": needs_claude_feedback,
            "context_used": context is not None and len(context.strip()) > 0,
            "analysis_stats": {
                "total_segments": len(segments),
                "high_similarity_count": len([s for s in segment_similarities if s['similarity'] >= 0.8]),
                "medium_similarity_count": len([s for s in segment_similarities if s['similarity'] >= 0.4]),
                "low_similarity_count": len([s for s in segment_similarities if s['similarity'] < 0.4])
            }
        }
        
        # Add extracted context information (if any)
        if extracted_context_info:
            result["extracted_context"] = extracted_context_info
        
        return result
    
    def _should_trigger_claude_feedback(self, overall_similarity: float, segments: List[Dict], 
                                  user_understanding: str, original_text: str) -> bool:
        """
        Smart trigger logic: only call Claude's sharp analysis when really needed
        """
        
        # Basic statistics
        very_low_segments = len([s for s in segments if s['similarity'] < 0.2])
        low_segments = len([s for s in segments if s['similarity'] < 0.4])
        total_segments = len(segments)
        
        user_word_count = len(user_understanding.split())
        original_word_count = len(original_text.split())
        length_ratio = user_word_count / max(original_word_count, 1)
        
        # Condition 1: Very low similarity and short understanding - really not understood, need sharp guidance
        if overall_similarity < 0.25 and user_word_count < 8:
            logger.info("Trigger Claude: Very low similarity + short understanding - needs sharp analysis")
            return True
        
        # Condition 2: Most segments are very poor - there are fundamental problems with understanding, need deep analysis
        if very_low_segments > total_segments * 0.6:
            logger.info("Trigger Claude: Most segments very poor - needs detailed feedback")
            return True
        
        # Condition 3: Low similarity + abnormal understanding length - possibly systemic understanding problems
        if overall_similarity < 0.3 and (length_ratio < 0.25 or length_ratio > 4.0):
            logger.info("Trigger Claude: Low similarity + abnormal length - needs analysis")
            return True
        
        # Condition 4: User specifically requests strict analysis (determined by special markers)
        # Can be triggered by adding special keywords to understanding
        if "详细分析" in user_understanding or "detailed analysis" in user_understanding.lower():
            logger.info("Trigger Claude: User requested detailed analysis")
            return True
        
        # Other cases: low similarity but possibly just different expression, don't waste API calls
        logger.info(f"Skip Claude: Similarity {overall_similarity:.3f}, likely just different expression")
        return False
    
    def _classify_similarity(self, similarity: float) -> Tuple[str, str]:
        if similarity >= 0.75:
            return "excellent", "#059669"
        elif similarity >= 0.55:
            return "good", "#16a34a"  
        elif similarity >= 0.35:
            return "fair", "#ca8a04"
        elif similarity >= 0.25:
            return "partial", "#ea580c"
        else:
            return "poor", "transparent"
    
    def _enhance_user_understanding(self, user_understanding: str, context: str = None) -> str:
        """Enhance user understanding text"""
        if not context:
            return user_understanding
        return f"Context: {context}. My understanding: {user_understanding}"
    
    def _enhance_segment_with_context(self, segment_text: str, full_text: str, context: str = None) -> str:
        """Add context to text segments"""
        enhanced_text = segment_text
        
        if context:
            enhanced_text = f"Article context: {context}. Segment: {segment_text}"
        
        # Add simple surrounding context (optional optimization)
        segment_pos = full_text.find(segment_text)
        if segment_pos > 20:
            prefix = full_text[max(0, segment_pos-30):segment_pos].strip()
            if prefix:
                enhanced_text = f"...{prefix} {enhanced_text}"
        
        return enhanced_text
    
    def _generate_smart_suggestions(self, segments: List[Dict], overall_similarity: float) -> List[str]:
        """
        Generate smart suggestions - provide better generic suggestions for non-Claude cases
        """
        suggestions = []
        
        poor_segments = [s for s in segments if s['similarity'] < 0.4]
        excellent_segments = [s for s in segments if s['similarity'] >= 0.8]
        
        # Provide different suggestions based on similarity level
        if overall_similarity >= 0.6:
            suggestions.append("Excellent understanding! You've grasped the key concepts well")
        elif overall_similarity >= 0.4:
            suggestions.append("Good comprehension of the main ideas")
            if len(poor_segments) > 0:
                suggestions.append("Consider including more specific details from the original text")
        elif overall_similarity >= 0.25:
            # Medium-low similarity: possibly different expression
            suggestions.extend([
                "Your understanding may be correct but expressed differently",
                "Try using more specific terms from the original text for better matching",
                "Consider the author's exact examples and key phrases"
            ])
        else:
            # Very low similarity: may need re-understanding
            suggestions.extend([
                "Consider rereading the text to ensure you've captured the main points",
                "Focus on the core message and key supporting details",
                "Try to identify the author's primary argument or thesis"
            ])
        
        return suggestions[:3]  # Limit suggestion count
    
    def get_detailed_feedback_from_claude(self, original_text: str, user_understanding: str, analysis_result: Dict) -> Dict[str, Any]:
        """Get detailed feedback from Claude 3 Haiku"""
        try:
            bedrock = self._get_bedrock_client()
            
            # Build focused prompt with key missed segments
            poor_segments = [s for s in analysis_result['segments'] if s['similarity'] < 0.4]
            missed_content = [s['text'][:100] for s in poor_segments[:2]]  # Top 2 missed segments, truncated
            
            system_prompt = "You are a reading comprehension expert. Analyze user understanding and provide actionable feedback in valid JSON format only."
            
            user_content = f"""Analyze this text and extract context:

    Original: {original_text[:400]}{"..." if len(original_text) > 400 else ""}

    User understanding: {user_understanding}

    Similarity score: {analysis_result['overall_similarity']:.2f}
    Missed segments: {missed_content}

    Provide JSON with:
    - misunderstandings: list of specific gaps
    - cognitive_level: current level (remember/understand/apply/analyze/evaluate/create)  
    - actionable_suggestions: 3 specific improvement tips
    - error_type: main issue (main_idea/evidence/details/attitude/logic/inference/evaluation)
    - bloom_taxonomy: Bloom's level"""
            
            body = json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 500,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_content}]
            })
            
            response = bedrock.invoke_model(
                body=body,
                modelId="anthropic.claude-3-haiku-20240307-v1:0"
            )
            
            response_body = json.loads(response.get('body').read())
            claude_response = response_body['content'][0]['text']
            
            try:
                return json.loads(claude_response)
            except json.JSONDecodeError:
                return {
                    "misunderstandings": ["Need more careful understanding of key points"],
                    "cognitive_level": "understand",
                    "actionable_suggestions": [
                        "Re-read focusing on main arguments", 
                        "Identify key supporting evidence",
                        "Note author's tone and attitude"
                    ],
                    "error_type": "main_idea",
                    "bloom_taxonomy": "understand"
                }
                
        except Exception as e:
            logger.error(f"Claude API error: {e}")
            return {
                "misunderstandings": ["General comprehension gap"],
                "cognitive_level": "understand", 
                "actionable_suggestions": [
                    "Read the text multiple times",
                    "Focus on key information and connections",
                    "Practice summarizing main points"
                ],
                "error_type": "comprehensive_understanding",
                "bloom_taxonomy": "understand"
            }

    def extract_sentence_skeleton(self, text: str) -> Dict[str, Any]:
        """
        Simplified sentence skeleton extraction - just simplify sentences by removing modifiers
        Use Nova Micro for cost-effective sentence simplification
        Cache strategy: Medium-high value cache, 14-day TTL
        """
        cache_key = self.get_cache_key('sentence_skeleton', text)
        
        # Try cache read
        cached_skeleton = self.get_cached_data(cache_key)
        if cached_skeleton:
            return cached_skeleton
        
        # Use Amazon Nova Micro for sentence simplification (faster and more cost-effective)
        try:
            bedrock = self._get_bedrock_client()
            
            # Simplified prompt - focus only on sentence simplification
            user_prompt = f"""Simplify the following text by removing unnecessary words while keeping the core meaning:

Original text: {text}

RULES:
1. Remove adjectives, adverbs, and unnecessary modifiers
2. Keep the main action and key nouns
3. Make sentences shorter and clearer
4. Preserve the original meaning

EXAMPLES:
"The students are studying very hard for their upcoming final exams" → "Students are studying for exams"
"She quickly finished all of her homework assignments" → "She finished homework"  
"The important meeting will definitely start soon" → "Meeting will start soon"

Return ONLY valid JSON, no markdown:

{{
  "sentences": [
    {{
      "original": "original sentence text",
      "skeleton": "simplified sentence"
    }}
  ]
}}"""

            response = bedrock.converse(
                modelId="amazon.nova-micro-v1:0",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "text": user_prompt
                            }
                        ]
                    }
                ],
                inferenceConfig={
                    "maxTokens": 400,
                    "temperature": 0.1
                }
            )
            
            # Parse Converse API response format
            if 'output' in response and 'message' in response['output']:
                message_content = response['output']['message']['content']
                if message_content and len(message_content) > 0:
                    nova_response = message_content[0].get('text', '')
                else:
                    nova_response = ""
            else:
                logger.warning(f"Unexpected Nova Micro response format: {list(response.keys())}")
                nova_response = str(response)
            
            # Clean the response - remove markdown formatting and extra whitespace
            cleaned_response = self._clean_nova_response(nova_response)
            
            try:
                skeleton_data = json.loads(cleaned_response)
                
                # Simple processing - just validate basic structure
                result = self._process_simplified_skeleton(skeleton_data, text)
                
                # Cache the result
                self.set_cached_data(cache_key, result, 'sentence_skeleton')
                
                logger.info(f"Sentence skeleton extraction completed: {len(result.get('sentences', []))} sentences")
                return result
                
            except json.JSONDecodeError as e:
                logger.warning(f"Failed to parse Nova Micro skeleton response: {e}")
                logger.warning(f"Raw response: {nova_response[:300]}...")
                logger.warning(f"Cleaned response: {cleaned_response[:300]}...")
                
                # Try to recover partial data from truncated response
                partial_result = self._try_simple_recovery(cleaned_response, text)
                if partial_result:
                    logger.info("Successfully recovered partial skeleton data")
                    return partial_result
                
                logger.warning("No partial recovery possible, using fallback skeleton")
                return self._create_simple_fallback_skeleton(text)
                
        except Exception as e:
            logger.error(f"Skeleton extraction error: {e}")
            return self._create_simple_fallback_skeleton(text)
    
    def _clean_nova_response(self, response: str) -> str:
        """
        Clean Nova Micro response by removing markdown formatting and extra content
        """
        if not response:
            return ""
        
        # Remove markdown code block markers
        cleaned = response.strip()
        
        # Remove ```json and ``` markers
        if cleaned.startswith('```json'):
            cleaned = cleaned[7:]  # Remove ```json
        elif cleaned.startswith('```'):
            cleaned = cleaned[3:]   # Remove ```
        
        if cleaned.endswith('```'):
            cleaned = cleaned[:-3]  # Remove trailing ```
        
        # Remove any leading/trailing whitespace
        cleaned = cleaned.strip()
        
        # Try to extract valid JSON if there's extra text
        # Look for { at the beginning of a line and } at the end
        import re
        json_match = re.search(r'^\s*(\{.*\})\s*$', cleaned, re.DOTALL)
        if json_match:
            cleaned = json_match.group(1)
        
        return cleaned
    
    def _try_simple_recovery(self, response: str, original_text: str) -> Dict[str, Any]:
        """
        Try to recover simple skeleton data from truncated/malformed response
        """
        try:
            import re
            
            # Try to find sentences array even if JSON is incomplete
            sentences_match = re.search(r'"sentences"\s*:\s*\[(.*)', response, re.DOTALL)
            if not sentences_match:
                return None
            
            sentences_content = sentences_match.group(1)
            
            # Try to extract individual sentence objects (simplified)
            sentence_objects = []
            
            # Look for complete sentence objects
            sentence_pattern = r'\{\s*"original"\s*:\s*"([^"]*)",\s*"skeleton"\s*:\s*"([^"]*)"[^}]*\}'
            matches = re.findall(sentence_pattern, sentences_content)
            
            for original, skeleton in matches:
                if original and skeleton:
                    sentence_objects.append({
                        'original': original,
                        'skeleton': skeleton,
                        'complexity_reduced': len(skeleton) < len(original)
                    })
            
            if sentence_objects:
                logger.info(f"Recovered {len(sentence_objects)} sentences from partial response")
                return {
                    'original_text': original_text,
                    'sentences': sentence_objects,
                    'total_sentences': len(sentence_objects),
                    'partial_recovery': True
                }
                
        except Exception as e:
            logger.warning(f"Simple recovery failed: {e}")
        
        return None
    
    def _process_simplified_skeleton(self, skeleton_data: Dict, original_text: str) -> Dict[str, Any]:
        """Simple skeleton data processing - just validate and clean"""
        
        # Ensure basic structure exists
        if 'sentences' not in skeleton_data:
            skeleton_data['sentences'] = []
        
        # Simple processing for each sentence
        processed_sentences = []
        for sentence_data in skeleton_data.get('sentences', []):
            original = sentence_data.get('original', '').strip()
            skeleton = sentence_data.get('skeleton', '').strip()
            
            # Basic validation
            if not skeleton:
                skeleton = original  # Use original if no skeleton provided
            
            processed_sentence = {
                'original': original,
                'skeleton': skeleton,
                'complexity_reduced': len(skeleton) < len(original) and len(skeleton) > 0
            }
            processed_sentences.append(processed_sentence)
        
        return {
            'original_text': original_text,
            'sentences': processed_sentences,
            'total_sentences': len(processed_sentences)
        }
    
    def _create_simple_fallback_skeleton(self, text: str) -> Dict[str, Any]:
        """Create simple fallback skeleton data when Nova Micro fails"""
        
        # Simple fallback: split by sentences and apply basic simplification
        sentences = re.split(r'[.!?。！？]', text)
        sentence_data = []
        
        for sentence in sentences:
            sentence = sentence.strip()
            if sentence:
                # Basic simplification: remove common filler words
                simplified = self._basic_simplify(sentence)
                
                sentence_data.append({
                    'original': sentence,
                    'skeleton': simplified,
                    'complexity_reduced': len(simplified) < len(sentence)
                })
        
        return {
            'original_text': text,
            'sentences': sentence_data,
            'total_sentences': len(sentence_data),
            'fallback_used': True
        }
    
    def _basic_simplify(self, sentence: str) -> str:
        """Apply basic text simplification rules"""
        
        # Remove common filler words and phrases
        filler_words = [
            'very', 'really', 'quite', 'extremely', 'incredibly', 'absolutely',
            'definitely', 'certainly', 'obviously', 'clearly', 'actually',
            'basically', 'essentially', 'literally', 'seriously'
        ]
        
        words = sentence.split()
        simplified_words = []
        
        for word in words:
            # Remove filler words (case insensitive)
            clean_word = word.lower().rstrip('.,!?')
            if clean_word not in filler_words:
                simplified_words.append(word)
        
        simplified = ' '.join(simplified_words)
        
        # If we removed too much, return original
        if len(simplified.split()) < 2:
            return sentence
        
        return simplified

def lambda_handler(event, context):
    """
    Concept Muncher Lambda Handler with Warm-up Support
    Comprehension Analysis Service with Semantic Similarity
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
                'service': 'concept-muncher'
            })
        }
    
    try:
        # Parse request
        if isinstance(event.get('body'), str):
            body = json.loads(event['body'])
        else:
            body = event.get('body', {})
        
        original_text = body.get('original_text', '')
        skeleton_only = body.get('skeleton_only', False)
        
        # Handle skeleton-only requests
        if skeleton_only:
            if not original_text:
                return {
                    'statusCode': 400,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps({
                        'error': 'Missing required field: original_text'
                    })
                }
        else:
            # For full concept analysis
            user_understanding = body.get('user_understanding', '')
            context = body.get('context', '')
            auto_extract_context = body.get('auto_extract_context', False)
            
            if not original_text or not user_understanding:
                return {
                    'statusCode': 400,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps({
                        'error': 'Missing required fields: original_text and user_understanding'
                    })
                }
        
        # Handle skeleton-only requests first (no rate limiting for lightweight skeleton extraction)
        if skeleton_only:
            logger.info('Processing skeleton-only request (no rate limiting)')
            
            try:
                # Initialize analyzer for skeleton extraction only
                analyzer = TextComprehensionAnalyzer()
                skeleton_result = analyzer.extract_sentence_skeleton(original_text)
                
                return {
                    'statusCode': 200,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps(skeleton_result, ensure_ascii=False)
                }
            except Exception as e:
                logger.error(f"Skeleton extraction failed: {e}")
                return {
                    'statusCode': 500,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps({
                        'error': 'Skeleton extraction failed',
                        'message': str(e)
                    })
                }
        
        # For full concept analysis - apply rate limiting
        user_id = extract_user_id_from_event(event)
        is_anonymous = is_anonymous_user(event)
        
        if is_anonymous:
            rate_limit_result = check_anonymous_user_rate_limit(user_id)
            if not rate_limit_result['allowed']:
                # Send metrics for rate limit hit
                send_custom_metrics('anonymous', rate_limit_hit=True)
                
                return {
                    'statusCode': 429,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps({
                        'error': 'Daily usage limit exceeded',
                        'message': 'Anonymous users are limited to 5 concept analyses per day',
                        'usage_count': rate_limit_result['current_count'],
                        'limit': rate_limit_result['daily_limit'],
                        'reset_time': rate_limit_result['reset_time'],
                        'error_code': 'RATE_LIMIT_EXCEEDED'
                    })
                }
        
        # Send custom metrics for user invocations (excluding warm-up)
        user_type = 'anonymous' if is_anonymous else 'registered'
        send_custom_metrics(user_type)
        
        # Simplified security validation - align with frontend limits
        # Frontend validates: ≥6 words, ≤1000 chars, valid content
        word_count = len(original_text.split())
        
        # Basic security checks with frontend-aligned limits
        if word_count < 5:  # Slightly lower than frontend minimum (6) for edge cases
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': 'Text too short for concept analysis',
                    'note': 'Frontend should ensure minimum word count'
                })
            }
        
        # Security check: prevent excessively long texts (cost protection)
        if len(original_text) > 1200:  # Slightly higher than frontend limit (1000)
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': 'Security check: Text exceeds safe length limit',
                    'note': 'Frontend validation should have caught this'
                })
            }
        
        # User understanding security check
        if len(user_understanding) > 2000:  # Reasonable limit for user input
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': 'Security check: User understanding too long'
                })
            }
        
        # Context security check (optional field)
        if context and len(context) > 500:  # Context should be brief
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': 'Security check: Context too long'
                })
            }
        
        # Initialize Text Comprehension analyzer
        analyzer = TextComprehensionAnalyzer()
        
        # Execute analysis
        start_time = time.time()
        analysis_result = analyzer.analyze_comprehension(
            original_text, 
            user_understanding, 
            context, 
            auto_extract_context
        )
        analysis_time = time.time() - start_time

        # Debugging
        logger.info(f"Overall similarity: {analysis_result['overall_similarity']}")
        logger.info(f"Needs detailed feedback: {analysis_result['needs_detailed_feedback']}")
        
        # If detailed feedback needed, call Claude
        if analysis_result['needs_detailed_feedback']:
            logger.info("Calling Claude API for detailed feedback")
            try:
                detailed_feedback = analyzer.get_detailed_feedback_from_claude(
                    original_text, user_understanding, analysis_result
                )
                logger.info(f"Claude feedback received: {json.dumps(detailed_feedback)}")
                analysis_result['detailed_feedback'] = detailed_feedback
            except Exception as e:
                logger.error(f"Claude feedback failed: {e}")

        # Record usage for anonymous users (after successful analysis)
        if is_anonymous:
            record_anonymous_user_usage(user_id)

        # Record cognitive data asynchronously
        try:
            if user_id:
                # Prepare comprehensive analysis data for cognitive profiling
                cognitive_analysis_data = {
                    'original_text': original_text,
                    'user_understanding': user_understanding,
                    'context': context,
                    'analysis_result': analysis_result,
                    'url': body.get('url', ''),
                    'title': body.get('title', ''),
                    'timestamp': int(time.time())
                }
                
                # Send to cognitive profile service (async, non-blocking)
                record_cognitive_data_async(user_id, cognitive_analysis_data)
        except Exception as e:
            logger.warning(f"Cognitive data recording failed: {e}")
            # Don't fail the main request if cognitive recording fails

        
        # Add performance metrics
        analysis_result['performance'] = {
            'analysis_time_ms': round(analysis_time * 1000, 2),
            'segments_processed': len(analysis_result['segments'])
        }
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps(analysis_result, ensure_ascii=False)
        }
        
    except Exception as e:
        logger.error(f"Lambda handler error: {e}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'error': 'Internal server error',
                'message': str(e)
            })
        }
    
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

def check_anonymous_user_rate_limit(user_id):
    """Check if anonymous user has exceeded daily rate limit"""
    try:
        cache_table = get_cache_table()
        if not cache_table:
            logger.warning("Cache table not available, allowing request")
            return {'allowed': True, 'current_count': 0, 'daily_limit': 5, 'reset_time': get_tomorrow_timestamp()}
        
        # Generate today's rate limit key
        today = time.strftime('%Y-%m-%d')
        rate_limit_key = f"rate_limit_anonymous_{user_id}_{today}"
        
        # Try to get current usage count
        response = cache_table.get_item(Key={'cacheKey': rate_limit_key})
        
        current_count = 0
        if 'Item' in response:
            try:
                data = json.loads(response['Item']['data'])
                current_count = data.get('count', 0)
            except (json.JSONDecodeError, KeyError):
                current_count = 0
        
        daily_limit = 5
        allowed = current_count < daily_limit
        
        logger.info(f"Anonymous user {user_id[:8]}... usage check: {current_count}/{daily_limit}")
        
        return {
            'allowed': allowed,
            'current_count': current_count,
            'daily_limit': daily_limit,
            'reset_time': get_tomorrow_timestamp()
        }
        
    except Exception as e:
        logger.error(f"Rate limit check failed for user {user_id}: {e}")
        # On error, allow the request but log the issue
        return {'allowed': True, 'current_count': 0, 'daily_limit': 5, 'reset_time': get_tomorrow_timestamp()}

def record_anonymous_user_usage(user_id):
    """Record usage for anonymous user"""
    try:
        cache_table = get_cache_table()
        if not cache_table:
            logger.warning("Cache table not available, cannot record usage")
            return
        
        # Generate today's rate limit key
        today = time.strftime('%Y-%m-%d')
        rate_limit_key = f"rate_limit_anonymous_{user_id}_{today}"
        
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
                'model': 'anonymous_daily_limit'
            }
        )
        
        logger.info(f"Recorded usage for anonymous user {user_id[:8]}...: {new_count}/5")
        
    except Exception as e:
        logger.warning(f"Failed to record usage for anonymous user {user_id}: {e}")

def get_tomorrow_timestamp():
    """Get timestamp for tomorrow midnight (for TTL)"""
    tomorrow = datetime.datetime.now() + datetime.timedelta(days=1)
    tomorrow_midnight = tomorrow.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(tomorrow_midnight.timestamp())

def send_custom_metrics(user_type: str, rate_limit_hit: bool = False):
    """Send custom metrics to CloudWatch for analytics"""
    try:
        cloudwatch = get_cloudwatch_client()
        
        # Prepare metric data
        metric_data = [
            {
                'MetricName': 'UserInvocations',
                'Dimensions': [
                    {
                        'Name': 'Service',
                        'Value': 'concept-muncher'
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
                        'Name': 'Environment',
                        'Value': os.environ.get('ENVIRONMENT', 'dev')
                    }
                ],
                'Value': 1,
                'Unit': 'Count'
            })
        
        # Send metrics to CloudWatch
        cloudwatch.put_metric_data(
            Namespace='WordMunch/Analytics',
            MetricData=metric_data
        )
        
        logger.info(f"Sent custom metrics to CloudWatch: user_type={user_type}, rate_limit_hit={rate_limit_hit}")
        
    except Exception as e:
        logger.warning(f"Failed to send custom metrics to CloudWatch: {e}")