const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TABLE = process.env.APP_TABLE;

// Badge definitions
const BADGES = {
  FIRST_POST: { id: "first_post", name: "First Post", description: "Created your first post", icon: "✍️", rarity: "common" },
  FIRST_COMMENT: { id: "first_comment", name: "Conversationalist", description: "Made your first comment", icon: "💬", rarity: "common" },
  KARMA_100: { id: "karma_100", name: "Rising Star", description: "Earned 100 karma", icon: "⭐", rarity: "common" },
  KARMA_1000: { id: "karma_1000", name: "Influencer", description: "Earned 1,000 karma", icon: "🌟", rarity: "rare" },
  KARMA_10000: { id: "karma_10000", name: "Legend", description: "Earned 10,000 karma", icon: "👑", rarity: "epic" },
  STREAK_7: { id: "streak_7", name: "Week Warrior", description: "7-day streak", icon: "🔥", rarity: "rare" },
  STREAK_30: { id: "streak_30", name: "Monthly Master", description: "30-day streak", icon: "💎", rarity: "epic" },
  STREAK_365: { id: "streak_365", name: "Year Veteran", description: "365-day streak", icon: "🏆", rarity: "legendary" },
  TOP_POST: { id: "top_post", name: "Viral", description: "Post reached top 10", icon: "🚀", rarity: "rare" },
  HELPFUL: { id: "helpful", name: "Helper", description: "10 upvoted comments", icon: "🤝", rarity: "common" },
  COMMUNITY_FOUNDER: { id: "community_founder", name: "Founder", description: "Created a community", icon: "🏗️", rarity: "rare" },
  EARLY_ADOPTER: { id: "early_adopter", name: "Early Adopter", description: "Joined in first month", icon: "🎯", rarity: "legendary" }
};

