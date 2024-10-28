# Weblink WS Server

## Introduction

This is a WebSocket signaling server for the Weblink chat application, designed to replace Firebase. It utilizes the Bun runtime for high-performance server-side JavaScript execution. This server facilitates the exchange of signaling data required to establish peer-to-peer connections between clients.

Redis URLs can be set to enable a distributed architecture that prioritizes locally and collaborates across instances.

### TLS Setup

TLS is optional and can be enabled by setting the `TLS_CERT_FILE` and `TLS_KEY_FILE` environment variables or set in the .env file.

Optionally, a list of CA files can be set in the `TLS_CA_FILES` environment variable or .env file to enable mutual TLS.
