#!/bin/bash

# Set your API URL
API_URL="https://9q03u53gk1.execute-api.ap-south-1.amazonaws.com/Prod"

echo "🚀 Testing Reddit-like Backend API"
echo "=================================="
echo ""

# Test 1: Create User
echo "1️⃣ Creating user 'john_doe'..."
USER_RESPONSE=$(curl -s -X POST "${API_URL}/users" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "john_doe",
    "email": "john@example.com",
    "displayName": "John Doe",
    "bio": "Love coding and gaming!"
  }')
echo "Response: $USER_RESPONSE"
USER_ID=$(echo $USER_RESPONSE | grep -o '"userId":"[^"]*' | cut -d'"' -f4)
echo "User ID: $USER_ID"
echo ""

# Test 2: Create another user
echo "2️⃣ Creating user 'jane_smith'..."
USER2_RESPONSE=$(curl -s -X POST "${API_URL}/users" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "jane_smith",
    "email": "jane@example.com",
    "displayName": "Jane Smith",
    "bio": "Tech enthusiast"
  }')
echo "Response: $USER2_RESPONSE"
USER2_ID=$(echo $USER2_RESPONSE | grep -o '"userId":"[^"]*' | cut -d'"' -f4)
echo ""

# Test 3: Get User Profile
echo "3️⃣ Getting user profile..."
curl -s -X GET "${API_URL}/users/john_doe" | jq '.'
echo ""

# Test 4: Create Community
echo "4️⃣ Creating 'gaming' community..."
curl -s -X POST "${API_URL}/communities" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "gaming",
    "displayName": "Gaming",
    "description": "Everything about video games",
    "category": "entertainment"
  }' | jq '.'
echo ""

# Test 5: Create another community
echo "5️⃣ Creating 'programming' community..."
curl -s -X POST "${API_URL}/communities" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "programming",
    "displayName": "Programming",
    "description": "Code, debug, repeat",
    "category": "technology"
  }' | jq '.'
echo ""

# Test 6: List Communities
echo "6️⃣ Listing all communities..."
curl -s -X GET "${API_URL}/communities" | jq '.'
echo ""

# Test 7: Join Community
echo "7️⃣ User joining 'gaming' community..."
curl -s -X POST "${API_URL}/communities/gaming/join" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER_ID\"}" | jq '.'
echo ""

# Test 8: Get Community Details
echo "8️⃣ Getting 'gaming' community details..."
curl -s -X GET "${API_URL}/communities/gaming" | jq '.'
echo ""

# Test 9: Create Post
echo "9️⃣ Creating a post in 'gaming'..."
POST_RESPONSE=$(curl -s -X POST "${API_URL}/communities/gaming/posts" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"Best RPG of 2024\",
    \"body\": \"What's your favorite RPG this year? I'm loving Baldur's Gate 3!\",
    \"userId\": \"$USER_ID\"
  }")
echo "Response: $POST_RESPONSE"
POST_ID=$(echo $POST_RESPONSE | grep -o '"postId":"[^"]*' | cut -d'"' -f4)
echo "Post ID: $POST_ID"
echo ""

# Test 10: Create another post
echo "🔟 Creating another post..."
POST2_RESPONSE=$(curl -s -X POST "${API_URL}/communities/gaming/posts" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"Gaming Setup Tour\",
    \"body\": \"Check out my new gaming setup!\",
    \"userId\": \"$USER2_ID\"
  }")
POST2_ID=$(echo $POST2_RESPONSE | grep -o '"postId":"[^"]*' | cut -d'"' -f4)
echo ""

# Test 11: List Posts in Community
echo "1️⃣1️⃣ Listing posts in 'gaming'..."
curl -s -X GET "${API_URL}/communities/gaming/posts?limit=10&sort=new" | jq '.'
echo ""

# Test 12: Get Single Post
echo "1️⃣2️⃣ Getting single post..."
curl -s -X GET "${API_URL}/posts/$POST_ID" | jq '.'
echo ""

# Test 13: Upvote Post
echo "1️⃣3️⃣ Upvoting post..."
curl -s -X POST "${API_URL}/posts/$POST_ID/vote" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER2_ID\", \"vote\": \"up\"}" | jq '.'
echo ""

# Test 14: Another user upvotes
echo "1️⃣4️⃣ Another upvote..."
curl -s -X POST "${API_URL}/posts/$POST_ID/vote" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER_ID\", \"vote\": \"up\"}" | jq '.'
echo ""

# Test 15: Downvote Post
echo "1️⃣5️⃣ Downvoting second post..."
curl -s -X POST "${API_URL}/posts/$POST2_ID/vote" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER_ID\", \"vote\": \"down\"}" | jq '.'
echo ""

