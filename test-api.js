import { WebSocket } from 'ws';
import crypto from 'crypto';

const PORT = 4478;

async function run() {
  console.log('Connecting to WebSocket...');
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  
  ws.on('open', async () => {
    console.log('WS connected. Sending POST request to add server...');
    const res = await fetch(`http://localhost:${PORT}/api/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '127.0.0.1', username: 'test', password: 'test', name: 'TestServer' })
    });
    const data = await res.json();
    console.log('POST Response:', data);
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    console.log('WS Message:', msg.type);
    if (msg.type === 'inventory') {
      console.log('Inventory length:', msg.servers.length);
    } else if (msg.type === 'telemetry') {
      console.log('Telemetry for:', msg.data.id, 'status:', msg.data.status);
    }
  });

  ws.on('error', console.error);
}

run();
