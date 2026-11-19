# @rnctl/plugin-mcp

Local Model Context Protocol server that exposes rnctl devices, logs, Metro controls and environment checks to AI coding agents over stdio.

Configure a client with:

```json
{ "mcpServers": { "rnctl": { "type": "stdio", "command": "rnctl", "args": ["mcp"] } } }
```

Part of [rnctl](https://github.com/bittu/rnctl).
