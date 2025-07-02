import json
import boto3
import hashlib
import time
import os
import uuid
from typing import List, Dict, Tuple, Any
from decimal import Decimal
from datetime import datetime, timezone
import logging

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

class CognitiveProfileService:
    def __init__(self):
        self.dynamodb = boto3.resource('dynamodb')
        self.cache_table_name = os.environ.get('CACHE_TABLE_NAME', 'word-munch-cache')
        self.cache_table = self.dynamodb.Table(self.cache_table_name)
        
        # TTL settings for cognitive data
        self.cognitive_data_ttl = 90 * 24 * 60 * 60  # 90 days
        self.profile_cache_ttl = 24 * 60 * 60        # 24 hours for aggregated profiles
        
    def record_analysis_result(self, user_id: str, analysis_data: Dict) -> Dict[str, Any]:
        """Record a single comprehension analysis result"""
        
        try:
            # Extract cognitive dimensions from the analysis data
            cognitive_metrics = self.extract_cognitive_dimensions(analysis_data)
            
            # Generate unique record ID
            record_id = f"cognitive_{user_id}_{int(time.time())}_{uuid.uuid4().hex[:8]}"
            
            # Build comprehensive cognitive record
            cognitive_record = {
                'user_id': user_id,
                'timestamp': int(time.time()),
                'date_string': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
                'week_string': datetime.now(timezone.utc).strftime('%Y-W%U'),
                'month_string': datetime.now(timezone.utc).strftime('%Y-%m'),
                
                # Core analysis metrics
                'overall_similarity': analysis_data.get('overall_similarity', 0),
                'segment_count': len(analysis_data.get('segments', [])),
                'high_accuracy_segments': analysis_data.get('analysis_stats', {}).get('high_similarity_count', 0),
                'medium_accuracy_segments': analysis_data.get('analysis_stats', {}).get('medium_similarity_count', 0),
                'low_accuracy_segments': analysis_data.get('analysis_stats', {}).get('low_similarity_count', 0),
                
                # Cognitive dimensions
                **cognitive_metrics,
                
                # Text characteristics
                'text_word_count': len(analysis_data.get('original_text', '').split()),
                'text_complexity': self.calculate_text_complexity(analysis_data.get('original_text', '')),
                'text_domain': self.extract_text_domain(analysis_data),
                
                # User understanding characteristics
                'understanding_word_count': len(analysis_data.get('user_understanding', '').split()),
                'understanding_style': self.analyze_understanding_style(analysis_data.get('user_understanding', '')),
                
                # Bloom's taxonomy and cognitive classification
                'bloom_level': analysis_data.get('detailed_feedback', {}).get('bloom_taxonomy', 'understand'),
                'cognitive_level': analysis_data.get('detailed_feedback', {}).get('cognitive_level', 'understand'),
                'error_type': analysis_data.get('detailed_feedback', {}).get('error_type', 'none'),
                
                # Context and metadata
                'context_used': analysis_data.get('context_used', False),
                'url': analysis_data.get('url', ''),
                'title': analysis_data.get('title', ''),
                'suggestions': analysis_data.get('suggestions', [])
            }
            
            # Store in DynamoDB using your existing cache table structure
            self.cache_table.put_item(
                Item={
                    'cacheKey': record_id,
                    'data': json.dumps(cognitive_record, ensure_ascii=False),
                    'ttl': int(time.time()) + self.cognitive_data_ttl,
                    'timestamp': int(time.time()),
                    'provider': 'cognitive_profile',
                    'model': 'cognitive_analyzer_v1',
                    'createdAt': datetime.now(timezone.utc).isoformat()
                }
            )
            
            logger.info(f"Cognitive profile recorded for user {user_id}")
            
            # Invalidate cached profile for this user
            self.invalidate_user_profile_cache(user_id)
            
            return {
                'success': True,
                'record_id': record_id,
                'cognitive_metrics': cognitive_metrics
            }
            
        except Exception as e:
            logger.error(f"Failed to record cognitive profile: {e}")
            return {
                'success': False,
                'error': str(e)
            }
    
    def get_user_cognitive_profile(self, user_id: str, days: int = 30) -> Dict[str, Any]:
        """Get comprehensive cognitive profile for a user"""
        
        try:
            # Check for cached profile first
            cached_profile = self.get_cached_profile(user_id, days)
            if cached_profile:
                logger.info(f"Returning cached profile for user {user_id}")
                return cached_profile
            
            # Query user's cognitive records
            records = self.query_user_records(user_id, days)
            
            if not records:
                logger.info(f"No records found for user {user_id}, returning default profile")
                return self.get_default_profile()
            
            # Calculate comprehensive profile statistics
            profile = self.calculate_comprehensive_profile(records, days)
            
            # Cache the calculated profile
            self.cache_user_profile(user_id, days, profile)
            
            logger.info(f"Generated cognitive profile for user {user_id} with {len(records)} records")
            return profile
            
        except Exception as e:
            logger.error(f"Failed to get cognitive profile for user {user_id}: {e}")
            return self.get_default_profile()
    
    def extract_cognitive_dimensions(self, analysis_data: Dict) -> Dict:
        """Extract cognitive dimension metrics from analysis data"""
        
        segments = analysis_data.get('segments', [])
        original_text = analysis_data.get('original_text', '')
        user_understanding = analysis_data.get('user_understanding', '')
        
        # Coverage analysis
        coverage_metrics = self.analyze_coverage(segments)
        
        # Depth analysis
        depth_metrics = self.analyze_depth(analysis_data, user_understanding)
        
        # Accuracy analysis
        accuracy_metrics = self.analyze_accuracy(segments)
        
        # Pattern analysis
        pattern_metrics = self.analyze_patterns(segments, user_understanding)
        
        return {
            # Coverage metrics (0-1 scale)
            'coverage_score': coverage_metrics['coverage_score'],
            'missed_key_points': coverage_metrics['missed_key_points'],
            'covered_key_points': coverage_metrics['covered_key_points'],
            
            # Depth metrics
            'depth_level': depth_metrics['depth_level'],
            'depth_score': depth_metrics['depth_score'],
            'has_inferences': depth_metrics['has_inferences'],
            'has_analysis': depth_metrics['has_analysis'],
            'has_critical_thinking': depth_metrics['has_critical_thinking'],
            
            # Accuracy metrics
            'accuracy_score': accuracy_metrics['accuracy_score'],
            'misconceptions': accuracy_metrics['misconceptions'],
            'partial_understandings': accuracy_metrics['partial_understandings'],
            
            # Pattern metrics
            'understanding_pattern': pattern_metrics['understanding_pattern'],
            'consistency_score': pattern_metrics['consistency_score'],
            'improvement_potential': pattern_metrics['improvement_potential']
        }
    
    def analyze_coverage(self, segments: List[Dict]) -> Dict:
        """Analyze how well user covers the content"""
        if not segments:
            return {'coverage_score': 0, 'missed_key_points': 0, 'covered_key_points': 0}
        
        high_sim = len([s for s in segments if s.get('similarity', 0) >= 0.7])
        medium_sim = len([s for s in segments if 0.4 <= s.get('similarity', 0) < 0.7])
        low_sim = len([s for s in segments if s.get('similarity', 0) < 0.4])
        
        total = len(segments)
        coverage_score = (high_sim + medium_sim * 0.5) / total
        
        return {
            'coverage_score': min(1.0, coverage_score),
            'missed_key_points': low_sim,
            'covered_key_points': high_sim
        }
    
    def analyze_depth(self, analysis_data: Dict, user_understanding: str) -> Dict:
        """Analyze thinking depth"""
        text_lower = user_understanding.lower()
        
        # Keyword indicators for different depth levels
        inference_words = ['because', 'therefore', 'implies', 'suggests', 'leads to', 'results in', 'consequently', 'thus', 'hence']
        analysis_words = ['analyze', 'compare', 'contrast', 'evaluate', 'assess', 'examine', 'relationship', 'pattern', 'structure']
        critical_words = ['however', 'although', 'despite', 'nevertheless', 'on the other hand', 'critique', 'limitation', 'weakness', 'problem', 'flaw']
        synthesis_words = ['connect', 'combine', 'integrate', 'overall', 'conclusion', 'implication', 'broader', 'significance']
        
        has_inferences = any(word in text_lower for word in inference_words)
        has_analysis = any(word in text_lower for word in analysis_words)
        has_critical = any(word in text_lower for word in critical_words)
        has_synthesis = any(word in text_lower for word in synthesis_words)
        
        # Determine depth level based on Bloom's taxonomy
        bloom_level = analysis_data.get('detailed_feedback', {}).get('bloom_taxonomy', 'understand')
        depth_scores = {
            'remember': 0.2,
            'understand': 0.4,
            'apply': 0.6,
            'analyze': 0.8,
            'evaluate': 0.9,
            'create': 1.0
        }
        
        base_score = depth_scores.get(bloom_level, 0.4)
        
        # Adjust based on language indicators
        if has_critical or has_synthesis:
            depth_score = min(1.0, base_score + 0.2)
            depth_level = 'critical'
        elif has_analysis:
            depth_score = min(1.0, base_score + 0.1)
            depth_level = 'deep'
        elif has_inferences:
            depth_score = base_score
            depth_level = 'surface'
        else:
            depth_score = max(0.1, base_score - 0.1)
            depth_level = 'shallow'
        
        return {
            'depth_level': depth_level,
            'depth_score': depth_score,
            'has_inferences': has_inferences,
            'has_analysis': has_analysis,
            'has_critical_thinking': has_critical or has_synthesis
        }
    
    def analyze_accuracy(self, segments: List[Dict]) -> Dict:
        """Analyze understanding accuracy"""
        if not segments:
            return {'accuracy_score': 0, 'misconceptions': 0, 'partial_understandings': 0}
        
        excellent = len([s for s in segments if s.get('similarity', 0) >= 0.8])
        good = len([s for s in segments if 0.6 <= s.get('similarity', 0) < 0.8])
        partial = len([s for s in segments if 0.3 <= s.get('similarity', 0) < 0.6])
        poor = len([s for s in segments if s.get('similarity', 0) < 0.3])
        
        total = len(segments)
        accuracy_score = (excellent + good * 0.8 + partial * 0.4) / total
        
        return {
            'accuracy_score': min(1.0, accuracy_score),
            'misconceptions': poor,
            'partial_understandings': partial
        }
    
    def analyze_patterns(self, segments: List[Dict], user_understanding: str) -> Dict:
        """Analyze understanding patterns and consistency"""
        if not segments:
            return {'understanding_pattern': 'balanced', 'consistency_score': 0, 'improvement_potential': 0.5}
        
        similarities = [s.get('similarity', 0) for s in segments]
        avg_sim = sum(similarities) / len(similarities)
        variance = sum((x - avg_sim) ** 2 for x in similarities) / len(similarities)
        
        # Determine pattern
        if variance > 0.15:  # High variance
            high_sim_count = len([s for s in similarities if s > avg_sim + 0.2])
            if high_sim_count > len(similarities) * 0.4:
                pattern = 'detail-focused'
            else:
                pattern = 'big-picture'
        else:
            pattern = 'balanced'
        
        # Calculate consistency
        consistency_score = 1.0 - min(variance * 2, 1.0)
        
        # Calculate improvement potential
        if avg_sim < 0.3:
            improvement_potential = 0.9
        elif avg_sim < 0.6:
            improvement_potential = 0.7
        elif avg_sim < 0.8:
            improvement_potential = 0.4
        else:
            improvement_potential = 0.2
        
        return {
            'understanding_pattern': pattern,
            'consistency_score': consistency_score,
            'improvement_potential': improvement_potential
        }
    
    def calculate_text_complexity(self, text: str) -> str:
        """Calculate text complexity level"""
        if not text:
            return 'simple'
        
        words = text.split()
        if not words:
            return 'simple'
        
        avg_word_length = sum(len(word.strip('.,!?;:')) for word in words) / len(words)
        sentence_count = len([s for s in text.split('.') if s.strip()])
        avg_sentence_length = len(words) / max(sentence_count, 1)
        
        # Simple complexity scoring
        complexity_score = (avg_word_length * 0.4) + (avg_sentence_length * 0.1)
        
        if complexity_score < 6:
            return 'simple'
        elif complexity_score < 9:
            return 'medium'
        else:
            return 'complex'
    
    def extract_text_domain(self, analysis_data: Dict) -> str:
        """Extract text domain"""
        extracted_context = analysis_data.get('extracted_context', {})
        if isinstance(extracted_context, dict):
            context_details = extracted_context.get('context_details', {})
            return context_details.get('domain', 'general')
        return 'general'
    
    def analyze_understanding_style(self, user_understanding: str) -> str:
        """Analyze user's understanding expression style"""
        text_lower = user_understanding.lower()
        
        detail_words = ['specific', 'detail', 'example', 'instance', 'particular', 'precisely']
        big_picture_words = ['overall', 'general', 'main', 'summary', 'broadly', 'essentially']
        analytical_words = ['analyze', 'compare', 'relationship', 'pattern', 'structure', 'logic']
        narrative_words = ['story', 'narrative', 'describes', 'tells', 'explains', 'shows']
        
        if any(word in text_lower for word in detail_words):
            return 'detail-oriented'
        elif any(word in text_lower for word in big_picture_words):
            return 'big-picture'
        elif any(word in text_lower for word in analytical_words):
            return 'analytical'
        elif any(word in text_lower for word in narrative_words):
            return 'narrative'
        else:
            return 'descriptive'
    
    def query_user_records(self, user_id: str, days: int) -> List[Dict]:
        """Query user's cognitive records from DynamoDB"""
        cutoff_timestamp = int(time.time()) - (days * 24 * 60 * 60)
        
        try:
            # Scan for cognitive profile records for this user
            response = self.cache_table.scan(
                FilterExpression='begins_with(cacheKey, :prefix) AND #provider = :provider AND #ts >= :cutoff',
                ExpressionAttributeNames={
                    '#ts': 'timestamp',
                    '#provider': 'provider'
                },
                ExpressionAttributeValues={
                    ':prefix': f'cognitive_{user_id}_',
                    ':provider': 'cognitive_profile',
                    ':cutoff': cutoff_timestamp
                }
            )
            
            records = []
            for item in response.get('Items', []):
                try:
                    data = json.loads(item['data'])
                    records.append(data)
                except (json.JSONDecodeError, KeyError) as e:
                    logger.warning(f"Failed to parse cognitive record: {e}")
                    continue
            
            # Sort by timestamp (newest first)
            records.sort(key=lambda x: x.get('timestamp', 0), reverse=True)
            
            return records
            
        except Exception as e:
            logger.error(f"Failed to query user records: {e}")
            return []
    
    def calculate_comprehensive_profile(self, records: List[Dict], days: int) -> Dict:
        """Calculate comprehensive cognitive profile statistics"""
        
        total_analyses = len(records)
        
        # Basic cognitive metrics
        avg_similarity = sum(r.get('overall_similarity', 0) for r in records) / total_analyses
        avg_coverage = sum(r.get('coverage_score', 0) for r in records) / total_analyses
        avg_depth = sum(r.get('depth_score', 0) for r in records) / total_analyses
        avg_accuracy = sum(r.get('accuracy_score', 0) for r in records) / total_analyses
        
        # Advanced metrics
        analysis_score = self.calculate_analysis_capability(records)
        synthesis_score = self.calculate_synthesis_capability(records)
        
        # Cognitive radar data
        radar_data = {
            'comprehension': round(avg_similarity * 100, 1),
            'coverage': round(avg_coverage * 100, 1),
            'depth': round(avg_depth * 100, 1),
            'accuracy': round(avg_accuracy * 100, 1),
            'analysis': round(analysis_score * 100, 1),
            'synthesis': round(synthesis_score * 100, 1)
        }
        
        # Growth analysis
        growth_trend = self.calculate_growth_trend(records)
        
        # Strengths and weaknesses
        strengths_weaknesses = self.identify_strengths_weaknesses(radar_data)
        
        # Bloom's taxonomy distribution
        bloom_distribution = self.calculate_bloom_distribution(records)
        
        # Error pattern analysis
        error_patterns = self.analyze_error_patterns(records)
        
        # Generate personalized suggestions
        suggestions = self.generate_personalized_suggestions(radar_data, error_patterns, records)
        
        return {
            'total_analyses': total_analyses,
            'days_covered': days,
            'last_analysis': max(r.get('timestamp', 0) for r in records),
            'analysis_period': {
                'start_date': min(r.get('date_string', '') for r in records),
                'end_date': max(r.get('date_string', '') for r in records)
            },
            
            # Core cognitive metrics
            'cognitive_radar': radar_data,
            
            # Growth and development
            'growth_trend': growth_trend,
            'improvement_rate': self.calculate_improvement_rate(records),
            
            # Strengths and development areas
            'strengths': strengths_weaknesses['strengths'],
            'weaknesses': strengths_weaknesses['weaknesses'],
            
            # Learning patterns
            'bloom_distribution': bloom_distribution,
            'learning_patterns': self.analyze_learning_patterns(records),
            
            # Error analysis and suggestions
            'error_patterns': error_patterns,
            'personalized_suggestions': suggestions,
            
            # Performance trends
            'performance_trends': self.calculate_performance_trends(records),
            'consistency_metrics': self.calculate_consistency_metrics(records)
        }
    
    def calculate_analysis_capability(self, records: List[Dict]) -> float:
        """Calculate analytical thinking capability"""
        total_score = 0
        
        for record in records:
            depth_level = record.get('depth_level', 'shallow')
            has_analysis = record.get('has_analysis', False)
            bloom_level = record.get('bloom_level', 'understand')
            
            if depth_level == 'critical':
                total_score += 1.0
            elif depth_level == 'deep':
                total_score += 0.8
            elif has_analysis:
                total_score += 0.6
            elif bloom_level in ['analyze', 'evaluate', 'create']:
                total_score += 0.5
            else:
                total_score += 0.2
        
        return total_score / len(records) if records else 0
    
    def calculate_synthesis_capability(self, records: List[Dict]) -> float:
        """Calculate synthesis and integration capability"""
        total_score = 0
        
        for record in records:
            pattern = record.get('understanding_pattern', 'balanced')
            has_critical = record.get('has_critical_thinking', False)
            understanding_style = record.get('understanding_style', 'descriptive')
            
            if pattern == 'big-picture':
                total_score += 1.0
            elif has_critical:
                total_score += 0.8
            elif understanding_style == 'analytical':
                total_score += 0.7
            elif pattern == 'balanced':
                total_score += 0.6
            else:
                total_score += 0.3
        
        return total_score / len(records) if records else 0
    
    def calculate_growth_trend(self, records: List[Dict]) -> List[Dict]:
        """Calculate growth trend over time"""
        # Group records by date
        daily_stats = {}
        
        for record in records:
            date_str = record.get('date_string', '')
            if date_str not in daily_stats:
                daily_stats[date_str] = []
            daily_stats[date_str].append(record)
        
        # Calculate daily averages
        trend_data = []
        for date, day_records in sorted(daily_stats.items()):
            if not day_records:
                continue
                
            avg_similarity = sum(r.get('overall_similarity', 0) for r in day_records) / len(day_records)
            avg_depth = sum(r.get('depth_score', 0) for r in day_records) / len(day_records)
            avg_coverage = sum(r.get('coverage_score', 0) for r in day_records) / len(day_records)
            
            trend_data.append({
                'date': date,
                'similarity': round(avg_similarity * 100, 1),
                'depth': round(avg_depth * 100, 1),
                'coverage': round(avg_coverage * 100, 1),
                'count': len(day_records)
            })
        
        return trend_data[-14:]  # Return last 14 days
    
    def identify_strengths_weaknesses(self, radar_data: Dict) -> Dict:
        """Identify cognitive strengths and weaknesses"""
        items = list(radar_data.items())
        items.sort(key=lambda x: x[1], reverse=True)
        
        skill_names = {
            'comprehension': 'Reading Comprehension',
            'coverage': 'Information Coverage',
            'depth': 'Analytical Depth',
            'accuracy': 'Understanding Accuracy',
            'analysis': 'Logical Analysis',
            'synthesis': 'Synthesis Ability'
        }
        
        strengths = []
        weaknesses = []
        
        for skill, score in items:
            skill_name = skill_names.get(skill, skill.title())
            
            if score >= 80:
                strengths.append(f"Excellent {skill_name}")
            elif score >= 70:
                strengths.append(f"Strong {skill_name}")
            elif score < 50:
                weaknesses.append(f"Develop {skill_name}")
            elif score < 60:
                weaknesses.append(f"Improve {skill_name}")
        
        return {
            'strengths': strengths[:3],
            'weaknesses': weaknesses[:3]
        }
    
    def calculate_bloom_distribution(self, records: List[Dict]) -> Dict:
        """Calculate Bloom's taxonomy distribution"""
        bloom_counts = {}
        
        for record in records:
            bloom_level = record.get('bloom_level', 'understand')
            bloom_counts[bloom_level] = bloom_counts.get(bloom_level, 0) + 1
        
        return bloom_counts
    
    def analyze_error_patterns(self, records: List[Dict]) -> Dict:
        """Analyze common error patterns"""
        error_counts = {}
        total_errors = 0
        
        for record in records:
            error_type = record.get('error_type', 'none')
            if error_type != 'none':
                error_counts[error_type] = error_counts.get(error_type, 0) + 1
                total_errors += 1
        
        error_patterns = {}
        for error_type, count in error_counts.items():
            percentage = (count / total_errors * 100) if total_errors > 0 else 0
            error_patterns[error_type] = {
                'label': error_type.replace('_', ' ').title(),
                'count': count,
                'percentage': round(percentage, 1),
                'suggestion': self.get_error_suggestion(error_type)
            }
        
        return error_patterns
    
    def get_error_suggestion(self, error_type: str) -> str:
        """Get suggestion for specific error type"""
        suggestions = {
            'main_idea': 'Focus on identifying the central thesis and main arguments',
            'evidence': 'Pay closer attention to supporting details and examples',
            'details': 'Notice specific facts, figures, and concrete information',
            'attitude': 'Consider the author\'s tone, perspective, and stance',
            'logic': 'Trace cause-and-effect relationships and logical connections',
            'inference': 'Practice drawing conclusions from implied information',
            'evaluation': 'Develop critical thinking about the author\'s claims and reasoning'
        }
        return suggestions.get(error_type, 'Continue practicing active reading strategies')
    
    def generate_personalized_suggestions(self, radar_data: Dict, error_patterns: Dict, records: List[Dict]) -> List[Dict]:
        """Generate personalized improvement suggestions"""
        suggestions = []
        
        # Analyze weakest cognitive areas
        sorted_skills = sorted(radar_data.items(), key=lambda x: x[1])
        
        # Generate skill-based suggestions
        for skill, score in sorted_skills[:2]:
            if score < 70:
                suggestion = self.get_skill_suggestion(skill, score)
                if suggestion:
                    suggestions.append(suggestion)
        
        # Generate error-based suggestions
        if error_patterns:
            most_common_error = max(error_patterns.items(), key=lambda x: x[1]['count'])
            error_suggestion = self.get_error_specific_suggestion(most_common_error[0])
            if error_suggestion:
                suggestions.append(error_suggestion)
        
        # Generate pattern-based suggestions
        pattern_suggestion = self.get_pattern_suggestion(records)
        if pattern_suggestion:
            suggestions.append(pattern_suggestion)
        
        return suggestions[:3]
    
    def get_skill_suggestion(self, skill: str, score: float) -> Dict:
        """Get suggestion for improving specific skill"""
        suggestions = {
            'comprehension': {
                'icon': '🎯',
                'title': 'Boost Reading Comprehension',
                'description': 'Your overall understanding accuracy could be enhanced',
                'action': 'Practice the SQ3R method: Survey, Question, Read, Recite, Review'
            },
            'coverage': {
                'icon': '📋',
                'title': 'Improve Information Coverage',
                'description': 'You might be missing some key information',
                'action': 'Create concept maps while reading to ensure comprehensive coverage'
            },
            'depth': {
                'icon': '🔍',
                'title': 'Deepen Analytical Thinking',
                'description': 'Try to think more deeply about the content',
                'action': 'Ask "why," "how," and "what if" questions to develop deeper insights'
            },
            'accuracy': {
                'icon': '✅',
                'title': 'Enhance Understanding Precision',
                'description': 'Focus on precise comprehension of key concepts',
                'action': 'Pause after each paragraph to verify your understanding'
            },
            'analysis': {
                'icon': '🧐',
                'title': 'Strengthen Logical Analysis',
                'description': 'Develop your analytical reasoning skills',
                'action': 'Practice identifying relationships, patterns, and logical structures'
            },
            'synthesis': {
                'icon': '🔗',
                'title': 'Improve Synthesis Skills',
                'description': 'Work on connecting ideas and drawing conclusions',
                'action': 'Practice summarizing and linking different parts of the text'
            }
        }
        
        return suggestions.get(skill)
    
    def get_error_specific_suggestion(self, error_type: str) -> Dict:
        """Get suggestion for specific error pattern"""
        suggestions = {
            'main_idea': {
                'icon': '🎯',
                'title': 'Master Main Idea Recognition',
                'description': 'You often miss the central message',
                'action': 'Look for topic sentences and thesis statements first'
            },
            'evidence': {
                'icon': '📊',
                'title': 'Identify Supporting Evidence',
                'description': 'Practice recognizing how authors support their claims',
                'action': 'Distinguish between main points and supporting details'
            },
            'details': {
                'icon': '🔍',
                'title': 'Sharpen Attention to Detail',
                'description': 'Important details are sometimes overlooked',
                'action': 'Take notes of specific facts, figures, and examples while reading'
            }
        }
        
        return suggestions.get(error_type)
    
    def get_pattern_suggestion(self, records: List[Dict]) -> Dict:
        """Get suggestion based on learning patterns"""
        if not records:
            return None
        
        # Analyze recent performance trends
        recent_records = records[:5]  # Last 5 analyses
        avg_recent_similarity = sum(r.get('overall_similarity', 0) for r in recent_records) / len(recent_records)
        
        if avg_recent_similarity > 0.8:
            return {
                'icon': '🚀',
                'title': 'Challenge Yourself Further',
                'description': 'Your recent performance has been excellent',
                'action': 'Try analyzing more complex texts to continue growing'
            }
        elif avg_recent_similarity < 0.4:
            return {
                'icon': '📚',
                'title': 'Build Strong Foundations',
                'description': 'Focus on fundamentals to improve consistency',
                'action': 'Practice with shorter, simpler texts before tackling complex material'
            }
        
        return None
    
    def calculate_improvement_rate(self, records: List[Dict]) -> float:
        """Calculate rate of improvement over time"""
        if len(records) < 5:
            return 0.0
        
        # Compare first half vs second half performance
        mid_point = len(records) // 2
        early_records = records[mid_point:]  # Older records (reversed order)
        recent_records = records[:mid_point]  # Newer records
        
        early_avg = sum(r.get('overall_similarity', 0) for r in early_records) / len(early_records)
        recent_avg = sum(r.get('overall_similarity', 0) for r in recent_records) / len(recent_records)
        
        improvement = recent_avg - early_avg
        return round(improvement * 100, 1)  # Return as percentage
    
    def analyze_learning_patterns(self, records: List[Dict]) -> Dict:
        """Analyze user's learning patterns"""
        if not records:
            return {}
        
        # Time-based patterns
        time_patterns = self.analyze_time_patterns(records)
        
        # Complexity preferences
        complexity_patterns = self.analyze_complexity_patterns(records)
        
        # Domain patterns
        domain_patterns = self.analyze_domain_patterns(records)
        
        return {
            'time_patterns': time_patterns,
            'complexity_preferences': complexity_patterns,
            'domain_patterns': domain_patterns
        }
    
    def analyze_time_patterns(self, records: List[Dict]) -> Dict:
        """Analyze when user performs best"""
        # This is a simplified version - in reality you'd analyze hour/day patterns
        return {
            'most_active_days': 'weekdays',
            'consistency_score': 0.7,
            'analysis_frequency': len(records) / 30  # analyses per day
        }
    
    def analyze_complexity_patterns(self, records: List[Dict]) -> Dict:
        """Analyze performance with different text complexities"""
        complexity_performance = {}
        
        for record in records:
            complexity = record.get('text_complexity', 'medium')
            similarity = record.get('overall_similarity', 0)
            
            if complexity not in complexity_performance:
                complexity_performance[complexity] = []
            complexity_performance[complexity].append(similarity)
        
        # Calculate averages
        complexity_averages = {}
        for complexity, scores in complexity_performance.items():
            complexity_averages[complexity] = sum(scores) / len(scores)
        
        return complexity_averages
    
    def analyze_domain_patterns(self, records: List[Dict]) -> Dict:
        """Analyze performance across different domains"""
        domain_performance = {}
        
        for record in records:
            domain = record.get('text_domain', 'general')
            similarity = record.get('overall_similarity', 0)
            
            if domain not in domain_performance:
                domain_performance[domain] = []
            domain_performance[domain].append(similarity)
        
        # Calculate averages
        domain_averages = {}
        for domain, scores in domain_performance.items():
            domain_averages[domain] = sum(scores) / len(scores)
        
        return domain_averages
    
    def calculate_performance_trends(self, records: List[Dict]) -> Dict:
        """Calculate various performance trend metrics"""
        if len(records) < 3:
            return {}
        
        # Recent vs overall performance
        recent_records = records[:5]
        overall_avg = sum(r.get('overall_similarity', 0) for r in records) / len(records)
        recent_avg = sum(r.get('overall_similarity', 0) for r in recent_records) / len(recent_records)
        
        # Consistency trend
        similarities = [r.get('overall_similarity', 0) for r in records]
        consistency = 1.0 - (max(similarities) - min(similarities))
        
        return {
            'overall_average': round(overall_avg * 100, 1),
            'recent_average': round(recent_avg * 100, 1),
            'trend_direction': 'improving' if recent_avg > overall_avg else 'stable' if abs(recent_avg - overall_avg) < 0.05 else 'declining',
            'consistency_score': round(consistency * 100, 1)
        }
    
    def calculate_consistency_metrics(self, records: List[Dict]) -> Dict:
        """Calculate consistency metrics across different dimensions"""
        if not records:
            return {}
        
        # Similarity consistency
        similarities = [r.get('overall_similarity', 0) for r in records]
        sim_variance = sum((x - sum(similarities)/len(similarities))**2 for x in similarities) / len(similarities)
        
        # Depth consistency
        depths = [r.get('depth_score', 0) for r in records]
        depth_variance = sum((x - sum(depths)/len(depths))**2 for x in depths) / len(depths)
        
        return {
            'similarity_consistency': round((1.0 - min(sim_variance * 4, 1.0)) * 100, 1),
            'depth_consistency': round((1.0 - min(depth_variance * 4, 1.0)) * 100, 1),
            'overall_consistency': round((1.0 - min((sim_variance + depth_variance) * 2, 1.0)) * 100, 1)
        }
    
    def get_cached_profile(self, user_id: str, days: int) -> Dict:
        """Get cached profile if available and fresh"""
        cache_key = f"profile_cache_{user_id}_{days}"
        
        try:
            response = self.cache_table.get_item(Key={'cacheKey': cache_key})
            if 'Item' in response:
                cached_data = json.loads(response['Item']['data'])
                cache_time = response['Item'].get('timestamp', 0)
                
                # Check if cache is fresh (within 6 hours)
                if time.time() - cache_time < 6 * 60 * 60:
                    return cached_data
                    
        except Exception as e:
            logger.warning(f"Failed to get cached profile: {e}")
        
        return None
    
    def cache_user_profile(self, user_id: str, days: int, profile: Dict):
        """Cache calculated profile"""
        cache_key = f"profile_cache_{user_id}_{days}"
        
        try:
            self.cache_table.put_item(
                Item={
                    'cacheKey': cache_key,
                    'data': json.dumps(profile, ensure_ascii=False),
                    'ttl': int(time.time()) + self.profile_cache_ttl,
                    'timestamp': int(time.time()),
                    'provider': 'cognitive_profile_cache',
                    'model': 'profile_aggregator_v1'
                }
            )
            logger.info(f"Cached profile for user {user_id}")
            
        except Exception as e:
            logger.warning(f"Failed to cache profile: {e}")
    
    def invalidate_user_profile_cache(self, user_id: str):
        """Invalidate cached profiles for a user"""
        try:
            # Remove cached profiles for all time periods
            for days in [7, 30, 90]:
                cache_key = f"profile_cache_{user_id}_{days}"
                self.cache_table.delete_item(
                    Key={'cacheKey': cache_key},
                    ConditionExpression='attribute_exists(cacheKey)'
                )
                
        except Exception as e:
            logger.warning(f"Failed to invalidate cache for user {user_id}: {e}")
    
    def get_default_profile(self) -> Dict:
        """Return default profile for new users"""
        return {
            'total_analyses': 0,
            'days_covered': 0,
            'last_analysis': None,
            'analysis_period': {
                'start_date': '',
                'end_date': ''
            },
            'cognitive_radar': {
                'comprehension': 50,
                'coverage': 50,
                'depth': 50,
                'accuracy': 50,
                'analysis': 50,
                'synthesis': 50
            },
            'growth_trend': [],
            'improvement_rate': 0.0,
            'strengths': [],
            'weaknesses': [],
            'bloom_distribution': {},
            'learning_patterns': {},
            'error_patterns': {},
            'personalized_suggestions': [
                {
                    'icon': '📚',
                    'title': 'Begin Your Cognitive Journey',
                    'description': 'Use Concept Muncher to start building your cognitive profile',
                    'action': 'Analyze different types of texts to discover your learning patterns'
                }
            ],
            'performance_trends': {},
            'consistency_metrics': {}
        }


