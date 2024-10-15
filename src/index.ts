import type { ServerWebSocket } from "bun";
import type {
  ClientID,
  ClientSignal,
  RawSignal,
  TransferClient,
} from "./types";

type ServerWebSocketData = { roomId: string; passwordHash: string; clientId: ClientID | null }

interface Room {
  clients: Map<ClientID, TransferClient>;
  sessions: Map<ClientID, ServerWebSocket<ServerWebSocketData>>;
  passwordHash: string | null;
}

const rooms: Map<string, Room> = new Map();

const server = Bun.serve<ServerWebSocketData>({
  port: 3000,
  fetch(req, server) {
    const url = new URL(req.url);
    const roomId = url.searchParams.get("room") || "";
    const passwordHash = url.searchParams.get("pwd") || "";
    server.upgrade(req, {
      data: { roomId, passwordHash, clientId: null },
    })
  },
  websocket: {
    open(ws) {
      const { roomId, passwordHash } = ws.data;
      console.log(`new connection: ${roomId} ${passwordHash}`);

      let room: Room | undefined = rooms.get(roomId);
      if (!room) {
        room = {
          clients: new Map(),
          sessions: new Map(),
          passwordHash: passwordHash || null,
        };
        rooms.set(roomId, room);
        console.log("room created");
      }

      ws.send(
        JSON.stringify({
          type: "connected",
          data: room.passwordHash,
        })
      );
    },
    message(ws, message) {
      const signal: RawSignal = JSON.parse(message.toString());
      const room: Room | undefined = rooms.get(ws.data.roomId);

      if (!room) {
        console.log("room not found");
        return;
      }

      switch (signal.type) {
        case "join":
          handleJoin(room, signal.data as TransferClient, ws);
          break;
        case "leave":
          handleLeave(room, signal.data as TransferClient, ws);
          break;
        case "message":
          handleMessage(room, signal.data as ClientSignal, ws);
          break;
        default:
          console.log("unknown signal type");
          break;
      }
    },
    close(ws) {
      const room: Room | undefined = rooms.get(ws.data.roomId);
      if (!room) {
        console.log("room not found");
        return;
      }

      const client: TransferClient | undefined = room.clients.get(ws.data.clientId || "");
      if (!client) {
        console.log("client not found");
        return;
      }

      room.sessions.delete(client.clientId);
      room.clients.delete(client.clientId);

      ws.data.clientId = null;

      const leaveMessage: RawSignal = {
        type: "leave",
        data: client,
      };
      room.sessions.forEach((clientWs) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          console.log(`send leave message to ${client.clientId}`);
          clientWs.send(JSON.stringify(leaveMessage));
        }
      });

      if (room.sessions.size === 0) {
        rooms.delete(ws.data.roomId);
        console.log("room deleted");
      }
    },
  },
});

function handleJoin(room: Room, client: TransferClient, ws: ServerWebSocket<ServerWebSocketData>) {
  if (!room) return;
  if (room.clients.has(client.clientId)) return;
  if (room.sessions.has(client.clientId)) return;


  console.log(`client ${client.clientId} joined`);
  ws.data.clientId = client.clientId;
  room.clients.forEach((existingClient) => {
    ws.send(
      JSON.stringify({
        type: "join",
        data: existingClient,
      })
    );
  });

  room.sessions.forEach((clientWs) => {
    if (clientWs !== ws && clientWs.readyState === WebSocket.OPEN) {
      console.log(`send join message to ${client.clientId}`);
      clientWs.send(
        JSON.stringify({
          type: "join",
          data: client,
        })
      );
    }
  });

  room.sessions.set(client.clientId, ws);
  room.clients.set(client.clientId, client);
}

function handleLeave(room: Room, client: TransferClient, ws: ServerWebSocket<ServerWebSocketData>) {
  if (!room) return;
  room.sessions.delete(client.clientId);
  room.clients.delete(client.clientId);
  console.log(`client ${client.clientId} left`);
  room.sessions.forEach((clientWs) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      console.log(`send leave message to ${client.clientId}`);
      clientWs.send(
        JSON.stringify({
          type: "leave",
          data: client,
        })
      );
    }
  });
  ws.close();
}

function handleMessage(room: Room, data: ClientSignal, ws: ServerWebSocket<ServerWebSocketData>) {
  const targetWs = room?.sessions.get(data.targetClientId);
  if (targetWs && targetWs !== ws && targetWs.readyState === WebSocket.OPEN) {
    console.log(`send message to ${data.targetClientId}`);
    targetWs.send(
      JSON.stringify({
        type: "message",
        data: data,
      })
    );
  }
}

console.log(`WebSocket server running on port ${server.port}`);
