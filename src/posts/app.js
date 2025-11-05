const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, ScanCommand, QueryCommand, UpdateCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TABLE = process.env.APP_TABLE;

exports.handler = async (event) => {
  try {
    const method = event.requestContext.httpMethod;
    const path = event.path;
    
    // CREATE POST - POST /communities/{name}/posts
    if (method === "POST" && event.pathParameters && event.pathParameters.name && !path.includes("/search")) {
      const community = event.pathParameters.name;
      const body = JSON.parse(event.body || "{}");
      const { title, body: content, media, userId, tags } = body;

      if (!title) {
        return { statusCode: 400, body: JSON.stringify({ message: "title required" }) };
      }

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      const postId = uuidv4();
      const now = new Date().toISOString();

      const item = {
        PK: `COMM#${community}`,
        SK: `POST#${postId}`,
        GSI1PK: `POST#${postId}`,
        GSI1SK: `CREATED#${now}`,
        type: "post",
        postId,
        community,
        userId,
        title,
        body: content || "",
        media: media || [],
        tags: tags || [],
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

      await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));

      // Increment post count in community
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `COMM#${community}`, SK: "META" },
        UpdateExpression: "ADD postCount :inc SET updatedAt = :now",
        ExpressionAttributeValues: { 
          ":inc": 1,
          ":now": now
        }
      }));

      return {
        statusCode: 201,
        body: JSON.stringify({ postId, createdAt: now })
      };
    }

    // EDIT POST - PUT /posts/{postId}
    if (method === "PUT" && event.pathParameters && event.pathParameters.postId) {
      const postId = event.pathParameters.postId;
      const body = JSON.parse(event.body || "{}");
      const { userId, title, body: content, tags } = body;

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      // Find post
      const postResult = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `POST#${postId}` },
        Limit: 1
      }));

      if (!postResult.Items || postResult.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "post not found" }) };
      }

      const post = postResult.Items[0];

      // Check ownership
      if (post.userId !== userId) {
        return { statusCode: 403, body: JSON.stringify({ message: "not authorized" }) };
      }

      const now = new Date().toISOString();
      const updates = ["updatedAt = :now", "edited = :edited"];
      const values = { ":now": now, ":edited": true };

      if (title) {
        updates.push("title = :title");
        values[":title"] = title;
      }
      if (content !== undefined) {
        updates.push("body = :body");
        values[":body"] = content;
      }
      if (tags) {
        updates.push("tags = :tags");
        values[":tags"] = tags;
      }

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: post.PK, SK: post.SK },
        UpdateExpression: `SET ${updates.join(", ")}`,
        ExpressionAttributeValues: values
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "post updated", updatedAt: now })
      };
    }

    // DELETE POST - DELETE /posts/{postId}
    if (method === "DELETE" && event.pathParameters && event.pathParameters.postId) {
      const postId = event.pathParameters.postId;
      const body = JSON.parse(event.body || "{}");
      const { userId } = body;

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      // Find post
      const postResult = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `POST#${postId}` },
        Limit: 1
      }));

      if (!postResult.Items || postResult.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "post not found" }) };
      }

      const post = postResult.Items[0];

      // Check ownership
      if (post.userId !== userId) {
        return { statusCode: 403, body: JSON.stringify({ message: "not authorized" }) };
      }

      const now = new Date().toISOString();

      // Soft delete
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: post.PK, SK: post.SK },
        UpdateExpression: "SET #status = :status, body = :body, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "deleted",
          ":body": "[deleted]",
          ":now": now
        }
      }));

      // Decrement community post count
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `COMM#${post.community}`, SK: "META" },
        UpdateExpression: "ADD postCount :dec SET updatedAt = :now",
        ExpressionAttributeValues: { 
          ":dec": -1,
          ":now": now
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "post deleted" })
      };
    }

    // LIST POSTS IN COMMUNITY - GET /communities/{name}/posts
    if (method === "GET" && event.pathParameters && event.pathParameters.name && !path.includes("/search")) {
      const community = event.pathParameters.name;
      const limit = parseInt(event.queryStringParameters?.limit || 25);
      const lastKey = event.queryStringParameters?.lastKey;
      const sort = event.queryStringParameters?.sort || "new"; // new, hot, top, controversial

      const params = {
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { 
          ":pk": `COMM#${community}`,
          ":sk": "POST#"
        },
        Limit: limit,
        ScanIndexForward: false
      };

      if (lastKey) {
        params.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastKey));
      }

      const result = await ddb.send(new QueryCommand(params));
      let items = (result.Items || []).filter(item => item.status === "active");

      // Sorting algorithms
      if (sort === "hot") {
        items = items.sort((a, b) => {
          const aHot = a.score / Math.pow((Date.now() - new Date(a.createdAt).getTime()) / 3600000 + 2, 1.5);
          const bHot = b.score / Math.pow((Date.now() - new Date(b.createdAt).getTime()) / 3600000 + 2, 1.5);
          return bHot - aHot;
        });
      } else if (sort === "top") {
        items = items.sort((a, b) => b.score - a.score);
      } else if (sort === "controversial") {
        items = items.sort((a, b) => {
          const aControversy = Math.min(a.upvotes, a.downvotes) * (a.upvotes + a.downvotes);
          const bControversy = Math.min(b.upvotes, b.downvotes) * (b.upvotes + b.downvotes);
          return bControversy - aControversy;
        });
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          posts: items,
          lastKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null
        })
      };
    }

    // GET SINGLE POST - GET /posts/{postId}
    if (method === "GET" && path.includes("/posts/") && event.pathParameters && event.pathParameters.postId && !path.includes("/vote")) {
      const postId = event.pathParameters.postId;

      const params = {
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `POST#${postId}` }
      };

      const result = await ddb.send(new QueryCommand(params));
      const item = (result.Items && result.Items[0]) || null;
      
      if (!item) {
        return { statusCode: 404, body: JSON.stringify({ message: "post not found" }) };
      }

      // Increment view count
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: item.PK, SK: item.SK },
        UpdateExpression: "ADD viewCount :inc",
        ExpressionAttributeValues: { ":inc": 1 }
      }));

      item.viewCount = (item.viewCount || 0) + 1;

      return { statusCode: 200, body: JSON.stringify(item) };
    }

    // SEARCH POSTS - GET /posts/search
    if (method === "GET" && path.includes("/posts/search")) {
      const query = event.queryStringParameters?.q || "";
      const limit = parseInt(event.queryStringParameters?.limit || 25);
      
      if (!query || query.length < 2) {
        return { statusCode: 400, body: JSON.stringify({ message: "query must be at least 2 characters" }) };
      }

      const params = {
        TableName: TABLE,
        FilterExpression: "#type = :type AND #status = :status AND (contains(#title, :query) OR contains(body, :query))",
        ExpressionAttributeNames: {
          "#type": "type",
          "#status": "status",
          "#title": "title"
        },
        ExpressionAttributeValues: {
          ":type": "post",
          ":status": "active",
          ":query": query.toLowerCase()
        },
        Limit: limit
      };

      const result = await ddb.send(new ScanCommand(params));
      const posts = (result.Items || []).sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          posts,
          count: posts.length,
          query
        })
      };
    }

    // GET TRENDING POSTS - GET /posts/trending
    if (method === "GET" && path.includes("/posts/trending")) {
      const limit = parseInt(event.queryStringParameters?.limit || 10);
      const timeframe = event.queryStringParameters?.timeframe || "day"; // day, week, month

      const now = Date.now();
      const timeframes = {
        day: 24 * 3600000,
        week: 7 * 24 * 3600000,
        month: 30 * 24 * 3600000
      };

      const params = {
        TableName: TABLE,
        FilterExpression: "#type = :type AND #status = :status",
        ExpressionAttributeNames: {
          "#type": "type",
          "#status": "status"
        },
        ExpressionAttributeValues: {
          ":type": "post",
          ":status": "active"
        }
      };

      const result = await ddb.send(new ScanCommand(params));
      
      const trending = (result.Items || [])
        .filter(post => now - new Date(post.createdAt).getTime() < timeframes[timeframe])
        .map(post => ({
          ...post,
          trendScore: (post.score + post.commentCount * 2 + post.viewCount * 0.1) / 
                     Math.pow((now - new Date(post.createdAt).getTime()) / 3600000 + 2, 1.5)
        }))
        .sort((a, b) => b.trendScore - a.trendScore)
        .slice(0, limit);

      return {
        statusCode: 200,
        body: JSON.stringify({ posts: trending, timeframe })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ message: "bad request" }) };
  } catch (err) {
    console.error("posts error", err);
    return { statusCode: 500, body: JSON.stringify({ message: "internal error", error: err.message }) };
  }
};