# Test 16: Get Vote Status
echo "1️⃣6️⃣ Checking user's vote on post..."
curl -s -X GET "${API_URL}/posts/$POST_ID/vote?userId=$USER_ID" | jq '.'
echo ""

# Test 17: Add Comment
echo "1️⃣7️⃣ Adding comment to post..."
COMMENT_RESPONSE=$(curl -s -X POST "${API_URL}/posts/$POST_ID/comments" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$USER2_ID\",
    \"body\": \"I agree! BG3 is amazing. The character customization is incredible!\"
  }")
echo "Response: $COMMENT_RESPONSE"
COMMENT_ID=$(echo $COMMENT_RESPONSE | grep -o '"commentId":"[^"]*' | cut -d'"' -f4)
echo "Comment ID: $COMMENT_ID"
echo ""

# Test 18: Reply to Comment
echo "1️⃣8️⃣ Replying to comment (nested)..."
REPLY_RESPONSE=$(curl -s -X POST "${API_URL}/posts/$POST_ID/comments" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$USER_ID\",
    \"body\": \"Absolutely! The story is so engaging too.\",
    \"parentCommentId\": \"$COMMENT_ID\"
  }")
echo "Response: $REPLY_RESPONSE"
REPLY_ID=$(echo $REPLY_RESPONSE | grep -o '"commentId":"[^"]*' | cut -d'"' -f4)
echo ""

# Test 19: Add another comment
echo "1️⃣9️⃣ Adding another top-level comment..."
curl -s -X POST "${API_URL}/posts/$POST_ID/comments" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$USER2_ID\",
    \"body\": \"Has anyone tried the multiplayer mode yet?\"
  }" | jq '.'
echo ""

# Test 20: Get All Comments
echo "2️⃣0️⃣ Getting all comments for post (nested tree)..."
curl -s -X GET "${API_URL}/posts/$POST_ID/comments?sort=best" | jq '.'
echo ""

# Test 21: Upvote Comment
echo "2️⃣1️⃣ Upvoting comment..."
curl -s -X POST "${API_URL}/comments/$COMMENT_ID/vote" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER_ID\", \"vote\": \"up\"}" | jq '.'
echo ""

# Test 22: Update Comment
echo "2️⃣2️⃣ Updating comment..."
curl -s -X PUT "${API_URL}/comments/$REPLY_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$USER_ID\",
    \"body\": \"Absolutely! The story is so engaging too. Edit: Can't wait for DLC!\"
  }" | jq '.'
echo ""

# Test 23: Update User Profile
echo "2️⃣3️⃣ Updating user profile..."
curl -s -X PUT "${API_URL}/users/john_doe" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$USER_ID\",
    \"bio\": \"Love coding, gaming, and coffee! ☕🎮\",
    \"avatar\": \"https://example.com/avatar.jpg\"
  }" | jq '.'
echo ""

# Test 24: Get User's Posts
echo "2️⃣4️⃣ Getting user's posts..."
curl -s -X GET "${API_URL}/users/john_doe/posts" | jq '.'
echo ""

# Test 25: Get User's Comments
echo "2️⃣5️⃣ Getting user's comments..."
curl -s -X GET "${API_URL}/users/john_doe/comments" | jq '.'
echo ""

# Test 26: Get User Stats
echo "2️⃣6️⃣ Getting user stats..."
curl -s -X GET "${API_URL}/users/john_doe/stats" | jq '.'
echo ""

# Test 27: Presign Media Upload
echo "2️⃣7️⃣ Getting presigned URL for media upload..."
curl -s -X POST "${API_URL}/media/presign" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "gaming_screenshot.png",
    "contentType": "image/png",
    "size": 2048000
  }' | jq '.'
echo ""

# Test 28: Leave Community
echo "2️⃣8️⃣ User leaving 'gaming' community..."
curl -s -X POST "${API_URL}/communities/gaming/leave" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER_ID\"}" | jq '.'
echo ""

# Test 29: Delete Comment
echo "2️⃣9️⃣ Deleting comment (soft delete)..."
curl -s -X DELETE "${API_URL}/comments/$REPLY_ID" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER_ID\"}" | jq '.'
echo ""

# Test 30: Change vote
echo "3️⃣0️⃣ Changing vote from up to down..."
curl -s -X POST "${API_URL}/posts/$POST_ID/vote" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER_ID\", \"vote\": \"down\"}" | jq '.'
echo ""

echo "=================================="
echo "✅ All tests completed!"
echo "=================================="