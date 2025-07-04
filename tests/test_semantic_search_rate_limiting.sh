#!/bin/bash

# Test script for Semantic Search Rate Limiting
# This script tests the 3-request daily limit for anonymous users

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
API_URL="https://your-api-gateway-url.amazonaws.com/dev/semantic-search"
ANONYMOUS_USER_ID="test_anon_$(date +%s)"

echo -e "${YELLOW}Testing Semantic Search Rate Limiting for Anonymous Users${NC}"
echo "Anonymous User ID: $ANONYMOUS_USER_ID"
echo "Daily Limit: 3 requests"
echo "=========================================="

# Function to make a semantic search request
make_semantic_search_request() {
    local request_num=$1
    echo -e "\n${YELLOW}Request #$request_num${NC}"
    
    response=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL" \
        -H "Content-Type: application/json" \
        -H "User-Agent: TestScript/1.0" \
        -d "{
            \"action\": \"search_chunks\",
            \"anonymous_user_id\": \"$ANONYMOUS_USER_ID\",
            \"query\": \"What is machine learning?\",
            \"chunks\": [
                \"Machine learning is a subset of artificial intelligence.\",
                \"Deep learning uses neural networks with multiple layers.\",
                \"Natural language processing helps computers understand human language.\"
            ],
            \"top_k\": 2,
            \"similarity_threshold\": 0.5
        }")
    
    # Get full response to check for rate limiting
    full_response=$(curl -s -X POST "$API_URL" \
        -H "Content-Type: application/json" \
        -H "User-Agent: TestScript/1.0" \
        -d "{
            \"action\": \"search_chunks\",
            \"anonymous_user_id\": \"$ANONYMOUS_USER_ID\",
            \"query\": \"What is machine learning?\",
            \"chunks\": [
                \"Machine learning is a subset of artificial intelligence.\",
                \"Deep learning uses neural networks with multiple layers.\",
                \"Natural language processing helps computers understand human language.\"
            ],
            \"top_k\": 2,
            \"similarity_threshold\": 0.5
        }")
    
    # Check if response contains rate limit message
    if echo "$full_response" | grep -q "Daily Limit Reached"; then
        echo -e "${RED}✗ Request $request_num: RATE LIMITED (returned as search result)${NC}"
        return 1
    elif [ "$response" = "200" ]; then
        echo -e "${GREEN}✓ Request $request_num: SUCCESS (HTTP 200)${NC}"
        return 0
    else
        echo -e "${RED}✗ Request $request_num: ERROR (HTTP $response)${NC}"
        return 2
    fi
}

# Test 1: First 3 requests should succeed
echo -e "\n${YELLOW}Test 1: First 3 requests should succeed${NC}"
for i in {1..3}; do
    make_semantic_search_request $i
    sleep 1
done

# Test 2: 4th request should be rate limited (returned as search result)
echo -e "\n${YELLOW}Test 2: 4th request should show rate limit message${NC}"
make_semantic_search_request 4
rate_limited=$?

if [ $rate_limited -eq 1 ]; then
    echo -e "${GREEN}✓ Rate limiting working correctly! (Message shown as search result)${NC}"
else
    echo -e "${RED}✗ Rate limiting not working as expected${NC}"
fi

# Test 3: Test with detailed response
echo -e "\n${YELLOW}Test 3: Detailed rate limit message displayed to user${NC}"
detailed_response=$(curl -s -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H "User-Agent: TestScript/1.0" \
    -d "{
        \"action\": \"search_chunks\",
        \"anonymous_user_id\": \"$ANONYMOUS_USER_ID\",
        \"query\": \"Test query\",
        \"chunks\": [\"Test chunk\"],
        \"top_k\": 1
    }")

echo "Response:"
echo "$detailed_response" | jq '.' 2>/dev/null || echo "$detailed_response"

# Test 4: Test embedding generation rate limiting
echo -e "\n${YELLOW}Test 4: Test embedding generation rate limiting${NC}"
embedding_response=$(curl -s -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H "User-Agent: TestScript/1.0" \
    -d "{
        \"action\": \"generate_embeddings\",
        \"anonymous_user_id\": \"$ANONYMOUS_USER_ID\",
        \"texts\": [\"Test text for embedding\"]
    }")

if echo "$embedding_response" | grep -q "Daily Limit Reached"; then
    echo -e "${GREEN}✓ Embedding generation also properly rate limited${NC}"
else
    echo -e "${YELLOW}! Embedding generation returned different response${NC}"
fi

echo "Embedding Response:"
echo "$embedding_response" | jq '.' 2>/dev/null || echo "$embedding_response"

echo -e "\n${YELLOW}Testing completed!${NC}"
echo -e "${YELLOW}Note: Update API_URL variable with your actual API Gateway URL${NC}"
echo -e "${GREEN}Rate limit messages now display as search results - no frontend changes needed! 🎉${NC}" 