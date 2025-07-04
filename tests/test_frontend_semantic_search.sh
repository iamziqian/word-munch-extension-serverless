#!/bin/bash

# Test script for frontend semantic search functionality
# Uses realistic text chunks similar to what the reader mode would generate

echo "🔍 Testing Frontend-Style Semantic Search..."
echo "============================================"

# API endpoint
SEMANTIC_SEARCH_URL="https://lyfnwm0cz5.execute-api.us-east-1.amazonaws.com/dev/semantic-search"

# Test with realistic article chunks
read -r -d '' TEST_PAYLOAD << EOF
{
  "action": "search_chunks",
  "chunks": [
    "Artificial intelligence has revolutionized many industries by automating complex tasks that previously required human intelligence. From healthcare diagnostics to financial trading, AI systems are becoming increasingly sophisticated and capable.",
    "Machine learning algorithms, a subset of artificial intelligence, enable computers to learn and improve from experience without being explicitly programmed. These algorithms identify patterns in data and make predictions or decisions based on that analysis.",
    "Deep learning, which uses neural networks with multiple layers, has achieved breakthrough results in image recognition, natural language processing, and game playing. The technology mimics the way human brains process information through interconnected neurons.",
    "Climate change represents one of the most pressing challenges of our time, with rising global temperatures causing widespread environmental disruption. Scientists warn that immediate action is needed to reduce greenhouse gas emissions and limit further warming.",
    "Renewable energy sources like solar and wind power are becoming increasingly cost-effective alternatives to fossil fuels. Many countries are investing heavily in clean energy infrastructure to meet their climate commitments and reduce carbon emissions.",
    "Blockchain technology provides a decentralized way to record transactions and store data across multiple computers. This distributed ledger system offers enhanced security and transparency compared to traditional centralized databases."
  ],
  "query": "What is machine learning?",
  "top_k": 3,
  "similarity_threshold": 0.2
}
EOF

echo "🎯 Query: 'What is machine learning?'"
echo "📊 Expected: Should find chunks about AI, machine learning, and deep learning"
echo ""

# Make the API call
RESPONSE=$(curl -s -w "HTTPSTATUS:%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$TEST_PAYLOAD" \
  "$SEMANTIC_SEARCH_URL")

# Extract HTTP status and body
HTTP_STATUS=$(echo $RESPONSE | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
RESPONSE_BODY=$(echo $RESPONSE | sed -e 's/HTTPSTATUS\:.*//g')

echo "📊 Response Status: $HTTP_STATUS"
echo ""

if [ "$HTTP_STATUS" -eq 200 ]; then
    echo "✅ API call successful!"
    echo ""
    
    # Extract key metrics
    RELEVANT_CHUNKS=$(echo "$RESPONSE_BODY" | jq -r '.relevant_chunks | length // 0')
    TOP_SIMILARITY=$(echo "$RESPONSE_BODY" | jq -r '.top_similarity // "N/A"')
    
    echo "📈 Search Results:"
    echo "  • Relevant chunks found: $RELEVANT_CHUNKS"
    echo "  • Top similarity score: $TOP_SIMILARITY"
    echo ""
    
    if [ "$RELEVANT_CHUNKS" -gt 0 ]; then
        echo "🎉 SUCCESS: Found relevant chunks with semantic matching!"
        echo ""
        echo "🔍 Relevant chunks:"
        echo "$RESPONSE_BODY" | jq -r '.relevant_chunks[] | "  • Similarity: \(.similarity | (. * 100 | floor / 100)) | Chunk: \(.chunk[:80])..."'
        echo ""
        
        # Test with lower threshold
        echo "🧪 Testing with even lower threshold (0.1)..."
        RESPONSE2=$(curl -s -X POST -H "Content-Type: application/json" \
          -d "${TEST_PAYLOAD/0.2/0.1}" "$SEMANTIC_SEARCH_URL")
        RELEVANT_CHUNKS2=$(echo "$RESPONSE2" | jq -r '.relevant_chunks | length // 0')
        echo "  • Chunks found with 0.1 threshold: $RELEVANT_CHUNKS2"
        
    else
        echo "❌ ISSUE: No relevant chunks found even with 0.2 threshold"
        echo "This suggests the similarity scores are very low for this content."
        echo ""
        echo "🔍 Full response for debugging:"
        echo "$RESPONSE_BODY" | jq '.'
    fi
    
else
    echo "❌ API call failed with status: $HTTP_STATUS"
    echo ""
    echo "📋 Error Response:"
    echo "$RESPONSE_BODY" | jq '.' 2>/dev/null || echo "$RESPONSE_BODY"
fi

echo ""
echo "💡 Frontend Recommendations:"
echo "  • Use similarity_threshold: 0.2 or lower"
echo "  • Show similarity scores to help users understand relevance"
echo "  • Consider fallback text search if no semantic results found"
echo ""
echo "�� Test completed!" 