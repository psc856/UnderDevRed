const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TABLE = process.env.APP_TABLE;

exports.handler = async (event) => {
  try {
    const method = event.requestContext.httpMethod;
    const path = event.path;

    // CREATE USER - POST /users
    if (method === "POST" && path === "/users") {
      const body = JSON.parse(event.body || "{}");
      const { username, email, displayName, avatar, bio } = body;

      if (!username || !email) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ message: "username and email required" }) 
        };
      }

      // Check if username exists
      const existing = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" }
      }));

      if (existing.Item) {
        return { 
          statusCode: 409, 
          body: JSON.stringify({ message: "username already exists" }) 
        };
      }

      const userId = uuidv4();
      const now = new Date().toISOString();

      const item = {
        PK: `USER#${username}`,
        SK: "PROFILE",
        GSI1PK: `USERID#${userId}`,
        GSI1SK: "PROFILE",
        type: "user",
        userId,
        username,
        email,
        displayName: displayName || username,
        avatar: avatar || "",
        bio: bio || "",
        karma: 0,
        postKarma: 0,
        commentKarma: 0,
        postCount: 0,
        commentCount: 0,
        awardCount: 0,
        cakeDay: now,
        status: "active",
        createdAt: now,
        updatedAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));

      return {
        statusCode: 201,
        body: JSON.stringify({ 
          userId, 
          username,
          createdAt: now 
        })
      };
    }

    // GET USER PROFILE - GET /users/{username}
    if (method === "GET" && event.pathParameters && event.pathParameters.username && path.includes("/users/") && !path.includes("/posts") && !path.includes("/comments")) {
      const username = event.pathParameters.username;

      const result = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" }
      }));

      if (!result.Item) {
        return { 
          statusCode: 404, 
          body: JSON.stringify({ message: "user not found" }) 
        };
      }

      // Remove sensitive data
      const { email, ...publicProfile } = result.Item;

      return { 
        statusCode: 200, 
        body: JSON.stringify(publicProfile) 
      };
    }

    // UPDATE USER PROFILE - PUT /users/{username}
    if (method === "PUT" && event.pathParameters && event.pathParameters.username) {
      const username = event.pathParameters.username;
      const body = JSON.parse(event.body || "{}");
      const { userId, displayName, avatar, bio } = body;

      if (!userId) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ message: "userId required for authentication" }) 
        };
      }

      // Verify user owns this profile
      const existing = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" }
      }));

      if (!existing.Item) {
        return { statusCode: 404, body: JSON.stringify({ message: "user not found" }) };
      }

      if (existing.Item.userId !== userId) {
        return { statusCode: 403, body: JSON.stringify({ message: "not authorized" }) };
      }

      const now = new Date().toISOString();
      const updateExpressions = [];
      const attributeValues = { ":now": now };

      if (displayName !== undefined) {
        updateExpressions.push("displayName = :displayName");
        attributeValues[":displayName"] = displayName;
      }
      if (avatar !== undefined) {
        updateExpressions.push("avatar = :avatar");
        attributeValues[":avatar"] = avatar;
      }
      if (bio !== undefined) {
        updateExpressions.push("bio = :bio");
        attributeValues[":bio"] = bio;
      }

      updateExpressions.push("updatedAt = :now");

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" },
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ExpressionAttributeValues: attributeValues
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "profile updated", updatedAt: now })
      };
    }

    // GET USER'S POSTS - GET /users/{username}/posts
    if (method === "GET" && event.pathParameters && event.pathParameters.username && path.includes("/posts")) {
      const username = event.pathParameters.username;
      const limit = event.queryStringParameters?.limit || 25;
      const lastKey = event.queryStringParameters?.lastKey;

      // Get userId from username
      const userResult = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" }
      }));

      if (!userResult.Item) {
        return { statusCode: 404, body: JSON.stringify({ message: "user not found" }) };
      }

      const userId = userResult.Item.userId;

      // Query posts by userId using a scan (in production, you'd use GSI)
      const { ScanCommand } = require("@aws-sdk/lib-dynamodb");
      const params = {
        TableName: TABLE,
        FilterExpression: "#type = :type AND userId = :userId",
        ExpressionAttributeNames: { "#type": "type" },
        ExpressionAttributeValues: { 
          ":type": "post",
          ":userId": userId
        },
        Limit: parseInt(limit)
      };

      if (lastKey) {
        params.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastKey));
      }

      const result = await ddb.send(new ScanCommand(params));

      // Sort by creation date
      const posts = (result.Items || []).sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          posts,
          count: posts.length,
          lastKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null
        })
      };
    }

    // GET USER'S COMMENTS - GET /users/{username}/comments
    if (method === "GET" && event.pathParameters && event.pathParameters.username && path.includes("/comments")) {
      const username = event.pathParameters.username;
      const limit = event.queryStringParameters?.limit || 25;
      const lastKey = event.queryStringParameters?.lastKey;

      // Get userId from username
      const userResult = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" }
      }));

      if (!userResult.Item) {
        return { statusCode: 404, body: JSON.stringify({ message: "user not found" }) };
      }

      const userId = userResult.Item.userId;

      // Query comments by userId
      const { ScanCommand } = require("@aws-sdk/lib-dynamodb");
      const params = {
        TableName: TABLE,
        FilterExpression: "#type = :type AND userId = :userId",
        ExpressionAttributeNames: { "#type": "type" },
        ExpressionAttributeValues: { 
          ":type": "comment",
          ":userId": userId
        },
        Limit: parseInt(limit)
      };

      if (lastKey) {
        params.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastKey));
      }

      const result = await ddb.send(new ScanCommand(params));

      // Sort by creation date
      const comments = (result.Items || []).sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          comments,
          count: comments.length,
          lastKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null
        })
      };
    }

    // UPDATE USER KARMA (Internal use)
    if (method === "POST" && path.includes("/karma")) {
      const body = JSON.parse(event.body || "{}");
      const { username, postKarmaDelta, commentKarmaDelta } = body;

      if (!username) {
        return { statusCode: 400, body: JSON.stringify({ message: "username required" }) };
      }

      const now = new Date().toISOString();
      const totalKarmaDelta = (postKarmaDelta || 0) + (commentKarmaDelta || 0);

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" },
        UpdateExpression: "ADD karma :totalDelta, postKarma :postDelta, commentKarma :commentDelta SET updatedAt = :now",
        ExpressionAttributeValues: {
          ":totalDelta": totalKarmaDelta,
          ":postDelta": postKarmaDelta || 0,
          ":commentDelta": commentKarmaDelta || 0,
          ":now": now
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "karma updated" })
      };
    }

    // GET USER STATS - GET /users/{username}/stats
    if (method === "GET" && event.pathParameters && event.pathParameters.username && path.includes("/stats")) {
      const username = event.pathParameters.username;

      const userResult = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" }
      }));

      if (!userResult.Item) {
        return { statusCode: 404, body: JSON.stringify({ message: "user not found" }) };
      }

      const user = userResult.Item;
      const accountAge = Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24));

      return {
        statusCode: 200,
        body: JSON.stringify({
          username: user.username,
          karma: user.karma,
          postKarma: user.postKarma,
          commentKarma: user.commentKarma,
          postCount: user.postCount,
          commentCount: user.commentCount,
          awardCount: user.awardCount,
          accountAge,
          cakeDay: user.cakeDay
        })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ message: "bad request" }) };
  } catch (err) {
    console.error("users error", err);
    return { statusCode: 500, body: JSON.stringify({ message: "internal error", error: err.message }) };
  }
};