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

    // ========== POLLS FEATURE ==========
    // CREATE POLL - POST /communities/{name}/polls
    if (method === "POST" && event.pathParameters && event.pathParameters.name && path.includes("/polls")) {
      const community = event.pathParameters.name;
      const body = JSON.parse(event.body || "{}");
      const { userId, question, options, duration, allowMultiple } = body;

      if (!userId || !question || !options || options.length < 2) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ message: "userId, question, and at least 2 options required" }) 
        };
      }

      const pollId = uuidv4();
      const now = new Date().toISOString();
      const expiresAt = duration 
        ? new Date(Date.now() + duration * 3600000).toISOString() 
        : new Date(Date.now() + 7 * 24 * 3600000).toISOString(); // Default 7 days

      const poll = {
        PK: `COMM#${community}`,
        SK: `POLL#${pollId}`,
        GSI1PK: `POLL#${pollId}`,
        GSI1SK: `CREATED#${now}`,
        type: "poll",
        pollId,
        community,
        userId,
        question,
        options: options.map((opt, i) => ({
          id: `opt_${i}`,
          text: opt,
          votes: 0,
          voters: []
        })),
        allowMultiple: allowMultiple || false,
        totalVotes: 0,
        status: "active",
        expiresAt,
        createdAt: now,
        updatedAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: poll }));

      return {
        statusCode: 201,
        body: JSON.stringify({ pollId, expiresAt, createdAt: now })
      };
    }

    // VOTE ON POLL - POST /polls/{pollId}/vote (CHECK THIS FIRST - more specific)
    if (method === "POST" && event.pathParameters && event.pathParameters.pollId && path.includes("/vote")) {
      const pollId = event.pathParameters.pollId;
      const body = JSON.parse(event.body || "{}");
      const { userId, optionIds } = body;

      if (!userId || !optionIds || optionIds.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId and optionIds required" }) };
      }

      // Get poll
      const pollResult = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `POLL#${pollId}` },
        Limit: 1
      }));

      if (!pollResult.Items || pollResult.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "poll not found" }) };
      }

      const poll = pollResult.Items[0];

      // Check if expired
      if (new Date(poll.expiresAt) < new Date()) {
        return { statusCode: 400, body: JSON.stringify({ message: "poll has expired" }) };
      }

      // Check if multiple votes allowed
      if (!poll.allowMultiple && optionIds.length > 1) {
        return { statusCode: 400, body: JSON.stringify({ message: "multiple votes not allowed" }) };
      }

      // Remove previous votes if exists
      const updatedOptions = poll.options.map(opt => ({
        ...opt,
        voters: opt.voters.filter(v => v !== userId),
        votes: opt.voters.filter(v => v !== userId).length
      }));

      // Add new votes
      optionIds.forEach(optId => {
        const option = updatedOptions.find(o => o.id === optId);
        if (option) {
          option.voters.push(userId);
          option.votes++;
        }
      });

      const totalVotes = updatedOptions.reduce((sum, opt) => sum + opt.votes, 0);

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: poll.PK, SK: poll.SK },
        UpdateExpression: "SET options = :opts, totalVotes = :total, updatedAt = :now",
        ExpressionAttributeValues: {
          ":opts": updatedOptions,
          ":total": totalVotes,
          ":now": new Date().toISOString()
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "vote recorded", totalVotes })
      };
    }

    // GET POLL RESULTS - GET /polls/{pollId}
    if (method === "GET" && event.pathParameters && event.pathParameters.pollId && path.includes("/polls/") && !path.includes("/vote")) {
      const pollId = event.pathParameters.pollId;

      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `POLL#${pollId}` },
        Limit: 1
      }));

      if (!result.Items || result.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "poll not found" }) };
      }

      const poll = result.Items[0];
      const isExpired = new Date(poll.expiresAt) < new Date();

      // Calculate percentages
      const resultsWithPercentages = poll.options.map(opt => ({
        ...opt,
        percentage: poll.totalVotes > 0 ? ((opt.votes / poll.totalVotes) * 100).toFixed(1) : 0,
        voters: undefined // Hide voters list in results
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({
          ...poll,
          options: resultsWithPercentages,
          isExpired,
          timeRemaining: isExpired ? 0 : Math.max(0, new Date(poll.expiresAt).getTime() - Date.now())
        })
      };
    }

    // ========== TIME CAPSULE FEATURE ==========
    // CREATE TIME CAPSULE - POST /communities/{name}/capsules
    if (method === "POST" && event.pathParameters && event.pathParameters.name && path.includes("/capsules")) {
      const community = event.pathParameters.name;
      const body = JSON.parse(event.body || "{}");
      const { userId, title, message, media, openDate } = body;

      if (!userId || !title || !message || !openDate) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId, title, message, and openDate required" }) };
      }

      const capsuleId = uuidv4();
      const now = new Date().toISOString();

      // Validate openDate is in the future
      if (new Date(openDate) <= new Date()) {
        return { statusCode: 400, body: JSON.stringify({ message: "openDate must be in the future" }) };
      }

      const capsule = {
        PK: `COMM#${community}`,
        SK: `CAPSULE#${capsuleId}`,
        GSI1PK: `CAPSULE#${capsuleId}`,
        GSI1SK: `OPENS#${openDate}`,
        type: "capsule",
        capsuleId,
        community,
        userId,
        title,
        message,
        media: media || [],
        openDate,
        status: "sealed", // sealed, opened
        views: 0,
        reactions: {},
        createdAt: now,
        openedAt: null
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: capsule }));

      return {
        statusCode: 201,
        body: JSON.stringify({ 
          capsuleId, 
          openDate,
          message: "Time capsule sealed! It will open on " + openDate
        })
      };
    }

    // OPEN TIME CAPSULE - GET /capsules/{capsuleId}
    if (method === "GET" && event.pathParameters && event.pathParameters.capsuleId && path.includes("/capsules/") && !path.includes("/upcoming")) {
      const capsuleId = event.pathParameters.capsuleId;

      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `CAPSULE#${capsuleId}` },
        Limit: 1
      }));

      if (!result.Items || result.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "capsule not found" }) };
      }

      const capsule = result.Items[0];
      const now = new Date();
      const openDate = new Date(capsule.openDate);

      if (now < openDate && capsule.status === "sealed") {
        // Not yet time to open
        const timeUntilOpen = openDate.getTime() - now.getTime();
        const daysRemaining = Math.ceil(timeUntilOpen / (1000 * 60 * 60 * 24));

        return {
          statusCode: 403,
          body: JSON.stringify({ 
            message: "Time capsule is still sealed",
            openDate: capsule.openDate,
            daysRemaining,
            title: capsule.title // Show only title when sealed
          })
        };
      }

      // It's time! Open the capsule
      if (capsule.status === "sealed") {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: capsule.PK, SK: capsule.SK },
          UpdateExpression: "SET #status = :status, openedAt = :now, views = :views",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "opened",
            ":now": now.toISOString(),
            ":views": 1
          }
        }));
        capsule.openedAt = now.toISOString();
        capsule.status = "opened";
      } else {
        // Already opened, just increment views
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: capsule.PK, SK: capsule.SK },
          UpdateExpression: "ADD views :inc",
          ExpressionAttributeValues: { ":inc": 1 }
        }));
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          ...capsule,
          message: capsule.status === "opened" ? "Time capsule opened!" : "Welcome to the past!"
        })
      };
    }

    // GET UPCOMING CAPSULES - GET /communities/{name}/capsules/upcoming
    if (method === "GET" && path.includes("/capsules/upcoming")) {
      const community = event.pathParameters?.name;
      const limit = parseInt(event.queryStringParameters?.limit || 10);

      const params = {
        TableName: TABLE,
        FilterExpression: "#type = :type AND #status = :status" + (community ? " AND community = :comm" : ""),
        ExpressionAttributeNames: {
          "#type": "type",
          "#status": "status"
        },
        ExpressionAttributeValues: {
          ":type": "capsule",
          ":status": "sealed",
          ...(community ? { ":comm": community } : {})
        },
        Limit: limit
      };

      const result = await ddb.send(new ScanCommand(params));

      const upcoming = (result.Items || [])
        .sort((a, b) => new Date(a.openDate).getTime() - new Date(b.openDate).getTime())
        .map(cap => ({
          capsuleId: cap.capsuleId,
          title: cap.title,
          community: cap.community,
          openDate: cap.openDate,
          daysUntilOpen: Math.ceil((new Date(cap.openDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        }));

      return {
        statusCode: 200,
        body: JSON.stringify({ capsules: upcoming })
      };
    }

    // ========== COMMUNITY EVENTS FEATURE ==========
    // CREATE EVENT - POST /communities/{name}/events
    if (method === "POST" && event.pathParameters && event.pathParameters.name && path.includes("/events") && !path.includes("/upcoming")) {
      const community = event.pathParameters.name;
      const body = JSON.parse(event.body || "{}");
      const { userId, title, description, eventDate, duration, location, isOnline, maxAttendees } = body;

      if (!userId || !title || !eventDate) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId, title, and eventDate required" }) };
      }

      const eventId = uuidv4();
      const now = new Date().toISOString();

      const eventItem = {
        PK: `COMM#${community}`,
        SK: `EVENT#${eventId}`,
        GSI1PK: `EVENT#${eventId}`,
        GSI1SK: `DATE#${eventDate}`,
        type: "event",
        eventId,
        community,
        createdBy: userId,
        title,
        description: description || "",
        eventDate,
        duration: duration || 60, // minutes
        location: location || "",
        isOnline: isOnline || false,
        maxAttendees: maxAttendees || null,
        attendees: [],
        attendeeCount: 0,
        status: "upcoming", // upcoming, ongoing, completed, cancelled
        createdAt: now,
        updatedAt: now
      };

      await ddb.send(new PutCommand({ TableName: TABLE, Item: eventItem }));

      return {
        statusCode: 201,
        body: JSON.stringify({ eventId, eventDate })
      };
    }

    // RSVP TO EVENT - POST /events/{eventId}/rsvp
    if (method === "POST" && event.pathParameters && event.pathParameters.eventId && path.includes("/rsvp")) {
      const eventId = event.pathParameters.eventId;
      const body = JSON.parse(event.body || "{}");
      const { userId, status } = body; // status: going, maybe, not_going

      if (!userId || !status) {
        return { statusCode: 400, body: JSON.stringify({ message: "userId and status required" }) };
      }

      // Get event
      const eventResult = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `EVENT#${eventId}` },
        Limit: 1
      }));

      if (!eventResult.Items || eventResult.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "event not found" }) };
      }

      const eventItem = eventResult.Items[0];

      // Check if event is full
      if (eventItem.maxAttendees && eventItem.attendeeCount >= eventItem.maxAttendees && status === "going") {
        return { statusCode: 400, body: JSON.stringify({ message: "event is full" }) };
      }

      // Update attendees
      const attendees = eventItem.attendees.filter(a => a.userId !== userId);
      if (status === "going") {
        attendees.push({ userId, status, joinedAt: new Date().toISOString() });
      }

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: eventItem.PK, SK: eventItem.SK },
        UpdateExpression: "SET attendees = :att, attendeeCount = :count, updatedAt = :now",
        ExpressionAttributeValues: {
          ":att": attendees,
          ":count": attendees.filter(a => a.status === "going").length,
          ":now": new Date().toISOString()
        }
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "RSVP updated", attendeeCount: attendees.length })
      };
    }

    // GET UPCOMING EVENTS - GET /communities/{name}/events/upcoming
    if (method === "GET" && path.includes("/events/upcoming")) {
      const community = event.pathParameters?.name;
      const limit = parseInt(event.queryStringParameters?.limit || 10);

      const params = {
        TableName: TABLE,
        FilterExpression: "#type = :type AND #status = :status" + (community ? " AND community = :comm" : ""),
        ExpressionAttributeNames: {
          "#type": "type",
          "#status": "status"
        },
        ExpressionAttributeValues: {
          ":type": "event",
          ":status": "upcoming",
          ...(community ? { ":comm": community } : {})
        },
        Limit: limit
      };

      const result = await ddb.send(new ScanCommand(params));

      const upcoming = (result.Items || [])
        .filter(e => new Date(e.eventDate) > new Date())
        .sort((a, b) => new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime());

      return {
        statusCode: 200,
        body: JSON.stringify({ events: upcoming })
      };
    }

    // GET EVENT DETAILS - GET /events/{eventId}
    if (method === "GET" && event.pathParameters && event.pathParameters.eventId && path.includes("/events/") && !path.includes("/rsvp") && !path.includes("/upcoming")) {
      const eventId = event.pathParameters.eventId;

      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `EVENT#${eventId}` },
        Limit: 1
      }));

      if (!result.Items || result.Items.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ message: "event not found" }) };
      }

      const eventItem = result.Items[0];
      const now = new Date();
      const eventDate = new Date(eventItem.eventDate);

      // Auto-update status
      if (eventDate < now && eventItem.status === "upcoming") {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: eventItem.PK, SK: eventItem.SK },
          UpdateExpression: "SET #status = :status",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":status": "completed" }
        }));
        eventItem.status = "completed";
      }

      return {
        statusCode: 200,
        body: JSON.stringify(eventItem)
      };
    }

    return { statusCode: 400, body: JSON.stringify({ message: "bad request" }) };
  } catch (err) {
    console.error("Unique features error", err);
    return { statusCode: 500, body: JSON.stringify({ message: "internal error", error: err.message }) };
  }
};