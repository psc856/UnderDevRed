const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand, ScanCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { ComprehendClient, DetectSentimentCommand, DetectKeyPhrasesCommand, DetectEntitiesCommand } = require("@aws-sdk/client-comprehend");
const { RekognitionClient, DetectModerationLabelsCommand, DetectLabelsCommand } = require("@aws-sdk/client-rekognition");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const comprehend = new ComprehendClient({});
const rekognition = new RekognitionClient({});

const TABLE = process.env.APP_TABLE;

exports.handler = async (event) => {
  try {
    const method = event.requestContext.httpMethod;
    const path = event.path;

    // AUTO-TAG POST - POST /posts/{postId}/auto-tag
    if (method === "POST" && event.pathParameters && event.pathParameters.postId && path.includes("/auto-tag")) {
      const postId = event.pathParameters.postId;

      // Get post
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
      const text = `${post.title}. ${post.body}`;

      try {
        // Detect key phrases
        const keyPhrasesResult = await comprehend.send(new DetectKeyPhrasesCommand({
          Text: text,
          LanguageCode: "en"
        }));

        // Detect entities (people, places, organizations)
        const entitiesResult = await comprehend.send(new DetectEntitiesCommand({
          Text: text,
          LanguageCode: "en"
        }));

        // Extract relevant tags
        const phrases = (keyPhrasesResult.KeyPhrases || [])
          .filter(kp => kp.Score > 0.8)
          .map(kp => kp.Text.toLowerCase())
          .slice(0, 5);

        const entities = (entitiesResult.Entities || [])
          .filter(e => ["PERSON", "LOCATION", "ORGANIZATION", "EVENT"].includes(e.Type) && e.Score > 0.8)
          .map(e => e.Text.toLowerCase())
          .slice(0, 3);

        const suggestedTags = [...new Set([...phrases, ...entities])].slice(0, 8);

        // Update post with tags
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: post.PK, SK: post.SK },
          UpdateExpression: "SET tags = :tags, autoTagged = :auto",
          ExpressionAttributeValues: {
            ":tags": suggestedTags,
            ":auto": true
          }
        }));

        return {
          statusCode: 200,
          body: JSON.stringify({ 
            tags: suggestedTags,
            message: "tags auto-generated"
          })
        };
      } catch (err) {
        console.error("Comprehend error", err);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ message: "AI analysis failed", error: err.message }) 
        };
      }
    }

    // SENTIMENT ANALYSIS - GET /posts/{postId}/sentiment OR /comments/{commentId}/sentiment
    if (method === "GET" && path.includes("/sentiment")) {
      let targetId, targetType;
      if (event.pathParameters.postId) {
        targetId = event.pathParameters.postId;
        targetType = "post";
      } else if (event.pathParameters.commentId) {
        targetId = event.pathParameters.commentId;
        targetType = "comment";
      }

      // Get content
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
      const text = targetType === "post" ? `${item.title}. ${item.body}` : item.body;

      try {
        const sentimentResult = await comprehend.send(new DetectSentimentCommand({
          Text: text,
          LanguageCode: "en"
        }));

        return {
          statusCode: 200,
          body: JSON.stringify({
            sentiment: sentimentResult.Sentiment,
            scores: {
              positive: sentimentResult.SentimentScore.Positive,
              negative: sentimentResult.SentimentScore.Negative,
              neutral: sentimentResult.SentimentScore.Neutral,
              mixed: sentimentResult.SentimentScore.Mixed
            }
          })
        };
      } catch (err) {
        console.error("Sentiment analysis error", err);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ message: "sentiment analysis failed" }) 
        };
      }
    }

    // MODERATE IMAGE - POST /media/moderate
    if (method === "POST" && path.includes("/media/moderate")) {
      const body = JSON.parse(event.body || "{}");
      const { s3Key } = body;

      if (!s3Key) {
        return { statusCode: 400, body: JSON.stringify({ message: "s3Key required" }) };
      }

      try {
        const moderationResult = await rekognition.send(new DetectModerationLabelsCommand({
          Image: {
            S3Object: {
              Bucket: process.env.MEDIA_BUCKET,
              Name: s3Key
            }
          },
          MinConfidence: 60
        }));

        const unsafe = (moderationResult.ModerationLabels || []).filter(label => label.Confidence > 75);
        const isAppropriate = unsafe.length === 0;

        // Also detect general labels for categorization
        const labelsResult = await rekognition.send(new DetectLabelsCommand({
          Image: {
            S3Object: {
              Bucket: process.env.MEDIA_BUCKET,
              Name: s3Key
            }
          },
          MaxLabels: 10,
          MinConfidence: 75
        }));

        return {
          statusCode: 200,
          body: JSON.stringify({
            appropriate: isAppropriate,
            moderationLabels: unsafe,
            contentLabels: (labelsResult.Labels || []).map(l => ({
              name: l.Name,
              confidence: l.Confidence
            }))
          })
        };
      } catch (err) {
        console.error("Image moderation error", err);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ message: "image moderation failed" }) 
        };
      }
    }

    // GET PERSONALIZED RECOMMENDATIONS - GET /recommendations
    if (method === "GET" && path === "/recommendations") {
      const userId = event.queryStringParameters?.userId;
      const limit = parseInt(event.queryStringParameters?.limit || 10);

      if (!userId) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId required" }) };
      }

      // Get user's interaction history (votes, comments, views)
      const votesResult = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":sk": "POSTVOTE#"
        },
        Limit: 50
      }));

      // Get posts user upvoted
      const upvotedPostIds = (votesResult.Items || [])
        .filter(v => v.voteType === "up")
        .map(v => v.postId);

      if (upvotedPostIds.length === 0) {
        // New user - return trending posts
        const trending = await ddb.send(new ScanCommand({
          TableName: TABLE,
          FilterExpression: "#type = :type AND #status = :status",
          ExpressionAttributeNames: {
            "#type": "type",
            "#status": "status"
          },
          ExpressionAttributeValues: {
            ":type": "post",
            ":status": "active"
          },
          Limit: limit
        }));

        return {
          statusCode: 200,
          body: JSON.stringify({
            posts: (trending.Items || []).sort((a, b) => b.score - a.score).slice(0, limit),
            reason: "trending_for_new_user"
          })
        };
      }

      // Get tags from upvoted posts
      const postsPromises = upvotedPostIds.slice(0, 10).map(async (postId) => {
        const result = await ddb.send(new QueryCommand({
          TableName: TABLE,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": `POST#${postId}` },
          Limit: 1
        }));
        return result.Items ? result.Items[0] : null;
      });

      const upvotedPosts = (await Promise.all(postsPromises)).filter(p => p);
      const userTags = [...new Set(upvotedPosts.flatMap(p => p.tags || []))];
      const userCommunities = [...new Set(upvotedPosts.map(p => p.community))];

      // Find similar posts
      const allPosts = await ddb.send(new ScanCommand({
        TableName: TABLE,
        FilterExpression: "#type = :type AND #status = :status",
        ExpressionAttributeNames: {
          "#type": "type",
          "#status": "status"
        },
        ExpressionAttributeValues: {
          ":type": "post",
          ":status": "active"
        },
        Limit: 100
      }));

      // Calculate similarity score
      const scored = (allPosts.Items || [])
        .filter(post => !upvotedPostIds.includes(post.postId)) // Exclude already seen
        .map(post => {
          let score = 0;
          
          // Tag similarity
          const commonTags = (post.tags || []).filter(tag => userTags.includes(tag));
          score += commonTags.length * 3;
          
          // Community preference
          if (userCommunities.includes(post.community)) {
            score += 5;
          }
          
          // Recency bonus
          const ageHours = (Date.now() - new Date(post.createdAt).getTime()) / 3600000;
          if (ageHours < 24) score += 2;
          
          // Engagement bonus
          score += Math.log(post.score + 1);
          
          return { ...post, similarityScore: score };
        })
        .sort((a, b) => b.similarityScore - a.similarityScore)
        .slice(0, limit);

      return {
        statusCode: 200,
        body: JSON.stringify({
          posts: scored,
          reason: "personalized",
          basedOn: {
            tags: userTags.slice(0, 5),
            communities: userCommunities
          }
        })
      };
    }

    // DISCOVER COMMUNITIES - GET /communities/discover
    if (method === "GET" && path.includes("/communities/discover")) {
      const userId = event.queryStringParameters?.userId;
      const limit = parseInt(event.queryStringParameters?.limit || 5);

      // Get user's communities
      let userCommunities = [];
      if (userId) {
        const memberResult = await ddb.send(new QueryCommand({
          TableName: TABLE,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sk)",
          ExpressionAttributeValues: {
            ":pk": `USER#${userId}`,
            ":sk": "JOINED#"
          }
        }));
        userCommunities = (memberResult.Items || []).map(m => m.communityName);
      }

      // Get all communities
      const allCommunities = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": "COMMUNITY" }
      }));

      // Filter and score
      const scored = (allCommunities.Items || [])
        .filter(comm => !userCommunities.includes(comm.name))
        .map(comm => {
          let score = 0;
          
          // Activity score
          score += comm.postCount * 2;
          score += comm.memberCount;
          
          // Recency
          const ageMonths = (Date.now() - new Date(comm.createdAt).getTime()) / (30 * 24 * 3600000);
          if (ageMonths < 1) score += 10; // New communities get boost
          
          return { ...comm, discoverScore: score };
        })
        .sort((a, b) => b.discoverScore - a.discoverScore)
        .slice(0, limit);

      return {
        statusCode: 200,
        body: JSON.stringify({
          communities: scored,
          message: "discover new communities"
        })
      };
    }

    // ANALYZE COMMENT TOXICITY - POST /comments/{commentId}/analyze-toxicity
    if (method === "POST" && event.pathParameters && event.pathParameters.commentId && path.includes("/analyze-toxicity")) {
      const commentId = event.pathParameters.commentId;

      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `COMMENT#${commentId}` },
        Limit: 1
      }));

      if (!result.Items || result.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "comment not found" }) };
      }

      const comment = result.Items[0];

      try {
        // Use sentiment as proxy for toxicity
        const sentimentResult = await comprehend.send(new DetectSentimentCommand({
          Text: comment.body,
          LanguageCode: "en"
        }));

        const negativeScore = sentimentResult.SentimentScore.Negative;
        const isToxic = negativeScore > 0.75;

        // Simple keyword detection for common toxic patterns
        const toxicKeywords = ["hate", "stupid", "idiot", "kill", "die"];
        const containsToxicWords = toxicKeywords.some(word => 
          comment.body.toLowerCase().includes(word)
        );

        const toxicity = {
          score: negativeScore,
          isToxic: isToxic || containsToxicWords,
          sentiment: sentimentResult.Sentiment,
          containsToxicKeywords: containsToxicWords
        };

        // If toxic, flag for moderation
        if (toxicity.isToxic) {
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { PK: comment.PK, SK: comment.SK },
            UpdateExpression: "SET flaggedForReview = :flag, toxicityScore = :score",
            ExpressionAttributeValues: {
              ":flag": true,
              ":score": negativeScore
            }
          }));
        }

        return {
          statusCode: 200,
          body: JSON.stringify(toxicity)
        };
      } catch (err) {
        console.error("Toxicity analysis error", err);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ message: "toxicity analysis failed" }) 
        };
      }
    }

    return { statusCode: 400, body: JSON.stringify({ message: "bad request" }) };
  } catch (err) {
    console.error("AI features error", err);
    return { statusCode: 500, body: JSON.stringify({ message: "internal error", error: err.message }) };
  }
};