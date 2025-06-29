#!/bin/bash

set -e  # Exit on any error

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# API URL
API_URL="https://4gjsn9p4kc.execute-api.us-east-1.amazonaws.com/dev/concept-muncher"

# Log file
LOG_FILE="test_results_$(date +%Y%m%d_%H%M%S).log"

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE} Text Comprehension Analysis Test Suite${NC}"
echo -e "${BLUE}============================================${NC}"
echo "Test results will be saved to: $LOG_FILE"
echo ""

# Log to file
log_test() {
    echo "[$1] $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
    echo "$2" >> "$LOG_FILE"
    echo "" >> "$LOG_FILE"
}

# Get milliseconds (cross-platform compatible)
get_ms() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        python3 -c "import time; print(int(time.time() * 1000))"
    else
        # Linux
        date +%s%3N
    fi
}

# Execute test request
run_test() {
    local test_name="$1"
    local test_data="$2"
    local description="$3"
    
    echo -e "${YELLOW}=== $test_name ===${NC}"
    echo "Description: $description"
    echo ""
    
    # Record start time
    start_time=$(get_ms)
    
    # Execute request
    response=$(curl -s -X POST "$API_URL" \
        -H "Content-Type: application/json" \
        -d "$test_data")
    
    # Record end time
    end_time=$(get_ms)
    call_time=$((end_time - start_time))
    
    echo "Response time: ${call_time}ms"
    echo "Response content:"
    echo "$response" | jq . 2>/dev/null || echo "$response"
    echo ""
    
    # Log to file
    log_test "$test_name" "Description: $description
Response time: ${call_time}ms
Response content: $response"
    
    # Pause to avoid too frequent requests
    sleep 1
}

echo -e "${GREEN}🚀 Preparation${NC}"
echo "1. Deploy latest code..."
echo "   Please ensure you have run: cd cdk && cdk deploy"
echo ""

echo "2. Clearing cache..."
echo "Cleaning segments cache..."

# Clear cache
aws dynamodb scan --table-name word-munch-cache-dev \
    --filter-expression "begins_with(cacheKey, :prefix)" \
    --expression-attribute-values '{":prefix":{"S":"segments_"}}' \
    --query 'Items[].cacheKey.S' --output text 2>/dev/null | \
    tr '\t' '\n' | while read key; do
        if [ ! -z "$key" ]; then
            aws dynamodb delete-item --table-name word-munch-cache-dev \
                --key "{\"cacheKey\":{\"S\":\"$key\"}}" 2>/dev/null
            echo "Deleted cache: $key"
        fi
    done

echo "Cache cleanup completed, waiting 5 seconds..."
sleep 5
echo ""

echo -e "${GREEN}🧪 Starting Test Suite${NC}"
echo ""

# Test 1: Basic Segmentation Validation
run_test "Test 1: Basic Segmentation Validation" \
'{
  "original_text": "AI is changing healthcare. It helps doctors make better decisions.",
  "user_understanding": "AI helps doctors."
}' \
"Expected: 2 sentences, no duplicates, context_used=false"

# Test 2: Decimal Point Fix Validation
run_test "Test 2: Decimal Point Fix Validation" \
'{
  "original_text": "The Federal Reserve announced a 0.25% interest rate increase to combat inflation. This decision reflects concerns about economic overheating and wage growth.",
  "user_understanding": "The Fed raised rates to fight inflation.",
  "context": "Financial news analysis of monetary policy decisions in 2024"
}' \
"Expected: 2 complete sentences, 0.25% not split, context_used=true"

# Test 3: Long Text Segmentation Test
run_test "Test 3: Long Text Segmentation Test" \
'{
  "original_text": "Climate change is a global challenge that requires immediate action. Scientists worldwide have documented rising temperatures and melting ice caps. Governments must implement policies to reduce carbon emissions. Individual actions also play a crucial role in environmental protection.",
  "user_understanding": "Climate change needs action from governments and individuals to reduce emissions."
}' \
"Expected: 4 sentences, reasonable similarity distribution"

# Test 4: Automatic Context Extraction Test
run_test "Test 4: Automatic Context Extraction Test" \
'{
  "original_text": "Shakespeare wrote Hamlet as a exploration of revenge and morality. The play examines the psychological toll of indecision and the complexity of human nature.",
  "user_understanding": "Hamlet is about revenge and psychology.",
  "auto_extract_context": true
}' \
"Expected: Extract literature-related context, context_used=true"

# Test 5: Low Similarity Detailed Feedback Test
run_test "Test 5: Low Similarity Detailed Feedback Test" \
'{
  "original_text": "Blockchain technology utilizes distributed ledger systems with cryptographic hashing to ensure data integrity and eliminate the need for centralized authorities in financial transactions.",
  "user_understanding": "Blockchain is good."
}' \
"Expected: overall_similarity < 0.6, trigger Claude detailed feedback"

