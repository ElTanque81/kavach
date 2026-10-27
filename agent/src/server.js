import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleChat } from "./chat.js";

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

export function startServer(engine, port) {
  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  engine.on("state", () => broadcast("state", engine.publicState()));

  const chatLog = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const body = async () => {
      let b = "";
      for await (const c of req) b += c;
      try {
        return JSON.parse(b || "{}");
      } catch {
        return {};
      }
    };

    try {
      if (url.pathname === "/api/state") return json(200, { ...engine.publicState(), chat: chatLog.slice(-30) });

      if (url.pathname === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: state\ndata: ${JSON.stringify(engine.publicState())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      if (url.pathname === "/api/chat" && req.method === "POST") {
        const { text } = await body();
        if (!text || typeof text !== "string") return json(400, { error: "text required" });
        chatLog.push({ who: "you", text, t: Date.now() });
        const r = await handleChat(text.slice(0, 500), {
          settings: engine.settings,
          policy: engine.policy,
          state: engine.state,
          snap: engine.snap,
          engine,
        });
        chatLog.push({ who: "kavach", text: r.reply, t: Date.now() });
        if (r.changed?.length) engine.log("You", `chat → ${r.changed.join(", ")}`, null, "info");
        broadcast("state", engine.publicState());
        return json(200, r);
      }

      if (url.pathname === "/api/control" && req.method === "POST") {
        const { action, sym } = await body();
        if (action === "start") engine.start();
        else if (action === "stop") engine.stop();
        else if (action === "cycle") await engine.cycle();
        else if (action === "plug") engine.pullThePlug();
        else if (action === "revive") engine.revive();
        else if (action === "crash") engine.crash(sym || "WHSK");
        else if (action === "crashtest") await engine.crashTest(sym || "WHSK");
        else if (action === "open") await engine.forceOpen(sym || "WHSK");
        else return json(400, { error: "unknown action" });
        broadcast("state", engine.publicState());
        return json(200, { ok: true });
      }

      // static dashboard
      let file = url.pathname === "/" ? "/index.html" : url.pathname;
      file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
      const full = path.join(pub, file);
      if (!full.startsWith(pub) || !fs.existsSync(full)) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(full)] || "application/octet-stream" });
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      json(500, { error: e.message });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`\n  KAVACH dashboard → http://localhost:${port}\n`);
  });
  return server;
}
