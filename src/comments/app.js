const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TABLE = process.env.APP_TABLE;

exports.handler = async (event) => {
  try {
    const method = event.requestContext.httpMethod;
    const path = event.path;

    // CREATE COMMENT - POST /posts/{postId}/comments
    if (method === "POST" && event.pathParameters && event.pathParameters.postId && path.includes("/posts/")) {
      const postId = event.pathParameters.postId;
      const body = JSON.parse(event.body || "{}");
      const { userId, body: commentBody, parentCommentId } = body;

      if (!userId || !commentBody) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ message: "userId and body required" }) 
        };
      }

      const commentId = uuidv4();
      const now = new Date().toISOString();

      // Determine depth and path for nested comments
      let depth = 0;
      let commentPath = commentId;

      if (parentCommentId) {
        // Get parent comment to determine depth
        const parentResult = await ddb.send(new QueryCommand({
          TableName: TABLE,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": `COMMENT#${parentCommentId}` },
          Limit: 1
        }));

        if (parentResult.Items && parentResult.Items.length > 0) {
          const parent = parentResult.Items[0];
          depth = (parent.depth || 0) + 1;
          commentPath = `${parent.commentPath}/${commentId}`;
        }
      }

      const item = {
        PK: `POST#${postId}`,
        SK: `COMMENT#${commentId}`,
        GSI1PK: `COMMENT#${commentId}`,
        GSI1SK: `CREATED#${now}`,
        type: "comment",
        commentId,
        postId,
        userId,
        body: commentBody,
        parentCommentId: parentCommentId || null,
        depth,
        commentPath,
        upvotes: 0,
        downvotes: 0,
        score: 0,
        replyCount: 0,
        status: "active",
        createdAt: now,
        updatedAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));

      // Increment comment count on post
      const postResult = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `POST#${postId}` },
        Limit: 1
      }));

      if (postResult.Items && postResult.Items.length > 0) {
        const post = postResult.Items[0];
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: post.PK, SK: post.SK },
          UpdateExpression: "ADD commentCount :inc SET updatedAt = :now",
          ExpressionAttributeValues: { 
            ":inc": 1,
            ":now": now
          }
        }));
      }

      // If reply, increment reply count on parent comment
      if (parentCommentId) {
        const parentResult = await ddb.send(new QueryCommand({
          TableName: TABLE,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": `COMMENT#${parentCommentId}` },
          Limit: 1
        }));

        if (parentResult.Items && parentResult.Items.length > 0) {
          const parent = parentResult.Items[0];
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { PK: parent.PK, SK: parent.SK },
            UpdateExpression: "ADD replyCount :inc SET updatedAt = :now",
            ExpressionAttributeValues: { 
              ":inc": 1,
              ":now": now
            }
          }));
        }
      }

      return {
        statusCode: 201,
        body: JSON.stringify({ 
          commentId, 
          createdAt: now,
          depth,
          parentCommentId: parentCommentId || null
        })
      };
    }

    // GET COMMENTS FOR POST - GET /posts/{postId}/comments
    if (method === "GET" && event.pathParameters && event.pathParameters.postId && path.includes("/posts/")) {
      const postId = event.pathParameters.postId;
      const limit = event.queryStringParameters?.limit || 50;
      const sort = event.queryStringParameters?.sort || "best"; // best, new, top, controversial
      const lastKey = event.queryStringParameters?.lastKey;

      const params = {
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { 
          ":pk": `POST#${postId}`,
          ":sk": "COMMENT#"
        },
        Limit: parseInt(limit)
      };

      if (lastKey) {
        params.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastKey));
      }

      const result = await ddb.send(new QueryCommand(params));
      let comments = result.Items || [];

      // Sort comments
      if (sort === "best") {
        comments = comments.sort((a, b) => {
          const aScore = (a.upvotes + 1) / (a.upvotes + a.downvotes + 1);
          const bScore = (b.upvotes + 1) / (b.upvotes + b.downvotes + 1);
          return bScore - aScore;
        });
      } else if (sort === "new") {
        comments = comments.sort((a, b) => 
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      } else if (sort === "top") {
        comments = comments.sort((a, b) => b.score - a.score);
      } else if (sort === "controversial") {
        comments = comments.sort((a, b) => {
          const aControversy = Math.min(a.upvotes, a.downvotes);
          const bControversy = Math.min(b.upvotes, b.downvotes);
          return bControversy - aControversy;
        });
      }

      // Build nested comment tree
      const buildTree = (comments) => {
        const commentMap = {};
        const roots = [];

        // First pass: create map
        comments.forEach(comment => {
          commentMap[comment.commentId] = { ...comment, replies: [] };
        });

        // Second pass: build tree
        comments.forEach(comment => {
          if (comment.parentCommentId && commentMap[comment.parentCommentId]) {
            commentMap[comment.parentCommentId].replies.push(commentMap[comment.commentId]);
          } else {
            roots.push(commentMap[comment.commentId]);
          }
        });

        return roots;
      };

      const tree = buildTree(comments);

      return {
        statusCode: 200,
        body: JSON.stringify({
          comments: tree,
          count: comments.length,
          lastKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null
        })
      };
    }

    // GET SINGLE COMMENT - GET /comments/{commentId}
    if (method === "GET" && event.pathParameters && event.pathParameters.commentId && path.includes("/comments/") && !path.includes("/vote")) {
      const commentId = event.pathParameters.commentId;

      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `COMMENT#${commentId}` }
      }));

      const comment = result.Items && result.Items[0];
      if (!comment) {
        return { statusCode: 404, body: JSON.stringify({ message: "comment not found" }) };
      }

      return { statusCode: 200, body: JSON.stringify(comment) };
    }

    // UPDATE COMMENT - PUT /comments/{commentId}
    if (method === "PUT" && event.pathParameters && event.pathParameters.commentId) {
      const commentId = event.pathParameters.commentId;
      const body = JSON.parse(event.body || "{}");
      const { userId, body: newBody } = body;

      if (!userId || !newBody) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ message: "userId and body required" }) 
        };
      }

      // Get comment to verify ownership
      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `COMMENT#${commentId}` }
      }));

      const comment = result.Items && result.Items[0];
      if (!comment) {
        return { statusCode: 404, body: JSON.stringify({ message: "comment not found" }) };
      }

      if (comment.userId !== userId) {
        return { statusCode: 403, body: JSON.stringify({ message: "not authorized" }) };
      }

      const now = new Date().toISOString();

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: comment.PK, SK: comment.SK },
        UpdateExpression: "SET body = :body, updatedAt = :now, edited = :edited",
        ExpressionAttributeValues: {
          ":body": newBody,
          ":now": now,
          ":edited": true
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "comment updated", updatedAt: now })
      };
    }

    // DELETE COMMENT - DELETE /comments/{commentId}
    if (method === "DELETE" && event.pathParameters && event.pathParameters.commentId) {
      const commentId = event.pathParameters.commentId;
      const body = JSON.parse(event.body || "{}");
      const { userId } = body;

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      // Get comment to verify ownership
      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `COMMENT#${commentId}` }
      }));

      const comment = result.Items && result.Items[0];
      if (!comment) {
        return { statusCode: 404, body: JSON.stringify({ message: "comment not found" }) };
      }

      if (comment.userId !== userId) {
        return { statusCode: 403, body: JSON.stringify({ message: "not authorized" }) };
      }

      const now = new Date().toISOString();

      // Soft delete - mark as deleted instead of removing
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: comment.PK, SK: comment.SK },
        UpdateExpression: "SET status = :status, body = :body, updatedAt = :now",
        ExpressionAttributeValues: {
          ":status": "deleted",
          ":body": "[deleted]",
          ":now": now
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "comment deleted" })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ message: "bad request" }) };
  } catch (err) {
    console.error("comments error", err);
    return { statusCode: 500, body: JSON.stringify({ message: "internal error", error: err.message }) };
  }
};