# Test 6: Cache Performance Test
echo -e "${YELLOW}=== Test 6: Cache Performance Test ===${NC}"
echo "Description: Expected second call to be significantly faster"
echo ""

test_data='{
  "original_text": "Renewable energy sources like solar and wind are becoming increasingly cost-effective. Many countries are investing heavily in clean energy infrastructure.",
  "user_understanding": "Solar and wind energy are getting cheaper and countries are investing in them."
}'

echo "First call..."
start_time=$(get_ms)
response1=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$test_data")
end_time=$(get_ms)
first_call_time=$((end_time - start_time))
echo "First call time: ${first_call_time}ms"

sleep 2

echo "Second call..."
start_time=$(get_ms)
response2=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$test_data")
end_time=$(get_ms)
second_call_time=$((end_time - start_time))
echo "Second call time: ${second_call_time}ms"

performance_gain=$((first_call_time - second_call_time))
echo "Performance improvement: ${performance_gain}ms"
echo ""
echo "First response:"
echo "$response1" | jq . 2>/dev/null || echo "$response1"
echo ""
echo "Second response:"
echo "$response2" | jq . 2>/dev/null || echo "$response2"
echo ""

log_test "Test 6: Cache Performance Test" "Description: Expected second call to be significantly faster
First call time: ${first_call_time}ms
Second call time: ${second_call_time}ms
Performance improvement: ${performance_gain}ms
First response: $response1
Second response: $response2"

# Test 7a: Text Too Short Test
run_test "Test 7a: Text Too Short Test" \
'{
  "original_text": "Short text.",
  "user_understanding": "Text is short."
}' \
"Expected: statusCode=400, error message contains 'at least 10 words'"

# Test 7b: Missing Field Test
run_test "Test 7b: Missing Field Test" \
'{
  "original_text": "This is a test text with more than ten words to pass validation."
}' \
"Expected: statusCode=400, error message contains 'Missing required fields'"

# Test 8: Performance Benchmark Test
run_test "Test 8: Performance Benchmark Test" \
'{
  "original_text": "Artificial intelligence is transforming multiple industries through machine learning algorithms that can process vast amounts of data. Healthcare applications include medical imaging analysis, drug discovery, and personalized treatment recommendations. Financial services use AI for fraud detection, algorithmic trading, and risk assessment. Transportation benefits from autonomous vehicles and traffic optimization systems. However, these advances raise important ethical questions about privacy, bias, and job displacement that society must address.",
  "user_understanding": "AI is being used in healthcare, finance, and transportation, but raises ethical concerns about privacy and jobs."
}' \
"Expected: analysis_time_ms < 3000, around 5 segments"

# Test 9: Special Characters Test
run_test "Test 9: Special Characters Test" \
'{
  "original_text": "What is AI? AI stands for Artificial Intelligence! It includes machine learning, natural language processing, etc. Some examples: chatbots, recommendation systems, and autonomous vehicles.",
  "user_understanding": "AI includes machine learning and has applications like chatbots and self-driving cars."
}' \
"Expected: Correctly handle question marks, exclamation marks, etc. not incorrectly split"

# Test 10: Comprehensive Functionality Test
run_test "Test 10: Comprehensive Functionality Test" \
'{
  "original_text": "The COVID-19 pandemic has accelerated digital transformation across industries. Companies adopted remote work technologies, e-commerce platforms saw unprecedented growth, and telemedicine became mainstream. However, the digital divide became more apparent, with disadvantaged communities lacking access to high-speed internet and digital devices.",
  "user_understanding": "COVID-19 made companies go digital faster, but some people were left behind.",
  "context": "Technology and society analysis during the pandemic era"
}' \
"Expected: context_used=true, all features working together"

echo -e "${GREEN}✅ Testing Complete${NC}"
echo ""
echo -e "${BLUE}📊 Test Results Summary${NC}"
echo "Detailed results saved to: $LOG_FILE"
echo ""
echo "Please check the following key metrics:"
echo "1. All segments have type 'sentence'"
echo "2. Decimal points (0.25%) are not incorrectly split"
echo "3. context_used accurately reflects actual usage"
echo "4. Cache performance shows significant improvement"
echo "5. Error handling returns correct HTTP status codes"
echo ""
echo -e "${YELLOW}Please send the contents of $LOG_FILE to the developer for analysis!${NC}"
echo ""

# Show log file location
echo "Test log file location: $(pwd)/$LOG_FILE"
echo "View complete log: cat $LOG_FILE"