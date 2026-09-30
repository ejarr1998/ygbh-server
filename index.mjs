// Yard Goats vs Ball Hogs — realtime lobby + match server (TRD §3–4)
// Node + ws, in-memory rooms, server-authoritative at 15Hz. $0 hosting target.
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8787;