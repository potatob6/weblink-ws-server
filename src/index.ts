import type { ServerWebSocket } from "bun";
import type { ClientID, ClientSignal, RawSignal, TransferClient } from "./types";
import pino from "pino";
import { LOG_LEVEL, PORT, HEARTBEAT_INTERVAL, PONG_TIMEOUT, DISCONNECT_TIMEOUT } from "./var";

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
  disconnectTimeout: Timer | null;
  messageCache: RawSignal[];
}

interface Room {
  clients: Map<ClientID, ClientData>;
  passwordHash: string | null;
}

const rooms: Map<string, Room> = new Map();

const server = Bun.serve<ServerWebSocketData>({
  port: PORT,
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
          case "leave":
            handleLeave(room, signal.data as TransferClient, ws);
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
      handleClose(ws);
    },
  },
});

function handleJoin(room: Room, client: TransferClient, ws: ServerWebSocket<ServerWebSocketData>) {
  if (!room) {
    logger.warn({ roomId: ws.data.roomId }, "Room not found");
    return;
  }

  const existingClient = room.clients.get(client.clientId);

  ws.data.clientId = client.clientId;

  if (existingClient) {
    if (existingClient.disconnectTimeout) {
      clearTimeout(existingClient.disconnectTimeout);
      existingClient.disconnectTimeout = null;
    }
    existingClient.session = ws;
    existingClient.lastPongTime = Date.now();
    logger.info({ clientId: client.clientId, name: client.name }, "Client reconnected");

    // send cached messages
    existingClient.messageCache.forEach((message) => {
      ws.send(JSON.stringify(message));
    });
    existingClient.messageCache = [];

    return;
  }

  // send join message to new client
  room.clients.forEach((clientData) => {
    ws.send(
      JSON.stringify({
        type: "join",
        data: clientData.client,
      })
    );
  });

  // send join message to other clients
  room.clients.forEach((clientData) => {
    if (clientData.session === ws) return;
    const joinMessage: RawSignal = {
      type: "join",
      data: client,
    };
    if (clientData.session.readyState === WebSocket.OPEN) {
      clientData.session.send(JSON.stringify(joinMessage));
      logger.info(
        { clientId: clientData.client.clientId, name: clientData.client.name },
        "send join message to client"
      );
    } else {
      clientData.messageCache.push(joinMessage);
    }
  });

  room.clients.set(client.clientId, {
    client,
    session: ws,
    lastPongTime: Date.now(),
    disconnectTimeout: null,
    messageCache: [],
  });
}

function handleLeave(room: Room, client: TransferClient, ws: ServerWebSocket<ServerWebSocketData>) {
  const clientData = room.clients.get(client.clientId);
  if (!clientData) {
    logger.warn({ clientId: client.clientId }, "Client not found");
    return;
  }

  // if exist disconnect timeout, cancel it
  if (clientData.disconnectTimeout) {
    clearTimeout(clientData.disconnectTimeout);
    clientData.disconnectTimeout = null;
  }

  // remove client from room
  room.clients.delete(client.clientId);
  logger.info({ clientId: client.clientId, name: client.name }, "Client left");

  room.clients.forEach((targetClientData, targetClientId) => {
    const leaveMessage = {
      type: "leave",
      data: client,
    };

    if (targetClientData.session.readyState === WebSocket.OPEN) {
      targetClientData.session.send(JSON.stringify(leaveMessage));
      logger.info(
        { targetClientId, targetName: targetClientData.client.name },
        "Send leave message"
      );
    } else {
      targetClientData.messageCache.push(leaveMessage);
    }
  });

  // if room is empty, delete room
  if (room.clients.size === 0) {
    rooms.delete(ws.data.roomId);
    logger.info({ roomId: ws.data.roomId }, "Room deleted");
  }

  ws.close();
}

function handleClose(ws: ServerWebSocket<ServerWebSocketData>) {
  const room: Room | undefined = rooms.get(ws.data.roomId);
  if (!room) {
    logger.warn({ roomId: ws.data.roomId }, "Room not found");
    return;
  }

  const clientData = room.clients.get(ws.data.clientId || "");
  if (!clientData) {
    logger.warn({ clientId: ws.data.clientId }, "Client not found");
    return;
  }

  clientData.disconnectTimeout = setTimeout(() => {
    handleLeave(room, clientData.client, clientData.session);
  }, DISCONNECT_TIMEOUT);
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
