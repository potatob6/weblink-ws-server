export const LOG_LEVEL = process.env["LOG_LEVEL"] || "info";
export const PORT = parseInt(process.env["PORT"] || "9000", 10);
export const HEARTBEAT_INTERVAL = parseInt(process.env["HEARTBEAT_INTERVAL"] || "30000", 10);
export const PONG_TIMEOUT = parseInt(process.env["PONG_TIMEOUT"] || "60000", 10);
export const DISCONNECT_TIMEOUT = parseInt(process.env["DISCONNECT_TIMEOUT"] || "90000", 10);
export const REDIS_URL = process.env["REDIS_URL"] || null;
