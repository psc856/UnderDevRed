const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, ScanCommand, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TABLE = process.env.APP_TABLE;

exports.handler = async (event) => {
  try {
    const method = event.requestContext.httpMethod;
    const path = event.path;
    
    // CREATE POST - POST /communities/{name}/posts
    if (method === "POST" && event.pathParameters && event.pathParameters.name) {
      const community = event.pathParameters.name;
      const body = JSON.parse(event.body || "{}");
      const { title, body: content, media, userId } = body;

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
        score: 0,
        upvotes: 0,
        downvotes: 0,
        commentCount: 0,
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

    // LIST POSTS IN COMMUNITY - GET /communities/{name}/posts
    if (method === "GET" && event.pathParameters && event.pathParameters.name) {
      const community = event.pathParameters.name;
      const limit = event.queryStringParameters?.limit || 25;
      const lastKey = event.queryStringParameters?.lastKey;
      const sort = event.queryStringParameters?.sort || "new"; // new, hot, top

      const params = {
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { 
          ":pk": `COMM#${community}`,
          ":sk": "POST#"
        },
        Limit: parseInt(limit),
        ScanIndexForward: false // newest first
      };

      if (lastKey) {
        params.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastKey));
      }

      const result = await ddb.send(new QueryCommand(params));

      // Simple sorting (for hot/top, you'd implement more complex logic)
      let items = result.Items || [];
      
      if (sort === "hot") {
        items = items.sort((a, b) => {
          const aScore = a.score / (Math.pow((Date.now() - new Date(a.createdAt).getTime()) / 3600000 + 2, 1.5));
          const bScore = b.score / (Math.pow((Date.now() - new Date(b.createdAt).getTime()) / 3600000 + 2, 1.5));
          return bScore - aScore;
        });
      } else if (sort === "top") {
        items = items.sort((a, b) => b.score - a.score);
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
    if (method === "GET" && path.includes("/posts/") && event.pathParameters && event.pathParameters.postId) {
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

      return { statusCode: 200, body: JSON.stringify(item) };
    }

    return { statusCode: 400, body: JSON.stringify({ message: "bad request" }) };
  } catch (err) {
    console.error("posts error", err);
    return { statusCode: 500, body: JSON.stringify({ message: "internal error", error: err.message }) };
  }
};