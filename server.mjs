import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import apiHandler from "./api/index.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT || 4177);
const root = resolve(import.meta.dirname, "public");
const sessions = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error("Session not found. Create a session first.");
  }
  return session;
}

function cleanBaseUrl(baseUrl) {
  const url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Base URL must start with http:// or https://");
  }
  return url;
}

async function proxyJson(session, method, path, body) {
  const response = await fetch(`${session.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${session.apiKey}`,
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
  const port = Number(body.dbPort || 5432);
  const schema = body.dbSchema || "public";
  const sslMode = body.dbSslMode || "require";

  return JSON.stringify({
    host: body.dbHost,
    port,
    username: body.dbUsername,
    password: body.dbPassword,
    database: body.dbDatabase,
    schema,
    sslmode: sslMode,
    ssl_mode: sslMode,
    pg_host: body.dbHost,
    pg_port: port,
    pg_username: body.dbUsername,
    pg_password: body.dbPassword,
    pg_database: body.dbDatabase,
    pg_schema: schema,
    pg_sslmode: sslMode,
    postgres_host: body.dbHost,
    postgres_port: port,
    postgres_username: body.dbUsername,
    postgres_password: body.dbPassword,
    postgres_database: body.dbDatabase,
    postgres_schema: schema,
    postgres_sslmode: sslMode,
  });
}

async function routeApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/session") {
    const body = await readBody(req);
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      baseUrl: cleanBaseUrl(body.baseUrl || "https://app.infinisynapse.cn"),
      apiKey: String(body.apiKey || "").trim(),
      createdAt: Date.now(),
    });
    sendJson(res, 200, { sessionId });
    return;
  }

  if (url.pathname === "/api/events") {
    const session = getSession(url.searchParams.get("sessionId"));
    const connId = url.searchParams.get("connId");
    if (!connId) throw new Error("connId is required");

    const upstream = await fetch(
      `${session.baseUrl}/api/ai/events?connId=${encodeURIComponent(connId)}`,
      {
        headers: {
          authorization: `Bearer ${session.apiKey}`,
          accept: "text/event-stream",
          "x-lang": "zh_CN",
        },
      },
    );

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

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
    return;
  }

  const body = ["POST", "PUT", "PATCH"].includes(req.method || "") ? await readBody(req) : {};
  const session = getSession(body.sessionId || url.searchParams.get("sessionId"));

  if (req.method === "POST" && url.pathname === "/api/test-connection") {
    const result = await proxyJson(session, "POST", "/api/ai_database/testConnection", {
      type: "postgres",
      config: databaseConfig(body),
    });
    sendJson(res, result.status, result.payload);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/list-datasources") {
    const params = new URLSearchParams({
      page: "1",
      pageSize: "100",
      source: "all",
      name: body.name || "",
    });
    const result = await proxyJson(session, "GET", `/api/ai_database/list?${params}`, undefined);
    sendJson(res, result.status, result.payload);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/add-datasource") {
    const result = await proxyJson(session, "POST", "/api/ai_database/add", {
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

  if (req.method === "POST" && url.pathname === "/api/update-datasource") {
    const result = await proxyJson(session, "POST", "/api/ai_database/update", {
      id: body.id,
      name: body.name,
      type: "postgres",
      config: databaseConfig(body),
      enabled: 1,
      description: body.description || "Updated via InfiniSynapse PostgreSQL tool",
      nickname: body.nickname || body.name,
    });
    sendJson(res, result.status, result.payload);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/message") {
    const result = await proxyJson(session, "POST", "/api/ai/message", {
      type: "newTask",
      text: body.text,
      connId: body.connId,
    });
    sendJson(res, result.status, result.payload);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/task") {
    const params = new URLSearchParams({ taskId: url.searchParams.get("taskId") || "" });
    const result = await proxyJson(session, "GET", `/api/ai_task/tasks?${params}`, undefined);
    sendJson(res, result.status, result.payload);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/message-payload") {
    const params = new URLSearchParams({
      taskId: url.searchParams.get("taskId") || "",
      messageTs: url.searchParams.get("messageTs") || "",
    });
    const result = await proxyJson(session, "GET", `/api/ai_task/messagePayload?${params}`, undefined);
    sendJson(res, result.status, result.payload);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/workspace") {
    const taskId = encodeURIComponent(url.searchParams.get("taskId") || "");
    const result = await proxyJson(session, "GET", `/api/ai_task/getTaskWorkspace/${taskId}`, undefined);
    sendJson(res, result.status, result.payload);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/preview-file") {
    const result = await proxyJson(session, "POST", "/api/ai_task/previewFile", {
      taskId: body.taskId,
      fileName: body.fileName,
    });
    sendJson(res, result.status, result.payload);
    return;
  }

  sendJson(res, 404, { error: "API route not found" });
}

async function routeStatic(req, res, url) {
  const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = resolve(join(root, filePath));
  if (!resolved.startsWith(root)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await readFile(resolved);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(resolved)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "File not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await apiHandler(req, res);
      return;
    }
    await routeStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unknown server error",
    });
  }
});

server.listen(port, host, () => {
  console.log(`InfiniSynapse tool page is running at http://${host}:${port}`);
});
