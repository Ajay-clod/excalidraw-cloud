// y-websocket server with Redis pub/sub bridging.
//
// Behavior:
// - Each connected client uses y-websocket protocol to sync with the local Y.Doc.
// - For each room (Y.Doc) we subscribe to updates and publish them to Redis channel `yjs:<room>`
//   so other server instances can apply them.
// - We also psubscribe to `yjs:*` and apply incoming Redis updates to the corresponding local Y.Doc.
// - To avoid loops we apply Redis-originated updates with origin "redis" and skip republishing updates with origin === "redis".
//
// Env:
//  - PORT (default 1234)
//  - REDIS_URL (e.g. redis://redis:6379) — required to enable cross-instance bridging
//
// Run:
//  REDIS_URL=redis://redis:6379 node index.js

const http = require("http");

const express = require("express");
const WebSocket = require("ws");
const { setupWSConnection, getYDoc } = require("y-websocket/bin/utils");
const Y = require("yjs");
const IORedis = require("ioredis");

const PORT = process.env.PORT || 1234;
const REDIS_URL = process.env.REDIS_URL || null;

const app = express();
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Redis pub/sub (optional but required for multi-instance)
let pub = null;
let sub = null;
let redisEnabled = false;
if (REDIS_URL) {
  pub = new IORedis(REDIS_URL);
  sub = new IORedis(REDIS_URL);
  redisEnabled = true;

  // Use pattern subscribe to catch all rooms: channel format `yjs:<room>`
  sub.psubscribe("yjs:*").then(() => {
    // eslint-disable-next-line no-console
    console.log("Subscribed to Redis pattern yjs:*");
  });

  sub.on("pmessage", async (_pattern, channel, message) => {
    try {
      if (!channel.startsWith("yjs:")) {
        return;
      }
      const room = channel.slice(4);
      if (!room) {
        return;
      }

      // message is base64 encoded update bytes
      const update = Buffer.from(message, "base64");
      // get or create local doc (this mirrors how y-websocket creates docs)
      const doc = getYDoc(room);

      // Apply update with origin 'redis' so we don't republish it
      Y.applyUpdate(doc, update, "redis");
      // no need to persist (no persistence requested)
      // console.log(`Applied redis update to room ${room}`);
    } catch (e) {
      console.error("Failed to apply redis update", e);
    }
  });

  pub.on("error", (e) => console.error("redis pub error", e));
  sub.on("error", (e) => console.error("redis sub error", e));
} else {
  console.warn(
    "REDIS_URL not set — running single-instance without cross-instance bridging",
  );
}

// Keep track of which docs we have attached publish handlers to (avoid duplicate handlers)
const docsWithPublishHandler = new Set();

wss.on("connection", (conn, req) => {
  // Do any handshake/auth validation here BEFORE setupWSConnection if needed.
  // Example:
  // const url = new URL(req.url, `http://${req.headers.host}`);
  // const params = url.searchParams;
  // const roomKey = params.get("roomKey"); // validate token/roomKey here
  //
  // If unauthorized:
  //   conn.close(4001, "unauthorized");
  //   return;

  // Let y-websocket set up the connection and Y.Doc for this room
  setupWSConnection(conn, req, { gc: true });

  // Determine room name from request URL like the protocol expects
  const getRoomFromReqUrl = (reqUrl) => {
    if (!reqUrl) {
      return null;
    }
    // strip query string and leading slash
    const path = reqUrl.split("?")[0];
    return path.startsWith("/") ? path.slice(1) : path;
  };

  const room = getRoomFromReqUrl(req.url);
  if (!room) {
    return;
  } // nothing we can do

  // Attach publish handler once per room (idempotent)
  if (redisEnabled && !docsWithPublishHandler.has(room)) {
    try {
      const doc = getYDoc(room);

      // doc.on('update', (update, origin) => {}) captures the raw Yjs update bytes
      const updateHandler = (update, origin) => {
        // Skip updates that came from Redis to avoid republishing loops
        if (origin === "redis") {
          return;
        }

        try {
          if (pub) {
            const b64 = Buffer.from(update).toString("base64");
            pub.publish(`yjs:${room}`, b64).catch((e) => {
              console.error("Failed to publish update to redis", e);
            });
          }
        } catch (e) {
          console.error("publish update failed", e);
        }
      };

      doc.on("update", updateHandler);
      docsWithPublishHandler.add(room);
      // Note: we don't remove the handler; it's okay for the lifetime of the process
    } catch (e) {
      console.error("Failed to attach publish handler to doc", room, e);
    }
  }
});

// Start server
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`y-websocket server listening on http://0.0.0.0:${PORT}`);
  if (redisEnabled) {
    // eslint-disable-next-line no-console
    console.log("Redis bridging enabled:", REDIS_URL);
  }
});
