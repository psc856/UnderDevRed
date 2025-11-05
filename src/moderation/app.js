const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TABLE = process.env.APP_TABLE;

exports.handler = async (event) => {
  try {
    const method = event.requestContext.httpMethod;
    const path = event.path;

    // REPORT POST - POST /posts/{postId}/report
    if (method === "POST" && event.pathParameters && event.pathParameters.postId && path.includes("/report")) {
      const postId = event.pathParameters.postId;
      const body = JSON.parse(event.body || "{}");
      const { userId, reason, description } = body;

      if (!userId || !reason) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId and reason required" }) };
      }

      const reportId = uuidv4();
      const now = new Date().toISOString();

      const report = {
        PK: `POST#${postId}`,
        SK: `REPORT#${reportId}`,
        GSI1PK: `REPORT#${reportId}`,
        GSI1SK: `CREATED#${now}`,
        type: "report",
        reportId,
        reportType: "post",
        targetId: postId,
        reportedBy: userId,
        reason, // spam, harassment, hate, violence, misinformation, other
        description: description || "",
        status: "pending", // pending, reviewed, dismissed, actioned
        createdAt: now,
        updatedAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: report }));

      return {
        statusCode: 201,
        body: JSON.stringify({ reportId, message: "report submitted" })
      };
    }

    // REPORT COMMENT - POST /comments/{commentId}/report
    if (method === "POST" && event.pathParameters && event.pathParameters.commentId && path.includes("/report")) {
      const commentId = event.pathParameters.commentId;
      const body = JSON.parse(event.body || "{}");
      const { userId, reason, description } = body;

      if (!userId || !reason) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId and reason required" }) };
      }

      const reportId = uuidv4();
      const now = new Date().toISOString();

      const report = {
        PK: `COMMENT#${commentId}`,
        SK: `REPORT#${reportId}`,
        GSI1PK: `REPORT#${reportId}`,
        GSI1SK: `CREATED#${now}`,
        type: "report",
        reportId,
        reportType: "comment",
        targetId: commentId,
        reportedBy: userId,
        reason,
        description: description || "",
        status: "pending",
        createdAt: now,
        updatedAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: report }));

      return {
        statusCode: 201,
        body: JSON.stringify({ reportId, message: "report submitted" })
      };
    }

    // HIDE CONTENT - POST /posts/{postId}/hide OR /comments/{commentId}/hide
    if (method === "POST" && path.includes("/hide")) {
      const body = JSON.parse(event.body || "{}");
      const { userId, moderatorId } = body;

      if (!moderatorId) {
        return { statusCode: 400, body: JSON.stringify({ message: "moderatorId required" }) };
      }

      let targetId, targetType;
      if (event.pathParameters.postId) {
        targetId = event.pathParameters.postId;
        targetType = "post";
      } else if (event.pathParameters.commentId) {
        targetId = event.pathParameters.commentId;
        targetType = "comment";
      }

      // Find the content
      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { 
          ":pk": targetType === "post" ? `POST#${targetId}` : `COMMENT#${targetId}` 
        },
        Limit: 1
      }));

      if (!result.Items || result.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: `${targetType} not found` }) };
      }

      const item = result.Items[0];
      const now = new Date().toISOString();

      // Update status to hidden
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: item.PK, SK: item.SK },
        UpdateExpression: "SET #status = :status, hiddenBy = :mod, hiddenAt = :now, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "hidden",
          ":mod": moderatorId,
          ":now": now
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: `${targetType} hidden` })
      };
    }

    // REMOVE CONTENT - DELETE /posts/{postId}/remove OR /comments/{commentId}/remove
    if (method === "DELETE" && path.includes("/remove")) {
      const body = JSON.parse(event.body || "{}");
      const { moderatorId, reason } = body;

      if (!moderatorId) {
        return { statusCode: 400, body: JSON.stringify({ message: "moderatorId required" }) };
      }

      let targetId, targetType;
      if (event.pathParameters.postId) {
        targetId = event.pathParameters.postId;
        targetType = "post";
      } else if (event.pathParameters.commentId) {
        targetId = event.pathParameters.commentId;
        targetType = "comment";
      }

      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { 
          ":pk": targetType === "post" ? `POST#${targetId}` : `COMMENT#${targetId}` 
        },
        Limit: 1
      }));

      if (!result.Items || result.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: `${targetType} not found` }) };
      }

      const item = result.Items[0];
      const now = new Date().toISOString();

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: item.PK, SK: item.SK },
        UpdateExpression: "SET #status = :status, body = :body, removedBy = :mod, removalReason = :reason, removedAt = :now, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "removed",
          ":body": "[removed by moderator]",
          ":mod": moderatorId,
          ":reason": reason || "violation of community rules",
          ":now": now
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: `${targetType} removed` })
      };
    }

    // BAN USER FROM COMMUNITY - POST /communities/{name}/ban
    if (method === "POST" && event.pathParameters && event.pathParameters.name && path.includes("/ban")) {
      const community = event.pathParameters.name;
      const body = JSON.parse(event.body || "{}");
      const { userId, moderatorId, reason, duration } = body; // duration in days, null = permanent

      if (!userId || !moderatorId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId and moderatorId required" }) };
      }

      const banId = uuidv4();
      const now = new Date().toISOString();
      const expiresAt = duration ? new Date(Date.now() + duration * 24 * 3600000).toISOString() : null;

      const ban = {
        PK: `COMM#${community}`,
        SK: `BAN#${userId}`,
        GSI1PK: `USER#${userId}`,
        GSI1SK: `BAN#${now}`,
        type: "ban",
        banId,
        community,
        userId,
        bannedBy: moderatorId,
        reason: reason || "violation of community rules",
        duration,
        expiresAt,
        status: "active",
        createdAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: ban }));

      return {
        statusCode: 200,
        body: JSON.stringify({ 
          banId, 
          message: "user banned",
          expiresAt: expiresAt || "permanent"
        })
      };
    }

    // UNBAN USER - DELETE /communities/{name}/ban/{userId}
    if (method === "DELETE" && path.includes("/ban") && event.pathParameters.name && event.pathParameters.userId) {
      const community = event.pathParameters.name;
      const userId = event.pathParameters.userId;
      const body = JSON.parse(event.body || "{}");
      const { moderatorId } = body;

      if (!moderatorId) {
        return { statusCode: 400, body: JSON.stringify({ message: "moderatorId required" }) };
      }

      const now = new Date().toISOString();

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `COMM#${community}`, SK: `BAN#${userId}` },
        UpdateExpression: "SET #status = :status, unbannedBy = :mod, unbannedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "revoked",
          ":mod": moderatorId,
          ":now": now
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "user unbanned" })
      };
    }

    // CHECK IF USER IS BANNED - GET /communities/{name}/ban/{userId}
    if (method === "GET" && path.includes("/ban") && event.pathParameters.name && event.pathParameters.userId) {
      const community = event.pathParameters.name;
      const userId = event.pathParameters.userId;

      const result = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `COMM#${community}`, SK: `BAN#${userId}` }
      }));

      if (!result.Item || result.Item.status !== "active") {
        return {
          statusCode: 200,
          body: JSON.stringify({ banned: false })
        };
      }

      const ban = result.Item;

      // Check if temporary ban has expired
      if (ban.expiresAt && new Date(ban.expiresAt) < new Date()) {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `COMM#${community}`, SK: `BAN#${userId}` },
          UpdateExpression: "SET #status = :status",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":status": "expired" }
        }));

        return {
          statusCode: 200,
          body: JSON.stringify({ banned: false })
        };
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ 
          banned: true, 
          reason: ban.reason,
          expiresAt: ban.expiresAt
        })
      };
    }

    // SET MODERATOR ROLE - POST /communities/{name}/moderators
    if (method === "POST" && path.includes("/moderators") && event.pathParameters.name) {
      const community = event.pathParameters.name;
      const body = JSON.parse(event.body || "{}");
      const { userId, assignedBy, permissions } = body;

      if (!userId || !assignedBy) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId and assignedBy required" }) };
      }

      const now = new Date().toISOString();

      const moderator = {
        PK: `COMM#${community}`,
        SK: `MOD#${userId}`,
        GSI1PK: `USER#${userId}`,
        GSI1SK: `MOD#${now}`,
        type: "moderator",
        community,
        userId,
        assignedBy,
        permissions: permissions || ["all"], // all, posts, comments, users, reports
        status: "active",
        assignedAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: moderator }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "moderator assigned" })
      };
    }

    // GET PENDING REPORTS - GET /reports/pending
    if (method === "GET" && path.includes("/reports/pending")) {
      const limit = parseInt(event.queryStringParameters?.limit || 50);

      const params = {
        TableName: TABLE,
        FilterExpression: "#type = :type AND #status = :status",
        ExpressionAttributeNames: {
          "#type": "type",
          "#status": "status"
        },
        ExpressionAttributeValues: {
          ":type": "report",
          ":status": "pending"
        },
        Limit: limit
      };

      const result = await ddb.send(new ScanCommand(params));
      
      const reports = (result.Items || []).sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      return {
        statusCode: 200,
        body: JSON.stringify({ reports, count: reports.length })
      };
    }

    // UPDATE REPORT STATUS - PUT /reports/{reportId}
    if (method === "PUT" && event.pathParameters && event.pathParameters.reportId) {
      const reportId = event.pathParameters.reportId;
      const body = JSON.parse(event.body || "{}");
      const { moderatorId, status, action } = body; // status: reviewed, dismissed, actioned

      if (!moderatorId || !status) {
        return { statusCode: 400, body: JSON.stringify({ message: "moderatorId and status required" }) };
      }

      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `REPORT#${reportId}` },
        Limit: 1
      }));

      if (!result.Items || result.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "report not found" }) };
      }

      const report = result.Items[0];
      const now = new Date().toISOString();

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: report.PK, SK: report.SK },
        UpdateExpression: "SET #status = :status, reviewedBy = :mod, reviewedAt = :now, action = :action, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":mod": moderatorId,
          ":now": now,
          ":action": action || "none"
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "report updated" })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ message: "bad request" }) };
  } catch (err) {
    console.error("moderation error", err);
    return { statusCode: 500, body: JSON.stringify({ message: "internal error", error: err.message }) };
  }
};