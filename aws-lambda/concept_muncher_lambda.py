import json
import boto3
import hashlib
import time
import re
import os
import threading
import logging
from typing import List, Dict, Tuple, Any
from decimal import Decimal


# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

def record_cognitive_data_async(user_id: str, analysis_data: Dict):
    """Asynchronously record cognitive data to the cognitive profile service"""
    def make_request():
        try:
            # Call the cognitive profile Lambda
            lambda_client = boto3.client('lambda', region_name='us-east-1')
            
            payload = {
                'action': 'record_analysis',
                'user_id': user_id,
                'analysis_data': analysis_data
            }
            
            # Invoke cognitive profile Lambda asynchronously
            lambda_client.invoke(
                FunctionName='cognitive-profile-lambda',  # Your cognitive Lambda function name
                InvocationType='Event',  # Async invocation
                Payload=json.dumps(payload)
            )
            
            logger.info(f"Cognitive data sent for user {user_id}")
            
        except Exception as e:
            logger.warning(f"Failed to send cognitive data: {e}")
    
    # Run in background thread to not block response
    thread = threading.Thread(target=make_request)
    thread.daemon = True
    thread.start()

class TextComprehensionAnalyzer:
    def __init__(self):
        self.bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')
        self.dynamodb = boto3.resource('dynamodb')
        self.cache_table_name = os.environ.get('CACHE_TABLE_NAME')
        self.cache_table = self.dynamodb.Table(self.cache_table_name) if self.cache_table_name else None
        self.cache_enabled = os.environ.get('CACHE_ENABLED', 'true').lower() == 'true'
        
        # Cache Master's tiered TTL strategy
        self.cache_ttl = {
            'embedding_original': 2592000,    # 30 days - Original text embeddings (highest value)
            'segments': 2592000,              # 30 days - Text segmentation results (high stability)
            'embedding_segment': 604800,      # 7 days - Segment embeddings (medium value)
        }
        
    def get_cache_key(self, prefix: str, content: str) -> str:
        """Generate standardized cache key"""
        content_hash = hashlib.md5(content.encode('utf-8')).hexdigest()
        return f"{prefix}_{content_hash}"
    
    def get_cached_data(self, cache_key: str) -> Any:
        """Generic cache read method"""
        if not (self.cache_enabled and self.cache_table):
            return None
            
        try:
            response = self.cache_table.get_item(Key={'cacheKey': cache_key})
            if 'Item' in response:
                logger.info(f"Cache HIT: {cache_key[:20]}...")
                return json.loads(response['Item']['data'])
        except Exception as e:
            logger.warning(f"Cache read error for {cache_key}: {e}")
        
        logger.info(f"Cache MISS: {cache_key[:20]}...")    
        return None
    
    def set_cached_data(self, cache_key: str, data: Any, ttl_type: str):
        """Generic cache write method"""
        if not (self.cache_enabled and self.cache_table):
            return
            
        try:
            ttl_seconds = self.cache_ttl.get(ttl_type, 604800)  # Default 7 days
            self.cache_table.put_item(
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
            
            response = self.bedrock.invoke_model(
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
            body = json.dumps({
                "inputText": text,
                "dimensions": 1024,
                "normalize": True
            })
            
            response = self.bedrock.invoke_model(
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
        
        # 2. User understanding embeddings (no cache - personalized content)
        enhanced_user_text = self._enhance_user_understanding(user_understanding, context)
        user_embedding = self.get_text_embedding(enhanced_user_text, cache_type='no_cache')
        
        # 3. Calculate segment similarities
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
        
        # 4. Calculate overall similarity
        overall_similarity = sum(s['similarity'] for s in segment_similarities) / len(segment_similarities)
        
        # 5. Smartly determine if Claude detailed feedback is needed
        needs_claude_feedback = self._should_trigger_claude_feedback(
            overall_similarity, 
            segment_similarities, 
            user_understanding, 
            original_text
        )
        
        # 6. Generate suggestions
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
            
            response = self.bedrock.invoke_model(
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

def lambda_handler(event, context):
    """
    Concept Muncher Lambda Handler
    Comprehension Analysis Service with Semantic Similarity
    """
    try:
        # Parse request
        if isinstance(event.get('body'), str):
            body = json.loads(event['body'])
        else:
            body = event.get('body', {})
        
        original_text = body.get('original_text', '')
        user_understanding = body.get('user_understanding', '')
        context = body.get('context', '')
        auto_extract_context = body.get('auto_extract_context', False)
        
        # Input validation
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
        
        # Validate text length
        if len(original_text.split()) < 10:
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': 'Original text must contain at least 10 words'
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

        # Record cognitive data asynchronously
        try:
            user_id = extract_user_id_from_event(event)
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
    
    if auth_header.startswith('Bearer '):
        return 'user_' + hashlib.md5(auth_header.encode()).hexdigest()[:8]
    
    user_ip = headers.get('X-Forwarded-For', headers.get('X-Real-IP', 'unknown'))
    return 'user_' + hashlib.md5(user_ip.encode()).hexdigest()[:8]