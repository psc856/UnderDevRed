const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TABLE = process.env.APP_TABLE;

exports.handler = async (event) => {
  try {
    const method = event.requestContext.httpMethod;
    const path = event.path;

    // VOTE ON POST - POST /posts/{postId}/vote
    if (method === "POST" && event.pathParameters && event.pathParameters.postId && path.includes("/posts/") && path.includes("/vote")) {
      const postId = event.pathParameters.postId;
      const body = JSON.parse(event.body || "{}");
      const { userId, vote } = body;

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      if (!["up", "down", "remove"].includes(vote)) {
        return { statusCode: 400, body: JSON.stringify({ message: "vote must be 'up', 'down', or 'remove'" }) };
      }

      // First, find the post using GSI1
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
      const postPK = post.PK; // This will be COMM#gaming
      const postSK = post.SK; // This will be POST#postId

      // Get existing vote using a composite key based on post location
      const voteKey = `${postPK}#${postSK}#VOTE#${userId}`;
      const existingVote = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: postPK, SK: `VOTE#${postSK}#${userId}` }
      }));

      const previousVote = existingVote.Item?.voteType;
      const now = new Date().toISOString();

      let upvoteDelta = 0;
      let downvoteDelta = 0;

      // Calculate deltas
      if (vote === "remove") {
        if (previousVote === "up") upvoteDelta = -1;
        if (previousVote === "down") downvoteDelta = -1;
        
        if (previousVote) {
          await ddb.send(new DeleteCommand({
            TableName: TABLE,
            Key: { PK: postPK, SK: `VOTE#${postSK}#${userId}` }
          }));
        }
      } else {
        // Remove previous vote if exists
        if (previousVote === "up") upvoteDelta = -1;
        if (previousVote === "down") downvoteDelta = -1;

        // Add new vote
        if (vote === "up") upvoteDelta += 1;
        if (vote === "down") downvoteDelta += 1;

        // Store vote record
        await ddb.send(new PutCommand({
          TableName: TABLE,
          Item: {
            PK: postPK,
            SK: `VOTE#${postSK}#${userId}`,
            GSI1PK: `USER#${userId}`,
            GSI1SK: `POSTVOTE#${now}`,
            type: "vote",
            postId,
            userId,
            voteType: vote,
            createdAt: now
          }
        }));
      }

      // Update post vote counts
      const scoreDelta = upvoteDelta - downvoteDelta;
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: postPK, SK: postSK },
        UpdateExpression: "ADD upvotes :upDelta, downvotes :downDelta, score :scoreDelta SET updatedAt = :now",
        ExpressionAttributeValues: {
          ":upDelta": upvoteDelta,
          ":downDelta": downvoteDelta,
          ":scoreDelta": scoreDelta,
          ":now": now
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ 
          message: "vote recorded",
          vote: vote === "remove" ? null : vote,
          scoreDelta 
        })
      };
    }

    // GET USER'S VOTE ON POST - GET /posts/{postId}/vote
    if (method === "GET" && event.pathParameters && event.pathParameters.postId && path.includes("/vote")) {
      const postId = event.pathParameters.postId;
      const userId = event.queryStringParameters?.userId;

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      // Find post first
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
      const vote = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: post.PK, SK: `VOTE#${post.SK}#${userId}` }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ 
          vote: vote.Item ? vote.Item.voteType : null 
        })
      };
    }

    // VOTE ON COMMENT - POST /comments/{commentId}/vote
    if (method === "POST" && event.pathParameters && event.pathParameters.commentId && path.includes("/comments/")) {
      const commentId = event.pathParameters.commentId;
      const body = JSON.parse(event.body || "{}");
      const { userId, vote } = body;

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      if (!["up", "down", "remove"].includes(vote)) {
        return { statusCode: 400, body: JSON.stringify({ message: "vote must be 'up', 'down', or 'remove'" }) };
      }

      // Find comment first
      const commentResult = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `COMMENT#${commentId}` },
        Limit: 1
      }));

      if (!commentResult.Items || commentResult.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "comment not found" }) };
      }

      const comment = commentResult.Items[0];
      const commentPK = comment.PK;
      const commentSK = comment.SK;

      const existingVote = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: commentPK, SK: `VOTE#${commentSK}#${userId}` }
      }));

      const previousVote = existingVote.Item?.voteType;
      const now = new Date().toISOString();

      let upvoteDelta = 0;
      let downvoteDelta = 0;

      if (vote === "remove") {
        if (previousVote === "up") upvoteDelta = -1;
        if (previousVote === "down") downvoteDelta = -1;
        
        if (previousVote) {
          await ddb.send(new DeleteCommand({
            TableName: TABLE,
            Key: { PK: commentPK, SK: `VOTE#${commentSK}#${userId}` }
          }));
        }
      } else {
        if (previousVote === "up") upvoteDelta = -1;
        if (previousVote === "down") downvoteDelta = -1;

        if (vote === "up") upvoteDelta += 1;
        if (vote === "down") downvoteDelta += 1;

        await ddb.send(new PutCommand({
          TableName: TABLE,
          Item: {
            PK: commentPK,
            SK: `VOTE#${commentSK}#${userId}`,
            GSI1PK: `USER#${userId}`,
            GSI1SK: `COMMENTVOTE#${now}`,
            type: "comment_vote",
            commentId,
            userId,
            voteType: vote,
            createdAt: now
          }
        }));
      }

      const scoreDelta = upvoteDelta - downvoteDelta;

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: commentPK, SK: commentSK },
        UpdateExpression: "ADD upvotes :upDelta, downvotes :downDelta, score :scoreDelta SET updatedAt = :now",
        ExpressionAttributeValues: {
          ":upDelta": upvoteDelta,
          ":downDelta": downvoteDelta,
          ":scoreDelta": scoreDelta,
          ":now": now
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ 
          message: "vote recorded",
          vote: vote === "remove" ? null : vote,
          scoreDelta 
        })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ message: "bad request" }) };
  } catch (err) {
    console.error("voting error", err);
    return { statusCode: 500, body: JSON.stringify({ message: "internal error", error: err.message }) };
  }
};