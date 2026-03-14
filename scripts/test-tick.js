// test-tick.js — Connect a test agent and simulate responses
require('dotenv').config({ path: '../.env' });
const WebSocket = require('ws');
const { issueToken } = require('../server/auth');

const AGENT_ID = 'tato_lion_001';
const WORLD_ID = 'grassland_v1';
const PORT = process.env.PORT || 3100;

const token = issueToken(AGENT_ID, WORLD_ID);
const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${token}`);

ws.on('open', () => {
  console.log('[Test] Connected as Tato (塔托)');
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  
  switch (msg.type) {
    case 'connected':
      console.log('[Test]', msg.message);
      break;

    case 'tick_start':
      console.log(`\n[Test] === Tick ${msg.tick} START ===`);
      console.log('[Test] Self state:', JSON.stringify(msg.self.needs));
      console.log('[Test] Visible agents:', msg.visibleAgents.length);
      console.log('\n' + msg.asciiMap);
      
      // Simulate simple decision logic
      const { needs } = msg.self;
      let action;
      
      if (needs.hunger < 30) {
        // Hunt/eat
        action = { type: 'eat' };
        console.log('[Test] Decision: EAT (hunger low)');
      } else if (needs.safety < 30) {
        action = { type: 'rest' };
        console.log('[Test] Decision: REST (safety low)');
      } else {
        // Move toward water
        action = { type: 'move', target: { x: 4, y: 3 } };
        console.log('[Test] Decision: MOVE toward water');
      }
      
      ws.send(JSON.stringify({ type: 'action', action }));
      break;

    case 'tick_end':
      console.log(`\n[Test] === Tick ${msg.tick} END ===`);
      console.log('[Test] Events:', msg.events.length);
      console.log('[Test] Alive:', msg.aliveCount, 'agents');
      console.log('\n' + msg.asciiMap);
      break;

    case 'error':
      console.error('[Test] Error:', msg.message);
      break;
  }
});

ws.on('close', () => console.log('[Test] Disconnected'));
ws.on('error', (err) => console.error('[Test] WS Error:', err.message));

// Run for 3 ticks then exit
setTimeout(() => {
  console.log('\n[Test] Done — 3 ticks observed');
  ws.close();
  process.exit(0);
}, 120_000);