exports.handler = async (event) => {
  try {
    const method = event.requestContext.httpMethod;
    const path = event.path;

    // AWARD BADGE - POST /users/{username}/badges
    if (method === "POST" && event.pathParameters && event.pathParameters.username && path.includes("/badges")) {
      const username = event.pathParameters.username;
      const body = JSON.parse(event.body || "{}");
      const { badgeId, autoAwarded } = body;

      if (!badgeId || !BADGES[badgeId.toUpperCase()]) {
        return { statusCode: 400, body: JSON.stringify({ message: "invalid badgeId" }) };
      }

      const badge = BADGES[badgeId.toUpperCase()];
      const now = new Date().toISOString();

      // Check if already has badge
      const existing = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: `BADGE#${badge.id}` }
      }));

      if (existing.Item) {
        return { statusCode: 409, body: JSON.stringify({ message: "badge already awarded" }) };
      }

      const userBadge = {
        PK: `USER#${username}`,
        SK: `BADGE#${badge.id}`,
        GSI1PK: `BADGE#${badge.id}`,
        GSI1SK: `AWARDED#${now}`,
        type: "badge",
        badgeId: badge.id,
        username,
        badge,
        autoAwarded: autoAwarded || false,
        awardedAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: userBadge }));

      // Increment badge count
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" },
        UpdateExpression: "ADD awardCount :inc",
        ExpressionAttributeValues: { ":inc": 1 }
      }));

      return {
        statusCode: 201,
        body: JSON.stringify({ 
          message: "badge awarded",
          badge,
          awardedAt: now
        })
      };
    }

    // GET USER BADGES - GET /users/{username}/badges
    if (method === "GET" && event.pathParameters && event.pathParameters.username && path.includes("/badges")) {
      const username = event.pathParameters.username;

      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `USER#${username}`,
          ":sk": "BADGE#"
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({
          badges: result.Items || [],
          count: (result.Items || []).length
        })
      };
    }

    // UPDATE STREAK - POST /users/{username}/streak
    if (method === "POST" && event.pathParameters && event.pathParameters.username && path.includes("/streak")) {
      const username = event.pathParameters.username;
      const now = new Date();
      const today = now.toISOString().split('T')[0];

      // Get user profile
      const user = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" }
      }));

      if (!user.Item) {
        return { statusCode: 404, body: JSON.stringify({ message: "user not found" }) };
      }

      const profile = user.Item;
      const lastActive = profile.lastActiveDate;
      const currentStreak = profile.currentStreak || 0;
      const longestStreak = profile.longestStreak || 0;

      let newStreak = currentStreak;

      if (!lastActive) {
        // First day
        newStreak = 1;
      } else {
        const lastDate = new Date(lastActive);
        const diffDays = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));

        if (diffDays === 0) {
          // Same day, no change
          return {
            statusCode: 200,
            body: JSON.stringify({ 
              currentStreak,
              message: "already checked in today"
            })
          };
        } else if (diffDays === 1) {
          // Consecutive day
          newStreak = currentStreak + 1;
        } else {
          // Streak broken
          newStreak = 1;
        }
      }

      const newLongest = Math.max(newStreak, longestStreak);

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" },
        UpdateExpression: "SET currentStreak = :streak, longestStreak = :longest, lastActiveDate = :date, updatedAt = :now",
        ExpressionAttributeValues: {
          ":streak": newStreak,
          ":longest": newLongest,
          ":date": today,
          ":now": now.toISOString()
        }
      }));

      // Auto-award streak badges
      const streakBadges = {
        7: "STREAK_7",
        30: "STREAK_30",
        365: "STREAK_365"
      };

      for (const [days, badgeKey] of Object.entries(streakBadges)) {
        if (newStreak >= parseInt(days) && currentStreak < parseInt(days)) {
          // Award badge
          const badge = BADGES[badgeKey];
          await ddb.send(new PutCommand({
            TableName: TABLE,
            Item: {
              PK: `USER#${username}`,
              SK: `BADGE#${badge.id}`,
              GSI1PK: `BADGE#${badge.id}`,
              GSI1SK: `AWARDED#${now.toISOString()}`,
              type: "badge",
              badgeId: badge.id,
              username,
              badge,
              autoAwarded: true,
              awardedAt: now.toISOString()
            }
          }));
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ 
          currentStreak: newStreak,
          longestStreak: newLongest,
          streakIncreased: newStreak > currentStreak
        })
      };
    }

    // GET COMMUNITY LEADERBOARD - GET /communities/{name}/leaderboard
    if (method === "GET" && event.pathParameters && event.pathParameters.name && path.includes("/leaderboard")) {
      const community = event.pathParameters.name;
      const timeframe = event.queryStringParameters?.timeframe || "all"; // day, week, month, all
      const limit = parseInt(event.queryStringParameters?.limit || 10);

      const now = Date.now();
      const timeframes = {
        day: 24 * 3600000,
        week: 7 * 24 * 3600000,
        month: 30 * 24 * 3600000,
        all: Infinity
      };

      // Get all posts in community
      const postsResult = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `COMM#${community}`,
          ":sk": "POST#"
        }
      }));

      // Calculate user scores
      const userScores = {};
      (postsResult.Items || []).forEach(post => {
        if (post.status === "active" && now - new Date(post.createdAt).getTime() < timeframes[timeframe]) {
          const userId = post.userId;
          if (!userScores[userId]) {
            userScores[userId] = { userId, posts: 0, karma: 0, comments: 0 };
          }
          userScores[userId].posts++;
          userScores[userId].karma += post.score;
        }
      });

      // Get comments
      const commentsResult = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `COMM#${community}`,
          ":sk": "COMMENT#"
        }
      }));

      (commentsResult.Items || []).forEach(comment => {
        if (comment.status === "active" && now - new Date(comment.createdAt).getTime() < timeframes[timeframe]) {
          const userId = comment.userId;
          if (!userScores[userId]) {
            userScores[userId] = { userId, posts: 0, karma: 0, comments: 0 };
          }
          userScores[userId].comments++;
          userScores[userId].karma += comment.score;
        }
      });

      // Sort by karma
      const leaderboard = Object.values(userScores)
        .sort((a, b) => b.karma - a.karma)
        .slice(0, limit)
        .map((entry, index) => ({
          rank: index + 1,
          ...entry
        }));

      return {
        statusCode: 200,
        body: JSON.stringify({ leaderboard, timeframe, community })
      };
    }

    // GET GLOBAL LEADERBOARD - GET /leaderboard
    if (method === "GET" && path === "/leaderboard") {
      const metric = event.queryStringParameters?.metric || "karma"; // karma, posts, comments, streak
      const limit = parseInt(event.queryStringParameters?.limit || 10);

      const params = {
        TableName: TABLE,
        FilterExpression: "#type = :type AND #status = :status",
        ExpressionAttributeNames: {
          "#type": "type",
          "#status": "status"
        },
        ExpressionAttributeValues: {
          ":type": "user",
          ":status": "active"
        }
      };

      const result = await ddb.send(new ScanCommand(params));

      const sortMetrics = {
        karma: (a, b) => (b.karma || 0) - (a.karma || 0),
        posts: (a, b) => (b.postCount || 0) - (a.postCount || 0),
        comments: (a, b) => (b.commentCount || 0) - (a.commentCount || 0),
        streak: (a, b) => (b.currentStreak || 0) - (a.currentStreak || 0)
      };

      const leaderboard = (result.Items || [])
        .sort(sortMetrics[metric])
        .slice(0, limit)
        .map((user, index) => ({
          rank: index + 1,
          username: user.username,
          displayName: user.displayName,
          avatar: user.avatar,
          value: user[metric === "karma" ? "karma" : metric === "posts" ? "postCount" : metric === "comments" ? "commentCount" : "currentStreak"] || 0
        }));

      return {
        statusCode: 200,
        body: JSON.stringify({ leaderboard, metric })
      };
    }

    // CALCULATE USER LEVEL - GET /users/{username}/level
    if (method === "GET" && event.pathParameters && event.pathParameters.username && path.includes("/level")) {
      const username = event.pathParameters.username;

      const user = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" }
      }));

      if (!user.Item) {
        return { statusCode: 404, body: JSON.stringify({ message: "user not found" }) };
      }

      const profile = user.Item;
      const karma = profile.karma || 0;
      const posts = profile.postCount || 0;
      const comments = profile.commentCount || 0;
      const badges = profile.awardCount || 0;
      const streak = profile.currentStreak || 0;

      // Calculate XP
      const xp = karma * 10 + posts * 100 + comments * 50 + badges * 500 + streak * 20;

      // Calculate level (exponential curve)
      const level = Math.floor(Math.sqrt(xp / 100)) + 1;
      const xpForNextLevel = Math.pow(level, 2) * 100;
      const xpProgress = xp - (Math.pow(level - 1, 2) * 100);
      const xpNeeded = xpForNextLevel - (Math.pow(level - 1, 2) * 100);

      // Determine title based on level
      const titles = [
        { min: 1, max: 5, title: "Newcomer", color: "#808080" },
        { min: 6, max: 10, title: "Member", color: "#4169E1" },
        { min: 11, max: 20, title: "Regular", color: "#32CD32" },
        { min: 21, max: 35, title: "Veteran", color: "#FFD700" },
        { min: 36, max: 50, title: "Elite", color: "#FF4500" },
        { min: 51, max: 75, title: "Master", color: "#9370DB" },
        { min: 76, max: 100, title: "Legend", color: "#FF1493" },
        { min: 101, max: 999, title: "Mythic", color: "#00CED1" }
      ];

      const userTitle = titles.find(t => level >= t.min && level <= t.max) || titles[0];

      return {
        statusCode: 200,
        body: JSON.stringify({
          username,
          level,
          xp,
          xpProgress,
          xpNeeded,
          percentToNextLevel: Math.floor((xpProgress / xpNeeded) * 100),
          title: userTitle.title,
          titleColor: userTitle.color,
          stats: { karma, posts, comments, badges, streak }
        })
      };
    }

    // CHECK AND AWARD AUTOMATIC BADGES - POST /users/{username}/check-achievements
    if (method === "POST" && event.pathParameters && event.pathParameters.username && path.includes("/check-achievements")) {
      const username = event.pathParameters.username;

      const user = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${username}`, SK: "PROFILE" }
      }));

      if (!user.Item) {
        return { statusCode: 404, body: JSON.stringify({ message: "user not found" }) };
      }

      const profile = user.Item;
      const awarded = [];

      // Check karma badges
      const karmaBadges = [
        { threshold: 100, badge: "KARMA_100" },
        { threshold: 1000, badge: "KARMA_1000" },
        { threshold: 10000, badge: "KARMA_10000" }
      ];

      for (const { threshold, badge } of karmaBadges) {
        if (profile.karma >= threshold) {
          const existing = await ddb.send(new GetCommand({
            TableName: TABLE,
            Key: { PK: `USER#${username}`, SK: `BADGE#${BADGES[badge].id}` }
          }));

          if (!existing.Item) {
            const badgeData = BADGES[badge];
            await ddb.send(new PutCommand({
              TableName: TABLE,
              Item: {
                PK: `USER#${username}`,
                SK: `BADGE#${badgeData.id}`,
                GSI1PK: `BADGE#${badgeData.id}`,
                GSI1SK: `AWARDED#${new Date().toISOString()}`,
                type: "badge",
                badgeId: badgeData.id,
                username,
                badge: badgeData,
                autoAwarded: true,
                awardedAt: new Date().toISOString()
              }
            }));
            awarded.push(badgeData);
          }
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ 
          message: "achievements checked",
          awarded,
          count: awarded.length
        })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ message: "bad request" }) };
  } catch (err) {
    console.error("gamification error", err);
    return { statusCode: 500, body: JSON.stringify({ message: "internal error", error: err.message }) };
  }
};