// Simple PumpPortal Data Monitor
// This will show all messages from PumpPortal and demonstrate subscriptions
const WebSocket = require('ws');
const fs = require('fs');

// Connect to WebSocket
console.log('Starting PumpPortal Monitor...');
const ws = new WebSocket('wss://pumpportal.fun/api/data');

// Counters
let messageCount = 0;
let newTokenCount = 0;
let tradeCount = 0;
let migrationCount = 0;

// Set of tracked tokens
const trackedTokens = new Set();

// Log directory
const LOG_DIR = './monitor_logs';
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Create log file for this session
const date = new Date();
const logFile = `${LOG_DIR}/monitor_${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}.log`;

// Log function
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  fs.appendFileSync(logFile, logMessage);
  console.log(message);
}

log('Monitor started');

ws.on('open', function open() {
  log('WebSocket connection established');
  
  // Subscribe to new token events
  log('Subscribing to new token events...');
  let payload = {
    method: "subscribeNewToken"
  };
  ws.send(JSON.stringify(payload));
  
  // Subscribe to migration events
  log('Subscribing to migration events...');
  payload = {
    method: "subscribeMigration"
  };
  ws.send(JSON.stringify(payload));
  
  // Subscribe to example tokens
  const exampleTokens = [
    "4PBWYjxpsa4C7xod4wNXLYFETRyx5raHGfSZYQLqpump",
    "GHTW9RyZGVnzKpyBbsrYD4rp2Vd6gs7L363VDbuCb1L2"
  ];
  
  log(`Subscribing to ${exampleTokens.length} example tokens...`);
  payload = {
    method: "subscribeTokenTrade",
    keys: exampleTokens
  };
  ws.send(JSON.stringify(payload));
  
  // Add these to tracking
  exampleTokens.forEach(token => trackedTokens.add(token));
  
  log('Initial subscriptions complete. Waiting for messages...');
});

ws.on('message', function message(data) {
  try {
    messageCount++;
    const parsedData = JSON.parse(data);
    
    // Handle different message types
    if (parsedData.method === 'newToken' && parsedData.params) {
      newTokenCount++;
      const { mint, name, symbol } = parsedData.params;
      log(`[NEW TOKEN #${newTokenCount}] ${name} (${symbol}) - ${mint}`);
      
      // Add to tracked tokens
      trackedTokens.add(mint);
      
      // IMPORTANT: Subscribe to this token's trades
      const payload = {
        method: "subscribeTokenTrade",
        keys: [mint]
      };
      ws.send(JSON.stringify(payload));
      log(`Subscribed to trades for ${symbol} (${mint})`);
    }
    else if (parsedData.method === 'tokenTrade' && parsedData.params) {
      tradeCount++;
      const { mint, txType, tokenAmount, solAmount } = parsedData.params;
      
      // Calculate price
      const price = solAmount / tokenAmount;
      
      log(`[TRADE #${tradeCount}] Token: ${mint.slice(0, 8)}... Type: ${txType.toUpperCase()} Amount: ${solAmount.toFixed(4)} SOL, Price: ${price.toFixed(9)}`);
    }
    else if (parsedData.method === 'migration' && parsedData.params) {
      migrationCount++;
      const { mint, pool } = parsedData.params;
      log(`[MIGRATION #${migrationCount}] ${mint} to ${pool}`);
    }
    else {
      log(`[OTHER MSG] Type: ${parsedData.method}`);
    }
    
    // Print stats periodically
    if (messageCount % 20 === 0) {
      log(`\n--- STATS ---`);
      log(`Total Messages: ${messageCount}`);
      log(`New Tokens: ${newTokenCount}`);
      log(`Trades: ${tradeCount}`);
      log(`Migrations: ${migrationCount}`);
      log(`Tracked Tokens: ${trackedTokens.size}`);
      log(`--------------\n`);
    }
  } catch (error) {
    log(`Error processing message: ${error.message}`);
  }
});

ws.on('error', function error(err) {
  log(`WebSocket error: ${err.message}`);
});

ws.on('close', function close() {
  log('WebSocket connection closed');
  
  // Try to reconnect
  setTimeout(() => {
    log('Attempting to reconnect...');
    process.exit(1);  // Exit with error code to allow restart script to reconnect
  }, 5000);
});

// Re-subscribe every 2 minutes to ensure we keep getting trades
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    // Re-subscribe to base events
    log('Re-subscribing to base events...');
    
    // New tokens
    let payload = {
      method: "subscribeNewToken"
    };
    ws.send(JSON.stringify(payload));
    
    // Migrations
    payload = {
      method: "subscribeMigration"
    };
    ws.send(JSON.stringify(payload));
    
    // Re-subscribe to all tokens
    if (trackedTokens.size > 0) {
      log(`Re-subscribing to ${trackedTokens.size} token trades...`);
      
      // Subscribe in batches to avoid message size issues
      const BATCH_SIZE = 5;
      const tokenArray = Array.from(trackedTokens);
      
      for (let i = 0; i < tokenArray.length; i += BATCH_SIZE) {
        const batch = tokenArray.slice(i, i + BATCH_SIZE);
        payload = {
          method: "subscribeTokenTrade",
          keys: batch
        };
        ws.send(JSON.stringify(payload));
        log(`Sent subscription batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(tokenArray.length/BATCH_SIZE)}`);
      }
    }
  }
}, 2 * 60 * 1000);

// Ping to keep connection alive
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.ping();
    log('Sent ping to keep connection alive');
  }
}, 30000);

// Handle process termination
process.on('SIGINT', () => {
  log('Process interrupted. Closing...');
  ws.close();
  process.exit(0);
});

log('Monitor is running. Press Ctrl+C to exit.');