const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TABLE = process.env.APP_TABLE;

exports.handler = async (event) => {
  try {
    const method = event.requestContext.httpMethod;
    const path = event.path;

    // FOLLOW USER - POST /users/{username}/follow
    if (method === "POST" && event.pathParameters && event.pathParameters.username && path.includes("/follow")) {
      const targetUsername = event.pathParameters.username;
      const body = JSON.parse(event.body || "{}");
      const { userId } = body;

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      // Get target user
      const targetUser = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${targetUsername}`, SK: "PROFILE" }
      }));

      if (!targetUser.Item) {
        return { statusCode: 404, body: JSON.stringify({ message: "user not found" }) };
      }

      const targetUserId = targetUser.Item.userId;
      const now = new Date().toISOString();

      // Check if already following
      const existing = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${userId}`, SK: `FOLLOWING#${targetUserId}` }
      }));

      if (existing.Item) {
        return { statusCode: 409, body: JSON.stringify({ message: "already following" }) };
      }

      // Create follow relationship
      const follow = {
        PK: `USER#${userId}`,
        SK: `FOLLOWING#${targetUserId}`,
        GSI1PK: `USER#${targetUserId}`,
        GSI1SK: `FOLLOWER#${userId}`,
        type: "follow",
        followerId: userId,
        followingId: targetUserId,
        followingUsername: targetUsername,
        createdAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: follow }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "now following", followedAt: now })
      };
    }

    // UNFOLLOW USER - DELETE /users/{username}/follow
    if (method === "DELETE" && event.pathParameters && event.pathParameters.username && path.includes("/follow")) {
      const targetUsername = event.pathParameters.username;
      const body = JSON.parse(event.body || "{}");
      const { userId } = body;

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      const targetUser = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${targetUsername}`, SK: "PROFILE" }
      }));

      if (!targetUser.Item) {
        return { statusCode: 404, body: JSON.stringify({ message: "user not found" }) };
      }

      const targetUserId = targetUser.Item.userId;

      await ddb.send(new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `USER#${userId}`, SK: `FOLLOWING#${targetUserId}` }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "unfollowed" })
      };
    }

    // GET FOLLOWERS - GET /users/{username}/followers
    if (method === "GET" && event.pathParameters && event.pathParameters.username && path.includes("/followers")) {
      const username = event.pathParameters.username;
      const limit = parseInt(event.queryStringParameters?.limit || 50);

      const user = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" }
      }));

      if (!user.Item) {
        return { statusCode: 404, body: JSON.stringify({ message: "user not found" }) };
      }

      const userId = user.Item.userId;

      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":sk": "FOLLOWER#"
        },
        Limit: limit
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({
          followers: result.Items || [],
          count: (result.Items || []).length
        })
      };
    }

    // GET FOLLOWING - GET /users/{username}/following
    if (method === "GET" && event.pathParameters && event.pathParameters.username && path.includes("/following")) {
      const username = event.pathParameters.username;
      const limit = parseInt(event.queryStringParameters?.limit || 50);

      const user = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" }
      }));

      if (!user.Item) {
        return { statusCode: 404, body: JSON.stringify({ message: "user not found" }) };
      }

      const userId = user.Item.userId;

      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":sk": "FOLLOWING#"
        },
        Limit: limit
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({
          following: result.Items || [],
          count: (result.Items || []).length
        })
      };
    }

    // SEND DIRECT MESSAGE - POST /messages
    if (method === "POST" && path === "/messages") {
      const body = JSON.parse(event.body || "{}");
      const { senderId, recipientId, message, media } = body;

      if (!senderId || !recipientId || !message) {
        return { statusCode: 400, body: JSON.stringify({ message: "senderId, recipientId, and message required" }) };
      }

      const messageId = uuidv4();
      const now = new Date().toISOString();
      const conversationId = [senderId, recipientId].sort().join("#");

      const dm = {
        PK: `CONV#${conversationId}`,
        SK: `MSG#${now}#${messageId}`,
        GSI1PK: `USER#${recipientId}`,
        GSI1SK: `INBOX#${now}`,
        type: "message",
        messageId,
        conversationId,
        senderId,
        recipientId,
        message,
        media: media || [],
        read: false,
        createdAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: dm }));

      return {
        statusCode: 201,
        body: JSON.stringify({ messageId, sentAt: now })
      };
    }

    // GET CONVERSATION - GET /messages/conversations/{conversationId}
    if (method === "GET" && event.pathParameters && event.pathParameters.conversationId && path.includes("/conversations/")) {
      const conversationId = event.pathParameters.conversationId;
      const limit = parseInt(event.queryStringParameters?.limit || 50);
      const lastKey = event.queryStringParameters?.lastKey;

      const params = {
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `CONV#${conversationId}`,
          ":sk": "MSG#"
        },
        Limit: limit,
        ScanIndexForward: false
      };

      if (lastKey) {
        params.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastKey));
      }

      const result = await ddb.send(new QueryCommand(params));

      return {
        statusCode: 200,
        body: JSON.stringify({
          messages: result.Items || [],
          lastKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null
        })
      };
    }

    // GET USER INBOX - GET /messages/inbox
    if (method === "GET" && path.includes("/inbox")) {
      const userId = event.queryStringParameters?.userId;
      const limit = parseInt(event.queryStringParameters?.limit || 50);

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":sk": "INBOX#"
        },
        Limit: limit,
        ScanIndexForward: false
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({
          messages: result.Items || [],
          unreadCount: (result.Items || []).filter(m => !m.read).length
        })
      };
    }

    // MARK MESSAGE AS READ - PUT /messages/{messageId}/read
    if (method === "PUT" && event.pathParameters && event.pathParameters.messageId && path.includes("/read")) {
      const messageId = event.pathParameters.messageId;
      const body = JSON.parse(event.body || "{}");
      const { userId } = body;

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      // Find message
      const result = await ddb.send(new ScanCommand({
        TableName: TABLE,
        FilterExpression: "messageId = :mid AND recipientId = :uid",
        ExpressionAttributeValues: {
          ":mid": messageId,
          ":uid": userId
        },
        Limit: 1
      }));

      if (!result.Items || result.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "message not found" }) };
      }

      const message = result.Items[0];

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: message.PK, SK: message.SK },
        UpdateExpression: "SET #read = :read, readAt = :now",
        ExpressionAttributeNames: { "#read": "read" },
        ExpressionAttributeValues: {
          ":read": true,
          ":now": new Date().toISOString()
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "marked as read" })
      };
    }

    // CROSS-POST - POST /posts/{postId}/crosspost
    if (method === "POST" && event.pathParameters && event.pathParameters.postId && path.includes("/crosspost")) {
      const originalPostId = event.pathParameters.postId;
      const body = JSON.parse(event.body || "{}");
      const { userId, targetCommunity, title } = body;

      if (!userId || !targetCommunity) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId and targetCommunity required" }) };
      }

      // Get original post
      const originalResult = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `POST#${originalPostId}` },
        Limit: 1
      }));

      if (!originalResult.Items || originalResult.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "original post not found" }) };
      }

      const original = originalResult.Items[0];
      const crosspostId = uuidv4();
      const now = new Date().toISOString();

      const crosspost = {
        PK: `COMM#${targetCommunity}`,
        SK: `POST#${crosspostId}`,
        GSI1PK: `POST#${crosspostId}`,
        GSI1SK: `CREATED#${now}`,
        type: "post",
        postId: crosspostId,
        community: targetCommunity,
        userId,
        title: title || `Crosspost: ${original.title}`,
        body: original.body,
        media: original.media,
        tags: original.tags || [],
        isCrosspost: true,
        originalPostId,
        originalCommunity: original.community,
        score: 0,
        upvotes: 0,
        downvotes: 0,
        commentCount: 0,
        viewCount: 0,
        shareCount: 0,
        status: "active",
        createdAt: now,
        updatedAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: crosspost }));

      // Increment share count on original
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: original.PK, SK: original.SK },
        UpdateExpression: "ADD shareCount :inc",
        ExpressionAttributeValues: { ":inc": 1 }
      }));

      return {
        statusCode: 201,
        body: JSON.stringify({ 
          crosspostId, 
          originalPostId,
          createdAt: now 
        })
      };
    }

    // SHARE TO EXTERNAL - POST /posts/{postId}/share
    if (method === "POST" && event.pathParameters && event.pathParameters.postId && path.includes("/share") && !path.includes("/crosspost")) {
      const postId = event.pathParameters.postId;
      const body = JSON.parse(event.body || "{}");
      const { platform } = body; // twitter, facebook, linkedin, reddit, etc.

      // Find post
      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `POST#${postId}` },
        Limit: 1
      }));

      if (!result.Items || result.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "post not found" }) };
      }

      const post = result.Items[0];

      // Increment share count
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: post.PK, SK: post.SK },
        UpdateExpression: "ADD shareCount :inc",
        ExpressionAttributeValues: { ":inc": 1 }
      }));

      // Generate share URL (you'd use your actual domain)
      const shareUrl = `https://yourapp.com/r/${post.community}/p/${postId}`;
      
      const shareUrls = {
        twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(post.title)}&url=${encodeURIComponent(shareUrl)}`,
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`,
        linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`,
        reddit: `https://reddit.com/submit?url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(post.title)}`
      };

      return {
        statusCode: 200,
        body: JSON.stringify({ 
          shareUrl: shareUrls[platform] || shareUrl,
          platform 
        })
      };
    }

    // GET FEED (Following) - GET /feed
    if (method === "GET" && path === "/feed") {
      const userId = event.queryStringParameters?.userId;
      const limit = parseInt(event.queryStringParameters?.limit || 25);

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      // Get users that this user follows
      const followingResult = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":sk": "FOLLOWING#"
        }
      }));

      const followingUserIds = (followingResult.Items || []).map(f => f.followingId);

      if (followingUserIds.length === 0) {
        return {
          statusCode: 200,
          body: JSON.stringify({ posts: [], message: "follow users to see their posts" })
        };
      }

      // Get posts from followed users (this is simplified, in production use GSI)
      const params = {
        TableName: TABLE,
        FilterExpression: "#type = :type AND #status = :status AND userId IN (" + 
          followingUserIds.map((_, i) => `:uid${i}`).join(",") + ")",
        ExpressionAttributeNames: {
          "#type": "type",
          "#status": "status"
        },
        ExpressionAttributeValues: {
          ":type": "post",
          ":status": "active",
          ...Object.fromEntries(followingUserIds.map((id, i) => [`:uid${i}`, id]))
        },
        Limit: limit
      };

      const result = await ddb.send(new ScanCommand(params));
      
      const posts = (result.Items || []).sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      return {
        statusCode: 200,
        body: JSON.stringify({ posts, count: posts.length })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ message: "bad request" }) };
  } catch (err) {
    console.error("social error", err);
    return { statusCode: 500, body: JSON.stringify({ message: "internal error", error: err.message }) };
  }
};