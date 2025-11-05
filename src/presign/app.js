const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { v4: uuidv4 } = require("uuid");

const s3 = new S3Client({});

const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { filename, contentType, size } = body;

    if (!filename || !contentType || !size) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "filename, contentType and size are required" })
      };
    }

    if (size > MAX_SIZE_BYTES) {
      return { statusCode: 413, body: JSON.stringify({ message: "file too large" }) };
    }

    const ext = filename.split(".").pop();
    const key = `uploads/${uuidv4()}.${ext}`;

    const putCmd = new PutObjectCommand({
      Bucket: process.env.MEDIA_BUCKET,
      Key: key,
      ContentType: contentType
    });

    const url = await getSignedUrl(s3, putCmd, { expiresIn: 300 });

    return {
      statusCode: 200,
      body: JSON.stringify({ uploadUrl: url, s3Key: key })
    };
  } catch (err) {
    console.error("presign error", err);
    return { statusCode: 500, body: JSON.stringify({ message: "internal" }) };
  }
};