def lambda_handler(event, context):
    """
    Cognitive Profile Lambda Handler
    Independent service for cognitive profile management
    """
    try:
        # Parse request
        if isinstance(event.get('body'), str):
            body = json.loads(event['body'])
        else:
            body = event.get('body', {})
        
        action = body.get('action')
        
        if not action:
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': 'Missing required field: action'
                })
            }
        
        # Initialize cognitive profile service
        cognitive_service = CognitiveProfileService()
        
        if action == 'record_analysis':
            return handle_record_analysis(cognitive_service, body)
        
        elif action == 'get_profile':
            return handle_get_profile(cognitive_service, body)
        
        else:
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': f'Unknown action: {action}'
                })
            }
        
    except Exception as e:
        logger.error(f"Cognitive profile lambda handler error: {e}")
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


def handle_record_analysis(cognitive_service, body):
    """Handle recording analysis result"""
    user_id = body.get('user_id')
    analysis_data = body.get('analysis_data')
    
    if not user_id or not analysis_data:
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'error': 'Missing user_id or analysis_data'
            })
        }
    
    # Simplified security validation - basic checks only
    if len(user_id) > 200:  # Reasonable limit for user ID
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'error': 'Security check: User ID too long'
            })
        }
    
    # Analysis data size check - prevent excessive memory usage
    try:
        data_size = len(json.dumps(analysis_data))
        if data_size > 100000:  # 100KB limit - reasonable for analysis data
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'error': 'Security check: Analysis data too large'
                })
            }
    except (TypeError, ValueError):
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'error': 'Invalid analysis data format'
            })
        }
    
    result = cognitive_service.record_analysis_result(user_id, analysis_data)
    
    return {
        'statusCode': 200 if result['success'] else 500,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        'body': json.dumps(result, ensure_ascii=False)
    }


def handle_get_profile(cognitive_service, body):
    """Handle getting user profile"""
    user_id = body.get('user_id')
    days = body.get('days', 30)
    
    if not user_id:
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'error': 'Missing user_id'
            })
        }
    
    # Simplified security validation for get_profile
    if len(user_id) > 200:  # Reasonable limit for user ID
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'error': 'Security check: User ID too long'
            })
        }
    
    # Basic days parameter validation
    if not isinstance(days, int) or days < 1 or days > 1000:  # More flexible limit
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'error': 'Security check: Invalid days parameter'
            })
        }
    
    profile = cognitive_service.get_user_cognitive_profile(user_id, days)
    
    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        'body': json.dumps(profile, ensure_ascii=False)
    }