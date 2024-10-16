import type { ServerWebSocket } from "bun";
import type { ClientID, ClientSignal, RawSignal, TransferClient } from "./types";
import pino from "pino";

const LOG_LEVEL = process.env["LOG_LEVEL"] || "info";

const logger = pino({
  level: LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { pid: process.pid },
});

type ServerWebSocketData = {
  roomId: string;
  passwordHash: string;
  clientId: ClientID | null;
};

interface ClientData {
  client: TransferClient;
  session: ServerWebSocket<ServerWebSocketData>;
  lastPongTime: number;
}

interface Room {
  clients: Map<ClientID, ClientData>;
  passwordHash: string | null;
}

const rooms: Map<string, Room> = new Map();

const server = Bun.serve<ServerWebSocketData>({
  port: 3000,
  fetch(req, server) {
    const url = new URL(req.url);
    const roomId = url.searchParams.get("room") || "";
    const passwordHash = url.searchParams.get("pwd") || "";

    if (
      server.upgrade(req, {
        data: { roomId, passwordHash, clientId: null },
      })
    ) {
      return;
    }

    return new Response(undefined, { status: 404 });
  },
  websocket: {
    open(ws) {
      const { roomId, passwordHash } = ws.data;
      logger.info({ remoteAddress: ws.remoteAddress, roomId }, "New connection");

      let room: Room | undefined = rooms.get(roomId);
      if (!room) {
        room = {
          clients: new Map(),
          passwordHash: passwordHash || null,
        };
        rooms.set(roomId, room);
        logger.info({ roomId }, "Room created");
      }

      ws.send(
        JSON.stringify({
          type: "connected",
          data: room.passwordHash,
        })
      );
    },
    message(ws, message) {
      try {
        const signal: RawSignal = JSON.parse(message.toString());
        const room: Room | undefined = rooms.get(ws.data.roomId);

        if (!room) {
          logger.warn({ roomId: ws.data.roomId }, "Room not found");
          return;
        }

        if (signal.type === "pong") {
          const clientData = room.clients.get(ws.data.clientId || "");
          if (clientData) {
            clientData.lastPongTime = Date.now();
          }
          return;
        }

        switch (signal.type) {
          case "join":
            handleJoin(room, signal.data as TransferClient, ws);
            break;
          case "message":
            handleMessage(room, signal.data as ClientSignal, ws);
            break;
          default:
            logger.warn({ signal }, "Unknown signal type");
            break;
        }
      } catch (error) {
        logger.error({ error }, "Error processing message");
      }
    },
    close(ws) {
      const room: Room | undefined = rooms.get(ws.data.roomId);
      if (!room) {
        logger.warn({ roomId: ws.data.roomId }, "Client not found");
        return;
      }

      const clientData = room.clients.get(ws.data.clientId || "");
      if (!clientData) {
        logger.warn({ clientId: ws.data.clientId }, "Client not found");
        return;
      }

      room.clients.delete(clientData.client.clientId);
      logger.info(
        { name: clientData.client.name, clientId: clientData.client.clientId },
        "Client disconnected"
      );

      room.clients.forEach((targetClientData, clientId) => {
        if (
          targetClientData.session !== ws &&
          targetClientData.session.readyState === WebSocket.OPEN
        ) {
          targetClientData.session.send(
            JSON.stringify({
              type: "leave",
              data: clientData.client,
            })
          );
          logger.info({ clientId, name: targetClientData.client.name }, `send leave message`);
        }
      });

      if (room.clients.size === 0) {
        rooms.delete(ws.data.roomId);
        logger.info({ roomId: ws.data.roomId }, "Room deleted");
      }
    },
  },
});

function handleJoin(room: Room, client: TransferClient, ws: ServerWebSocket<ServerWebSocketData>) {
  if (!room) return;
  if (room.clients.has(client.clientId)) return;
  ws.data.clientId = client.clientId;
  room.clients.forEach((clientData) => {
    ws.send(
      JSON.stringify({
        type: "join",
        data: clientData.client,
      })
    );
  });

  room.clients.forEach((clientData) => {
    if (clientData.session !== ws && clientData.session.readyState === WebSocket.OPEN) {
      clientData.session.send(
        JSON.stringify({
          type: "join",
          data: client,
        })
      );
      logger.info(
        { clientId: clientData.client.clientId, name: clientData.client.name },
        "send join message to client"
      );
    }
  });

  room.clients.set(client.clientId, {
    client,
    session: ws,
    lastPongTime: Date.now(),
  });
}

function handleMessage(room: Room, data: ClientSignal, ws: ServerWebSocket<ServerWebSocketData>) {
  const targetClientData = room?.clients.get(data.targetClientId);
  const clientData = room?.clients.get(ws.data.clientId || "");
  if (!clientData) {
    logger.warn({ clientId: ws.data.clientId }, "Can't find client, skip message");
    return;
  }
  if (
    targetClientData &&
    targetClientData.session !== ws &&
    targetClientData.session.readyState === WebSocket.OPEN
  ) {
    targetClientData.session.send(
      JSON.stringify({
        type: "message",
        data: data,
      })
    );
    logger.debug(
      {
        clientId: ws.data.clientId,
        clientName: clientData.client.name,
        targetClientId: data.targetClientId,
        targetClientName: targetClientData.client.name,
      },
      "send message to client"
    );
  }
}

function startHeartbeat() {
  const HEARTBEAT_INTERVAL = parseInt(process.env["HEARTBEAT_INTERVAL"] || "10000");
  const PONG_TIMEOUT = parseInt(process.env["PONG_TIMEOUT"] || "30000");

  setInterval(() => {
    const now = Date.now();
    rooms.forEach((room, roomId) => {
      room.clients.forEach((clientData, clientId) => {
        if (clientData.session.readyState === WebSocket.OPEN) {
          if (now - clientData.lastPongTime > PONG_TIMEOUT) {
            logger.warn({ clientId, roomId }, "Client timed out, closing connection");
            clientData.session.close();
          } else {
            clientData.session.send(JSON.stringify({ type: "ping" }));
          }
        }
      });
    });
  }, HEARTBEAT_INTERVAL);
}

logger.info({ port: server.port }, "WebSocket server started");
startHeartbeat();

process.on("SIGINT", () => {
  logger.info("Shutting down server...");
  server.stop();
  logger.info("Server closed");
  process.exit(0);
});
