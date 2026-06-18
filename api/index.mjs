export const config = {
  maxDuration: 60,
};

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

function cleanBaseUrl(baseUrl) {
  const url = String(baseUrl || "https://app.infinisynapse.cn").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Base URL must start with http:// or https://");
  }
  return url;
}

function authFromBody(body) {
  const apiKey = String(body.apiKey || "").trim();
  if (!apiKey) {
    throw new Error("API Key is required");
  }
  return {
    baseUrl: cleanBaseUrl(body.baseUrl),
    apiKey,
  };
}

async function readRequestBody(req) {
  if (typeof req.body === "string") {
    return req.body ? JSON.parse(req.body) : {};
  }
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function proxyJson(auth, method, path, body) {
  const response = await fetch(`${auth.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${auth.apiKey}`,
      "content-type": "application/json",
      "x-lang": "zh_CN",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  return { status: response.status, payload };
}

function databaseConfig(body) {
  return JSON.stringify({
    postgres_host: body.dbHost,
    postgres_port: Number(body.dbPort || 5432),
    postgres_username: body.dbUsername,
    postgres_password: body.dbPassword,
    postgres_database: body.dbDatabase,
  });
}

async function streamEvents(req, res, auth, body) {
  const connId = body.connId;
  if (!connId) {
    throw new Error("connId is required");
  }

  const upstream = await fetch(
    `${auth.baseUrl}/api/ai/events?connId=${encodeURIComponent(connId)}`,
    {
      headers: {
        authorization: `Bearer ${auth.apiKey}`,
        accept: "text/event-stream",
        "x-lang": "zh_CN",
      },
    },
  );

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");

  if (!upstream.ok || !upstream.body) {
    res.write(`event: proxy_error\ndata: ${JSON.stringify({ status: upstream.status })}\n\n`);
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  req.on("close", () => reader.cancel().catch(() => {}));

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

async function handle(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Only POST is supported" });
    return;
  }

  const body = await readRequestBody(req);
  const auth = authFromBody(body);
  const route = body._route || req.url.split("?")[0].replace(/^\/api/, "") || "/";

  if (route === "/events") {
    await streamEvents(req, res, auth, body);
    return;
  }

  if (route === "/test-connection") {
    const result = await proxyJson(auth, "POST", "/api/ai_database/testConnection", {
      type: "postgres",
      config: databaseConfig(body),
    });
    sendJson(res, result.status, result.payload);
    return;
  }

  if (route === "/list-datasources") {
    const params = new URLSearchParams({
      page: "1",
      pageSize: "100",
      source: "all",
      name: body.name || "",
    });
    const result = await proxyJson(auth, "GET", `/api/ai_database/list?${params}`, undefined);
    sendJson(res, result.status, result.payload);
    return;
  }

  if (route === "/add-datasource") {
    const result = await proxyJson(auth, "POST", "/api/ai_database/add", {
      name: body.name,
      type: "postgres",
      config: databaseConfig(body),
      enabled: 1,
      description: body.description || "Created via InfiniSynapse PostgreSQL tool",
      nickname: body.nickname || body.name,
    });
    sendJson(res, result.status, result.payload);
    return;
  }

  if (route === "/message") {
    const result = await proxyJson(auth, "POST", "/api/ai/message", {
      type: "newTask",
      text: body.text,
      connId: body.connId,
    });
    sendJson(res, result.status, result.payload);
    return;
  }

  if (route === "/task") {
    const params = new URLSearchParams({ taskId: body.taskId || "" });
    const result = await proxyJson(auth, "GET", `/api/ai_task/tasks?${params}`, undefined);
    sendJson(res, result.status, result.payload);
    return;
  }

  if (route === "/message-payload") {
    const params = new URLSearchParams({
      taskId: body.taskId || "",
      messageTs: body.messageTs || "",
    });
    const result = await proxyJson(auth, "GET", `/api/ai_task/messagePayload?${params}`, undefined);
    sendJson(res, result.status, result.payload);
    return;
  }

  if (route === "/workspace") {
    const taskId = encodeURIComponent(body.taskId || "");
    const result = await proxyJson(auth, "GET", `/api/ai_task/getTaskWorkspace/${taskId}`, undefined);
    sendJson(res, result.status, result.payload);
    return;
  }

  if (route === "/preview-file") {
    const result = await proxyJson(auth, "POST", "/api/ai_task/previewFile", {
      taskId: body.taskId,
      fileName: body.fileName,
    });
    sendJson(res, result.status, result.payload);
    return;
  }

  sendJson(res, 404, { error: "API route not found" });
}

export default async function handler(req, res) {
  try {
    await handle(req, res);
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unknown server error",
    });
  }
}
