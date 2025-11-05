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

    // CREATE COMMUNITY - POST /communities
    if (method === "POST" && path === "/communities") {
      const body = JSON.parse(event.body || "{}");
      const { name, displayName, description, category, rules } = body;

      if (!name || !displayName) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ message: "name and displayName required" }) 
        };
      }

      // Check if community already exists
      const existing = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `COMM#${name}`, SK: "META" }
      }));

      if (existing.Item) {
        return { 
          statusCode: 409, 
          body: JSON.stringify({ message: "community already exists" }) 
        };
      }

      const now = new Date().toISOString();
      const communityId = uuidv4();

      const item = {
        PK: `COMM#${name}`,
        SK: "META",
        GSI1PK: "COMMUNITY",
        GSI1SK: `CREATED#${now}`,
        type: "community",
        communityId,
        name,
        displayName,
        description: description || "",
        category: category || "general",
        rules: rules || [],
        memberCount: 0,
        postCount: 0,
        status: "active",
        createdAt: now,
        updatedAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));

      return {
        statusCode: 201,
        body: JSON.stringify({ 
          communityId, 
          name, 
          displayName,
          createdAt: now 
        })
      };
    }

    // GET COMMUNITY - GET /communities/{name}
    if (method === "GET" && event.pathParameters && event.pathParameters.name) {
      const name = event.pathParameters.name;

      const result = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `COMM#${name}`, SK: "META" }
      }));

      if (!result.Item) {
        return { 
          statusCode: 404, 
          body: JSON.stringify({ message: "community not found" }) 
        };
      }

      return { 
        statusCode: 200, 
        body: JSON.stringify(result.Item) 
      };
    }

    // LIST ALL COMMUNITIES - GET /communities
    if (method === "GET" && path === "/communities") {
      const limit = event.queryStringParameters?.limit || 20;
      const lastKey = event.queryStringParameters?.lastKey;

      const params = {
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": "COMMUNITY" },
        Limit: parseInt(limit),
        ScanIndexForward: false // newest first
      };

      if (lastKey) {
        params.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastKey));
      }

      const result = await ddb.send(new QueryCommand(params));

      return {
        statusCode: 200,
        body: JSON.stringify({
          communities: result.Items || [],
          lastKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null
        })
      };
    }

    // JOIN COMMUNITY - POST /communities/{name}/join
    if (method === "POST" && event.pathParameters && event.pathParameters.name && path.includes("/join")) {
      const name = event.pathParameters.name;
      const body = JSON.parse(event.body || "{}");
      const { userId } = body;

      if (!userId) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ message: "userId required" }) 
        };
      }

      const now = new Date().toISOString();

      // Add membership record
      const memberItem = {
        PK: `COMM#${name}`,
        SK: `MEMBER#${userId}`,
        GSI1PK: `USER#${userId}`,
        GSI1SK: `JOINED#${now}`,
        type: "membership",
        userId,
        communityName: name,
        role: "member",
        joinedAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: memberItem }));

      // Increment member count
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `COMM#${name}`, SK: "META" },
        UpdateExpression: "ADD memberCount :inc SET updatedAt = :now",
        ExpressionAttributeValues: { 
          ":inc": 1,
          ":now": now
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "joined successfully", joinedAt: now })
      };
    }

    // LEAVE COMMUNITY - POST /communities/{name}/leave
    if (method === "POST" && event.pathParameters && event.pathParameters.name && path.includes("/leave")) {
      const name = event.pathParameters.name;
      const body = JSON.parse(event.body || "{}");
      const { userId } = body;

      if (!userId) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ message: "userId required" }) 
        };
      }

      const now = new Date().toISOString();

      // Remove membership record
      const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
      await ddb.send(new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `COMM#${name}`, SK: `MEMBER#${userId}` }
      }));

      // Decrement member count
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `COMM#${name}`, SK: "META" },
        UpdateExpression: "ADD memberCount :dec SET updatedAt = :now",
        ExpressionAttributeValues: { 
          ":dec": -1,
          ":now": now
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "left successfully" })
      };
    }

    return { 
      statusCode: 400, 
      body: JSON.stringify({ message: "bad request" }) 
    };

  } catch (err) {
    console.error("communities error", err);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ message: "internal error", error: err.message }) 
    };
  }
};