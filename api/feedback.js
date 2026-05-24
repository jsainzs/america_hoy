const MAX_ITEMS = 80;
const TARGET_PATTERN = /^[a-z0-9:-]{1,80}$/i;

function json(res, statusCode, payload){
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function getRedisConfig(){
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redis(command){
  const config = getRedisConfig();
  if(!config){
    const error = new Error("Feedback storage is not configured.");
    error.statusCode = 501;
    throw error;
  }

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const payload = await response.json().catch(() => ({}));
  if(!response.ok || payload.error){
    const error = new Error(payload.error || "Redis request failed.");
    error.statusCode = 502;
    throw error;
  }

  return payload.result;
}

function parseBody(req){
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if(body.length > 12000){
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch(err) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function cleanText(value, maxLength){
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function feedbackKey(target){
  return `america_hoy:feedback:${target}`;
}

function isValidType(type){
  return type === "like" || type === "comment" || type === "error";
}

function cleanEmail(value){
  const email = cleanText(value, 120).toLowerCase();
  if(!email){
    return "";
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

module.exports = async function handler(req, res){
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");

  if(req.method === "OPTIONS"){
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    if(req.method === "GET"){
      const url = new URL(req.url, "https://america-hoy.vercel.app");
      const target = cleanText(url.searchParams.get("target"), 80);
      if(!TARGET_PATTERN.test(target)){
        json(res, 400, { error: "Invalid feedback target." });
        return;
      }

      const rows = await redis(["LRANGE", feedbackKey(target), "0", String(MAX_ITEMS - 1)]);
      const items = (rows || []).map(row => JSON.parse(row));
      json(res, 200, { items });
      return;
    }

    if(req.method === "POST"){
      const body = await parseBody(req);
      const target = cleanText(body.target, 80);
      const type = cleanText(body.type, 20);
      const name = cleanText(body.name, 42) || "Americanista";
      const message = cleanText(body.message, type === "error" ? 500 : 360);
      const email = cleanEmail(body.email);

      if(!TARGET_PATTERN.test(target) || !isValidType(type)){
        json(res, 400, { error: "Invalid feedback payload." });
        return;
      }
      if(type !== "like" && message.length < 4){
        json(res, 400, { error: "Write a little more detail." });
        return;
      }

      const item = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
        target,
        type,
        name,
        message,
        email,
        createdAt: new Date().toISOString()
      };

      await redis(["LPUSH", feedbackKey(target), JSON.stringify(item)]);
      await redis(["LTRIM", feedbackKey(target), "0", String(MAX_ITEMS - 1)]);
      json(res, 201, { item });
      return;
    }

    json(res, 405, { error: "Method not allowed." });
  } catch(err) {
    json(res, err.statusCode || 500, { error: err.message || "Feedback request failed." });
  }
};
