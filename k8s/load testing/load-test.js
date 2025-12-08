import WebSocket from "ws";

const NUM_CLIENTS = 30;
const WS_URL = "ws://yjs.your-domain.com"; // or local

function createClient(i) {
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    // eslint-disable-next-line no-console
    console.log(`Client ${i} connected`);

    setInterval(() => {
      ws.send(
        JSON.stringify({
          type: "sync",
          payload: { x: Math.random(), y: Math.random() },
        }),
      );
    }, 50);
  });

  ws.on("error", console.error);
}

for (let i = 0; i < NUM_CLIENTS; i++) {
  createClient(i);
}
