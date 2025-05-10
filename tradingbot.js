// Import required modules
const WebSocket = require('ws');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const path = require('path');
const walletManager = require('./wallet_manager.js');
const privateKeyExtractor = require('./extract_private_key.js');
const analytics = require('./analytics/index.js');
const bundleAnalyzerModule = require('./bundle_analyzer.js');
const alertsModule = require('./modules/alerts.js');
const tradingSystem = require('./trading-system');
const alertToTradeHook = require('./alert_to_trade_hook.js');
const keyboardManager = require('./modules/keyboard_manager.js');
const keyboardHandlers = require('./modules/keyboard_handlers.js');


// Configuration
const TELEGRAM_BOT_TOKEN = '7765351072:AAHQIYM4kFZesytAfwL7z2HJm08VW81Vn0Y';
const LOG_DIR = './logs';
const DATA_DIR = './data';
const MAX_MESSAGE_LENGTH = 4000;
const VERSION = '1.0.0';

// Analysis thresholds - Balanced for better win rate without being too strict
const VOLUME_THRESHOLD = 90.0; // SOL - Higher volume requirement but not excessive (was 45)
const BUY_SELL_RATIO_THRESHOLD = 1.3; // Better buy pressure required (was 1.7)
const WHALE_BUY_THRESHOLD = 1.8; // SOL - Slightly higher whale threshold (was 2.5)
const PRICE_INCREASE_THRESHOLD = 40; // Percentage - Higher growth required (was 35)
const VOLUME_VELOCITY_THRESHOLD = 1.1; // SOL per minute - Better volume requirement (was 0.5)
const HOLDER_GROWTH_THRESHOLD = 45; // Unique buyers - More community interest (was 30)
const INITIAL_PUMP_THRESHOLD = 35; // % increase within 5 minutes of launch (was 80)
const MIN_MARKETCAP_THRESHOLD = 90; // Minimum marketcap in SOL
const RUG_HIGH_THRESHOLD = 60; // SOL - High point before considering a potential rug
const RUG_LOW_THRESHOLD = 32; // SOL - Low point to confirm a rug pull

// Market tracking data
const tokenRegistry = new Map(); // Store token metadata
const volumeTracker = new Map(); // Track volume by token
const tradeHistory = new Map(); // Track trade history by token
const priceTracker = new Map(); // Track price points by token
const uniqueHolders = new Map(); // Track unique holders by token
const buyVolumeTracker = new Map(); // Track buy volume by token
const sellVolumeTracker = new Map(); // Track sell volume by token
const volumeTimeframes = new Map(); // Track volume in timeframes
const whaleTracker = new Map(); // Track whale activity
const launchTimeTracker = new Map(); // Track token launch times
const initialPumpTracker = new Map(); // Track initial pumps
const trendingTokens = new Map(); // Track trending tokens
const alertTracker = new Map(); // Track alerts and outcomes (win/loss)

// Alert performance stats
let alertStats = {
  totalAlerts: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  pendingCount: 0,
  alertTypes: {
    tokenAlert: { total: 0, wins: 0, losses: 0 },
    smartMoney: { total: 0, wins: 0, losses: 0 },
    migration: { total: 0, wins: 0, losses: 0 }
  },
  lossReasons: {
    lowMarketCap: 0,
    significantDrop: 0,
    timeout: 0
  },
  winTimes: {
    under1hour: 0,
    under6hours: 0,
    under24hours: 0,
    over24hours: 0
  },
  averageWinPercent: 0,
  totalWinPercent: 0,
  highestWinPercent: 0,
  xMilestones: {
    "2x": 0,
    "3x": 0,
    "5x": 0,
    "10x": 0,
    "20x": 0,
    "50x": 0,
    "100x": 0,
    "500x": 0,
    "1000x": 0
  },
  // Tracking continuous achievement
  xAchievements: {}, // mint -> { timestamp, milestone }
  // Pending X milestones to prevent duplication
  pendingMilestones: {}
};
const smartMoneyWallets = new Set([
  "AArPXm8JatJiuyEffuC1un2Sc835SULa4uQqDcaGpAjV",
  "Drcw57AaWYQ7PdNS7B1oAgjYfVxRjheL46KNbbfjb9CT"
  // Add more "smart money" addresses here
]);
const smartMoneyActivity = new Map(); // Track smart money activity
const smartMoneyAlertDeduplication = new Set(); // Global set to deduplicate smart money alerts
const migrationAlertDeduplication = new Set(); // Global set to deduplicate migration alerts
const subscriptionAttempts = new Map(); // Track subscription attempts
const bullishAlertDeduplication = new Set(); // Global set to deduplicate bullish token alerts

// Initialize global milestone tracking if not already done
if (!global.milestoneTracker) {
  global.milestoneTracker = {
    recentChecks: new Set(),     // For deduplicating checks in a time window (10 seconds)
    recentAlerts: new Map(),     // For tracking which milestone alerts were sent
    lastCleanup: Date.now(),     // Track when we last cleaned up old entries
    cleanupInterval: 300000      // Clean up every 5 minutes (300,000 ms)
  };
}
// Telegram management
const activeChats = new Set();
const userSettings = new Map(); // Store user-specific settings with expanded customization options
const adminChatId = 5956309039; // Your admin ID

// System counters and diagnostics
let wsMessageCount = 0;
let tokenTradeCount = 0;
let lastReconnectAttempt = 0;
let reconnectAttempts = 0;
let isReconnecting = false;
let lastActivity = Date.now();
let wsConnectionId = null; // Unique identifier for each connection session
let memoryUsage = null; // Memory usage tracking

// Bundle analyzer module
let bundleAnalyzer;

// Global price data
global.solPriceUsd = null;
global.lastSolPriceUpdate = 0;

// Initialize Telegram bot
let bot;
try {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  console.log('Telegram bot initialized');

  // Register commands for Telegram command menu
  bot.setMyCommands([
    { command: 'profitstats', description: 'View trading profit statistics' },
    { command: 'pnlreport', description: 'View detailed profit/loss report' },
    { command: 'tradingconfig', description: 'View trading configuration' },
    { command: 'positions', description: 'View active trading positions' },
    { command: 'tradehistory', description: 'View completed trade history' }
  ]);
  console.log('Telegram commands registered');

  // Initialize private key extractor with the bot instance
  privateKeyExtractor.setupTelegramIntegration(bot);

  // Add command handlers
  bot.onText(/\/reset/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    // For security, only allow reset from admin
    if (chatId === adminChatId) {
      console.log(`Reset command received from admin user ${userId} in chat ${chatId}`);
      const result = resetTracking();
      bot.sendMessage(chatId, `🔄 ${result}`);
    } else {
      bot.sendMessage(chatId, "⚠️ This command is restricted to the admin user.");
    }
  });

 // In the /stats command handler:
 bot.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;

  // Calculate wins by type
  const tokenAlertWinRate = alertStats.alertTypes.tokenAlert.total > 0
    ? ((alertStats.alertTypes.tokenAlert.wins / alertStats.alertTypes.tokenAlert.total) * 100).toFixed(2)
    : "0.00";

  const smartMoneyWinRate = alertStats.alertTypes.smartMoney.total > 0
    ? ((alertStats.alertTypes.smartMoney.wins / alertStats.alertTypes.smartMoney.total) * 100).toFixed(2)
    : "0.00";

  const migrationWinRate = alertStats.alertTypes.migration.total > 0
    ? ((alertStats.alertTypes.migration.wins / alertStats.alertTypes.migration.total) * 100).toFixed(2)
    : "0.00";

  // Fix: Use alert type wins and losses for rate calculation instead of total alerts
  const tokenAlertTotal = alertStats.alertTypes.tokenAlert.wins + alertStats.alertTypes.tokenAlert.losses;
  const tokenAlertWinRateFix = tokenAlertTotal > 0
    ? ((alertStats.alertTypes.tokenAlert.wins / tokenAlertTotal) * 100).toFixed(2)
    : "0.00";

  const smartMoneyTotal = alertStats.alertTypes.smartMoney.wins + alertStats.alertTypes.smartMoney.losses;
  const smartMoneyWinRateFix = smartMoneyTotal > 0
    ? ((alertStats.alertTypes.smartMoney.wins / smartMoneyTotal) * 100).toFixed(2)
    : "0.00";

  const migrationTotal = alertStats.alertTypes.migration.wins + alertStats.alertTypes.migration.losses;
  const migrationWinRateFix = migrationTotal > 0
    ? ((alertStats.alertTypes.migration.wins / migrationTotal) * 100).toFixed(2)
    : "0.00";

  // Count milestones
  const milestones = alertStats.xMilestones || {};

  // Calculate actual win rate
  const realWinRate = (alertStats.wins + alertStats.losses) > 0 ?
    ((alertStats.wins / (alertStats.wins + alertStats.losses)) * 100) : 0;

  // Calculate total alerts as sum of wins, losses, and pending
  const totalAlerts = alertStats.wins + alertStats.losses + alertStats.pendingCount;

  // Format message using the correct win rate calculation
  const statsMsg = `📊 *Bot Alert Statistics*\n\n` +
                  `🔢 *Overall Performance:*\n` +
                  `• Total Alerts: ${totalAlerts}\n` +
                  `• Wins: ${alertStats.wins}\n` +
                  `• Losses: ${alertStats.losses}\n` +
                  `• Win Rate: ${realWinRate.toFixed(2)}%\n` +
                  `• Pending: ${alertStats.pendingCount}\n\n` +

                  `🎯 *X Milestones Achieved:*\n` +
                  `2x: ${milestones['2x'] || 0} | 3x: ${milestones['3x'] || 0} | 5x: ${milestones['5x'] || 0} | ` +
                  `10x: ${milestones['10x'] || 0} | 20x: ${milestones['20x'] || 0}\n` +
                  `50x: ${milestones['50x'] || 0} | 100x: ${milestones['100x'] || 0} | 250x: ${milestones['250x'] || 0} | ` +
                  `500x: ${milestones['500x'] || 0} | 1000x: ${milestones['1000x'] || 0}\n\n` +

                  `🧮 *By Alert Type:*\n` +
                  `• Token Alerts: ${alertStats.alertTypes.tokenAlert.total} alerts (${tokenAlertWinRateFix}% win rate)\n` +
                  `• Smart Money: ${alertStats.alertTypes.smartMoney.total} alerts (${smartMoneyWinRateFix}% win rate)\n` +
                  `• Migrations: ${alertStats.alertTypes.migration.total} alerts (${migrationWinRateFix}% win rate)\n\n` +

                  `⏱ *Win Timing:*\n` +
                  `• Under 1hr: ${alertStats.winTimes.under1hour} | Under 6hrs: ${alertStats.winTimes.under6hours}\n` +
                  `• Under 24hrs: ${alertStats.winTimes.under24hours} | Over 24hrs: ${alertStats.winTimes.over24hours}\n\n` +

                  `💯 *Performance:*\n` +
                  `• Average Win: ${alertStats.averageWinPercent.toFixed(2)}%\n` +
                  `• Highest Win: ${alertStats.highestWinPercent.toFixed(2)}%\n\n` +

                  `ℹ️ A win is defined as a token gaining 50% or more after alert.\n` +
                  `ℹ️ A loss is recorded when a token's market cap drops below 32 SOL.\n` +
                  `ℹ️ Try /toppumps to see detailed X performance`;

  // Send stats message
  bot.sendMessage(chatId, statsMsg, { parse_mode: 'Markdown' });
});



} catch (error) {
  console.error('Error initializing Telegram bot:', error);
  process.exit(1);
}

// Initialize callback query handler for instabuy buttons
bot.on('callback_query', async (callbackQuery) => {
  const userId = callbackQuery.from.id.toString();
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  try {
    // Handle copy private key button
    if (data.startsWith('copy_key_')) {
      const targetUserId = data.split('_')[2];

      // Security check - only allow users to copy their own keys
      if (userId === targetUserId) {
        bot.answerCallbackQuery(callbackQuery.id, {
          text: "✅ Private key copied to clipboard!",
          show_alert: true
        });
      } else {
        bot.answerCallbackQuery(callbackQuery.id, {
          text: "⚠️ Security Alert: You can only copy your own private key",
          show_alert: true
        });
      }
      return;
    }

    // Handle wallet view request
    else if (data === 'view_wallet') {
      const walletAddress = walletManager.getUserWallet(userId);

      if (!walletAddress) {
        // Create wallet if user doesn't have one
        const newWallet = walletManager.assignWalletToUser(userId, chatId);
        const balance = await walletManager.getWalletBalance(newWallet.publicKey);

        // Get the wallet details including private key
        const walletInfo = walletManager.getWalletDetails(userId);

        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Created a new wallet for you!' });
        await bot.sendMessage(chatId,
          `💼 *Your Solana Wallet*\n\n` +
          `🔑 *Address:* \`${newWallet.publicKey}\`\n` +
          `💰 *Balance:* ${balance.toFixed(4)} SOL\n\n` +
          `Send SOL to this address to fund your instabuy transactions.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔐 Show Private Key (Tap to reveal)', callback_data: `show_privatekey_${userId}` }],
                [{ text: '📋 Copy Wallet Address', callback_data: `copy_address_${userId}` }]
              ]
            }
          }
        );
      } else {
        // Show existing wallet info
        const balance = await walletManager.getWalletBalance(walletAddress);

        await bot.answerCallbackQuery(callbackQuery.id);
        await bot.sendMessage(chatId,
          `💼 *Your Solana Wallet*\n\n` +
          `🔑 *Address:* \`${walletAddress}\`\n` +
          `💰 *Balance:* ${balance.toFixed(4)} SOL\n\n` +
          `Send SOL to this address to fund your instabuy transactions.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔐 Show Private Key (Tap to reveal)', callback_data: `show_privatekey_${userId}` }],
                [{ text: '📋 Copy Wallet Address', callback_data: `copy_address_${userId}` }]
              ]
            }
          }
        );
      }
    }

    // Handle show private key request
    else if (data.startsWith('show_privatekey_')) {
      const requestUserId = data.split('_')[2];

      // Only show private key to the wallet owner
      if (userId !== requestUserId) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'You are not authorized to view this private key.',
          show_alert: true
        });
        return;
      }

      const walletInfo = walletManager.getWalletDetails(userId);
      if (!walletInfo) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Wallet information not found.',
          show_alert: true
        });
        return;
      }

      // Convert private key to array format for Phantom import
      const privateKeyBuffer = Buffer.from(walletInfo.privateKey, 'hex');
      const privateKeyArray = Array.from(privateKeyBuffer);
      const phantomFormat = JSON.stringify(privateKeyArray);

      // Send private key as a separate message with warning
      await bot.answerCallbackQuery(callbackQuery.id);

      // First send the warning and instructions
      await bot.sendMessage(chatId,
        `🔐 *PRIVATE KEY - KEEP SECURE*\n\n` +
        `⚠️ *WARNING:* Never share this key with anyone!\n\n` +
        `To import into Phantom wallet:\n` +
        `1. Copy the key from the following message\n` +
        `2. In Phantom, click "Add/Connect Wallet"\n` +
        `3. Select "Import Private Key"\n` +
        `4. Paste the key and follow the prompts`,
        { parse_mode: 'Markdown' }
      );

      // Then send just the private key as plain text for easy copying
      const keyMessage = await bot.sendMessage(chatId, phantomFormat, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Delete this message for security', callback_data: 'delete_privatekey_msg' }]
          ]
        }
      });

      // Store the message ID for later deletion
      setTimeout(() => {
        try {
          bot.deleteMessage(chatId, keyMessage.message_id).catch(() => {
            console.log('Auto-delete private key message failed');
          });
        } catch (error) {
          console.error('Error auto-deleting private key message:', error);
        }
      }, 60000); // Auto-delete after 1 minute for security
    }

    // Handle copy wallet address request
    else if (data.startsWith('copy_address_')) {
      const walletAddress = walletManager.getUserWallet(userId);
      if (!walletAddress) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Wallet address not found.' });
        return;
      }

      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Wallet address copied to clipboard!' });
      await bot.sendMessage(chatId, `\`${walletAddress}\``, { parse_mode: 'Markdown' });
    }

    // Handle delete private key message request
    else if (data === 'delete_privatekey_msg') {
      try {
        await bot.deleteMessage(chatId, callbackQuery.message.message_id);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Message deleted for security.' });

        // Try to delete the previous message (instructions) as well
        try {
          await bot.deleteMessage(chatId, callbackQuery.message.message_id - 1);
        } catch (err) {
          // Silently ignore if we can't delete the previous message
          console.log('Could not delete instructions message');
        }
      } catch (error) {
        console.error('Error deleting message:', error);
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Could not delete message. Please delete it manually for security.',
          show_alert: true
        });
      }
    }

    // Handle buy requests
    else if (data.startsWith('buy_')) {
      const [_, shortMint, amountStr] = data.split('_');
      const amount = parseFloat(amountStr);

      if (isNaN(amount)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Invalid amount' });
        return;
      }

      // Find the full token mint from the shortened version
      let tokenMint = shortMint;
      let tokenName = "Token";

      // Try to find the full mint by prefix
      Array.from(tokenRegistry.entries()).forEach(([mint, info]) => {
        if (mint.startsWith(shortMint)) {
          tokenMint = mint;
          tokenName = info.name || "Token";
        }
      });

      // Get or create user wallet
      let walletAddress = walletManager.getUserWallet(userId);

      if (!walletAddress) {
        const newWallet = walletManager.assignWalletToUser(userId, chatId);
        walletAddress = newWallet.publicKey;
        await bot.sendMessage(chatId, `Created a new wallet for you: \`${walletAddress}\``, { parse_mode: 'Markdown' });
      }

      // Check wallet balance
      const balance = await walletManager.getWalletBalance(walletAddress);

      if (balance < amount) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: `Insufficient balance. You have ${balance.toFixed(4)} SOL, need ${amount} SOL.`,
          show_alert: true
        });
        return;
      }

      // Show processing message
      await bot.sendMessage(chatId, `Processing purchase of ${tokenName} for ${amount} SOL... Please wait.`);

      // Execute the buy transaction (no nested try/catch, use the outer one)
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Processing purchase...' });

      // Use exactly the requested amount - we'll handle fee adjustments in the wallet_manager
      // This ensures the user sees the same amount in messages as they requested
      const result = await walletManager.buyToken(userId, tokenMint, amount);

      if (result.success) {
        await bot.sendMessage(chatId,
          `✅ *Transaction Successful*\n\n` +
          `🪙 Token: ${tokenName} \`${tokenMint.substring(0, 6)}...${tokenMint.substring(tokenMint.length - 4)}\`\n` +
          `💰 Amount: ${amount} SOL\n` +
          `🧾 [View Transaction](${result.explorer})\n` +
          `🧾 Transaction ID: \`${result.txId}\``,
          { parse_mode: 'Markdown' }
        );
      } else {
        await bot.sendMessage(chatId,
          `❌ *Transaction Failed*\n\n` +
          `🪙 Token: ${tokenName} \`${tokenMint.substring(0, 6)}...${tokenMint.substring(tokenMint.length - 4)}\`\n` +
          `💰 Amount: ${amount} SOL\n` +
          `❗ Error: ${result.message}`,
          { parse_mode: 'Markdown' }
        );
      }
    }
  } catch (error) {
    console.error('Error handling callback query:', error);

    // If this was a buy attempt, show more detailed error
    if (data.startsWith('buy_')) {
      const [_, shortMint, amountStr] = data.split('_');
      const amount = parseFloat(amountStr);
      let tokenName = shortMint;

      try {
        await bot.sendMessage(chatId,
          `❌ *Transaction Error*\n\n` +
          `🪙 Token: ${tokenName}\n` +
          `💰 Amount: ${amount} SOL\n` +
          `❗ Error: ${error.message}`,
          { parse_mode: 'Markdown' }
        );
      } catch (msgError) {
        console.error('Error sending error message:', msgError);
      }
    }

    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'An error occurred. Please try again later.',
      show_alert: true
    });
  }
});

let ws = null;
let wsReconnectTimer = null;
let wsKeepAliveTimer = null;
// Ensure required directories exist

function ensureDirectoriesExist() {
  [LOG_DIR, DATA_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// Simplified WebSocket connection based on PumpPortal's example
function setupWebSocket() {
  // Clear any existing timers
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  if (wsKeepAliveTimer) {
    clearInterval(wsKeepAliveTimer);
    wsKeepAliveTimer = null;
  }

  // Close existing connection if it exists
  if (ws) {
    try {
      ws.terminate(); // Force close any existing connection
    } catch (e) {
      console.error('Error terminating existing WebSocket:', e);
    }
    ws = null;
  }

  console.log('🔄 Setting up WebSocket connection...');

  // Create a new WebSocket connection
  ws = new WebSocket('wss://pumpportal.fun/api/data');

  // Set up event handlers
  ws.on('open', function open() {
    console.log('🟢 WebSocket connection established successfully');
    lastActivity = Date.now();

    // Subscribe to events
    console.log('Subscribing to events...');

    // 1. Subscribe to new token events
    ws.send(JSON.stringify({
      method: "subscribeNewToken"
    }));

    // 2. Subscribe to migration events
    ws.send(JSON.stringify({
      method: "subscribeMigration"
    }));

    // 3. Subscribe to smart money wallets if any
    if (smartMoneyWallets.size > 0) {
      ws.send(JSON.stringify({
        method: "subscribeAccountTrade",
        keys: Array.from(smartMoneyWallets)
      }));
    }

    // 4. Subscribe to tracked tokens in batches
    const tokenSubscriptions = Array.from(tokenRegistry.keys());
    if (tokenSubscriptions.length > 0) {
      console.log(`Subscribing to ${tokenSubscriptions.length} tracked tokens...`);

      // Use batches to avoid overwhelming the connection
      const BATCH_SIZE = 50;
      for (let i = 0; i < tokenSubscriptions.length; i += BATCH_SIZE) {
        const batch = tokenSubscriptions.slice(i, i + BATCH_SIZE);
        ws.send(JSON.stringify({
          method: "subscribeTokenTrade",
          keys: batch
        }));
        console.log(`Sent subscription batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(tokenSubscriptions.length/BATCH_SIZE)}`);
      }
    }

    // Set up a keep-alive ping every 30 seconds to prevent connection timeouts
    wsKeepAliveTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping();
        console.log('Sent WebSocket ping to keep connection alive');

        // Save milestone data periodically (every 5 pings = 2.5 minutes)
        if (wsMessageCount % 5 === 0) {
          saveMilestoneData();
        }
      }
    }, 30000000); // 0030 seconds (was incorrectly set to 30000000 ms)

    // Notify active chats
    broadcastToChats('🔌 *PumpPortal Pro Trader connected*\nMonitoring for trading opportunities...',
      { parse_mode: 'Markdown' });

    // Check subscription status after connection is established
    setTimeout(() => {
      console.log('Checking subscription status after initial connection...');
      checkSubscriptionStatus();
    }, 5000); // Wait 5 seconds after connection to check subscriptions
  });

  ws.on('message', function message(data) {
    try {
      wsMessageCount++;
      lastActivity = Date.now();

      // Process message data
      const message = JSON.parse(data);

      // Log to file
      logToFile(message);

      // Handle subscription confirmation messages
      if (message.message) {
        return;
      }

      // Process based on txType
      if (message.txType === 'create') {
        // New token creation event

        // Subscribe to token trades
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            method: "subscribeTokenTrade",
            keys: [message.mint]
          }));
        }

        // Process the new token
        const params = {
          mint: message.mint,
          name: message.name,
          symbol: message.symbol,
          creator: message.traderPublicKey,
          uri: message.uri,
          initialBuy: message.initialBuy,
          solAmount: message.solAmount,
          bondingCurveKey: message.bondingCurveKey,
          vTokensInBondingCurve: message.vTokensInBondingCurve,
          vSolInBondingCurve: message.vSolInBondingCurve,
          marketCapSol: message.marketCapSol,
          pool: message.pool,
          traderPublicKey: message.traderPublicKey
        };
        processNewToken(params);
      }
      else if (message.txType === 'buy' || message.txType === 'sell') {
        // Token trade event
        tokenTradeCount++;
        processTokenTrade(message).catch(error => console.error('Error processing token trade:', error));
      }
      else if (message.txType === 'migrate') {
        // Migration event
        const migrationParams = {
          mint: message.mint,
          pool: message.pool,
          signature: message.signature
        };
        processMigration(migrationParams).catch(error => console.error('Error processing migration:', error));
      }
      else if (message.txType === 'accountTrade') {
        // Account trade event (smart money wallet)
        // Create a deduplication key
        const txSignature = message.signature || '';
        const dedupeKey = `wsHandler_accountTrade_${message.traderPublicKey}_${message.mint}_${message.solAmount?.toFixed(4)}_${txSignature}`;

        // Check for duplicates
        if (smartMoneyAlertDeduplication.has(dedupeKey)) {
          console.log(`GLOBAL DEDUPE: Skipping duplicate account trade message for tx ${txSignature.slice(0, 8)}...`);
          return;
        }

        // Add to deduplication set
        smartMoneyAlertDeduplication.add(dedupeKey);

        // Process account trade
        processAccountTrade(message);
      }
    } catch (error) {
      console.error('Error processing message:', error);
      console.error('Raw data:', typeof data === 'string' ? data.substring(0, 200) : 'Non-string data');
    }
  });

  ws.on('error', function(err) {
    console.error('⚠️ WebSocket error:', err);
    handleReconnect();
  });

  ws.on('close', function(code, reason) {
    console.log(`WebSocket connection closed: ${code} - ${reason || 'No reason provided'}`);
    handleReconnect();
  });

  // Handle pong responses to keep track of connection health
  ws.on('pong', () => {
    console.log('Received pong from server - connection is alive');
    lastActivity = Date.now();
  });
}

// Handle reconnection with exponential backoff
function handleReconnect() {
  // Clear any existing keep-alive timer
  if (wsKeepAliveTimer) {
    clearInterval(wsKeepAliveTimer);
    wsKeepAliveTimer = null;
  }

  // Save milestone data before reconnecting to prevent data loss
  console.log('Saving milestone data before reconnection...');
  saveMilestoneData();

  // Set a timer to reconnect
  if (!wsReconnectTimer) {
    const delay = 5000; // Fixed 5-second delay for simplicity
    console.log(`Scheduling reconnection in ${delay/1000} seconds...`);

    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      console.log('Attempting to reconnect...');

      // Load milestone data before reconnecting
      loadMilestoneData();

      // Reconnect WebSocket
      setupWebSocket();

      // Check subscription status after reconnection
      setTimeout(() => {
        console.log('Checking subscription status after reconnection...');
        checkSubscriptionStatus();
      }, 5000); // Wait 5 seconds after reconnection to check subscriptions
    }, delay);
  }
}

// Simple function to safely close the WebSocket connection
function safeCloseWebSocket() {
  // Clear any timers
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  if (wsKeepAliveTimer) {
    clearInterval(wsKeepAliveTimer);
    wsKeepAliveTimer = null;
  }

  if (ws) {
    try {
      ws.close(1000, 'Normal closure');
      console.log('WebSocket connection closed gracefully');
    } catch (e) {
      console.error('Error closing WebSocket:', e);
      // Force terminate if clean close fails
      try {
        ws.terminate();
      } catch (e) {
        console.error('Error terminating WebSocket:', e);
      }
    }
    ws = null;
  }
}

// Process new token
function processNewToken(tokenData) {
  try {
    const { mint, name, symbol, creator, uri, traderPublicKey, initialBuy,
            solAmount, bondingCurveKey, vTokensInBondingCurve, vSolInBondingCurve,
            marketCapSol, pool } = tokenData;

    console.log(`New token detected: ${name} (${symbol}) - ${mint}`);

    // Store token data
    const tokenInfo = {
      name,
      symbol,
      creator,
      traderPublicKey,
      createdAt: Date.now(),
      initialBuy,
      solAmount,
      initialPrice: solAmount / initialBuy,
      currentPrice: solAmount / initialBuy,
      bondingCurveKey,
      vTokensInBondingCurve,
      vSolInBondingCurve,
      marketCapSol,
      uri,
      pool,
      logo: null, // Will be fetched if possible
      metadataFetched: false,
      lowestAlertMarketCap: marketCapSol, // Track lowest alert market cap for unified milestone tracking
      milestoneTracking: {
        lastTrackedPrice: solAmount / initialBuy,
        achievedMilestones: {}, // Track milestones already achieved
        initialAlertTime: Date.now(),
        initialAlertType: 'newToken'
      }
    };

    // Add to token registry
    tokenRegistry.set(mint, tokenInfo);

    // Track in analytics
    analytics.dailyMetrics.recordNewToken(tokenInfo);

    // Initialize tracking data
    volumeTracker.set(mint, 0);
    tradeHistory.set(mint, []);
    priceTracker.set(mint, []);
    uniqueHolders.set(mint, new Set());
    buyVolumeTracker.set(mint, 0);
    sellVolumeTracker.set(mint, 0);
    volumeTimeframes.set(mint, {});
    whaleTracker.set(mint, 0);
    launchTimeTracker.set(mint, Date.now());
    initialPumpTracker.set(mint, {
      initialPrice: solAmount / initialBuy,
      highestPrice: solAmount / initialBuy,
      percentageIncrease: 0,
      pumpDetected: false
    });

    // Subscribe to token trades - with verification
    if (ws && ws.readyState === WebSocket.OPEN) {
      const payload = {
        method: "subscribeTokenTrade",
        keys: [mint]
      };
      ws.send(JSON.stringify(payload));

      // Track subscription attempt
      subscriptionAttempts.set(mint, {
        timestamp: Date.now(),
        attempts: 1
      });
    } else {
      console.error(`Cannot subscribe to token trades for ${mint} - WebSocket not ready (State: ${ws ? ws.readyState : 'null'})`);
    }

    // Try to fetch token metadata
    fetchTokenMetadata(mint);

    // Calculate initial price
    const initialPrice = solAmount / initialBuy;


    setTimeout(() => {
      analyzeNewToken(mint).catch(error => console.error(`Error in scheduled analysis for ${mint}:`, error));
    }, 180000); // 3 minute analysis
    setTimeout(() => {
      analyzeNewToken(mint).catch(error => console.error(`Error in scheduled analysis for ${mint}:`, error));
    }, 300000); // 5 minute analysis
    setTimeout(() => {
      analyzeNewToken(mint).catch(error => console.error(`Error in scheduled analysis for ${mint}:`, error));
    }, 600000); // 10 minute analysis
  } catch (error) {
    console.error('Error processing new token:', error);
  }
}

// Process token trade
async function processTokenTrade(tradeData) {
  try {
    // Double check we have the right data
    if (!tradeData.mint || !tradeData.txType) {
      console.log('Invalid trade data, missing required fields');
      console.log(JSON.stringify(tradeData));
      return;
    }

    const { mint, txType, tokenAmount, solAmount, traderPublicKey,
            tokensInPool, solInPool, marketCapSol, signature, pool } = tradeData;

    // Track if price was updated to trigger immediate checks
    let priceUpdated = false;

    // Auto-register token if we're not tracking it yet
    if (!tokenRegistry.has(mint)) {
      console.log(`Auto-registering new token from trade: ${mint}`);
      tokenRegistry.set(mint, {
        name: `Token_${mint.slice(0, 6)}`,
        symbol: mint.slice(0, 4).toUpperCase(),
        creator: traderPublicKey,
        createdAt: Date.now(),
        discoveredThrough: 'trade',
        currentPrice: solAmount / tokenAmount,
        marketCapSol: marketCapSol || 0
      });

      // Initialize tracking data
      volumeTracker.set(mint, 0);
      tradeHistory.set(mint, []);
      priceTracker.set(mint, []);
      uniqueHolders.set(mint, new Set());
      buyVolumeTracker.set(mint, 0);
      sellVolumeTracker.set(mint, 0);
      volumeTimeframes.set(mint, {});
      whaleTracker.set(mint, 0);
      launchTimeTracker.set(mint, Date.now());
      initialPumpTracker.set(mint, {
        initialPrice: solAmount / tokenAmount,
        highestPrice: solAmount / tokenAmount,
        percentageIncrease: 0,
        pumpDetected: false
      });

      // Subscribe to this token's trades to make sure we get future trades
      if (ws && ws.readyState === WebSocket.OPEN) {
        const payload = {
          method: "subscribeTokenTrade",
          keys: [mint]
        };
        ws.send(JSON.stringify(payload));
        console.log(`Subscribed to trades for auto-registered token: ${mint}`);
      }
    }

    // Log that we're processing this trade

    const tokenInfo = tokenRegistry.get(mint);
    const isBuy = txType === 'buy';
    const timestamp = Date.now();

    // Calculate price
    const price = solAmount / tokenAmount;

    // Update token market data
    if (tokensInPool !== undefined && solInPool !== undefined) {
      tokenInfo.tokensInPool = tokensInPool;
      tokenInfo.solInPool = solInPool;
    }

    // Immediately update the current price - this is critical for real-time position management
    const oldPrice = tokenInfo.currentPrice || price;
    tokenInfo.currentPrice = price;

    // Flag that price was updated
    priceUpdated = true;

    // Log significant price changes to help with debugging
    if (Math.abs((price - oldPrice) / oldPrice) > 0.05) { // 5% change
    }

    // Update market cap
    if (marketCapSol !== undefined) {
      tokenInfo.marketCapSol = marketCapSol;
    }

    checkAndTrackMilestones(mint, marketCapSol, price);

    // Update USD market cap if we have SOL price
    if (marketCapSol !== undefined && global.solPriceUsd) {
      tokenInfo.marketCapUsd = marketCapSol * global.solPriceUsd;
    }

    // Add to trade history
    const tradeInfo = {
      txType,
      tokenAmount,
      solAmount,
      trader: traderPublicKey,
      timestamp,
      price,
      tokensInPool,
      solInPool,
      marketCapSol,
      signature
    };

    const history = tradeHistory.get(mint) || [];
    history.push(tradeInfo);

    // Limit history size to prevent memory issues
    if (history.length > 1000) {
      history.splice(0, history.length - 1000);
    }

    tradeHistory.set(mint, history);

    // Update volume trackers
    const currentVolume = volumeTracker.get(mint) || 0;
    const newVolume = currentVolume + solAmount;
    volumeTracker.set(mint, newVolume);

    // Track volume in analytics
    analytics.dailyMetrics.recordTokenVolume(mint, solAmount);

    if (isBuy) {
      const buyVolume = buyVolumeTracker.get(mint) || 0;
      buyVolumeTracker.set(mint, buyVolume + solAmount);

      // Track unique holders
      const holders = uniqueHolders.get(mint) || new Set();
      holders.add(traderPublicKey);
      uniqueHolders.set(mint, holders);

      // Check for whale activity
      if (solAmount >= WHALE_BUY_THRESHOLD) {
        const whaleCount = whaleTracker.get(mint) || 0;
        whaleTracker.set(mint, whaleCount + 1);
      }
    } else {
      const sellVolume = sellVolumeTracker.get(mint) || 0;
      sellVolumeTracker.set(mint, sellVolume + solAmount);
    }

    // Track price points
    const prices = priceTracker.get(mint) || [];
    prices.push({
      price,
      timestamp,
      isBuy
    });

    // Limit price history size
    if (prices.length > 1000) {
      prices.splice(0, prices.length - 1000);
    }

    priceTracker.set(mint, prices);

    // Track volume in timeframes (5-minute intervals)
    const timeframeId = Math.floor(timestamp / 300000);
    const timeframes = volumeTimeframes.get(mint) || {};
    timeframes[timeframeId] = (timeframes[timeframeId] || 0) + solAmount;

    // Clean up old timeframes (keep last 24h)
    const oldTimeframeThreshold = timeframeId - 288; // 288 5-min periods = 24h
    Object.keys(timeframes)
      .filter(id => parseInt(id) < oldTimeframeThreshold)
      .forEach(id => delete timeframes[id]);

    volumeTimeframes.set(mint, timeframes);

    // Check for smart money activity
    if (smartMoneyWallets.has(traderPublicKey)) {
      const activity = smartMoneyActivity.get(mint) || [];
      activity.push({
        trader: traderPublicKey,
        action: isBuy ? 'buy' : 'sell',
        amount: solAmount,
        timestamp
      });

      // Limit activity history size
      if (activity.length > 100) {
        activity.splice(0, activity.length - 100);
      }

      smartMoneyActivity.set(mint, activity);

      // Alert on smart money buys
      if (isBuy) {
        // Check if token is at least 3 minutes old
        const tokenAge = Date.now() - tokenInfo.createdAt;
        const tokenAgeMinutes = tokenAge / (60 * 1000);
        if (tokenAgeMinutes < 3) {
          console.log(`Skipping smart money alert for ${tokenInfo.symbol || mint} - token too new (${tokenAgeMinutes.toFixed(2)} minutes old)`);
          return;
        }

        // Check minimum marketcap threshold
        if (marketCapSol < MIN_MARKETCAP_THRESHOLD) {
          console.log(`Skipping smart money alert for ${tokenInfo.symbol || mint} - marketcap too low (${marketCapSol.toFixed(2)} SOL)`);
          return;
        }

        // Check if token already has an alert using the centralized system
        if (alertsModule.hasAlertedToken(mint)) {
          console.log(`Skipping smart money alert for ${tokenInfo.symbol || mint} - token already alerted`);
          return;
        }

        // Check for duplication with a unique key
        const walletKey = `${traderPublicKey}_${mint}`;
        const lastAlert = tokenInfo.smartMoneyAlerts?.[walletKey];

        // Check DEXScreener status before creating alert
        try {
          const dexStatus = await checkDexScreenerStatus(mint);
          // Update token info with DEXScreener status
          tokenInfo.dexScreenerPaid = dexStatus.hasPaid;
          tokenInfo.dexScreenerOrderTypes = dexStatus.types;
          tokenRegistry.set(mint, tokenInfo);

          console.log(`DEXScreener paid status for ${tokenInfo.symbol || mint} (smart money): ${dexStatus.hasPaid ? 'PAID' : 'NOT PAID'}`);
        } catch (error) {
          console.error('Error checking DEXScreener status:', error);
          return; // Skip alert if we can't check DEXScreener status
        }

        // Track this alert for win/loss statistics
        trackAlert(mint, 'smartMoney', marketCapSol);

        // Create alert data
        const alertData = {
          mint,
          tokenInfo,
          traderPublicKey,
          solAmount,
          price,
          isFollowup: lastAlert ? true : false,
          lastAlert,
          marketCapSol,
          solPriceUsd: global.solPriceUsd
        };

        // Use the alerts module to send the alert
        const alertSent = await alertsModule.createSmartMoneyAlert(alertData);
        if (alertSent) {
          console.log(`Smart money alert sent for ${tokenInfo.symbol || mint} via alerts module`);

          // Store the smart money alert info to avoid duplicates
          if (!tokenInfo.smartMoneyAlerts) tokenInfo.smartMoneyAlerts = {};
          tokenInfo.smartMoneyAlerts[walletKey] = {
            amount: solAmount,
            price: tokenInfo.currentPrice || price,
            timestamp: Date.now()
          };
          tokenRegistry.set(mint, tokenInfo);
        } else {
          console.log(`Failed to send smart money alert for ${tokenInfo.symbol || mint}`);
        }
      }
    }

    // Check for initial pump
    const launchTime = launchTimeTracker.get(mint) || 0;
    const initialPumpData = initialPumpTracker.get(mint) || {
      initialPrice: price,
      highestPrice: price,
      percentageIncrease: 0,
      pumpDetected: false
    };

    // Only check for 5 minutes after launch
    if (timestamp - launchTime < 300000) {
      if (price > initialPumpData.highestPrice) {
        initialPumpData.highestPrice = price;
        const percentIncrease = ((price - initialPumpData.initialPrice) / initialPumpData.initialPrice) * 100;
        initialPumpData.percentageIncrease = percentIncrease;

        // We've decided to remove MAJOR PUMP DETECTED alerts to reduce alert frequency
        // Just track the pump for data purposes
        if (percentIncrease >= INITIAL_PUMP_THRESHOLD * 1.8 && !initialPumpData.pumpDetected) {
          initialPumpData.pumpDetected = true;
          console.log(`Significant pump detected for ${tokenInfo.symbol || mint}: ${percentIncrease.toFixed(2)}% increase, but not alerting (reduced alerts)`);

          // Skip the rest of the pump alert code
          return;
        }
      }
      initialPumpTracker.set(mint, initialPumpData);
    }

    // Update token metrics every few trades or immediately after a price update
    if (priceUpdated || history.length % 3 === 0) {
      updateTokenMetrics(mint);
    }

    // If price was updated, immediately check alerts and trading positions
    if (priceUpdated) {
      // Immediate check for alerts
      if (alertTracker.has(mint)) {
        try {
          await checkAlertProgress(mint);
        } catch (err) {
          console.error(`Error during immediate alert check for ${mint}:`, err);
        }
      }

      // Immediate check for trading positions (if auto-trading is enabled)
      if (tradingSystem && tradingSystem.tradingConfig && tradingSystem.tradingConfig.activePositions &&
          tradingSystem.tradingConfig.activePositions.has(mint)) {
        try {
          tradingSystem.checkPosition(mint);
        } catch (err) {
          console.error(`Error during immediate position check for ${mint}:`, err);
        }
      }
    }

    // Check for significant events
    checkSignificantEvents(mint);
  } catch (error) {
    console.error('Error processing token trade:', error);
  }
}

// Process account trade
async function processAccountTrade(tradeData) {
  try {
    const { mint, txType, tokenAmount, solAmount, traderPublicKey } = tradeData;

    // We're mostly interested in smart money wallets
    if (smartMoneyWallets.has(traderPublicKey)) {
      const tokenInfo = tokenRegistry.get(mint);

      // If we don't know this token yet, subscribe to it
      if (!tokenInfo) {
        // Get token info (may need to query an API for complete data)
        fetchBasicTokenInfo(mint).then(info => {
          if (info) {
            // Store basic token data
            tokenRegistry.set(mint, {
              name: info.name || 'Unknown',
              symbol: info.symbol || 'UNKNOWN',
              createdAt: Date.now(),
              discoveredThrough: 'smartMoney'
            });

            // Initialize tracking data
            volumeTracker.set(mint, 0);
            tradeHistory.set(mint, []);
            priceTracker.set(mint, []);
            uniqueHolders.set(mint, new Set());
            buyVolumeTracker.set(mint, 0);
            sellVolumeTracker.set(mint, 0);
            volumeTimeframes.set(mint, {});
            whaleTracker.set(mint, 0);
            launchTimeTracker.set(mint, Date.now());

            // Subscribe to token trades with verification
            if (ws && ws.readyState === WebSocket.OPEN) {
              const payload = {
                method: "subscribeTokenTrade",
                keys: [mint]
              };
              console.log(`SENDING TOKEN TRADE SUBSCRIPTION FROM ACCOUNT TRADE: ${JSON.stringify(payload)}`);
              ws.send(JSON.stringify(payload));
              console.log(`Subscribed to trades for newly discovered token: ${mint}`);

              // Track subscription attempt
              subscriptionAttempts.set(mint, {
                timestamp: Date.now(),
                attempts: 1
              });
            } else {
              console.error(`Cannot subscribe to token trades for ${mint} from account trade - WebSocket not ready`);
            }
          }
        });
      }

      // Track smart money activity
      const isBuy = txType === 'buy';
      const activity = smartMoneyActivity.get(mint) || [];

      activity.push({
        trader: traderPublicKey,
        action: isBuy ? 'buy' : 'sell',
        amount: solAmount,
        timestamp: Date.now()
      });

      // Limit activity history size
      if (activity.length > 100) {
        activity.splice(0, activity.length - 100);
      }

      smartMoneyActivity.set(mint, activity);

      // Alert on significant smart money activity
      // Replace the direct alert generation in processAccountTrade
      if (isBuy && solAmount >= WHALE_BUY_THRESHOLD * 0.5) {
        const tokenName = tokenInfo ? tokenInfo.symbol : `Token ${mint.slice(0, 6)}...`;

        // Check if token already has an alert using the centralized system
        if (alertsModule.hasAlertedToken(mint)) {
          console.log(`Skipping account trade alert for ${tokenName} - token already alerted`);
          return;
        }

        // Find the wallet key and last alert if any
        const walletKey = `${traderPublicKey}_${mint}`;
        const lastAlert = tokenInfo?.smartMoneyAlerts?.[walletKey];

        // Create alert data
        const alertData = {
          mint,
          tokenInfo: tokenInfo || {
            name: tokenName,
            symbol: tokenName
          },
          traderPublicKey,
          solAmount,
          price: tokenInfo?.currentPrice || 0,
          isFollowup: lastAlert ? true : false,
          lastAlert,
          marketCapSol: tokenInfo?.marketCapSol || 0,
          solPriceUsd: global.solPriceUsd
        };

        // Use the alerts module to send the alert
        const alertSent = await alertsModule.createSmartMoneyAlert(alertData);
        if (alertSent) {
          console.log(`Smart money account activity alert sent for ${tokenName} via alerts module`);

          // Store alert info to avoid duplicates if we have token info
          if (tokenInfo) {
            if (!tokenInfo.smartMoneyAlerts) tokenInfo.smartMoneyAlerts = {};
            tokenInfo.smartMoneyAlerts[walletKey] = {
              amount: solAmount,
              price: tokenInfo.currentPrice || 0,
              timestamp: Date.now()
            };
            tokenRegistry.set(mint, tokenInfo);
          }
        } else {
          console.log(`Failed to send smart money account activity alert for ${tokenName}`);
        }
      }
    }
  } catch (error) {
    console.error('Error processing account trade:', error);
  }
}

// Process token migration
async function processMigration(migrationData) {
  try {
    const { mint, signature, pool } = migrationData;

    // Get token info
    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo) return false;

    // Check if token already has an alert using the centralized system
    if (alertsModule.hasAlertedToken(mint)) {
      console.log(`Skipping migration alert for ${tokenInfo.symbol || mint} - token already alerted`);
      return false;
    }

    // Update token info
    tokenInfo.migratedTo = pool;
    tokenInfo.migrationTime = Date.now();
    tokenInfo.migrationSignature = signature;
    tokenRegistry.set(mint, tokenInfo);

    // Track in analytics
    analytics.dailyMetrics.recordMigration(mint, pool);

    // Get the market cap value before doing DEXScreener check
    const marketCapSol = tokenInfo.marketCapSol || 0;

    // Track this alert for win/loss statistics immediately
    trackAlert(mint, 'migration', marketCapSol);

    // Check DEXScreener status before creating alert
    try {
      const dexStatus = await checkDexScreenerStatus(mint);
      // Update token info with DEXScreener status
      tokenInfo.dexScreenerPaid = dexStatus.hasPaid;
      tokenInfo.dexScreenerOrderTypes = dexStatus.types;
      tokenRegistry.set(mint, tokenInfo);

      console.log(`DEXScreener paid status for ${tokenInfo.symbol || mint} (migration): ${dexStatus.hasPaid ? 'PAID' : 'NOT PAID'}`);
    } catch (error) {
      console.error('Error checking DEXScreener status:', error);
      // Don't return - continue with alert even if DEXScreener check fails
      tokenInfo.dexScreenerPaid = false;
      tokenInfo.dexScreenerOrderTypes = [];
    }

    // Use the alerts module to send the migration alert
    try {
      const alertData = {
        mint,
        pool,
        tokenInfo,
        marketCapSol,
        solPriceUsd: global.solPriceUsd
      };

      const alertSent = alertsModule.createMigrationAlert(alertData);
      if (alertSent) {
        console.log(`Migration alert sent for ${tokenInfo.symbol || mint} via alerts module`);
      } else {
        console.log(`Failed to send migration alert for ${tokenInfo.symbol || mint}`);
      }
    } catch (error) {
      console.error(`Error sending migration alert via module for ${tokenInfo.symbol || mint}:`, error);
    }

    return true;
  } catch (error) {
    console.error('Error processing migration:', error);
    return false;
  }
}

// Fetch SOL price in USD
async function fetchSolPrice() {
  try {
    // Only fetch price if it's been over 5 minutes since last update
    const now = Date.now();
    if (now - global.lastSolPriceUpdate < 300000 && global.solPriceUsd !== null) {
      return global.solPriceUsd;
    }

    console.log('Fetching current SOL price...');
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');

    if (response.data && response.data.solana && response.data.solana.usd) {
      global.solPriceUsd = response.data.solana.usd;
      global.lastSolPriceUpdate = now;
      console.log(`Updated SOL price: $${global.solPriceUsd}`);
      return global.solPriceUsd;
    } else {
      console.error('Failed to get SOL price from API:', response.data);
      // Use cached price if available, otherwise fallback to estimate
      return global.solPriceUsd || 120.0; // Fallback to a reasonable estimate if API fails
    }
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    return global.solPriceUsd || 120.0; // Fallback to cached or estimated price
  }
}

// Fetch token metadata
async function fetchTokenMetadata(mint) {
  try {
    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo || tokenInfo.metadataFetched) return;

    // Try to get metadata from URI if available
    if (tokenInfo.uri) {
      try {
        const response = await axios.get(tokenInfo.uri, {
          timeout: 10000,
          headers: {
            'User-Agent': 'PumpPortalTrader/1.0.0'
          }
        });
        const metadata = response.data;

        if (metadata) {
          tokenInfo.description = metadata.description;
          tokenInfo.logo = metadata.image;
          tokenInfo.attributes = metadata.attributes;
          tokenInfo.metadataFetched = true;
          tokenRegistry.set(mint, tokenInfo);
          console.log(`Fetched metadata for ${mint}`);
        }
      } catch (err) {
        console.error(`Error fetching metadata for ${mint}:`, err.message);
      }
    }
  } catch (error) {
    console.error('Error fetching token metadata:', error);
  }
}

// Fetch basic token info
async function fetchBasicTokenInfo(mint) {
  // This might require an API call to get basic token info
  // For example, calling a Solana RPC for token info
  // Simplified placeholder implementation
  return {
    name: `Token_${mint.slice(0, 6)}`,
    symbol: mint.slice(0, 4).toUpperCase()
  };
}

// Check and track X milestones (2x, 3x, 5x, etc.)
function checkAndTrackMilestones(mint, currentMarketCap, currentPrice) {
  try {
    // Get token info
    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo) return;

    // Deduplicate frequent checks using global milestone tracker (avoid checking same token too often)
    const dedupeKey = `${mint}_check_${Math.floor(Date.now() / 10000)}`; // 10-second window

    // Initialize global milestone tracker if not already done
    if (!global.milestoneTracker) {
      global.milestoneTracker = {
        recentChecks: new Set(),     // For deduplicating checks in a time window (10 seconds)
        recentAlerts: new Map(),     // For tracking which milestone alerts were sent
        lastCleanup: Date.now(),     // Track when we last cleaned up old entries
        cleanupInterval: 300000      // Clean up every 5 minutes (300,000 ms)
      };
      console.log('Initialized global milestone tracker in checkAndTrackMilestones');
    }

    // Ensure recentChecks is a Set
    if (!(global.milestoneTracker.recentChecks instanceof Set)) {
      console.log('Converting recentChecks to Set in checkAndTrackMilestones');
      global.milestoneTracker.recentChecks = new Set(
        Array.isArray(global.milestoneTracker.recentChecks) ?
        global.milestoneTracker.recentChecks : []
      );
    }

    // Skip if we just checked this token recently (within 10 seconds)
    try {
      if (global.milestoneTracker.recentChecks.has(dedupeKey)) {
        if (process.env.DEBUG_MILESTONE) {
          console.log(`Skipping duplicate milestone check for ${tokenInfo.symbol || mint} - checked recently`);
        }
        return;
      }

      // Add to recent checks
      global.milestoneTracker.recentChecks.add(dedupeKey);
    } catch (err) {
      console.error('Error with milestone tracker recentChecks:', err);
      // Recreate the Set if there was an error
      global.milestoneTracker.recentChecks = new Set([dedupeKey]);
      console.log('Recreated milestone tracker recentChecks as a new Set');
    }

    // Cleanup old entries periodically to prevent memory leaks
    const now = Date.now();
    if (now - global.milestoneTracker.lastCleanup > global.milestoneTracker.cleanupInterval) {
      console.log('Cleaning up old milestone tracker entries');
      global.milestoneTracker.lastCleanup = now;

      // Clean up all checks older than current window
      global.milestoneTracker.recentChecks.clear();
    }

    // Initialize milestone tracking if it doesn't exist
    if (!tokenInfo.milestoneTracking) {
      return; // First record, no milestones to check yet
    }

    // Skip milestone checking if this was initialized from token creation, not an alert
    if (tokenInfo.milestoneTracking.initialAlertType === 'newToken') {
      return;
    }

    // Get the lowest market cap from any alert for this token
    let lowestMarketCap = tokenInfo.lowestAlertMarketCap;

    // For migration alerts, use the fixed market cap
    if (tokenInfo.milestoneTracking && tokenInfo.milestoneTracking.initialAlertType === 'migration') {
      lowestMarketCap = 410.88; // Use fixed market cap for migrations
      console.log(`Using fixed market cap of 410.88 SOL for migration milestone calculations: ${tokenInfo.symbol || mint}`);
    }

    // Skip milestone checking if we don't have a valid lowest market cap
    if (!lowestMarketCap || lowestMarketCap <= 0) {
      console.log(`Cannot check milestones for ${tokenInfo.symbol || mint} - no valid lowest market cap`);
      return;
    }

    // Calculate the gain multiple based on market cap (more reliable than price)
    const gainMultiple = currentMarketCap / lowestMarketCap;

    // Calculate percentage change for win tracking
    const percentChange = ((currentMarketCap - lowestMarketCap) / lowestMarketCap) * 100;

    // Skip if the multiple hasn't changed significantly
    if (tokenInfo.lastCheckedMultiple && Math.abs(gainMultiple - tokenInfo.lastCheckedMultiple) < 0.05) {
      return;
    }

    // Update the last checked multiple
    tokenInfo.lastCheckedMultiple = gainMultiple;
    tokenRegistry.set(mint, tokenInfo);

    // Ensure we have the alertStats structure properly initialized
    if (!alertStats.xMilestones) {
      alertStats.xMilestones = {
        '2x': 0, '3x': 0, '5x': 0, '10x': 0, '20x': 0, '50x': 0, '100x': 0, '500x': 0, '1000x': 0
      };
    }

    // Define our milestone levels
    const milestones = [2, 3, 5, 10, 20, 50, 100, 500, 1000];

    // Check each milestone
    for (const milestone of milestones) {
      const milestoneKey = `${milestone}x`;

      // Skip if already achieved this milestone
      if (tokenInfo.milestoneTracking.achievedMilestones[milestoneKey]) {
        continue;
      }

      // Check if milestone achieved
      if (gainMultiple >= milestone) {
        console.log(`🎯 MILESTONE: ${tokenInfo.symbol || mint} has reached ${milestone}X milestone!`);
        console.log(`   Initial market cap: ${lowestMarketCap.toFixed(2)} SOL`);
        console.log(`   Current market cap: ${currentMarketCap.toFixed(2)} SOL`);
        console.log(`   Gain multiple: ${gainMultiple.toFixed(2)}x`);
        console.log(`   Percentage change: ${percentChange.toFixed(2)}%`);

        // Calculate time to reach milestone
        const initialTime = tokenInfo.milestoneTracking.initialAlertTime;
        const timeToMilestone = Date.now() - initialTime;
        const hoursToMilestone = timeToMilestone / (1000 * 60 * 60);

        // Mark as achieved in token info with timing data
        tokenInfo.milestoneTracking.achievedMilestones[milestoneKey] = {
          achievedAt: Date.now(),
          initialMarketCap: lowestMarketCap,
          currentMarketCap: currentMarketCap,
          gainMultiple: gainMultiple,
          percentChange: percentChange,
          hoursToReach: hoursToMilestone
        };

        // Also track time to milestone in a separate structure for easier access
        if (!tokenInfo.milestoneTracking.timeToMilestones) {
          tokenInfo.milestoneTracking.timeToMilestones = {};
        }

        tokenInfo.milestoneTracking.timeToMilestones[milestoneKey] = {
          hours: hoursToMilestone,
          timestamp: Date.now()
        };

        // Update tracked data
        tokenRegistry.set(mint, tokenInfo);

        // DIRECTLY update global milestone counter
        alertStats.xMilestones[milestoneKey] = (alertStats.xMilestones[milestoneKey] || 0) + 1;

        // Update highest win percentage if this is higher
        const milestonePercent = (milestone - 1) * 100;
        if (milestonePercent > alertStats.highestWinPercent) {
          console.log(`Updating highest win percentage from ${alertStats.highestWinPercent.toFixed(2)}% to ${milestonePercent.toFixed(2)}% based on ${milestoneKey} milestone`);
          alertStats.highestWinPercent = milestonePercent;
        }

        // Save stats immediately
        saveAlertStats();

        // Update any active alerts in alertTracker
        if (alertTracker.has(mint)) {
          const alertData = alertTracker.get(mint);
          if (!alertData.reachedMilestones) {
            alertData.reachedMilestones = {};
          }

          alertData.reachedMilestones[milestoneKey] = Date.now();
          alertData.highestX = Math.max(alertData.highestX || 1, gainMultiple);
          alertData.currentX = gainMultiple;
          alertData.peakX = alertData.highestX;

          alertTracker.set(mint, alertData);
        }

        // Send milestone alert
        sendMilestoneAlert(mint, milestone, lowestMarketCap, currentMarketCap, gainMultiple);
      }
    }
  } catch (error) {
    console.error('Error checking milestones:', error);
  }
}

// Send milestone alert to users with enhanced data
function sendMilestoneAlert(mint, milestone, initialMarketCap, currentMarketCap, gainMultiple) {
  try {
    // Get token info
    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo) return;

    // Create a unique key for this milestone alert to prevent duplicates
    const milestoneAlertKey = `${mint}_${milestone}x`;

    // Initialize global milestone tracker if not already done
    if (!global.milestoneTracker) {
      global.milestoneTracker = {
        recentChecks: new Set(),     // For deduplicating checks in a time window (10 seconds)
        recentAlerts: new Map(),     // For tracking which milestone alerts were sent
        lastCleanup: Date.now(),     // Track when we last cleaned up old entries
        cleanupInterval: 300000      // Clean up every 5 minutes (300,000 ms)
      };
      console.log('Initialized global milestone tracker in sendMilestoneAlert');
    }

    // Ensure recentAlerts is a Map
    if (!(global.milestoneTracker.recentAlerts instanceof Map)) {
      console.log('Converting recentAlerts to Map in sendMilestoneAlert');
      global.milestoneTracker.recentAlerts = new Map(
        Array.isArray(global.milestoneTracker.recentAlerts) ?
        global.milestoneTracker.recentAlerts : []
      );
    }

    // Check if this exact milestone alert was sent already (no time window for milestones)
    try {
      if (global.milestoneTracker.recentAlerts.has(milestoneAlertKey)) {
        console.log(`Preventing duplicate milestone alert for ${tokenInfo.symbol || mint} - ${milestone}x already achieved`);
        return;
      }

      // Add to milestone alerts tracking
      global.milestoneTracker.recentAlerts.set(milestoneAlertKey, Date.now());
    } catch (err) {
      console.error('Error with milestone tracker recentAlerts:', err);
      // Recreate the Map if there was an error
      global.milestoneTracker.recentAlerts = new Map([[milestoneAlertKey, Date.now()]]);
      console.log('Recreated milestone tracker recentAlerts as a new Map');
    }

    // Keep backward compatibility with the old system
    if (!global.recentMilestoneAlerts) global.recentMilestoneAlerts = new Set();
    global.recentMilestoneAlerts.add(`${milestoneAlertKey}_${Math.floor(Date.now() / 300000)}`);

    // Cleanup old entries periodically to prevent memory leaks
    const now = Date.now();
    if (now - global.milestoneTracker.lastCleanup > global.milestoneTracker.cleanupInterval) {
      console.log('Cleaning up old milestone tracker entries');
      global.milestoneTracker.lastCleanup = now;

      // Clean up old milestone checks (anything older than 24 hours)
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      global.milestoneTracker.recentAlerts.forEach((timestamp, key) => {
        if (timestamp < oneDayAgo) {
          global.milestoneTracker.recentAlerts.delete(key);
        }
      });

      // Keep backward compatibility with old system
      if (global.recentMilestoneAlerts.size > 100) {
        const values = Array.from(global.recentMilestoneAlerts);
        for (let i = 0; i < values.length - 100; i++) {
          global.recentMilestoneAlerts.delete(values[i]);
        }
      }
    }

    // Handle migration types specifically with fixed market cap
    if (tokenInfo.milestoneTracking && tokenInfo.milestoneTracking.initialAlertType === 'migration') {
      // Fixed market cap for consistency in migration alerts
      initialMarketCap = 410.88; // Use consistent market cap for migrations
      console.log(`Using fixed market cap of 410.88 SOL for migration milestone alert: ${tokenInfo.symbol || mint}`);
    }

    // Skip milestone alerts for tokens that haven't been alerted to users yet
    if (!tokenInfo.milestoneTracking || tokenInfo.milestoneTracking.initialAlertType === 'newToken') {
      console.log(`Skipping milestone alert for ${tokenInfo.symbol || mint} - not from a user-facing alert`);
      return;
    }

    const symbol = tokenInfo.symbol || 'Unknown';
    const timeSinceAlert = Math.floor((Date.now() - tokenInfo.milestoneTracking.initialAlertTime) / 60000); // in minutes

    // Calculate USD values for both initial and current MC
    let marketCapUsdFormatted = "";
    let initialMarketCapUsd = "";
    if (global.solPriceUsd) {
      const marketCapUsd = currentMarketCap * global.solPriceUsd;
      marketCapUsdFormatted = marketCapUsd < 1000000
        ? ` ($${Math.round(marketCapUsd).toLocaleString()})`
        : ` ($${(marketCapUsd / 1000000).toFixed(2)}M)`;

      const initialMcUsd = initialMarketCap * global.solPriceUsd;
      initialMarketCapUsd = initialMcUsd < 1000000
        ? ` ($${Math.round(initialMcUsd).toLocaleString()})`
        : ` ($${(initialMcUsd / 1000000).toFixed(2)}M)`;
    }

    // Count how many X milestones achieved for this specific X value
    const milestoneCount = alertStats.xMilestones[`${milestone}x`] || 0;

    // Helper function to get ordinal suffix
    function getOrdinalSuffix(n) {
      const s = ['th', 'st', 'nd', 'rd'];
      const v = n % 100;
      return s[(v - 20) % 10] || s[v] || s[0];
    }

    // Generate URLs
    const pumpFunUrl = `https://pump.fun/coin/${mint}`;
    const solscanUrl = `https://solscan.io/token/${mint}`;
    const neoUrl = `https://neo.bullx.io/terminal?chainId=1399811149&address=${mint}`;

    // Find the original alert chat ID and message ID if stored
    const originalAlertRef = tokenInfo.originalAlertRef || '';
    let originalAlertLink = '';
    if (originalAlertRef && originalAlertRef.includes(':')) {
      const [chatId, msgId] = originalAlertRef.split(':');
      originalAlertLink = `\n🔍 [View Original Alert](https://t.me/c/${chatId.replace('-100', '')}/${msgId})`;
    }

    // Prepare alert message with enhanced data
    const alertMsg = `🚀 *${symbol} HIT ${milestone}X* 🚀\n\n` +
                    `Token has increased ${milestone}x from our initial alert!\n\n` +
                    `⏱️ Time since alert: ${timeSinceAlert}min\n` +
                    `💰 Initial MC: ${initialMarketCap.toFixed(2)} SOL${initialMarketCapUsd}\n` +
                    `📈 Current MC: ${currentMarketCap.toFixed(2)} SOL${marketCapUsdFormatted}\n` +
                    `🔥 Gain: ${Math.round((gainMultiple - 1) * 100)}%\n` +
                    `🔗 [PumpFun](${pumpFunUrl}) | [Solscan](${solscanUrl}) | [NeoBullX](${neoUrl})\n` +
                    `🪙 Full Address: \`${mint}\`\n` +
                    `${originalAlertLink}\n\n` +
                    `🏆 This is our ${milestoneCount + 1}${getOrdinalSuffix(milestoneCount + 1)} ${milestone}x call!`;

    // Send alert to all active chats
    broadcastToChats(alertMsg, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Error sending milestone alert:', error);
  }
}

// Update token metrics
// Update token metrics with proper variable definitions
function updateTokenMetrics(mint) {
  try {
    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo) return;

    // Calculate buy/sell ratio
    const buyVolume = buyVolumeTracker.get(mint) || 0;
    const sellVolume = sellVolumeTracker.get(mint) || 0;
    const buySellRatio = sellVolume > 0 ? buyVolume / sellVolume : buyVolume > 0 ? Infinity : 0;

    // Analyze trend and volume patterns
    const trendAnalysis = analyzeUptrend(mint);
    const volumeAnalysis = analyzeVolumeProfile(mint);

    // Extract and store trend metrics
    const isUptrend = trendAnalysis.isUptrend || false;
    const trendStrength = trendAnalysis.strength || 0;
    tokenInfo.isUptrend = isUptrend;
    tokenInfo.trendStrength = trendStrength;

    // Extract and store volume metrics
    const healthyVolume = volumeAnalysis.isHealthy || false;
    const volumeTrend = volumeAnalysis.volumeTrend || 0;
    const buyRatioTrend = volumeAnalysis.buyRatioTrend || 0;
    tokenInfo.healthyVolume = healthyVolume;
    tokenInfo.volumeTrend = volumeTrend;
    tokenInfo.buyRatioTrend = buyRatioTrend;

    // Define trend factors for sentiment calculation (these were missing)
    const trendFactor = isUptrend ? Math.min(trendStrength / 3, 2) : 0;
    const volumeTrendFactor = healthyVolume ? Math.min(volumeTrend / 2 + 1, 2) : 0;

    // Calculate price change
    const prices = priceTracker.get(mint) || [];
    let priceChangePercent = 0;
    let currentPrice = 0;

    if (prices.length >= 2) {
      const initialPrice = prices[0].price;
      currentPrice = prices[prices.length - 1].price;
      priceChangePercent = ((currentPrice - initialPrice) / initialPrice) * 100;
    } else if (prices.length === 1) {
      currentPrice = prices[0].price;
    }

    // Calculate volume velocity (SOL per minute)
    const timeframes = volumeTimeframes.get(mint) || {};
    const timeframeKeys = Object.keys(timeframes).sort();
    let volumeVelocity = 0;

    if (timeframeKeys.length >= 2) {
      const latestTimeframeId = parseInt(timeframeKeys[timeframeKeys.length - 1]);
      const latestVolume = timeframes[latestTimeframeId] || 0;
      volumeVelocity = latestVolume / 5; // 5 minute timeframes converted to per minute
    }

    // Count unique holders
    const holders = uniqueHolders.get(mint) || new Set();
    const holderCount = holders.size;

    // Get whale activity
    const whaleCount = whaleTracker.get(mint) || 0;

    // Check for smart money interest
    const smartMoneyInterest = smartMoneyActivity.has(mint);

    // Update token metrics
    tokenInfo.buySellRatio = buySellRatio;
    tokenInfo.priceChangePercent = priceChangePercent;
    tokenInfo.currentPrice = currentPrice;
    tokenInfo.volumeVelocity = volumeVelocity;
    tokenInfo.holderCount = holderCount;
    tokenInfo.whaleCount = whaleCount;
    tokenInfo.smartMoneyInterest = smartMoneyInterest;
    tokenInfo.lastUpdated = Date.now();

    // Calculate enhanced sentiment score (comprehensive weighted algorithm)
    // Use scaled factors instead of binary thresholds for more nuanced scoring
    const buySellFactor = Math.min(buySellRatio / BUY_SELL_RATIO_THRESHOLD, 2);
    const priceChangeFactor = Math.min(Math.max(priceChangePercent / PRICE_INCREASE_THRESHOLD, 0), 3);
    const volumeVelocityFactor = Math.min(volumeVelocity / VOLUME_VELOCITY_THRESHOLD, 2.5);
    const holderFactor = Math.min(holderCount / HOLDER_GROWTH_THRESHOLD, 1.5);
    const whaleFactor = whaleCount > 2 ? 2 : whaleCount > 0 ? 1.5 : 0;
    const smartMoneyFactor = smartMoneyInterest ? 2.5 : 0;

    // Age factor - newer tokens get a boost
    const ageInHours = (Date.now() - (tokenInfo.createdAt || Date.now())) / (1000 * 60 * 60);
    const ageFactor = ageInHours < 6 ? 1.5 : ageInHours < 24 ? 1.2 : 1;

    // Trade momentum - frequency of recent trades
    const tradeCount = tokenInfo.tradeCount || 0;
    const tradeMomentum = Math.min((tradeCount / Math.max(ageInHours, 1)), 3);
    const momentumFactor = tradeMomentum > 10 ? 1.5 : tradeMomentum > 5 ? 1.2 : 1;

    // Calculate raw score with adjusted weights for higher win rate
    // Prioritize stronger buy pressure and whale activity which correlate with sustained pumps
    const rawScore = (
      buySellFactor * 4.0 +
      priceChangeFactor * 2.5 +
      volumeVelocityFactor * 3.0 +
      holderFactor * 2.5 +
      whaleFactor * 4.0 +
      smartMoneyFactor * 5.0 +
      trendFactor * 4.0 +           // Now properly defined
      volumeTrendFactor * 3.0       // Now properly defined
    ) * ageFactor * momentumFactor;

    // Add sustainability factor
    let sustainabilityFactor = 1.0;
    if (tokenInfo.lastAlertPrice && tokenInfo.lastAlerts) {
      const timeSinceLastAlert = Date.now() - Object.values(tokenInfo.lastAlerts)[0];
      const hoursSinceLastAlert = timeSinceLastAlert / (1000 * 60 * 60);

      // If price has sustained for more than 1 hour and is still growing, this is a good sign
      if (hoursSinceLastAlert > 1 && currentPrice >= tokenInfo.lastAlertPrice) {
        sustainabilityFactor = 1.5;
      }
    }

    // Apply sustainability factor to the score
    const finalRawScore = rawScore * sustainabilityFactor;

    // Balanced normalization to 0-100 scale (using 7x multiplier)
    tokenInfo.sentimentScore = Math.min(Math.round(finalRawScore * 7), 100);

    if (tokenInfo.sentimentScore >= 95) tokenInfo.sentimentCategory = "Extremely Bullish";
    else if (tokenInfo.sentimentScore >= 85) tokenInfo.sentimentCategory = "Very Bullish";
    else if (tokenInfo.sentimentScore >= 75) tokenInfo.sentimentCategory = "Bullish";
    else if (tokenInfo.sentimentScore >= 65) tokenInfo.sentimentCategory = "Neutral";
    else tokenInfo.sentimentCategory = "Not Promising";

    tokenRegistry.set(mint, tokenInfo);

    // Add to trending tokens if score is high
    if (tokenInfo.sentimentScore >= 60) {
      trendingTokens.set(mint, {
        symbol: tokenInfo.symbol,
        score: tokenInfo.sentimentScore,
        timestamp: Date.now()
      });
    }
  } catch (error) {
    console.error('Error updating token metrics:', error);
  }
}

// Helper function to calculate trend strength - referenced in checkSignificantEvents but not defined
function calculateTrendStrength(mint) {
  try {
    const trendAnalysis = analyzeUptrend(mint);
    return trendAnalysis.strength || 0;
  } catch (error) {
    console.error('Error calculating trend strength:', error);
    return 0;
  }
}

function checkSignificantEvents(mint) {
  try {
    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo) return;

    // Skip if token is already marked as a rug
    if (tokenInfo.isRugPull) {
      return;
    }

    const volume = volumeTracker.get(mint) || 0;
    const sentimentScore = tokenInfo.sentimentScore || 0;
    const priceChangePercent = tokenInfo.priceChangePercent || 0;
    const currentPrice = tokenInfo.currentPrice || 0;
    const marketCapSol = tokenInfo.marketCapSol || 0;
    const buySellRatio = tokenInfo.buySellRatio || 0;
    const holderCount = tokenInfo.holderCount || 0;
    const volumeVelocity = tokenInfo.volumeVelocity || 0;

    // Keep track of highest price and marketcap for improved rug detection
    if (!tokenInfo.highestPrice || currentPrice > tokenInfo.highestPrice) {
      tokenInfo.highestPrice = currentPrice;
      tokenRegistry.set(mint, tokenInfo);
    }

    if (!tokenInfo.highestMarketCapSol || marketCapSol > tokenInfo.highestMarketCapSol) {
      tokenInfo.highestMarketCapSol = marketCapSol;
      tokenInfo.highestMarketCapTime = Date.now();
      tokenRegistry.set(mint, tokenInfo);
    }

    // Ensure trend analysis has been performed and trend data exists
    if (tokenInfo.isUptrend === undefined || tokenInfo.healthyVolume === undefined) {
      // Run trend analysis if needed
      const trendAnalysis = analyzeUptrend(mint);
      const volumeAnalysis = analyzeVolumeProfile(mint);

      // Store the results in token info
      tokenInfo.isUptrend = trendAnalysis.isUptrend || false;
      tokenInfo.trendStrength = trendAnalysis.strength || 0;
      tokenInfo.healthyVolume = volumeAnalysis.isHealthy || false;
      tokenInfo.volumeHealth = volumeAnalysis.volumeTrend || 0;
      tokenInfo.buyRatioTrend = volumeAnalysis.buyRatioTrend || 0;

      tokenRegistry.set(mint, tokenInfo);
    }

    // Modified trend analysis check - don't automatically skip tokens failing trend analysis
    if (!tokenInfo.isUptrend || !tokenInfo.healthyVolume) {

      // Continue if other metrics are strong enough
      const otherMetricsStrong = (
        priceChangePercent >= PRICE_INCREASE_THRESHOLD * 1.5 || // Significantly higher price increase
        buySellRatio >= BUY_SELL_RATIO_THRESHOLD * 1.3 || // Much stronger buy ratio
        (whaleTracker.get(mint) >= 2) || // Multiple whale buys
        smartMoneyActivity.has(mint) || // Smart money interest
        (tokenInfo.sentimentScore || 0) >= 90 // Very high sentiment score
      );

      // Only skip if we don't have other strong metrics
      if (!otherMetricsStrong) {
        return;
      }

    }

    // Additional requirement for minimum trend strength - but make it more lenient
    if (tokenInfo.trendStrength < 2) { // Reduced from 3 to 2

      // Continue if price change is very strong or we have smart money interest
      if (priceChangePercent >= PRICE_INCREASE_THRESHOLD * 1.8 || smartMoneyActivity.has(mint)) {
      } else {
        return;
      }
    }

    // Detect tokens that rose above RUG_HIGH_THRESHOLD and then dropped below RUG_LOW_THRESHOLD
    if (tokenInfo.highestMarketCapSol >= RUG_HIGH_THRESHOLD && marketCapSol <= RUG_LOW_THRESHOLD) {
      const percentDrop = ((tokenInfo.highestMarketCapSol - marketCapSol) / tokenInfo.highestMarketCapSol) * 100;

      console.log(`🚨 HIGH-TO-LOW RUG DETECTED for ${tokenInfo.symbol || mint}:`);


      // Mark token as a rug to avoid further alerts
      tokenInfo.isRugPull = true;
      tokenInfo.rugPullType = 'highToLowDrop';
      tokenInfo.rugPullTime = Date.now();
      tokenInfo.percentDrop = percentDrop;
      tokenRegistry.set(mint, tokenInfo);

      // Record rug pull for analytics
      try {
        analytics.dailyMetrics.recordRugPull(mint, tokenInfo);
      } catch (error) {
        console.error('Error recording rug pull in analytics:', error);
      }

      return; // Skip further processing for this token
    }

    // Standard rug check for tokens that never reached high levels
    const tokenAge = Date.now() - tokenInfo.createdAt;
    if (tokenAge > 60 * 60 * 1000 && volume > 1.0) { // 1+ hour old with 1+ SOL volume
      // Add necessary properties for rug detection
      const enrichedInfo = {
        ...tokenInfo,
        mint,
        totalVolume: volume,
        highestPrice: tokenInfo.highestPrice || tokenInfo.currentPrice
      };

      // Check if this is a rug pull using standard detection
      const rugStatus = analytics.dailyMetrics.checkForRugPull(enrichedInfo);

      // If it's a confirmed rug pull, mark it and skip further processing
      if (rugStatus && rugStatus.isRug) {
        console.log(`🚨 STANDARD RUG PULL DETECTED for ${tokenInfo.symbol || mint}: ${rugStatus.rugType} (Market Cap: $${rugStatus.marketCapUSD.toFixed(2)})`);

        // Mark token as a rug to avoid further alerts
        tokenInfo.isRugPull = true;
        tokenInfo.rugPullType = rugStatus.rugType;
        tokenInfo.rugPullTime = Date.now();
        tokenRegistry.set(mint, tokenInfo);

        return; // Skip further processing for this token
      }
    }

    // Avoid duplicate alerts
    const alertKey = `volume_${mint}`;
    const lastAlert = tokenInfo.lastAlerts ? tokenInfo.lastAlerts[alertKey] : 0;
    const now = Date.now();

    // Only alert once per 15 minutes for the same type of event (increased from 10 min)
    if (!lastAlert || now - lastAlert > 900000) {
      // First, ensure the token has updated sentiment metrics
      updateTokenMetrics(mint);

      // Get the freshly updated sentiment score
      const updatedSentimentScore = tokenInfo.sentimentScore || 0;

      // Check if token is at least 3 minutes old
      const tokenAgeMinutes = tokenAge / (60 * 1000);
      if (tokenAgeMinutes < 3) {
        return;
      }


      // We no longer check for price movement since last alert
      // as we only want one alert per token
      const significantPriceMovement = true;

      // Initialize analysis points array for generating alert analysis
      let analysisPoints = [];

      if (tokenInfo.isUptrend && tokenInfo.trendStrength >= 5) {
        analysisPoints.push(`Strong uptrend with ${tokenInfo.trendStrength} consecutive higher highs/lows`);
      } else if (tokenInfo.isUptrend) {
        analysisPoints.push(`Developing uptrend detected with ${tokenInfo.trendStrength} higher highs/lows`);
      } else if (priceChangePercent >= PRICE_INCREASE_THRESHOLD * 1.5) {
        // If no uptrend but strong price action, add positive analysis point
        analysisPoints.push(`Significant price increase of ${priceChangePercent.toFixed(0)}% detected`);
      }

      if (tokenInfo.healthyVolume && tokenInfo.volumeHealth > 2) {
        analysisPoints.push('Increasing volume supporting price action');
      } else if (tokenInfo.healthyVolume) {
        analysisPoints.push('Stable volume pattern with good buy pressure');
      } else if (volume >= VOLUME_THRESHOLD * 1.5) {
        // If no healthy volume pattern but high absolute volume, add positive point
        analysisPoints.push(`Strong trading volume of ${volume.toFixed(2)} SOL`);
      }

      if (tokenInfo.buyRatioTrend > 2) {
        analysisPoints.push('Growing buy ratio showing accumulation');
      } else if (buySellRatio >= BUY_SELL_RATIO_THRESHOLD * 1.3) {
        // If no growing trend but strong absolute buy ratio, add positive point
        analysisPoints.push(`Strong buy pressure with ${buySellRatio.toFixed(2)}x buy/sell ratio`);
      }

      // Better criteria for improved win rate without being too restrictive
      if (
        // Base requirements
        volume >= VOLUME_THRESHOLD &&
        updatedSentimentScore >= 80 && // Lower sentiment requirement (was 90)
        significantPriceMovement &&

        // Must meet EITHER the buy/sell ratio OR price increase threshold
        (
          buySellRatio >= BUY_SELL_RATIO_THRESHOLD ||
          priceChangePercent >= PRICE_INCREASE_THRESHOLD
        ) &&

        // At least ONE of these high-value signals must be present
        (
          whaleTracker.get(mint) >= 1 || // Whale interest
          smartMoneyActivity.has(mint) || // Smart money interest
          holderCount >= HOLDER_GROWTH_THRESHOLD || // Strong community
          volumeVelocity >= VOLUME_VELOCITY_THRESHOLD || // Consistent trading
          // New condition: allow tokens with very strong price growth even without other signals
          priceChangePercent >= PRICE_INCREASE_THRESHOLD * 2
        )
      ) { // Balanced criteria for higher win probability
        console.log(`✅ Alert criteria met for ${tokenInfo.symbol || mint}!`);

        // Initialize lastAlerts if needed
        if (!tokenInfo.lastAlerts) {
          tokenInfo.lastAlerts = {};
        }

        // Update last alert time and price
        tokenInfo.lastAlerts[alertKey] = now;
        tokenInfo.lastAlertPrice = currentPrice;
        tokenRegistry.set(mint, tokenInfo);

        // Send alert
        sendTokenAlert(mint, volume, updatedSentimentScore);
      } else {
        // Log that we skipped alerting for this token for other reasons
        console.log(`- Skipping alert for ${tokenInfo.symbol || mint} - criteria not met`);
      }
    }
  } catch (error) {
    console.error('Error checking significant events:', error);
  }
}

// Initial token analysis
async function analyzeNewToken(mint) {
  try {
    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo) return;

    // Get time since creation
    const timeSinceCreation = Date.now() - tokenInfo.createdAt;
    const minutesSinceCreation = timeSinceCreation / 60000;

    // Only do full analysis if it's been at least 3 minutes
    if (minutesSinceCreation < 3) {
      return;
    }

    // Check minimum marketcap threshold
    const marketCapSol = tokenInfo.marketCapSol || 0;
    if (marketCapSol < MIN_MARKETCAP_THRESHOLD) {
      return;
    }

    // Update token metrics
    updateTokenMetrics(mint);

    // Get updated metrics
    const volume = volumeTracker.get(mint) || 0;
    const buyVolume = buyVolumeTracker.get(mint) || 0;
    const sellVolume = sellVolumeTracker.get(mint) || 0;
    const holderCount = tokenInfo.holderCount || 0;
    const buySellRatio = tokenInfo.buySellRatio || 0;
    const priceChangePercent = tokenInfo.priceChangePercent || 0;
    const initialPumpData = initialPumpTracker.get(mint) || { percentageIncrease: 0 };

    // Look for promising tokens
    if (minutesSinceCreation >= 5) {
      // Calculate enhanced sentiment score using continuous factors rather than binary thresholds
      const volumeFactor = Math.min(volume / (VOLUME_THRESHOLD * 0.5), 2.5);
      const buySellFactor = Math.min(buySellRatio / BUY_SELL_RATIO_THRESHOLD, 2);
      const holderFactor = Math.min(holderCount / HOLDER_GROWTH_THRESHOLD, 1.5);
      const priceChangeFactor = Math.min(Math.max(priceChangePercent / (PRICE_INCREASE_THRESHOLD * 0.8), 0), 3);
      const pumpFactor = Math.min(initialPumpData.percentageIncrease / INITIAL_PUMP_THRESHOLD, 3);

      // Age bonus for fresh tokens (inverse scaling with age)
      const ageBonus = Math.max(1, 3 - (minutesSinceCreation / 60));

      // Calculate comprehensive weighted score with adjusted weights for higher win rate
      const totalScore = (
        volumeFactor * 3.5 +       // Increased from 2.5
        buySellFactor * 4.0 +      // Increased from 2.2 - stronger buy pressure predicts success
        holderFactor * 3.0 +       // Increased from 1.8 - community strength is important
        priceChangeFactor * 2.5 +  // Decreased from 4.0 - price alone is less predictive
        pumpFactor * 2.0           // Decreased from 3.0 - initial pumps can be misleading
      ) * ageBonus * 4.5;          // Slightly reduced scale factor (was 5)

      // Apply normalization and constraint
      const normalizedScore = Math.min(Math.round(totalScore), 100);

      // Set the token's sentiment score and category for future reference
      tokenInfo.sentimentScore = normalizedScore;

      // Add sentiment category with more balanced thresholds
      if (normalizedScore >= 95) tokenInfo.sentimentCategory = "Extremely Bullish";
      else if (normalizedScore >= 85) tokenInfo.sentimentCategory = "Very Bullish";
      else if (normalizedScore >= 75) tokenInfo.sentimentCategory = "Bullish";
      else if (normalizedScore >= 65) tokenInfo.sentimentCategory = "Neutral";
      else tokenInfo.sentimentCategory = "Not Promising";

      // Only alert on very bullish or extremely bullish tokens
      const isVeryBullish = normalizedScore >= 85; // Only very bullish or extremely bullish tokens

      // Send alert ONLY for very bullish or extremely bullish new tokens
      if (isVeryBullish && !tokenInfo.initialAnalysisSent) {
        // Check if token already has an alert using the centralized system
        if (alertsModule.hasAlertedToken(mint)) {
          console.log(`Skipping duplicate initial analysis alert for ${mint} - token already alerted`);
          return;
        }

        // Record initial market cap and analysis time for future reference
        tokenInfo.initialAnalysisSent = true;
        tokenInfo.initialAnalysisTime = Date.now();
        tokenInfo.initialMarketCapSol = tokenInfo.marketCapSol || 0;
        tokenRegistry.set(mint, tokenInfo);

        // Set up continuous monitoring for this promising token
        if (!tokenInfo.continuousMonitoring) {
          tokenInfo.continuousMonitoring = true;
          tokenRegistry.set(mint, tokenInfo);

          // Schedule continuous checks every 5 minutes for 1 hour
          for (let i = 1; i <= 12; i++) {
            setTimeout(() => checkPromsingTokenProgress(mint), i * 300000); // 5-minute intervals
          }
        }

        // Check DEXScreener paid status
        try {
          const dexStatus = await checkDexScreenerStatus(mint);
          tokenInfo.dexScreenerPaid = dexStatus.hasPaid;
          tokenInfo.dexScreenerOrderTypes = dexStatus.types;
          tokenRegistry.set(mint, tokenInfo);

          console.log(`DEXScreener paid status for ${tokenInfo.symbol || mint} (token analysis): ${dexStatus.hasPaid ? 'PAID' : 'NOT PAID'}`);
        } catch (error) {
          console.error('Error checking DEXScreener status:', error);
          return; // Skip alert if we can't check DEXScreener status
        }

        // Calculate buy vs sell percentage
        const totalVolume = buyVolume + sellVolume;
        const buyPercentage = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 0;
        const sellPercentage = totalVolume > 0 ? (sellVolume / totalVolume) * 100 : 0;

        // Get bundle info section if available
        const bundleInfoSection = await getBundleInfoSection(mint);

        // Create alert data for the alerts module
        // Calculate additional values needed for the alert
        const whaleCount = whaleTracker.get(mint) || 0;
        const smartMoneyInterest = smartMoneyActivity.has(mint);
        const volumeVelocity = tokenInfo.volumeVelocity || 0;

        // Format age string
        let ageString = "";
        if (minutesSinceCreation < 60) {
          ageString = `${Math.floor(minutesSinceCreation)}m`;
        } else if (minutesSinceCreation < 1440) {
          ageString = `${Math.floor(minutesSinceCreation / 60)}h ${Math.floor(minutesSinceCreation % 60)}m`;
        } else {
          ageString = `${Math.floor(minutesSinceCreation / 1440)}d ${Math.floor((minutesSinceCreation % 1440) / 60)}h`;
        }

        // Generate analysis text based on metrics
        const analysisPoints = [];
        if (volume >= VOLUME_THRESHOLD * 1.5) analysisPoints.push(`Strong volume of ${volume.toFixed(1)} SOL`);
        if (buySellRatio >= BUY_SELL_RATIO_THRESHOLD * 1.2) analysisPoints.push(`High buy pressure (${buySellRatio.toFixed(1)}x)`);
        if (priceChangePercent >= PRICE_INCREASE_THRESHOLD * 1.2) analysisPoints.push(`Significant price increase (${priceChangePercent.toFixed(0)}%)`);
        if (holderCount >= HOLDER_GROWTH_THRESHOLD * 1.2) analysisPoints.push(`Growing community (${holderCount} holders)`);
        if (whaleCount > 0) analysisPoints.push(`${whaleCount} whale buys detected`);
        if (smartMoneyInterest) analysisPoints.push("Smart money interest");

        const analysisText = analysisPoints.length > 0
          ? analysisPoints.join(" • ")
          : "Promising token with good metrics";

        // Create the alert data object
        const alertData = {
          mint,
          tokenInfo,
          marketCapSol,
          solPriceUsd: global.solPriceUsd,
          sentimentScore: normalizedScore,
          minutesSinceCreation,
          volume,
          priceChangePercent,
          buySellRatio,
          buyPercentage,
          sellPercentage,
          holderCount,
          whaleCount,
          smartMoneyInterest,
          volumeVelocity,
          ageString,
          totalScore: normalizedScore,
          bundleAnalysisResult: bundleInfoSection ? { bundleInfoSection } : null,
          PRICE_INCREASE_THRESHOLD,
          BUY_SELL_RATIO_THRESHOLD,
          HOLDER_GROWTH_THRESHOLD,
          analysisText,
          // Add this line to include the natural analysis
          naturalAnalysis: tokenInfo.naturalAnalysis
        };

        // Use the alerts module to send the alert
        try {
          const alertSent = alertsModule.createBullishTokenAlert(alertData);
          if (alertSent) {
            console.log(`Bullish token alert sent for ${tokenInfo.symbol || mint} via alerts module`);
          } else {
            console.log(`Failed to send bullish token alert for ${tokenInfo.symbol || mint}`);
          }
        } catch (error) {
          console.error(`Error sending bullish token alert via module for ${tokenInfo.symbol || mint}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('Error analyzing new token:', error);
  }
}

// Helper function to fetch and format bundle analysis for a token
async function getBundleInfoSection(mint) {
  try {
    // Return empty string immediately if bundleAnalyzer not initialized
    if (!bundleAnalyzer) {
      return '';
    }

    console.log(`Attempting to fetch bundle analysis for: ${mint}`);

    // Create a non-blocking promise that times out quickly
    let bundleInfo = '';

    try {
      // Wrap API call in a very short timeout to prevent blocking alerts
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve(null), 2500); // 2.5 second max timeout
      });

      // Race between the API call and the timeout
      const bundleAnalysisResult = await Promise.race([
        bundleAnalyzer.fetchBundleAnalysis(mint),
        timeoutPromise
      ]);

      if (bundleAnalysisResult) {
        // Extract and format bundle and creator data
        const bundleData = bundleAnalyzer.extractBundleAnalytics(bundleAnalysisResult);
        const creatorData = bundleAnalyzer.extractCreatorAnalytics(bundleAnalysisResult.creator_analysis);

        // Format bundle info for alert
        bundleInfo = bundleAnalyzer.formatBundleInfoForAlert(bundleData, creatorData);
        console.log(`Successfully added bundle analysis for ${mint}`);
      } else {
        console.log(`Bundle analysis timed out or unavailable for ${mint}`);
      }
    } catch (err) {
      // Just log and continue - never block the alert
      console.log(`Non-critical error in bundle analysis: ${err.message}`);
    }

    return bundleInfo;
  } catch (error) {
    // Ultimate safety - if anything at all goes wrong, don't block alerts
    console.error(`Error in getBundleInfoSection for ${mint}:`, error.message);
    return '';
  }
}

// Fetch extended token details from pump.fun API
async function fetchExtendedTokenInfo(mint) {
  try {
    console.log(`Fetching extended info for token: ${mint}`);

    // Construct the API URL with the mint address - first try exact match
    const apiUrl = `https://frontend-api-v3.pump.fun/coins/search_ranked?offset=0&limit=50&sort=market_cap&includeNsfw=false&order=DESC&searchTerm=${mint}&type=hybrid`;

    // Make the API request
    const response = await axios.get(apiUrl, {
      headers: {
        'User-Agent': 'PumpPortalTrader/1.0.0',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    // Check if we got data
    if (response.data && Array.isArray(response.data) && response.data.length > 0) {
      // Try to find exact match by mint address
      let tokenData = response.data.find(token => token.mint === mint);

      // If no exact match found, use the first result
      if (!tokenData && response.data.length > 0) {
        tokenData = response.data[0];
      }

      if (tokenData) {
        console.log(`Found token data: ${JSON.stringify(tokenData, null, 2).substring(0, 500)}...`);

        // Process social media links - add checking for valid urls
        let twitter = null;
        if (tokenData.twitter &&
            tokenData.twitter !== 'nan' &&
            tokenData.twitter !== 'undefined' &&
            tokenData.twitter !== '') {
          // Make sure Twitter URL is properly formatted
          if (!tokenData.twitter.startsWith('http')) {
            if (tokenData.twitter.includes('twitter.com') || tokenData.twitter.includes('x.com')) {
              twitter = `https://${tokenData.twitter.replace(/^\/\//, '')}`;
            } else {
              twitter = `https://twitter.com/${tokenData.twitter.replace('@', '')}`;
            }
          } else {
            twitter = tokenData.twitter;
          }
        }

        let telegram = null;
        if (tokenData.telegram &&
            tokenData.telegram !== 'nan' &&
            tokenData.telegram !== 'undefined' &&
            tokenData.telegram !== '') {
          // Make sure Telegram URL is properly formatted
          if (!tokenData.telegram.startsWith('http')) {
            if (tokenData.telegram.includes('t.me')) {
              telegram = `https://${tokenData.telegram.replace(/^\/\//, '')}`;
            } else {
              telegram = `https://t.me/${tokenData.telegram.replace('@', '')}`;
            }
          } else {
            telegram = tokenData.telegram;
          }
        }

        let website = null;
        if (tokenData.website &&
            tokenData.website !== 'nan' &&
            tokenData.website !== 'undefined' &&
            tokenData.website !== '') {
          // Make sure website URL is properly formatted
          if (!tokenData.website.startsWith('http')) {
            website = `https://${tokenData.website.replace(/^\/\//, '')}`;
          } else {
            website = tokenData.website;
          }
        }

        // Extract the relevant information
        const enrichedInfo = {
          twitter: twitter,
          telegram: telegram,
          website: website,
          kingOfTheHillTimestamp: tokenData.king_of_the_hill_timestamp,
          isKingOfTheHill: !!tokenData.king_of_the_hill_timestamp,
          replyCount: tokenData.reply_count || 0,
          athMarketCap: tokenData.ath_market_cap || 0,
          athMarketCapTimestamp: tokenData.ath_market_cap_timestamp,
          usdMarketCap: tokenData.usd_market_cap || 0,
          realSolReserves: tokenData.real_sol_reserves || 0,
          realTokenReserves: tokenData.real_token_reserves || 0,
          pumpSwapPool: tokenData.pump_swap_pool
        };

        console.log(`Successfully processed extended info for ${mint}`);
        console.log(`Social links - Twitter: ${twitter}, Telegram: ${telegram}, Website: ${website}`);
        return enrichedInfo;
      }
    }

    console.log(`No extended info found for ${mint}`);
    return null;
  } catch (error) {
    console.error(`Error fetching extended token info for ${mint}:`, error);
    return null;
  }
}

// Add these functions to your code base

// Analyze whether volume distribution looks natural
function analyzeVolumeDistribution(mint) {
  const trades = tradeHistory.get(mint) || [];
  if (trades.length < 30) return { isNatural: true, reason: "insufficient_data", confidence: 0 };

  // Group trades into time buckets
  const timeToVolume = {}; // time bucket -> volume

  // Populate time buckets (e.g., 1-minute intervals)
  const bucketSize = 60 * 1000; // 1 minute in ms
  trades.forEach(trade => {
    const bucket = Math.floor(trade.timestamp / bucketSize);
    timeToVolume[bucket] = (timeToVolume[bucket] || 0) + trade.solAmount;
  });

  // Analyze volume distribution
  const volumes = Object.values(timeToVolume);

  // Calculate statistics
  const avgVolume = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
  const stdDev = Math.sqrt(volumes.reduce((sq, v) => sq + Math.pow(v - avgVolume, 2), 0) / volumes.length);

  // Calculate coefficient of variation (CV)
  const cv = stdDev / avgVolume;

  // Natural trading has higher variation (typically CV > 0.5)
  // Manipulated trading often has suspiciously consistent volumes
  const isNatural = cv > 0.5;
  const confidence = Math.min(Math.abs(cv - 0.5) / 0.5, 1) * 100;

  return {
    isNatural,
    cv,
    confidence,
    reason: isNatural ? "natural_volume_distribution" : "suspicious_volume_consistency"
  };
}

// Analyze whether trader distribution looks natural
function analyzeTraderDiversity(mint) {
  const trades = tradeHistory.get(mint) || [];
  if (trades.length < 20) return { isNatural: true, reason: "insufficient_data", confidence: 0 };

  // Count trades per wallet
  const walletTrades = {};
  trades.forEach(trade => {
    walletTrades[trade.trader] = (walletTrades[trade.trader] || 0) + 1;
  });

  // Number of unique traders
  const uniqueTraders = Object.keys(walletTrades).length;

  // Calculate concentration ratio - what percentage of trades are from top 3 wallets
  const sortedWallets = Object.entries(walletTrades).sort((a, b) => b[1] - a[1]);
  const top3Trades = sortedWallets.slice(0, 3).reduce((sum, [_, count]) => sum + count, 0);
  const concentration = top3Trades / trades.length;

  // Check for circular trading patterns where same wallets trade back and forth
  let circularTrading = false;
  if (trades.length >= 20) {
    // Look for patterns where same wallets trade back and forth
    const traderSequence = trades.slice(-20).map(t => t.trader);
    const uniqueInSequence = new Set(traderSequence).size;

    // If fewer than 5 unique traders in last 20 trades, that's suspicious
    circularTrading = uniqueInSequence < 5;
  }

  // Natural trading should have many different wallets and low concentration
  const isNatural = (uniqueTraders >= 10 && concentration < 0.6 && !circularTrading);

  // Calculate confidence based on how far from thresholds
  const traderConfidence = Math.min(uniqueTraders / 10, 1) * 100;
  const concentrationConfidence = Math.min(Math.abs(concentration - 0.6) / 0.6, 1) * 100;
  const confidence = (traderConfidence + concentrationConfidence) / 2;

  return {
    isNatural,
    uniqueTraders,
    concentration,
    circularTrading,
    confidence,
    reason: isNatural ? "diverse_trader_activity" :
            (circularTrading ? "circular_trading_pattern" : "high_trader_concentration")
  };
}

// Analyze whether timing patterns look natural
function analyzeTimingPatterns(mint) {
  const trades = tradeHistory.get(mint) || [];
  if (trades.length < 30) return { isNatural: true, reason: "insufficient_data", confidence: 0 };

  // Calculate time between trades
  const intervals = [];
  for (let i = 1; i < trades.length; i++) {
    intervals.push(trades[i].timestamp - trades[i-1].timestamp);
  }

  // Calculate standard deviation of intervals
  const avgInterval = intervals.reduce((sum, i) => sum + i, 0) / intervals.length;
  const stdDev = Math.sqrt(intervals.reduce((sq, i) => sq + Math.pow(i - avgInterval, 2), 0) / intervals.length);

  // Calculate coefficient of variation
  const cv = stdDev / avgInterval;

  // Check for too-regular patterns
  // Natural trading has varied time intervals
  // Bot trading or manipulation often has suspiciously regular intervals
  const isTooRegular = cv < 0.7;

  // Check for unnaturally fast trades
  const tooManyFastTrades = intervals.filter(i => i < 2000).length > intervals.length * 0.3;

  const confidence = Math.min(Math.abs(cv - 0.7) / 0.7, 1) * 100;

  return {
    isNatural: !isTooRegular && !tooManyFastTrades,
    regularityCV: cv,
    tooManyFastTrades,
    confidence,
    reason: isTooRegular ? "suspiciously_regular_trading" :
            (tooManyFastTrades ? "unnaturally_frequent_trades" : "natural_timing_pattern")
  };
}

// Analyze whether price patterns look natural
function analyzePricePatterns(mint) {
  const prices = priceTracker.get(mint) || [];
  if (prices.length < 30) return { isNatural: true, reason: "insufficient_data", confidence: 0 };

  // Extract just the price values and timestamps
  const priceValues = prices.map(p => p.price);

  // Check for stair-step pattern (classic pump and dump)
  let stairStepPattern = false;
  let consecutiveIncreases = 0;

  for (let i = 1; i < priceValues.length; i++) {
    // If price increased by almost exactly the same amount multiple times
    const increase1 = priceValues[i] / priceValues[i-1];

    if (i < priceValues.length - 1) {
      const increase2 = priceValues[i+1] / priceValues[i];

      // Check if increases are suspiciously similar (within 5%)
      if (Math.abs(increase1 - increase2) / increase1 < 0.05 && increase1 > 1.02) {
        consecutiveIncreases++;
      } else {
        consecutiveIncreases = 0;
      }

      if (consecutiveIncreases >= 3) {
        stairStepPattern = true;
        break;
      }
    }
  }

  // Check for unnaturally smooth uptrend (likely bot manipulation)
  let suspiciouslySmooth = false;
  let directionChanges = 0;

  for (let i = 2; i < priceValues.length; i++) {
    const prevChange = priceValues[i-1] - priceValues[i-2];
    const currChange = priceValues[i] - priceValues[i-1];

    // Count direction changes (price going from up to down or vice versa)
    if ((prevChange > 0 && currChange < 0) || (prevChange < 0 && currChange > 0)) {
      directionChanges++;
    }
  }

  // Natural price action has regular direction changes
  // Too few changes suggest manipulation
  const expectedChanges = prices.length * 0.15; // Expect roughly 15% direction changes
  suspiciouslySmooth = directionChanges < expectedChanges;

  const confidence = stairStepPattern ? 90 :
                     (suspiciouslySmooth ? 80 :
                     (directionChanges > expectedChanges * 1.5 ? 90 : 70));

  return {
    isNatural: !stairStepPattern && !suspiciouslySmooth,
    stairStepPattern,
    suspiciouslySmooth,
    directionChanges,
    expectedChanges,
    confidence,
    reason: stairStepPattern ? "suspicious_stair_step_pattern" :
            (suspiciouslySmooth ? "suspiciously_smooth_price_movement" : "natural_price_pattern")
  };
}

// Combined analysis of natural vs. manipulated trading
function analyzeTokenNaturalness(mint) {
  // Run all analyses
  const volumeAnalysis = analyzeVolumeDistribution(mint);
  const traderAnalysis = analyzeTraderDiversity(mint);
  const timingAnalysis = analyzeTimingPatterns(mint);
  const priceAnalysis = analyzePricePatterns(mint);

  // For debugging, log all results
  console.log(`[NATURAL CHECK] ${mint} results:`);
  console.log(`- Volume: ${volumeAnalysis.isNatural ? 'NATURAL' : 'SUSPICIOUS'} (${volumeAnalysis.reason}, ${volumeAnalysis.confidence.toFixed(1)}% confidence)`);
  console.log(`- Traders: ${traderAnalysis.isNatural ? 'NATURAL' : 'SUSPICIOUS'} (${traderAnalysis.reason}, ${traderAnalysis.confidence.toFixed(1)}% confidence)`);
  console.log(`- Timing: ${timingAnalysis.isNatural ? 'NATURAL' : 'SUSPICIOUS'} (${timingAnalysis.reason}, ${timingAnalysis.confidence.toFixed(1)}% confidence)`);
  console.log(`- Price: ${priceAnalysis.isNatural ? 'NATURAL' : 'SUSPICIOUS'} (${priceAnalysis.reason}, ${priceAnalysis.confidence.toFixed(1)}% confidence)`);

  // Combine results (require passing at least 3 of 4 checks)
  const passCount = [
    volumeAnalysis.isNatural,
    traderAnalysis.isNatural,
    timingAnalysis.isNatural,
    priceAnalysis.isNatural
  ].filter(result => result).length;

  const isNatural = passCount >= 3;

  // Calculate overall confidence
  const avgConfidence = (
    volumeAnalysis.confidence +
    traderAnalysis.confidence +
    timingAnalysis.confidence +
    priceAnalysis.confidence
  ) / 4;

  // Get reasons for manipulation if not natural
  const manipulationReasons = [];
  if (!volumeAnalysis.isNatural) manipulationReasons.push(volumeAnalysis.reason);
  if (!traderAnalysis.isNatural) manipulationReasons.push(traderAnalysis.reason);
  if (!timingAnalysis.isNatural) manipulationReasons.push(timingAnalysis.reason);
  if (!priceAnalysis.isNatural) manipulationReasons.push(priceAnalysis.reason);

  const naturalScore = passCount * 25; // 0-100 score

  return {
    isNatural,
    naturalScore,
    passCount,
    avgConfidence,
    manipulationReasons: isNatural ? [] : manipulationReasons,
    details: {
      volume: volumeAnalysis,
      traders: traderAnalysis,
      timing: timingAnalysis,
      price: priceAnalysis
    }
  };
}

bot.onText(/\/natural (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbolOrMint = match[1];

  // Try to find the token by symbol or mint address
  let targetMint = null;
  let tokenInfo = null;

  // First try exact mint match
  if (tokenRegistry.has(symbolOrMint)) {
    targetMint = symbolOrMint;
    tokenInfo = tokenRegistry.get(symbolOrMint);
  } else {
    // Try to find by symbol (case insensitive)
    const upperSymbol = symbolOrMint.toUpperCase();
    for (const [mint, info] of tokenRegistry.entries()) {
      if (info.symbol && info.symbol.toUpperCase() === upperSymbol) {
        targetMint = mint;
        tokenInfo = info;
        break;
      }
    }
  }

  if (!targetMint || !tokenInfo) {
    bot.sendMessage(chatId, `❌ Token not found: ${symbolOrMint}`);
    return;
  }

  // Run natural analysis
  const analysis = analyzeTokenNaturalness(targetMint);

  // Format detailed report
  let reportMsg = `🔍 *Natural Trading Analysis: ${tokenInfo.symbol}*\n\n`;

  // Overall status
  reportMsg += `📊 *Summary:*\n`;
  reportMsg += `• Natural score: *${analysis.naturalScore}/100*\n`;
  reportMsg += `• Status: ${analysis.isNatural ? '✅ Natural' : '⚠️ Potentially manipulated'}\n`;
  reportMsg += `• Passed ${analysis.passCount}/4 checks\n`;

  if (!analysis.isNatural) {
    reportMsg += `• Issues: ${analysis.manipulationReasons.join(', ')}\n`;
  }

  // Detailed metrics
  reportMsg += `\n📈 *Detailed Analysis:*\n`;

  // Volume check - Handle potentially missing properties
  const volCheck = analysis.details.volume;
  reportMsg += `• Volume pattern: ${volCheck.isNatural ? '✅ Natural' : '❌ Suspicious'}\n`;

  if (volCheck.reason === "insufficient_data") {
    reportMsg += `  Not enough trade data for volume analysis\n`;
  } else {
    reportMsg += `  ${volCheck.isNatural ? 'Healthy volume variation' : 'Suspiciously consistent volume'}\n`;
    // Only include these properties if they exist
    if (volCheck.cv !== undefined) {
      reportMsg += `  Coefficient of variation: ${volCheck.cv.toFixed(2)} (>${volCheck.isNatural ? '' : '<'}0.5 is natural)\n`;
    }
  }

  // Trader check
  const traderCheck = analysis.details.traders;
  reportMsg += `• Trader activity: ${traderCheck.isNatural ? '✅ Natural' : '❌ Suspicious'}\n`;

  if (traderCheck.reason === "insufficient_data") {
    reportMsg += `  Not enough trade data for trader analysis\n`;
  } else {
    if (traderCheck.uniqueTraders !== undefined) {
      reportMsg += `  Unique traders: ${traderCheck.uniqueTraders} (${traderCheck.uniqueTraders >= 10 ? '✅' : '❌'} ≥10 is natural)\n`;
    }
    if (traderCheck.concentration !== undefined) {
      reportMsg += `  Top 3 wallet concentration: ${(traderCheck.concentration * 100).toFixed(1)}% (${traderCheck.concentration < 0.6 ? '✅' : '❌'} <60% is natural)\n`;
    }
    if (traderCheck.circularTrading !== undefined) {
      reportMsg += `  Circular trading: ${traderCheck.circularTrading ? '❌ Detected' : '✅ Not detected'}\n`;
    }
  }

  // Timing check
  const timingCheck = analysis.details.timing;
  reportMsg += `• Trade timing: ${timingCheck.isNatural ? '✅ Natural' : '❌ Suspicious'}\n`;

  if (timingCheck.reason === "insufficient_data") {
    reportMsg += `  Not enough trade data for timing analysis\n`;
  } else {
    if (timingCheck.regularityCV !== undefined) {
      reportMsg += `  Timing regularity: ${timingCheck.regularityCV.toFixed(2)} (${timingCheck.regularityCV >= 0.7 ? '✅' : '❌'} ≥0.7 is natural)\n`;
    }
    if (timingCheck.tooManyFastTrades !== undefined) {
      reportMsg += `  Unnaturally frequent trades: ${timingCheck.tooManyFastTrades ? '❌ Yes' : '✅ No'}\n`;
    }
  }

  // Price check
  const priceCheck = analysis.details.price;
  reportMsg += `• Price pattern: ${priceCheck.isNatural ? '✅ Natural' : '❌ Suspicious'}\n`;

  if (priceCheck.reason === "insufficient_data") {
    reportMsg += `  Not enough price data for pattern analysis\n`;
  } else {
    if (priceCheck.stairStepPattern !== undefined) {
      reportMsg += `  Stair-step pattern: ${priceCheck.stairStepPattern ? '❌ Detected' : '✅ Not detected'}\n`;
    }
    if (priceCheck.suspiciouslySmooth !== undefined) {
      reportMsg += `  Suspiciously smooth trend: ${priceCheck.suspiciouslySmooth ? '❌ Yes' : '✅ No'}\n`;
    }
    if (priceCheck.directionChanges !== undefined && priceCheck.expectedChanges !== undefined) {
      reportMsg += `  Direction changes: ${priceCheck.directionChanges} (${priceCheck.directionChanges >= priceCheck.expectedChanges ? '✅' : '❌'} expected ${Math.round(priceCheck.expectedChanges)}+)\n`;
    }
  }

  // Token links
  reportMsg += `\n🔗 *View token:*\n`;
  reportMsg += `• [PumpFun](https://pump.fun/coin/${targetMint})\n`;
  reportMsg += `• [Solscan](https://solscan.io/token/${targetMint})\n`;

  bot.sendMessage(chatId, reportMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/suspicious/, async (msg) => {
  const chatId = msg.chat.id;

  // Analyze all tokens in the registry with at least 30 trades
  const suspiciousTokens = [];

  for (const [mint, info] of tokenRegistry.entries()) {
    const trades = tradeHistory.get(mint) || [];
    if (trades.length >= 30) {
      const analysis = analyzeTokenNaturalness(mint);

      // Store suspicious tokens
      if (!analysis.isNatural) {
        suspiciousTokens.push({
          mint,
          symbol: info.symbol || 'Unknown',
          score: analysis.naturalScore,
          reasons: analysis.manipulationReasons,
          tradeCount: trades.length
        });
      }
    }
  }

  // Sort by natural score (lowest first)
  suspiciousTokens.sort((a, b) => a.score - b.score);

  // Generate report
  if (suspiciousTokens.length === 0) {
    bot.sendMessage(chatId, "✅ No suspicious tokens detected among those with sufficient trading data.");
    return;
  }

  let reportMsg = `⚠️ *Detected ${suspiciousTokens.length} Suspicious Tokens*\n\n`;

  suspiciousTokens.slice(0, 15).forEach((token, index) => {
    reportMsg += `${index + 1}. ${token.symbol} - Score: ${token.score}/100\n`;
    reportMsg += `   Issues: ${token.reasons.join(', ')}\n`;
    reportMsg += `   Trades: ${token.tradeCount}\n`;
    reportMsg += `   [PumpFun](https://pump.fun/coin/${token.mint}) | [View Details](/natural ${token.symbol})\n\n`;
  });

  if (suspiciousTokens.length > 15) {
    reportMsg += `\n... and ${suspiciousTokens.length - 15} more suspicious tokens`;
  }

  reportMsg += `\nUse /natural <symbol> to see detailed analysis`;

  bot.sendMessage(chatId, reportMsg, { parse_mode: 'Markdown' });
});

// Send token alert
async function sendTokenAlert(mint, volume, sentimentScore) {

// Run naturalness analysis but don't block alerts yet



  try {
    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo) return;

    // Check if token already has an alert using the centralized system
    if (alertsModule.hasAlertedToken(mint)) {
      console.log(`Skipping duplicate alert for ${tokenInfo.symbol || mint} - token already has an alert`);
      return;
    }

    // Try to fetch extended information
    let extendedInfo = null;
    try {
      extendedInfo = await fetchExtendedTokenInfo(mint);

      // If we got extended info, update the tokenInfo
      if (extendedInfo) {
        // Merge the extended info into token info
        Object.assign(tokenInfo, extendedInfo);

        // Save the updated info back to the registry
        tokenRegistry.set(mint, tokenInfo);
      }
    } catch (error) {
      console.error('Error fetching extended token info:', error);
    }

    try {
      const naturalAnalysis = analyzeTokenNaturalness(mint);

      // Store analysis results in token info for future reference
      if (naturalAnalysis) {
        tokenInfo.naturalAnalysis = naturalAnalysis;
        tokenRegistry.set(mint, tokenInfo);

        // Log comprehensive results for evaluation
        if (!naturalAnalysis.isNatural) {
          console.log(`⚠️ POTENTIAL MANIPULATION: ${tokenInfo.symbol || mint} (Score: ${naturalAnalysis.naturalScore}/100)`);
          console.log(`- Reasons: ${naturalAnalysis.manipulationReasons.join(', ')}`);
          console.log(`- Still sending alert for evaluation purposes`);
        } else {
          console.log(`✅ NATURAL TRADING: ${tokenInfo.symbol || mint} (Score: ${naturalAnalysis.naturalScore}/100)`);
        }
      }
    } catch (err) {
      console.log(`Error in natural analysis for ${mint}: ${err.message}`);
    }

    // Check if token is at least 3 minutes old
    const ageMs = Date.now() - tokenInfo.createdAt;
    const tokenAgeMinutes = ageMs / (60 * 1000);
    if (tokenAgeMinutes < 3) {
      console.log(`Skipping alert for ${tokenInfo.symbol || mint} - token too new (${tokenAgeMinutes.toFixed(2)} minutes old)`);
      return;
    }

    // Check minimum marketcap threshold
    const marketCapSol = tokenInfo.marketCapSol || 0;
    if (marketCapSol < MIN_MARKETCAP_THRESHOLD) {
      console.log(`Skipping alert for ${tokenInfo.symbol || mint} - marketcap too low (${marketCapSol.toFixed(2)} SOL)`);
      return;
    }

    // Check DEXScreener paid status
    const dexStatus = await checkDexScreenerStatus(mint);
    tokenInfo.dexScreenerPaid = dexStatus.hasPaid;
    tokenInfo.dexScreenerOrderTypes = dexStatus.types;
    tokenRegistry.set(mint, tokenInfo);

    // Track this alert for win/loss statistics
    trackAlert(mint, 'tokenAlert', marketCapSol);

    // Format age
    let ageString = '';
    if (ageMs < 60000) {
      ageString = `${Math.floor(ageMs / 1000)}s`;
    } else if (ageMs < 3600000) {
      ageString = `${Math.floor(ageMs / 60000)}m`;
    } else {
      ageString = `${Math.floor(ageMs / 3600000)}h ${Math.floor((ageMs % 3600000) / 60000)}m`;
    }

    // Get metrics
    const buySellRatio = tokenInfo.buySellRatio || 0;
    const priceChangePercent = tokenInfo.priceChangePercent || 0;
    const volumeVelocity = tokenInfo.volumeVelocity || 0;
    const holderCount = tokenInfo.holderCount || 0;
    const whaleCount = tokenInfo.whaleCount || 0;
    const smartMoneyInterest = tokenInfo.smartMoneyInterest || false;

    // Calculate buy vs sell percentage
    const buyVolume = buyVolumeTracker.get(mint) || 0;
    const sellVolume = sellVolumeTracker.get(mint) || 0;
    const totalVolume = buyVolume + sellVolume;
    const buyPercentage = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 0;
    const sellPercentage = totalVolume > 0 ? (sellVolume / totalVolume) * 100 : 0;

    // Skip rug pulls
    if (tokenInfo.isRugPull) {
      console.log(`Skipping alert for ${tokenInfo.symbol || mint} - marked as rug pull`);
      return;
    }

    // Alert type based on sentiment score
    let alertType = '';
    if (tokenInfo.sentimentCategory === "Extremely Bullish" || sentimentScore >= 95) {
      alertType = 'extremely_bullish';
    } else if (tokenInfo.sentimentCategory === "Very Bullish" || sentimentScore >= 85) {
      alertType = 'very_bullish';
    } else {
      console.log(`Skipping alert for ${tokenInfo.symbol || mint} - sentiment not high enough (${sentimentScore})`);
      return;
    }

    // Generate custom analysis text
    const analysisText = generateAnalysis(tokenInfo);

    // Get bundle info section
    const bundleInfoSection = await getBundleInfoSection(mint);

    // Create alert data
    // Make sure volume is defined (it's passed as a parameter but let's be safe)
    const tokenVolume = volume || volumeTracker.get(mint) || 0;

    // Create alert data
    const alertData = {
      mint,
      tokenInfo,
      marketCapSol,
      solPriceUsd: global.solPriceUsd,
      sentimentScore,
      minutesSinceCreation: tokenAgeMinutes,
      volume: tokenVolume,
      priceChangePercent,
      buySellRatio,
      buyPercentage,
      sellPercentage,
      holderCount,
      whaleCount,
      smartMoneyInterest,
      volumeVelocity,
      ageString,
      totalScore: sentimentScore,
      bundleAnalysisResult: bundleInfoSection ? { bundleInfoSection } : null,
      PRICE_INCREASE_THRESHOLD,
      BUY_SELL_RATIO_THRESHOLD,
      HOLDER_GROWTH_THRESHOLD,
      analysisText,
      // Add this line to include the natural analysis
      naturalAnalysis: tokenInfo.naturalAnalysis
    };

    // Use the alerts module to create and send the alert
    try {
      const alertSent = alertsModule.createBullishTokenAlert(alertData);
      if (alertSent) {
        console.log(`Bullish token alert sent for ${tokenInfo.symbol || mint} via alerts module`);
        // Update last alert time and price for future reference
        if (!tokenInfo.lastAlerts) {
          tokenInfo.lastAlerts = {};
        }
        const alertKey = `volume_${mint}`;
        tokenInfo.lastAlerts[alertKey] = Date.now();
        tokenInfo.lastAlertPrice = tokenInfo.currentPrice;
        tokenRegistry.set(mint, tokenInfo);
      } else {
        console.log(`Failed to send bullish token alert for ${tokenInfo.symbol || mint}`);
      }
    } catch (error) {
      console.error(`Error sending bullish token alert via module for ${tokenInfo.symbol || mint}:`, error);
    }
  } catch (error) {
    console.error('Error sending token alert:', error);
  }
}
// Generate token analysis text
function generateAnalysis(tokenInfo) {
const buySellRatio = tokenInfo.buySellRatio || 0;
const priceChangePercent = tokenInfo.priceChangePercent || 0;
const volumeVelocity = tokenInfo.volumeVelocity || 0;
const holderCount = tokenInfo.holderCount || 0;
const whaleCount = tokenInfo.whaleCount || 0;
const smartMoneyInterest = tokenInfo.smartMoneyInterest || false;
const sentimentScore = tokenInfo.sentimentScore || 0;

let analysisPoints = [];

// Buy pressure analysis
if (buySellRatio >= BUY_SELL_RATIO_THRESHOLD * 2) {
  analysisPoints.push('Very strong buy pressure with minimal selling');
} else if (buySellRatio >= BUY_SELL_RATIO_THRESHOLD) {
  analysisPoints.push('More buyers than sellers - positive momentum');
} else if (buySellRatio < 0.5) {
  analysisPoints.push('High sell pressure - caution advised');
}

// Price movement analysis
if (priceChangePercent >= PRICE_INCREASE_THRESHOLD * 3) {
  analysisPoints.push('Exceptional price growth since launch');
} else if (priceChangePercent >= PRICE_INCREASE_THRESHOLD) {
  analysisPoints.push('Solid upward price movement');
} else if (priceChangePercent <= -PRICE_INCREASE_THRESHOLD) {
  analysisPoints.push('Price declining - monitor closely');
}

// Holder analysis
if (holderCount >= HOLDER_GROWTH_THRESHOLD * 3) {
  analysisPoints.push('Strong community growth with many unique buyers');
} else if (holderCount >= HOLDER_GROWTH_THRESHOLD) {
  analysisPoints.push('Growing holder base');
}

// Whale analysis
if (whaleCount >= 5) {
  analysisPoints.push('Multiple whale buys detected - high interest from big players');
} else if (whaleCount > 0) {
  analysisPoints.push('Whale activity detected');
}

// Smart money analysis
if (smartMoneyInterest) {
  analysisPoints.push('Smart money wallets have taken positions');
}

// Volume velocity
if (volumeVelocity >= VOLUME_VELOCITY_THRESHOLD * 3) {
  analysisPoints.push('Extremely high trading velocity');
} else if (volumeVelocity >= VOLUME_VELOCITY_THRESHOLD) {
  analysisPoints.push('Above average trading activity');
}

// Overall sentiment based on categories with updated thresholds
if (tokenInfo.sentimentCategory === "Extremely Bullish" || sentimentScore >= 98) {
  analysisPoints.push('Exceptional momentum with multiple strong bullish indicators and sustained growth');
  analysisPoints.push('High volume and strong buy pressure with minimal selling');
  analysisPoints.push('Significant accumulation from quality wallets');
  analysisPoints.push('Rare combination of outstanding metrics across all key indicators');
} else if (tokenInfo.sentimentCategory === "Very Bullish" || sentimentScore >= 90) {
  analysisPoints.push('Very strong bullish signals across multiple key metrics');
  analysisPoints.push('Consistent buying pressure and healthy volume');
  analysisPoints.push('Showing signs of sustained upward momentum');
} else if (tokenInfo.sentimentCategory === "Bullish" || sentimentScore >= 80) {
  analysisPoints.push('Solid bullish momentum with positive indicators');
  analysisPoints.push('Good buying pressure and developing holder base');
} else if (tokenInfo.sentimentCategory === "Neutral" || sentimentScore >= 70) {
  analysisPoints.push('Mixed signals with some positive indicators');
  analysisPoints.push('Monitor for clearer directional movement');
} else {
  analysisPoints.push('Insufficient bullish indicators at this time');
}

if (analysisPoints.length === 0) {
  return 'Neutral activity detected. Monitoring for clearer signals.';
}

return '• ' + analysisPoints.join('\n• ');
}

// Continuous monitoring for promising tokens
async function checkPromsingTokenProgress(mint) {
  try {
    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo) return;

    // Skip if token is already marked as a rug
    if (tokenInfo.isRugPull) {
      console.log(`Skipping continuous monitoring for ${tokenInfo.symbol || mint}: Marked as rug pull`);
      return;
    }

    // Update metrics
    updateTokenMetrics(mint);



    // Check if token is still doing well
    const volume = volumeTracker.get(mint) || 0;
    const sentimentScore = tokenInfo.sentimentScore || 0;
    const priceChangePercent = tokenInfo.priceChangePercent || 0;
    const currentPrice = tokenInfo.currentPrice || 0;
    const buySellRatio = tokenInfo.buySellRatio || 0;
    const holderCount = tokenInfo.holderCount || 0;
    const volumeVelocity = tokenInfo.volumeVelocity || 0;

    console.log(`Continuous check for ${tokenInfo.symbol || mint}:`);
    console.log(`- Volume: ${volume.toFixed(2)} SOL`);
    console.log(`- Sentiment: ${sentimentScore} (${tokenInfo.sentimentCategory || 'N/A'})`);
    console.log(`- Price Change: ${priceChangePercent.toFixed(2)}%`);

    // Check for rug pull conditions
    const enrichedInfo = {
      ...tokenInfo,
      mint,
      totalVolume: volume,
      highestPrice: tokenInfo.highestPrice || tokenInfo.currentPrice
    };

    const rugStatus = analytics.dailyMetrics.checkForRugPull(enrichedInfo);

    // If it's a confirmed rug pull, mark it and skip further processing
    if (rugStatus && rugStatus.isRug) {
      console.log(`🚨 RUG PULL DETECTED during continuous monitoring for ${tokenInfo.symbol || mint}: ${rugStatus.rugType}`);

      // Mark token as a rug to avoid further alerts
      tokenInfo.isRugPull = true;
      tokenInfo.rugPullType = rugStatus.rugType;
      tokenInfo.rugPullTime = Date.now();
      tokenRegistry.set(mint, tokenInfo);

      return; // Skip further processing for this token
    }

    // Only send follow-up alert if still looking good and with significant price movement
    let significantPriceMovement = true;
    const lastAlertPrice = tokenInfo.lastAlertPrice || 0;

    // We no longer check for price movement since last alert
    // as we only want one alert per token

    if (!tokenInfo.isUptrend && tokenInfo.lastTrendState === true) {
      console.log(`⚠️ TREND REVERSAL: ${tokenInfo.symbol || mint} uptrend broken`);
      // Update last trend state
      tokenInfo.lastTrendState = false;
      tokenRegistry.set(mint, tokenInfo);
      return;
    }

    // Track trend state for reversal detection
    if (tokenInfo.isUptrend !== tokenInfo.lastTrendState) {
      tokenInfo.lastTrendState = tokenInfo.isUptrend;
      tokenRegistry.set(mint, tokenInfo);
    }

    // Existing code...

    // Only send follow-up alert with better criteria including trend
    if (
      // Basic requirements
      volume >= VOLUME_THRESHOLD * 0.7 &&
      sentimentScore >= 75 &&
      significantPriceMovement &&
      tokenInfo.isUptrend && // Require uptrend
      tokenInfo.healthyVolume && // Require healthy volume    if (
      // Basic requirements
      volume >= VOLUME_THRESHOLD * 0.7 && // Lower volume requirement for follow-ups
      sentimentScore >= 75 && // Lower sentiment requirement (was 90)
      significantPriceMovement &&

      // Must meet EITHER the buy/sell ratio OR significant price change
      (
        buySellRatio >= BUY_SELL_RATIO_THRESHOLD ||
        priceChangePercent >= PRICE_INCREASE_THRESHOLD * 0.8
      ) &&

      // At least ONE of these signals must be present
      (
        whaleTracker.get(mint) >= 1 ||
        smartMoneyActivity.has(mint) ||
        holderCount >= HOLDER_GROWTH_THRESHOLD * 0.8 || // 80% of threshold
        volumeVelocity >= VOLUME_VELOCITY_THRESHOLD // Consistent trading
      )
    ) {
      console.log(`✅ Follow-up alert criteria met for ${tokenInfo.symbol || mint}!`);

      // Mark as a follow-up alert
      tokenInfo.isFollowUpAlert = true;
      tokenInfo.lastAlertPrice = currentPrice;
      tokenRegistry.set(mint, tokenInfo);

      // Send follow-up alert
      sendTokenAlert(mint, volume, sentimentScore);
    } else {
      console.log(`❌ Follow-up alert criteria NOT met for ${tokenInfo.symbol || mint}`);
      if (!significantPriceMovement) {
        console.log(`  - Insufficient price movement since last alert`);
      }
    }
  } catch (error) {
    console.error('Error in continuous monitoring:', error);
  }
}

// Function to analyze price trends by detecting higher highs and higher lows
function analyzeUptrend(mint) {
  try {
    const prices = priceTracker.get(mint) || [];

    // Can work with just 5 price points (reduced from 8)
    if (prices.length < 5) {
      return {
        isUptrend: false,
        reason: "insufficient_data",
        strength: 0
      };
    }

    // Simple smoothing to reduce noise
    const smoothedPrices = [];
    const windowSize = Math.min(3, Math.floor(prices.length / 3));

    for (let i = 0; i < prices.length; i++) {
      let sum = 0;
      let count = 0;

      for (let j = Math.max(0, i - windowSize); j <= Math.min(prices.length - 1, i + windowSize); j++) {
        sum += prices[j].price;
        count++;
      }

      smoothedPrices.push({
        price: sum / count,
        timestamp: prices[i].timestamp,
        isBuy: prices[i].isBuy
      });
    }

    // Identify local extremes with relaxed criteria
    const highs = [];
    const lows = [];

    // Find local extremes
    for (let i = 1; i < smoothedPrices.length - 1; i++) {
      // High: higher than points before and after
      if (smoothedPrices[i].price > smoothedPrices[i-1].price &&
          smoothedPrices[i].price > smoothedPrices[i+1].price) {
        highs.push({
          price: smoothedPrices[i].price,
          timestamp: smoothedPrices[i].timestamp,
          index: i
        });
      }

      // Low: lower than points before and after
      if (smoothedPrices[i].price < smoothedPrices[i-1].price &&
          smoothedPrices[i].price < smoothedPrices[i+1].price) {
        lows.push({
          price: smoothedPrices[i].price,
          timestamp: smoothedPrices[i].timestamp,
          index: i
        });
      }
    }

    // Calculate trend metrics
    let higherHighsCount = 0;
    let higherLowsCount = 0;
    let lowerHighsCount = 0;
    let lowerLowsCount = 0;

    // Count higher highs
    for (let i = 1; i < highs.length; i++) {
      if (highs[i].price > highs[i-1].price) {
        higherHighsCount++;
      } else {
        lowerHighsCount++;
      }
    }

    // Count higher lows
    for (let i = 1; i < lows.length; i++) {
      if (lows[i].price > lows[i-1].price) {
        higherLowsCount++;
      } else {
        lowerLowsCount++;
      }
    }

    // Check overall price trend
    const firstPrice = prices[0].price;
    const lastPrice = prices[prices.length - 1].price;
    const overallPriceChange = ((lastPrice - firstPrice) / firstPrice) * 100;

    // Calculate trend strength using weighted factors
    const highStrength = highs.length > 0 ? higherHighsCount / highs.length : 0;
    const lowStrength = lows.length > 0 ? higherLowsCount / lows.length : 0;

    // Weights for different factors
    const weights = {
      higherHighs: 2.5,
      higherLows: 2.0,
      overallTrend: 1.5
    };

    // Calculate weighted score
    let trendScore = 0;

    // Add score for higher highs
    trendScore += highStrength * weights.higherHighs;

    // Add score for higher lows
    trendScore += lowStrength * weights.higherLows;

    // Add score for overall trend
    const overallTrendFactor = Math.min(Math.max(overallPriceChange / 10, -1), 1);
    trendScore += overallTrendFactor * weights.overallTrend;

    // Calculate trend strength (0-10 scale)
    const trendStrength = Math.min(Math.round((
      higherHighsCount +
      higherLowsCount +
      Math.max(0, Math.floor(overallPriceChange / 5))
    )), 10);

    // Determine if there's an uptrend
    // More lenient criteria - either higher highs OR higher lows, plus positive overall change
    const isUptrend = (
      // Either condition can qualify as an uptrend
      ((higherHighsCount > lowerHighsCount && higherHighsCount >= 1) ||
       (higherLowsCount > lowerLowsCount && higherLowsCount >= 1)) &&
      // Plus overall positive price trend
      overallPriceChange > 0
    );

    // If we have very strong evidence, override the counting criteria
    const strongUptrend = (overallPriceChange > 20 && (highStrength > 0.5 || lowStrength > 0.5));

    return {
      isUptrend: isUptrend || strongUptrend,
      highs,
      lows,
      highsCount: highs.length,
      lowsCount: lows.length,
      higherHighsCount,
      higherLowsCount,
      overallPriceChange,
      trendScore,
      strength: trendStrength,
      strongUptrend
    };
  } catch (error) {
    console.error('Error in analyzeUptrend:', error);
    // Default to no uptrend on error
    return { isUptrend: false, strength: 0, error: error.message };
  }
}

// Function to analyze volume trends
function analyzeVolumeProfile(mint) {
  const trades = tradeHistory.get(mint) || [];
  if (trades.length < 10) return { isHealthy: false };

  // Group trades into time buckets (e.g., 10-minute intervals)
  const bucketSize = 10 * 60 * 1000; // 10 minutes
  const volumeBuckets = {};
  const buyVolumeBuckets = {};
  const sellVolumeBuckets = {};

  trades.forEach(trade => {
    const bucketKey = Math.floor(trade.timestamp / bucketSize);

    // Initialize bucket if needed
    if (!volumeBuckets[bucketKey]) {
      volumeBuckets[bucketKey] = 0;
      buyVolumeBuckets[bucketKey] = 0;
      sellVolumeBuckets[bucketKey] = 0;
    }

    // Add volume
    volumeBuckets[bucketKey] += trade.solAmount;

    // Track buy/sell separately
    if (trade.txType === 'buy') {
      buyVolumeBuckets[bucketKey] += trade.solAmount;
    } else {
      sellVolumeBuckets[bucketKey] += trade.solAmount;
    }
  });

  // Convert to arrays for analysis
  const bucketKeys = Object.keys(volumeBuckets).sort((a, b) => a - b);
  const volumes = bucketKeys.map(key => volumeBuckets[key]);
  const buyVolumes = bucketKeys.map(key => buyVolumeBuckets[key]);
  const sellVolumes = bucketKeys.map(key => sellVolumeBuckets[key]);

  // Calculate moving average of volumes
  const ma = [];
  const maWindow = Math.min(3, Math.floor(volumes.length / 2));

  for (let i = 0; i < volumes.length; i++) {
    if (i < maWindow) {
      ma.push(volumes.slice(0, i + 1).reduce((sum, v) => sum + v, 0) / (i + 1));
    } else {
      ma.push(volumes.slice(i - maWindow, i + 1).reduce((sum, v) => sum + v, 0) / (maWindow + 1));
    }
  }

  // Check if volume trend is increasing
  let volumeTrend = 0;
  for (let i = maWindow; i < ma.length; i++) {
    if (ma[i] > ma[i-1]) volumeTrend++;
    else if (ma[i] < ma[i-1]) volumeTrend--;
  }

  // Calculate buy/sell ratio trend
  const buyRatios = bucketKeys.map((key, i) => {
    const total = buyVolumes[i] + sellVolumes[i];
    return total > 0 ? buyVolumes[i] / total : 0;
  });

  let buyRatioTrend = 0;
  for (let i = 1; i < buyRatios.length; i++) {
    if (buyRatios[i] > buyRatios[i-1]) buyRatioTrend++;
    else if (buyRatios[i] < buyRatios[i-1]) buyRatioTrend--;
  }

  return {
    isHealthy: volumeTrend > 0 && buyRatioTrend >= 0,
    volumeTrend,
    buyRatioTrend,
    buyRatios,
    volumeBuckets: volumes.length
  };
}
// Track alert and analyze outcome
function trackAlert(mint, alertType, initialMarketCap) {
  // Only track alerts for specific alert types (not token creation)
  const validAlertTypes = ['tokenAlert', 'smartMoney', 'migration'];
  const isValidAlertType = validAlertTypes.includes(alertType);

  // Register the alert in our tracking system
  const now = Date.now();
  const initialPriceUsd = initialMarketCap * (global.solPriceUsd || 0);

  // For migration alerts, use the fixed market cap for consistency
  if (alertType === 'migration') {
    initialMarketCap = 410.88; // Fixed value for migrations
    console.log(`Using fixed market cap of 410.88 SOL for migration alert: ${mint}`);
  }

  // Get token info
  const tokenInfo = tokenRegistry.get(mint);
  if (tokenInfo) {
    // Only update tracking for valid alert types
    if (isValidAlertType) {
      // If this token already has milestone tracking from a valid alert type,
      // preserve the original market cap to maintain consistent milestone calculations
      const existingTracking = tokenInfo.milestoneTracking || {};
      const isExistingValidAlert = existingTracking.initialAlertType &&
                                  validAlertTypes.includes(existingTracking.initialAlertType) &&
                                  existingTracking.initialAlertType !== 'newToken';

      // If token already has valid tracking, preserve the original market cap
      let effectiveMarketCap = initialMarketCap;

      if (isExistingValidAlert) {
        console.log(`Token ${mint} already has milestone tracking (${existingTracking.initialAlertType}). Preserving original market cap for consistency.`);
        effectiveMarketCap = existingTracking.initialMarketCap;
      } else {
        // This is the first valid alert for this token
        // Store the market cap at the time of the first alert for milestone calculations
        tokenInfo.lowestAlertMarketCap = initialMarketCap;
        console.log(`Set initial alert market cap for ${mint} to ${initialMarketCap.toFixed(2)} SOL`);
      }

      // Always ensure we have a lowestAlertMarketCap value
      if (!tokenInfo.lowestAlertMarketCap) {
        tokenInfo.lowestAlertMarketCap = effectiveMarketCap;
        console.log(`Initialized lowest alert market cap for ${mint} to ${effectiveMarketCap.toFixed(2)} SOL`);
      }

      // Preserve original milestone tracking if it exists, otherwise create new
      const preservedMilestones = (existingTracking && existingTracking.achievedMilestones) || {};

      // Create or update milestone tracking, preserving important fields
      tokenInfo.milestoneTracking = {
        initialMarketCap: effectiveMarketCap,
        initialPrice: isExistingValidAlert ? existingTracking.initialPrice : (tokenInfo.currentPrice || 0),
        initialAlertTime: isExistingValidAlert ? existingTracking.initialAlertTime : now,
        initialAlertType: isExistingValidAlert ? existingTracking.initialAlertType : alertType,
        achievedMilestones: preservedMilestones
      };

      console.log(`Initialized/updated milestone tracking for ${mint} (${tokenInfo.symbol || 'Unknown'}) - Market Cap: ${effectiveMarketCap.toFixed(2)} SOL, Type: ${tokenInfo.milestoneTracking.initialAlertType}`);

      // Update token registry
      tokenRegistry.set(mint, tokenInfo);
    } else {
      console.log(`Skipping milestone tracking initialization for non-alert type: ${alertType}`);
    }
  }

  // Check if we already have an alert for this token in the tracker
  const existingAlert = alertTracker.get(mint);

  // For consistent milestone tracking, preserve the original market cap and achievements
  if (existingAlert && existingAlert.type === alertType) {
    console.log(`Token ${mint} already has an alert. Preserving original market cap data for consistency.`);

    // Update with new data but preserve crucial tracking fields
    alertTracker.set(mint, {
      ...existingAlert,
      type: alertType,
      // Keep the original timestamp and market cap
      checked: false,
      outcome: 'pending',
      // Preserve achieved milestones to prevent duplicates
      // Only update the symbol if needed
      symbol: tokenInfo?.symbol || existingAlert.symbol || mint.slice(0, 6)
    });
  } else {
    // Create new alert entry
    alertTracker.set(mint, {
      type: alertType,
      timestamp: now,
      initialMarketCap,
      initialPriceUsd,
      initialSolPrice: global.solPriceUsd || 0,
      checked: false,
      outcome: 'pending', // will be 'win', 'loss', or 'pending'
      highestX: 1.0,      // tracking highest multiple reached
      currentX: 1.0,      // current multiple
      reachedMilestones: {}, // record when each X milestone was achieved
      symbol: tokenInfo?.symbol || mint.slice(0, 6) // for reporting
    });
  }

  // Update stats
  alertStats.totalAlerts++;
  if (alertType === 'tokenAlert') alertStats.alertTypes.tokenAlert.total++;
  if (alertType === 'smartMoney') alertStats.alertTypes.smartMoney.total++;
  if (alertType === 'migration') alertStats.alertTypes.migration.total++;

  // Ensure xMilestones is initialized
  if (!alertStats.xMilestones) {
    alertStats.xMilestones = {
      '2x': 0, '3x': 0, '5x': 0, '10x': 0, '20x': 0, '50x': 0, '100x': 0, '500x': 0, '1000x': 0
    };
  }

  // Save alert stats immediately
  saveAlertStats();

  // Process alert for trading system if it exists
  if (global.tradingSystemAPI && typeof global.tradingSystemAPI.hookIntoAlertTracker === 'function') {
    try {
      global.tradingSystemAPI.hookIntoAlertTracker(mint, alertTracker.get(mint));
      console.log(`Alert sent to trading system for potential trade entry: ${mint}`);
    } catch (error) {
      console.error(`Error sending alert to trading system: ${error.message}`);
    }
  }

  // Schedule milestone checks with a much more efficient schedule
  // Instead of 748 checks, we'll do just a few strategic checks
  const checkPoints = [
    1,      // 1 minute
    5,      // 5 minutes
    15,     // 15 minutes
    30,     // 30 minutes
    60,     // 1 hour
    120,    // 2 hours
    240,    // 4 hours
    480,    // 8 hours
    720,    // 12 hours
    1440,   // 24 hours
    2880,   // 48 hours
    4320    // 72 hours
  ];

  checkPoints.forEach(minutes => {
    setTimeout(() => {
      checkAlertProgress(mint);
    }, minutes * 60 * 1000);
  });

  console.log(`Alert tracked for ${mint} (${alertType}). Initial market cap: ${initialMarketCap.toFixed(2)} SOL ($${initialPriceUsd.toLocaleString()})`);
}

// Check if an alerted token has hit new X milestones
async function checkAlertProgress(mint) {
  try {
    const alertData = alertTracker.get(mint);
    if (!alertData) return; // Alert not found

    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo) return;

    // Get current market cap and the latest price
    const currentMarketCap = tokenInfo.marketCapSol || 0;
    const currentPrice = tokenInfo.currentPrice || 0; // Ensure we're using the most current price

    // Generate a unique key for this check to avoid duplicates
    const checkId = `${mint}_${Math.floor(Date.now() / 10000)}`; // 10-second window
    if (global.recentProgressChecks && global.recentProgressChecks.has(checkId)) {
      if (process.env.DEBUG_ALERTS) {
        console.log(`Avoiding duplicate progress check for ${tokenInfo.symbol || mint} - already checked in this time window`);
      }
      return;
    }

    // Record this check to prevent duplicates
    if (!global.recentProgressChecks) global.recentProgressChecks = new Set();
    global.recentProgressChecks.add(checkId);

    // Clean up old entries (keep only last 100)
    if (global.recentProgressChecks.size > 100) {
      const values = Array.from(global.recentProgressChecks);
      for (let i = 0; i < values.length - 100; i++) {
        global.recentProgressChecks.delete(values[i]);
      }
    }

    // Log this call with current price data for debugging
    if (process.env.DEBUG_ALERTS) {
      console.log(`[ALERT CHECK] ${tokenInfo.symbol || mint}: Price: ${currentPrice.toExponential(6)} SOL, MCap: ${currentMarketCap.toFixed(2)} SOL`);
    }

    // Use the appropriate market cap based on alert type
    let initialMarketCap = alertData.initialMarketCap;
    if (alertData.type === 'migration') {
      initialMarketCap = 410.88; // Use fixed market cap for consistency
      if (process.env.DEBUG_ALERTS) {
        console.log(`Using fixed market cap of 410.88 SOL for migration milestone calculations: ${mint}`);
      }
    }

    const xMultiple = currentMarketCap / initialMarketCap;
    const percentChange = ((currentMarketCap - initialMarketCap) / initialMarketCap) * 100;

    // Update current X multiple
    alertData.currentX = xMultiple;

    // Check if this is a new high
    if (xMultiple > alertData.highestX) {
      alertData.highestX = xMultiple;

      // Update milestone tracking in alertStats
      if (!alertStats.xMilestones) {
        alertStats.xMilestones = {
          '2x': 0, '3x': 0, '5x': 0, '10x': 0, '20x': 0, '50x': 0, '100x': 0, '500x': 0, '1000x': 0
        };
      }

      // Check for milestone achievements
      const milestones = [2, 3, 5, 10, 20, 50, 100, 500, 1000];

      // Create a unique milestone check key to prevent duplicates in short timeframes
      const checkKey = `${mint}_milestone_check_${Math.floor(Date.now() / 60000)}`; // 1-minute deduplication
      if (global.recentMilestoneChecks && global.recentMilestoneChecks.has(checkKey)) {
        if (process.env.DEBUG_ALERTS) {
          console.log(`Skipping duplicate milestone check for ${alertData.symbol || mint} (already checked in this minute)`);
        }
        return;
      }

      // Record this check
      if (!global.recentMilestoneChecks) global.recentMilestoneChecks = new Set();
      global.recentMilestoneChecks.add(checkKey);

      // Clean up old entries
      if (global.recentMilestoneChecks.size > 100) {
        const values = Array.from(global.recentMilestoneChecks);
        for (let i = 0; i < values.length - 100; i++) {
          global.recentMilestoneChecks.delete(values[i]);
        }
      }

      // For migration alerts, consistently use fixed market cap for milestone calculations
      let effectiveXMultiple = xMultiple;
      if (alertData.type === 'migration') {
        // Use same fixed market cap approach as in sendMilestoneAlert
        const fixedInitialMarketCap = 410.88;
        effectiveXMultiple = currentMarketCap / fixedInitialMarketCap;
      }

      for (const milestone of milestones) {
        // Check if we've hit this milestone and haven't recorded it yet
        if (effectiveXMultiple >= milestone && !alertData.reachedMilestones[`${milestone}x`]) {
          // Record when we hit this milestone
          alertData.reachedMilestones[`${milestone}x`] = Date.now();

          // Update overall stats
          if (!alertStats.xMilestones[`${milestone}x`]) {
            alertStats.xMilestones[`${milestone}x`] = 0;
          }
          alertStats.xMilestones[`${milestone}x`]++;

          // Track continuous achievement for this token and milestone
          if (!alertStats.xAchievements[mint]) {
            alertStats.xAchievements[mint] = {};
          }
          alertStats.xAchievements[mint][`${milestone}x`] = {
            timestamp: Date.now(),
            initialMarketCap: alertData.type === 'migration' ? 410.88 : alertData.initialMarketCap,
            currentMarketCap: currentMarketCap,
            symbol: alertData.symbol
          };

          // Get time since alert
          const minutesSinceAlert = Math.round((Date.now() - alertData.timestamp) / 60000);
          const hoursSinceAlert = (minutesSinceAlert / 60).toFixed(1);
          const timeSinceAlert = minutesSinceAlert < 60
            ? `${minutesSinceAlert}min`
            : `${hoursSinceAlert}hr`;

          // Create a notification message for chat
          const symbol = alertData.symbol;
          const usdValue = currentMarketCap * (global.solPriceUsd || 0);
          const usdFormatted = usdValue >= 1000000
            ? `$${(usdValue / 1000000).toFixed(2)}M`
            : `$${Math.round(usdValue).toLocaleString()}`;

            // Generate URLs
const pumpFunUrl = `https://pump.fun/coin/${mint}`;
const solscanUrl = `https://solscan.io/token/${mint}`;
const neoUrl = `https://neo.bullx.io/terminal?chainId=1399811149&address=${mint}`;

// Calculate initial market cap USD format if not already done
let initialMarketCapUsd = "";
// Use the correct initial market cap value for USD calculation
const initialMcForUsd = alertData.type === 'migration' ? 410.88 : alertData.initialMarketCap;
if (global.solPriceUsd) {
  const initialMcUsd = initialMcForUsd * global.solPriceUsd;
  initialMarketCapUsd = initialMcUsd < 1000000
    ? ` ($${Math.round(initialMcUsd).toLocaleString()})`
    : ` ($${(initialMcUsd / 1000000).toFixed(2)}M)`;
}

// Enhanced alert message with links but using the same data
const alertMsg = `🚀 *${symbol} HIT ${milestone}X* 🚀\n\n` +
               `Token has increased ${milestone}x from our initial alert!\n\n` +
               `⏱️ Time since alert: ${minutesSinceAlert}min\n` +
               `💰 Initial MC: ${initialMcForUsd.toFixed(2)} SOL${initialMarketCapUsd}\n` +
               `📈 Current MC: ${currentMarketCap.toFixed(2)} SOL (${usdFormatted})\n` +
               `🔥 Gain: ${percentChange.toFixed(0)}%\n` +
               `🔗 [PumpFun](${pumpFunUrl}) | [Solscan](${solscanUrl}) | [NeoBullX](${neoUrl})\n` +
               `🪙 Full Address: \`${mint}\`\n\n` +
               `🏆 This is our ${ordinalSuffix(alertStats.xMilestones[`${milestone}x`])} ${milestone}x call!`;

// Notify users of the milestone
broadcastToChats(alertMsg, { parse_mode: 'Markdown' });

          console.log(`🚀 ${symbol} HIT ${milestone}X: ${currentMarketCap.toFixed(2)} SOL from ${alertData.initialMarketCap.toFixed(2)} SOL (+${percentChange.toFixed(0)}%)`);
        }
      }
    }

    // Now also check for win/loss conditions
    await checkAlertOutcome(mint);

    // Save updated alert data
    alertTracker.set(mint, alertData);

    // Save alert stats
    saveAlertStats();
  } catch (error) {
    console.error('Error checking alert progress:', error);
  }
}

// Helper function for ordinal numbers
function ordinalSuffix(num) {
  const j = num % 10,
        k = num % 100;
  if (j == 1 && k != 11) {
    return num + "st";
  }
  if (j == 2 && k != 12) {
    return num + "nd";
  }
  if (j == 3 && k != 13) {
    return num + "rd";
  }
  return num + "th";
}

// Check if an alerted token is a win or loss
async function checkAlertOutcome(mint) {
  try {
    const alertData = alertTracker.get(mint);
    if (!alertData) return; // Alert not found

    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo) return;

    // Get current market cap and other metrics
    const currentMarketCap = tokenInfo.marketCapSol || 0;

    // Use the appropriate market cap based on alert type
    let initialMarketCap = alertData.initialMarketCap;
    if (alertData.type === 'migration') {
      initialMarketCap = 410.88; // Use fixed market cap for consistency
      console.log(`Using fixed market cap of 410.88 SOL for migration outcome calculations: ${mint}`);
    }

    const percentChange = ((currentMarketCap - initialMarketCap) / initialMarketCap) * 100;
    const timeSinceAlert = Date.now() - alertData.timestamp;
    const hoursSinceAlert = timeSinceAlert / (60 * 60 * 1000);

    // For a win, we need a 50% increase from initial market cap
    // For a loss, only count it if it drops below 32 SOL (rug)
    let outcome = 'pending';

    // Always update X tracking even for checked alerts
    alertData.currentX = currentMarketCap / initialMarketCap;

    // WIN CONDITION: 50% or higher gain from initial marketcap
   // In the checkAlertOutcome function:
if (percentChange >= 50 && !alertData.checked) {
  outcome = 'win';
  alertData.checked = true;
  alertData.winPercentage = percentChange;
  alertData.timeToWinHours = hoursSinceAlert;

  // Update win stats
  alertStats.wins++;
  if (alertData.type === 'tokenAlert') alertStats.alertTypes.tokenAlert.wins++;
  if (alertData.type === 'smartMoney') alertStats.alertTypes.smartMoney.wins++;
  if (alertData.type === 'migration') alertStats.alertTypes.migration.wins++;

  // Track win timing
  if (hoursSinceAlert <= 1) alertStats.winTimes.under1hour++;
  else if (hoursSinceAlert <= 6) alertStats.winTimes.under6hours++;
  else if (hoursSinceAlert <= 24) alertStats.winTimes.under24hours++;
  else alertStats.winTimes.over24hours++;

  // Track win percentage statistics
  alertStats.totalWinPercent += percentChange;
  alertStats.averageWinPercent = alertStats.totalWinPercent / alertStats.wins;

  // Fix: Compare directly with current highest win percentage
  if (percentChange > alertStats.highestWinPercent) {
    alertStats.highestWinPercent = percentChange;
    console.log(`New highest win percentage: ${percentChange.toFixed(2)}%`);
  }

  // Additional Fix: Syncing with milestone data
  // If we have milestone data, make sure our highest win percentage matches
  const xValues = Object.keys(alertStats.xMilestones)
    .filter(key => alertStats.xMilestones[key] > 0)
    .map(key => parseInt(key));

  if (xValues.length > 0) {
    const highestX = Math.max(...xValues);
    const impliedPercent = (highestX - 1) * 100; // Convert X to percentage

    if (impliedPercent > alertStats.highestWinPercent) {
      console.log(`Adjusting highest win percentage based on milestone data: ${impliedPercent.toFixed(2)}%`);
      alertStats.highestWinPercent = impliedPercent;
    }
  }

  console.log(`✅ WIN: Token ${mint} increased by ${percentChange.toFixed(2)}% (${currentMarketCap.toFixed(2)} SOL) in ${hoursSinceAlert.toFixed(1)} hours`);
}
    // LOSS CONDITION: Market cap dropped below rug threshold of 32 SOL
    else if (currentMarketCap < 32 && !alertData.checked) {
      outcome = 'loss';
      alertData.checked = true;
      alertData.lossReason = 'rugPull';

      // Update loss stats
      alertStats.losses++;
      if (alertData.type === 'tokenAlert') alertStats.alertTypes.tokenAlert.losses++;
      if (alertData.type === 'smartMoney') alertStats.alertTypes.smartMoney.losses++;
      if (alertData.type === 'migration') alertStats.alertTypes.migration.losses++;

      // Track loss reason
      alertStats.lossReasons.lowMarketCap = (alertStats.lossReasons.lowMarketCap || 0) + 1;

      console.log(`❌ LOSS (Rug): Token ${mint} market cap dropped below 32 SOL threshold. Now at ${currentMarketCap.toFixed(2)} SOL (${percentChange.toFixed(2)}%)`);
    }
    // STILL PENDING: Not a win or loss yet
    else if (!alertData.checked) {
      // Log progress but keep pending
      if (hoursSinceAlert > 1) {
        console.log(`⏳ PENDING: Token ${mint} at ${percentChange.toFixed(2)}% after ${hoursSinceAlert.toFixed(1)} hours`);
      }
    }

    // If we haven't already set an outcome, update it
    if (!alertData.checked) {
      alertData.outcome = outcome;
      if (outcome !== 'pending') {
        // Record final percent change for all resolved outcomes
        alertData.finalPercentChange = percentChange;
        alertData.timeToResolutionHours = hoursSinceAlert;
      }
    }

    alertTracker.set(mint, alertData);

    // Calculate win rate and pending count
    if (alertStats.wins + alertStats.losses > 0) {
      alertStats.winRate = (alertStats.wins / (alertStats.wins + alertStats.losses)) * 100;
    }

    // Count pending alerts
    let pendingCount = 0;
    for (const [_, data] of alertTracker.entries()) {
      if (data && !data.checked) {
        pendingCount++;
      }
    }
    alertStats.pendingCount = pendingCount;
  } catch (error) {
    console.error('Error checking alert outcome:', error);
  }
}

// Save alert stats to file
// In the saveAlertStats function:
function saveAlertStats() {
  try {
    const statsPath = path.join(DATA_DIR, 'alert_stats.json');

    // Ensure all stats are properly initialized
    if (!alertStats.xMilestones) {
      alertStats.xMilestones = {
        '2x': 0, '3x': 0, '5x': 0, '10x': 0, '20x': 0, '50x': 0, '100x': 0, '500x': 0, '1000x': 0
      };
    }

    if (!alertStats.pendingMilestones) {
      alertStats.pendingMilestones = {};
    }

    // Calculate overall win rate properly
    if (alertStats.wins + alertStats.losses > 0) {
      alertStats.winRate = (alertStats.wins / (alertStats.wins + alertStats.losses)) * 100;
    } else {
      alertStats.winRate = 0;
    }

    // Calculate per-type win rates
    const alertTypes = ['tokenAlert', 'smartMoney', 'migration'];
    for (const type of alertTypes) {
      if (!alertStats.alertTypes[type]) {
        alertStats.alertTypes[type] = { total: 0, wins: 0, losses: 0 };
      }

      // Fix: Calculate win rate for each type
      const total = alertStats.alertTypes[type].wins + alertStats.alertTypes[type].losses;
      const typeWinRate = total > 0 ?
        (alertStats.alertTypes[type].wins / total) * 100 : 0;

      // Store the calculated win rate
      alertStats.alertTypes[type].winRate = typeWinRate.toFixed(2);
    }

    // Ensure highest win percentage is at least consistent with milestone data
    const xValues = Object.keys(alertStats.xMilestones)
      .filter(key => alertStats.xMilestones[key] > 0)
      .map(key => parseFloat(key));

    if (xValues.length > 0) {
      // Extract the numeric part from keys like "5x"
      const numericXValues = xValues.map(x => {
        const match = x.toString().match(/(\d+)/);
        return match ? parseInt(match[1]) : 1;
      });

      if (numericXValues.length > 0) {
        const highestX = Math.max(...numericXValues);
        const impliedPercent = (highestX - 1) * 100; // Convert X to percentage

        if (impliedPercent > alertStats.highestWinPercent) {
          console.log(`Adjusting highest win percentage based on milestone data: ${impliedPercent.toFixed(2)}%`);
          alertStats.highestWinPercent = impliedPercent;
        }
      }
    }

    fs.writeFileSync(statsPath, JSON.stringify(alertStats, null, 2));
    console.log(`Alert stats saved: ${alertStats.wins} wins, ${alertStats.losses} losses (${alertStats.winRate.toFixed(2)}% win rate)`);

    // Log milestone stats for debugging
    console.log(`Milestone stats: 2x=${alertStats.xMilestones['2x']}, 3x=${alertStats.xMilestones['3x']}, 5x=${alertStats.xMilestones['5x']}`);
  } catch (error) {
    console.error('Error saving alert stats:', error);
  }
}

// Load alert stats from file
function loadAlertStats() {
  try {
    const statsPath = path.join(DATA_DIR, 'alert_stats.json');
    if (fs.existsSync(statsPath)) {
      const statsData = fs.readFileSync(statsPath, 'utf8');
      alertStats = JSON.parse(statsData);
      console.log(`Alert stats loaded: ${alertStats.wins} wins, ${alertStats.losses} losses (${alertStats.winRate.toFixed(2)}% win rate)`);
    }
  } catch (error) {
    console.error('Error loading alert stats:', error);
  }
}

async function checkDexScreenerStatus(mint) {
  try {
    // Use the correct URL format
    const url = `https://api.dexscreener.com/orders/v1/solana/${mint}`;

    console.log(`Checking DEXScreener status for: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.log(`DEXScreener API returned ${response.status} for ${mint}`);
      return { hasPaid: false, types: [] };
    }

    const data = await response.json();

    // Check if there are any approved orders
    const approvedOrders = data.filter(order => order.status === 'approved');

    if (approvedOrders.length > 0) {
      const types = approvedOrders.map(order => order.type);
      console.log(`DEXScreener paid status for ${mint}: PAID (${types.join(', ')})`);
      return { hasPaid: true, types: types };
    } else {
      console.log(`DEXScreener paid status for ${mint}: NOT PAID`);
      return { hasPaid: false, types: [] };
    }
  } catch (error) {
    console.error('Error checking DEXScreener status:', error);
    return { hasPaid: false, types: [] };
  }
}

// Reset tracked coins and data
function resetTracking() {
  try {
    console.log("🧹 Starting to reset tracking data...");

    // Clear all token tracking data structures
    tokenRegistry.clear();
    volumeTracker.clear();
    tradeHistory.clear();
    priceTracker.clear();
    uniqueHolders.clear();
    buyVolumeTracker.clear();
    sellVolumeTracker.clear();
    volumeTimeframes.clear();
    whaleTracker.clear();
    launchTimeTracker.clear();
    initialPumpTracker.clear();
    trendingTokens.clear();
    alertTracker.clear();
    smartMoneyActivity.clear();
    subscriptionAttempts.clear();
    smartMoneyAlertDeduplication.clear();
    migrationAlertDeduplication.clear();
    bullishAlertDeduplication.clear();

    // Reset counters
    wsMessageCount = 0;
    tokenTradeCount = 0;
    lastReconnectAttempt = Date.now();
    reconnectAttempts = 0;

    // Reset alert stats (but keep the structure)
    alertStats = {
      totalAlerts: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      pendingCount: 0,
      alertTypes: {
        tokenAlert: { total: 0, wins: 0, losses: 0 },
        smartMoney: { total: 0, wins: 0, losses: 0 },
        migration: { total: 0, wins: 0, losses: 0 }
      },
      lossReasons: {
        lowMarketCap: 0,
        significantDrop: 0,
        timeout: 0
      },
      winTimes: {
        under1hour: 0,
        under6hours: 0,
        under24hours: 0,
        over24hours: 0
      },
      averageWinPercent: 0,
      totalWinPercent: 0,
      highestWinPercent: 0,
      xMilestones: {
        "2x": 0,
        "3x": 0,
        "5x": 0,
        "10x": 0,
        "20x": 0,
        "50x": 0,
        "100x": 0,
        "500x": 0,
        "1000x": 0
      },
      xAchievements: {},
      pendingMilestones: {}
    };

    // Save the reset alert stats
    saveAlertStats();

    // Reset the bot state file
    const stateData = {
      resetTime: Date.now(),
      activeTokens: 0,
      lastReset: new Date().toISOString()
    };
    fs.writeFileSync(path.join(DATA_DIR, 'bot_state.json'), JSON.stringify(stateData, null, 2));

    console.log("✅ Successfully reset all tracking data!");
    console.log("🔄 Restart the bot to begin fresh tracking");

    return "All tracking data has been reset. Restart the bot to begin fresh tracking.";
  } catch (error) {
    console.error("Error resetting tracking data:", error);
    return "Error resetting tracking data: " + error.message;
  }
}

// Log data to file
function logToFile(data) {
try {
  // Ensure log directory exists
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
  }

  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    data
  };

  // Create log filename based on date
  const date = new Date();
  const filename = `${LOG_DIR}/pump_log_${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}.json`;

  // Append to log file
  fs.appendFileSync(filename, JSON.stringify(logEntry) + '\n');

  // Also write to a separate log file based on message type for easier analysis
  if (data.method) {
    const methodDir = `${LOG_DIR}/${data.method}`;
    if (!fs.existsSync(methodDir)) {
      fs.mkdirSync(methodDir, { recursive: true });
    }

    const methodFile = `${methodDir}/${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}.json`;
    fs.appendFileSync(methodFile, JSON.stringify(logEntry) + '\n');

    // For token trades, also log by token ID
    if (data.method === 'tokenTrade' && data.params && data.params.mint) {
      const tokenDir = `${LOG_DIR}/tokens`;
      if (!fs.existsSync(tokenDir)) {
        fs.mkdirSync(tokenDir, { recursive: true });
      }

      const tokenFile = `${tokenDir}/${data.params.mint}.json`;
      fs.appendFileSync(tokenFile, JSON.stringify(logEntry) + '\n');
    }
  }
} catch (error) {
  console.error('Error logging to file:', error);
}
}

// Broadcast message to all active chats
function broadcastToChats(message, options = {}) {
const promises = [];
let networkErrorOccurred = false;
const MAX_RETRIES = 3;

// Function to send message with retry logic for network errors
const sendMessageWithRetry = async (chatId, message, options, retryAttempt = 0) => {
  try {
    return await bot.sendMessage(chatId, message, options);
  } catch (error) {
    // Handle Telegram API errors (invalid chat, blocked bot, etc.)
    if (error.code === 'ETELEGRAM' &&
        (error.response?.body?.error_code === 403 || error.response?.body?.error_code === 400)) {
      activeChats.delete(chatId);
      console.log(`Removed invalid chat ID: ${chatId}`);
      return null;
    }

    // Handle network errors (DNS issues, connection problems)
    if ((error.code === 'EAI_AGAIN' || error.code === 'ENOTFOUND' ||
         error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') &&
        retryAttempt < MAX_RETRIES) {

      networkErrorOccurred = true;
      console.log(`Network error sending to chat ${chatId}, retry attempt ${retryAttempt + 1}/${MAX_RETRIES}`);

      // Exponential backoff: wait longer between each retry
      const delay = Math.pow(2, retryAttempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));

      // Retry the send
      return sendMessageWithRetry(chatId, message, options, retryAttempt + 1);
    }

    // Log other errors
    console.error(`Error sending message to chat ${chatId} (attempt ${retryAttempt + 1}):`, error);
    return null;
  }
};

// Process each chat
for (const chatId of activeChats) {
  try {
    const promise = sendMessageWithRetry(chatId, message, options);
    promises.push(promise);
  } catch (error) {
    console.error(`Unexpected error preparing message for chat ${chatId}:`, error);
  }
}

// After all messages are sent, log network status
Promise.all(promises).then(() => {
  if (networkErrorOccurred) {
    console.log(`Completed message broadcast with network issues. Some messages may have been delayed.`);
  }
}).catch(error => {
  console.error('Error in broadcast operation:', error);
});

return Promise.all(promises);
}

// Get trending tokens
function getTrendingTokens(limit = 5) {
  try {
    const topPerformers = [];

    // Try to get top_pumps.json data for recent trending tokens
    try {
      const topPumpsPath = path.join(__dirname, 'data', 'top_pumps.json');
      if (fs.existsSync(topPumpsPath)) {
        const topPumpsData = JSON.parse(fs.readFileSync(topPumpsPath, 'utf8'));

        // Get the best performing tokens from top_pumps.json
        topPumpsData.forEach(token => {
          // Create a trending token entry with performance-based score
          const score = calculateTrendingScore(token);
          if (score > 0) {
            topPerformers.push([
              token.mint,
              {
                symbol: token.symbol,
                score: score,
                timestamp: token.timestamp,
                currentX: token.currentX,
                highestX: token.highestX,
                initialMC: token.initialMC,
                currentMC: token.currentMC,
                volumeToday: token.volumeToday,
                holderCount: token.holderCount
              }
            ]);
          }
        });
      }
    } catch (err) {
      console.error('Error loading top_pumps.json:', err);
    }

    // If we didn't get enough tokens from top_pumps.json, try to get some from all_time_top_pumps.json
    if (topPerformers.length < limit) {
      try {
        const allTimeTopPumpsPath = path.join(__dirname, 'data', 'all_time_top_pumps.json');
        if (fs.existsSync(allTimeTopPumpsPath)) {
          // Only read first 100 entries to avoid memory issues
          const allTimeTopPumpsContent = fs.readFileSync(allTimeTopPumpsPath, 'utf8');
          const startArray = allTimeTopPumpsContent.indexOf('[');
          const firstChunk = allTimeTopPumpsContent.substring(startArray, startArray + 100000);
          const endBracket = firstChunk.lastIndexOf(']');
          const validJsonString = firstChunk.substring(0, endBracket + 1);

          try {
            const allTimeTopPumpsData = JSON.parse(validJsonString);

            // Sort by recent data and best performance
            allTimeTopPumpsData.sort((a, b) => {
              // Prioritize recent tokens (within last 48 hours)
              const aRecent = Date.now() - a.timestamp < 48 * 60 * 60 * 1000;
              const bRecent = Date.now() - b.timestamp < 48 * 60 * 60 * 1000;

              if (aRecent && !bRecent) return -1;
              if (!aRecent && bRecent) return 1;

              // For tokens with similar recency, compare highest performance
              return b.highestX - a.highestX;
            }).slice(0, 50).forEach(token => {
              // Skip if already in top performers
              if (topPerformers.some(entry => entry[0] === token.mint)) return;

              const score = calculateTrendingScore(token);
              if (score > 0) {
                topPerformers.push([
                  token.mint,
                  {
                    symbol: token.symbol,
                    score: score,
                    timestamp: token.timestamp,
                    currentX: token.currentX,
                    highestX: token.highestX,
                    initialMC: token.initialMC,
                    currentMC: token.currentMC,
                    volumeToday: token.volumeToday,
                    holderCount: token.holderCount || 0
                  }
                ]);
              }
            });
          } catch (parseError) {
            console.error('Error parsing all_time_top_pumps JSON chunk:', parseError);
          }
        }
      } catch (err) {
        console.error('Error loading all_time_top_pumps.json:', err);
      }
    }

    // Fallback to trendingTokens if still not enough tokens
    if (topPerformers.length < limit) {
      const now = Date.now();
      const maxAge = 12 * 60 * 60 * 1000; // 12 hours

      // Add tokens from trendingTokens that aren't already in topPerformers
      Array.from(trendingTokens.entries())
        .filter(([mint, data]) =>
          now - data.timestamp < maxAge &&
          !topPerformers.some(entry => entry[0] === mint))
        .forEach(([mint, data]) => {
          topPerformers.push([mint, data]);
        });
    }

    // Sort by score and take top limit
    return topPerformers
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit);
  } catch (error) {
    console.error('Error getting trending tokens:', error);
    return [];
  }
}

// Calculate trending score based on token data
function calculateTrendingScore(token) {
  let score = 0;

  // Factor #1: Current performance (higher weight for current performance)
  if (token.currentX > 1.5) score += token.currentX * 10; // Great current performance
  else if (token.currentX > 1) score += token.currentX * 5; // Good current performance
  else if (token.currentX < 0.5) score -= 10; // Performing poorly now

  // Factor #2: Historical high (weight for past performance)
  if (token.highestX > 3) score += 30; // Excellent historical performance
  else if (token.highestX > 2) score += 20; // Very good historical performance
  else if (token.highestX > 1.5) score += 10; // Good historical performance

  // Factor #3: Market cap (favor mid-size caps)
  if (token.currentMC > 50 && token.currentMC < 2000) score += 10; // Good market cap range
  else if (token.currentMC > 2000) score += 5; // Higher market cap

  // Factor #4: Volume is a strong indicator
  if (token.volumeToday > 1000) score += 25; // Very high volume
  else if (token.volumeToday > 500) score += 15; // High volume
  else if (token.volumeToday > 100) score += 5; // Decent volume

  // Factor #5: Holder count (community strength)
  if (token.holderCount > 500) score += 15; // Strong community
  else if (token.holderCount > 200) score += 10; // Good community
  else if (token.holderCount > 100) score += 5; // Decent community

  // Factor #6: Recency (favor newer tokens)
  const hoursSinceAlert = (Date.now() - token.timestamp) / (60 * 60 * 1000);
  if (hoursSinceAlert < 1) score += 20; // Very recent (<1 hour)
  else if (hoursSinceAlert < 3) score += 15; // Recent (<3 hours)
  else if (hoursSinceAlert < 12) score += 10; // Same day
  else if (hoursSinceAlert > 48) score -= 20; // Penalize older tokens

  return Math.max(0, score); // Score can't be negative
}

// Generate trending report
function generateTrendingReport() {
  const trending = getTrendingTokens(10);

  if (trending.length === 0) {
    return '📊 *Trending Tokens*\n\nNo trending tokens at the moment.';
  }

  let message = '🔥 *TOP PERFORMING TOKENS* 🔥\n';

  // Add global SOL price if available for USD conversion
  if (global.solPriceUsd) {
    message += `\nCurrent SOL price: $${global.solPriceUsd.toFixed(2)}\n`;
  }

  message += '\n';

  trending.forEach(([mint, data], index) => {
    // Try to get updated token info from registry
    const tokenInfo = tokenRegistry.get(mint);

    // Get token name if available
    const tokenName = data.name || tokenInfo?.name || '';

    // Build detailed message with better formatting
    message += `${index + 1}. *${data.symbol}* ${tokenName ? `(${tokenName})` : ''}\n`;

    // Separator line for visual clarity
    message += `   ${'─'.repeat(20)}\n`;

    // Performance section
    message += `   📈 *PERFORMANCE:*\n`;

    // Current and peak performance
    if (data.currentX) {
      const isPeakHigher = data.highestX && data.highestX > data.currentX;
      const performanceEmoji = data.currentX >= 3 ? '🚀' :
                              data.currentX >= 2 ? '⭐' :
                              data.currentX >= 1 ? '📈' : '📉';

      message += `   ${performanceEmoji} Current: *${data.currentX.toFixed(2)}x*`;

      // Price change percentage
      const percentChange = ((data.currentX - 1) * 100).toFixed(2);
      const changePrefix = data.currentX >= 1 ? '+' : '';
      message += ` (${changePrefix}${percentChange}%)\n`;

      // Show peak if higher than current
      if (isPeakHigher) {
        message += `   🔝 Peak: *${data.highestX.toFixed(2)}x*`;
        const peakTimeStr = data.highestXTimestamp ?
          formatTimeAgo(data.highestXTimestamp) : '';
        if (peakTimeStr) message += ` (${peakTimeStr})`;
        message += `\n`;
      }
    }

    // Market cap section
    message += `   💰 *MARKET CAP:*\n`;

    // Initial and current market cap with USD conversion if available
    if (data.initialMC) {
      message += `   📊 Initial: *${data.initialMC.toFixed(2)} SOL*`;
      if (global.solPriceUsd) {
        const usdValue = data.initialMC * global.solPriceUsd;
        message += ` ($${usdValue.toLocaleString(undefined, {maximumFractionDigits: 2})})`;
      }
      message += `\n`;
    }

    if (data.currentMC) {
      message += `   📊 Current: *${data.currentMC.toFixed(2)} SOL*`;
      if (global.solPriceUsd) {
        const usdValue = data.currentMC * global.solPriceUsd;
        message += ` ($${usdValue.toLocaleString(undefined, {maximumFractionDigits: 2})})`;
      }
      message += `\n`;
    }

    // Price section
    message += `   💲 *PRICE DATA:*\n`;

    // Initial price if available
    if (data.initialPrice && data.initialPrice > 0) {
      message += `   🏁 Initial: *${data.initialPrice.toExponential(6)} SOL*\n`;
    }

    // Current price - use registry data if available, otherwise data from top_pumps
    let currentPrice = tokenInfo?.currentPrice;
    if (!currentPrice && data.currentPrice) currentPrice = data.currentPrice;
    if (currentPrice) {
      message += `   💵 Current: *${currentPrice.toExponential(6)} SOL*\n`;
    }

    // Volume and trading data
    message += `   🔄 *TRADING INFO:*\n`;

    // Volume if available
    if (data.volumeToday) {
      message += `   📊 Volume: *${data.volumeToday.toFixed(1)} SOL*`;
      if (global.solPriceUsd) {
        const usdValue = data.volumeToday * global.solPriceUsd;
        message += ` ($${usdValue.toLocaleString(undefined, {maximumFractionDigits: 2})})`;
      }
      message += `\n`;
    }

    // Holder count if available
    if (data.holderCount) {
      const emoji = data.holderCount > 500 ? '👥' : '👤';
      message += `   ${emoji} Holders: *${data.holderCount.toLocaleString()}*\n`;
    }

    // Alert type and milestone count if available
    if (data.alertType) {
      let alertEmoji = '🔔';
      if (data.alertType.includes('bullish')) alertEmoji = '📈';
      else if (data.alertType.includes('smart')) alertEmoji = '🧠';

      message += `   ${alertEmoji} Alert type: *${data.alertType}*`;

      if (data.milestones) {
        message += ` (${data.milestones} milestone${data.milestones !== 1 ? 's' : ''})`;
      }
      message += `\n`;
    }

    // Age of alert
    const timeAgo = formatTimeAgo(data.timestamp);
    message += `   ⏱️ Alert age: *${timeAgo}*\n`;

    // Trading links section
    message += `   🔗 *LINKS:*\n`;
    message += `   • [PumpFun](https://pump.fun/coin/${mint})\n`;
    message += `   • [Jupiter](https://jup.ag/swap/SOL-${mint})\n`;
    message += `   • [Solscan](https://solscan.io/token/${mint})\n`;

    // Token address for trading (monospace formatted for easy copying)
    message += `   🪙 \`${mint}\`\n\n`;
  });

  // Add footer with refresh info
  message += `Updated: ${new Date().toLocaleString()}\n`;
  message += `Use /trending to refresh this list or view tokens tracked for longer time periods.`;

  return message;
}

// Format timestamp to relative time
function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Schedule trending reports
function scheduleTrendingReports() {
// Send trending report every 2 hours
setInterval(() => {
  const report = generateTrendingReport();
  broadcastToChats(report, { parse_mode: 'Markdown' });
}, 2 * 60 * 60 * 1000);
}

// Check subscription status and resubscribe if needed
// Check for duplicate WebSocket connections in the system
function checkForDuplicateConnections() {
  try {
    // We'll use the ws module's global data to check for multiple connections
    const WebSocket = require('ws');

    // Get our current connection ID
    const currentConnectionId = ws ? (ws.connectionId || wsConnectionId || 'unknown') : 'none';

    // Log all open connections
    console.log(`[${currentConnectionId}] Checking for duplicate WebSocket connections...`);

    // Use Node's process information to detect other sockets
    const connections = [];
    try {
      const netConnections = process._getActiveHandles().filter(h =>
        h && h._handle && h._handle.fd !== -1 &&
        typeof h.remoteAddress === 'string' &&
        h.remoteAddress.includes('pumpportal')
      );

      if (netConnections.length > 1) {
        console.log(`[${currentConnectionId}] WARNING: Detected ${netConnections.length} active socket connections to pumpportal!`);

        // If we have multiple connections and our ws is not null, validate it's the same as one of the connections
        if (ws && ws.readyState === WebSocket.OPEN) {
          let matchFound = false;

          for (const socket of netConnections) {
            const socketInfo = {
              localPort: socket.localPort,
              remoteAddress: socket.remoteAddress,
              remotePort: socket.remotePort
            };
            console.log(`[${currentConnectionId}] Socket: ${JSON.stringify(socketInfo)}`);

            // Try to match with our current ws
            if (socket === ws._socket) {
              console.log(`[${currentConnectionId}] ✓ This socket matches our current WebSocket connection`);
              matchFound = true;
            }
          }

          if (!matchFound && netConnections.length > 1) {
            console.log(`[${currentConnectionId}] ⚠️ Our current WebSocket doesn't match any detected sockets. Forcing reconnection...`);
            safeCloseWebSocket();
            setTimeout(() => setupWebSocket(), 5000);
          }
        }
      } else {
        console.log(`[${currentConnectionId}] No duplicate connections detected (${netConnections.length} connections)`);
      }
    } catch (e) {
      console.error(`[${currentConnectionId}] Error checking socket connections:`, e);
    }
  } catch (error) {
    console.error("Error in checkForDuplicateConnections:", error);
  }
}

function checkSubscriptionStatus() {
try {
  // Only proceed if WebSocket is open
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  const now = Date.now();

  // Check if we have tokens but no trades
  const tokenCount = tokenRegistry.size;
  const tokensWithTrades = Array.from(tradeHistory.entries())
    .filter(([_, trades]) => trades.length > 0)
    .length;

  console.log(`SUBSCRIPTION STATUS: Tracking ${tokenCount} tokens, ${tokensWithTrades} have trades`);

  // Only log summary information, not details for every token
  // This prevents performance issues with large token registries


  // Get tokens that have no trades or haven't been updated in a while
  // Use a more efficient approach that doesn't process every token
  const staleTokens = [];
  const exampleTokens = [
    "4PBWYjxpsa4C7xod4wNXLYFETRyx5raHGfSZYQLqpump",
    "GHTW9RyZGVnzKpyBbsrYD4rp2Vd6gs7L363VDbuCb1L2"
  ];

  // First add example tokens to ensure we keep getting trades
  exampleTokens.forEach(token => {
    if (tokenRegistry.has(token)) {
      staleTokens.push(token);
    }
  });

  // Then add a limited number of tokens that need resubscription
  // This prevents processing the entire registry which can be slow
  let staleCount = 0;
  const MAX_STALE_TOKENS = 50; // Limit the number of tokens to process

  for (const [mint, _] of tokenRegistry.entries()) {
    // Skip if we already have enough tokens or if it's an example token
    if (staleCount >= MAX_STALE_TOKENS || exampleTokens.includes(mint)) {
      continue;
    }

    const trades = tradeHistory.get(mint) || [];
    if (trades.length === 0 ||
        (trades.length > 0 && now - trades[trades.length - 1].timestamp > 15 * 60 * 1000)) {
      staleTokens.push(mint);
      staleCount++;
    }
  }



  // Resubscribe to stale tokens
  if (staleTokens.length > 0) {
    console.log(`Resubscribing to ${staleTokens.length} stale tokens`);

    // Print just a few stale tokens for debugging
    if (staleTokens.length > 5) {
      console.log(`  (Showing 5/${staleTokens.length} tokens)`);
    }

    staleTokens.slice(0, 5).forEach(mint => {
      const info = tokenRegistry.get(mint);
      console.log(`  Stale token: ${info?.symbol || 'Unknown'} (${mint})`);
    });

    // Resubscribe in batches
    const BATCH_SIZE = 10; // Smaller batch size
    for (let i = 0; i < staleTokens.length; i += BATCH_SIZE) {
      const batch = staleTokens.slice(i, i + BATCH_SIZE);
      const payload = {
        method: "subscribeTokenTrade",
        keys: batch
      };

      // Only log the first and last batch to reduce console spam
      if (i === 0 || i + BATCH_SIZE >= staleTokens.length) {
        console.log(`Sending subscription batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(staleTokens.length/BATCH_SIZE)}`);
      }

      ws.send(JSON.stringify(payload));
    }
  }

  // Check for new tokens that may need subscriptions
  // Limit the number of new tokens to process to avoid performance issues
  const MAX_NEW_TOKENS = 100;
  const newTokens = [];
  let newTokenCount = 0;

  // Process tokens more efficiently
  for (const mint of tokenRegistry.keys()) {
    if (newTokenCount >= MAX_NEW_TOKENS) {
      break;
    }

    if (!subscriptionAttempts.has(mint) ||
        now - subscriptionAttempts.get(mint).timestamp > 5 * 60 * 1000) {
      newTokens.push(mint);
      newTokenCount++;
    }
  }

  if (newTokens.length > 0) {
    console.log(`Subscribing to ${newTokens.length} new tokens${newTokenCount >= MAX_NEW_TOKENS ? ' (limited to ' + MAX_NEW_TOKENS + ')' : ''}`);

    // Subscribe in batches
    const BATCH_SIZE = 20;
    for (let i = 0; i < newTokens.length; i += BATCH_SIZE) {
      const batch = newTokens.slice(i, i + BATCH_SIZE);
      const payload = {
        method: "subscribeTokenTrade",
        keys: batch
      };

      // Only log the first and last batch to reduce console spam
      if (i === 0 || i + BATCH_SIZE >= newTokens.length) {
        console.log(`Sending new token subscription batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(newTokens.length/BATCH_SIZE)}`);
      }

      ws.send(JSON.stringify(payload));

      // Update subscription attempts
      batch.forEach(mint => {
        const attempts = subscriptionAttempts.get(mint) || { timestamp: now, attempts: 0 };
        attempts.timestamp = now;
        attempts.attempts += 1;
        subscriptionAttempts.set(mint, attempts);
      });
    }
  }
} catch (error) {
  console.error('Error checking subscription status:', error);
}
}

// Clean up old data
function cleanupOldData() {
try {
  const now = Date.now();
  const maxTokenAge = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Tokens to remove
  const oldTokens = [];

  // Check each token
  for (const [mint, tokenInfo] of tokenRegistry.entries()) {
    if (now - tokenInfo.createdAt > maxTokenAge) {
      oldTokens.push(mint);
    }
  }

  // Remove old tokens
  for (const mint of oldTokens) {
    // Unsubscribe from token trades
    if (ws && ws.readyState === WebSocket.OPEN) {
      const payload = {
        method: "unsubscribeTokenTrade",
        keys: [mint]
      };
      ws.send(JSON.stringify(payload));
    }

    // Remove from data structures
    tokenRegistry.delete(mint);
    volumeTracker.delete(mint);
    tradeHistory.delete(mint);
    priceTracker.delete(mint);
    uniqueHolders.delete(mint);
    buyVolumeTracker.delete(mint);
    sellVolumeTracker.delete(mint);
    volumeTimeframes.delete(mint);
    whaleTracker.delete(mint);
    launchTimeTracker.delete(mint);
    initialPumpTracker.delete(mint);
    trendingTokens.delete(mint);
    smartMoneyActivity.delete(mint);
    subscriptionAttempts.delete(mint);
  }

  if (oldTokens.length > 0) {
    console.log(`Cleaned up ${oldTokens.length} old tokens`);
  }

  // Clean up old logs
  const logRetentionDays = 7;

  if (fs.existsSync(LOG_DIR)) {
    fs.readdirSync(LOG_DIR).forEach(file => {
      const filePath = path.join(LOG_DIR, file);
      const fileStat = fs.statSync(filePath);

      if (now - fileStat.mtime.getTime() > logRetentionDays * 24 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
        console.log(`Deleted old log file: ${file}`);
      }
    });
  }
} catch (error) {
  console.error('Error cleaning up old data:', error);
}
}

// Check Telegram API connectivity
async function checkTelegramConnectivity() {
  try {
    // Try to resolve api.telegram.org
    const dns = require('dns');
    return new Promise((resolve) => {
      dns.lookup('api.telegram.org', (err) => {
        if (err) {
          console.error('Telegram API DNS resolution failed:', err.code);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  } catch (error) {
    console.error('Error checking Telegram connectivity:', error);
    return false;
  }
}

// Check system health
function checkSystemHealth() {
try {
  // Check Telegram connectivity periodically
  checkTelegramConnectivity().then(isConnected => {
    if (!isConnected) {
      console.warn('⚠️ WARNING: Cannot connect to Telegram API servers. Messages may fail to send.');
    }
  });
  const now = Date.now();

  // Check WebSocket health
  if (ws) {
    const connId = ws.connectionId || wsConnectionId || 'unknown';
    const wsState = ws.readyState;
    const wsStateString = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][wsState];
    console.log(`[${connId}] WebSocket state: ${wsStateString} (${wsState})`);

    // Check for inactivity
    const inactivityTime = now - lastActivity;
    console.log(`[${connId}] Time since last activity: ${Math.round(inactivityTime / 1000)}s`);

    // If the connection is in CONNECTING state for too long, it's stuck
    if (wsState === WebSocket.CONNECTING && inactivityTime > 30 * 1000) {
      console.log(`[${connId}] WebSocket stuck in CONNECTING state for ${Math.round(inactivityTime / 1000)}s, forcing reconnect`);
      safeCloseWebSocket();
      setTimeout(() => setupWebSocket(), 2000);
      return;
    }

    // If the connection is CLOSING for too long, it's stuck
    if (wsState === WebSocket.CLOSING && inactivityTime > 30 * 1000) {
      console.log(`[${connId}] WebSocket stuck in CLOSING state for ${Math.round(inactivityTime / 1000)}s, forcing terminate`);
      try {
        ws.terminate();
      } catch (e) {
        console.error(`[${connId}] Error terminating stuck closing websocket:`, e);
      }
      ws = null;
      setTimeout(() => setupWebSocket(), 2000);
      return;
    }

    // If the connection is CLOSED, we need to reconnect
    if (wsState === WebSocket.CLOSED) {
      console.log(`[${connId}] WebSocket is CLOSED, but wasn't cleaned up properly. Reconnecting...`);
      ws = null; // Clear the reference
      setTimeout(() => setupWebSocket(), 2000);
      return;
    }

    // Reconnect if inactive for too long (for OPEN connections)
    if (wsState === WebSocket.OPEN && inactivityTime > 5 * 60 * 1000) {
      console.log(`[${connId}] WebSocket inactive for too long, reconnecting...`);

      // Before terminating, try to send a ping to see if connection is still alive
      try {
        console.log(`[${connId}] Sending ping before terminating...`);
        const pingTimestamp = Date.now();
        ws.ping();

        // Give it a moment to respond
        setTimeout(() => {
          // Check if we got a pong response
          const newInactivityTime = Date.now() - lastActivity;
          if (newInactivityTime > inactivityTime || Date.now() - pingTimestamp > 2900) {
            // No response, terminate and reconnect
            console.log(`[${connId}] No ping response, terminating connection...`);
            safeCloseWebSocket();
            setTimeout(() => setupWebSocket(), 2000);
          } else {
            console.log(`[${connId}] Connection responded to ping, keeping connection alive`);
            // Re-subscribe to migrations as a keepalive
            if (ws && ws.readyState === WebSocket.OPEN) {
              const migrationPayload = {
                method: "subscribeMigration"
              };
              ws.send(JSON.stringify(migrationPayload));
              console.log(`[${connId}] Re-subscribed to migrations as keepalive`);
            }
          }
        }, 3000);
      } catch (e) {
        console.error(`[${connId}] Error sending ping:`, e);
        safeCloseWebSocket();
        setTimeout(() => setupWebSocket(), 2000);
      }
    }
  }

  // Log memory usage
  memoryUsage = process.memoryUsage();
  console.log('Memory usage:', {
    rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
    heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
    heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
    external: `${Math.round(memoryUsage.external / 1024 / 1024)} MB`
  });

  // Log counters
  console.log('Counters:', {
    wsMessages: wsMessageCount,
    tokenTrades: tokenTradeCount,
    trackedTokens: tokenRegistry.size,
    activeChats: activeChats.size
  });

  // Log summary of tokens being tracked instead of every token
  console.log('TRACKED TOKENS SUMMARY:');
  console.log(`- Total tokens: ${tokenRegistry.size}`);

  // Count tokens with trades
  const tokensWithTrades = Array.from(tradeHistory.entries())
    .filter(([_, trades]) => trades.length > 0)
    .length;
  console.log(`- Tokens with trades: ${tokensWithTrades}`);

  // Count tokens with price data
  const tokensWithPrice = Array.from(tokenRegistry.entries())
    .filter(([_, info]) => info.currentPrice && info.currentPrice > 0)
    .length;
  console.log(`- Tokens with price data: ${tokensWithPrice}`);

  // Log top volume tokens (just a few)
  console.log('TOP VOLUME TOKENS:');
  const topVolumeTokens = Array.from(volumeTracker.entries())
    .filter(([mint, _]) => tokenRegistry.has(mint))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  topVolumeTokens.forEach(([mint, volume]) => {
    const info = tokenRegistry.get(mint);
    if (info) {
      console.log(`- ${info.symbol || 'Unknown'} (${mint}): ${volume.toFixed(4)} SOL`);
    }
  });

  // Check WebSocket status and automatically fix issues
  if (ws) {
    const stateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    console.log(`WebSocket state: ${stateNames[ws.readyState]} (${ws.readyState})`);

    // Check if WebSocket is in a bad state
    if (ws.readyState !== WebSocket.OPEN) {
      console.log('⚠️ WebSocket is not in OPEN state, scheduling reconnection...');
      handleReconnect();
    }

    // Check for inactivity (no messages received in 5 minutes)
    const inactivityThreshold = 5 * 60 * 1000; // 5 minutes
    if (now - lastActivity > inactivityThreshold) {
      console.log(`⚠️ WebSocket inactive for ${Math.floor((now - lastActivity) / 60000)} minutes, reconnecting...`);
      handleReconnect();
    }
  } else {
    console.log('WebSocket: Not initialized, creating new connection...');
    setupWebSocket();
  }

  // Update memory usage display
  memoryUsage = process.memoryUsage();
  console.log(`Memory usage: ${Math.round(memoryUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB Heap`);

  // If memory usage is very high, suggest a restart
  if (memoryUsage.rss > 1024 * 1024 * 1024) { // Over 1GB
    console.log('⚠️ High memory usage detected. Consider restarting the bot.');

    // Notify admin chats about high memory usage
    broadcastToChats('⚠️ *System Alert*: High memory usage detected. Consider restarting the bot for optimal performance.',
      { parse_mode: 'Markdown' });
  }
} catch (error) {
  console.error('Error checking system health:', error);
}
}

// Bot command handlers
// Command: /wallet - Create or view user wallet
bot.onText(/\/wallet/, async (msg) => {
  const userId = msg.from.id.toString();
  const chatId = msg.chat.id;

  try {
    // If keyboard manager is available, use it to show wallet menu
    if (global.keyboardManagerAPI) {
      let walletAddress = walletManager.getUserWallet(userId);

      if (!walletAddress) {
        // Create new wallet for user
        const newWallet = walletManager.assignWalletToUser(userId, chatId);
        walletAddress = newWallet.publicKey;
        const balance = await walletManager.getWalletBalance(walletAddress);

        await bot.sendMessage(chatId,
          `💼 *New Wallet Created*\n\n` +
          `🔑 *Address:* \`${walletAddress}\`\n` +
          `💰 *Balance:* ${balance.toFixed(4)} SOL\n\n` +
          `Send SOL to this address to fund your instabuy transactions.`,
          { parse_mode: 'Markdown' }
        );
      }

      // Get updated balance
      const balance = await walletManager.getWalletBalance(walletAddress);

      // Show wallet menu
      await global.keyboardManagerAPI.sendMenuMessage(
        chatId,
        `👛 *Your Wallet*\n\n` +
        `Address: \`${walletAddress}\`\n` +
        `Balance: *${balance.toFixed(4)} SOL*\n\n` +
        `Select an action:`,
        global.keyboardManagerAPI.getWalletActionsKeyboard()
      );
    } else {
      // Fallback to old wallet display if keyboard manager is not available
      let walletAddress = walletManager.getUserWallet(userId);

      if (!walletAddress) {
        // Create new wallet for user
        const newWallet = walletManager.assignWalletToUser(userId, chatId);
        walletAddress = newWallet.publicKey;
        const balance = await walletManager.getWalletBalance(walletAddress);

        // Get the wallet details including private key
        const walletInfo = walletManager.getWalletDetails(userId);
        if (walletInfo) {
          // Show new wallet with buttons
          await bot.sendMessage(chatId,
            `💼 *New Wallet Created*\n\n` +
            `🔑 *Address:* \`${walletAddress}\`\n` +
            `💰 *Balance:* ${balance.toFixed(4)} SOL\n\n` +
            `Send SOL to this address to fund your instabuy transactions.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔐 Show Private Key (Tap to reveal)', callback_data: `show_privatekey_${userId}` }],
                  [{ text: '📋 Copy Wallet Address', callback_data: `copy_address_${userId}` }]
                ]
              }
            }
          );
        } else {
          await bot.sendMessage(chatId,
            `💼 *New Wallet Created*\n\n` +
            `🔑 Address: \`${walletAddress}\`\n` +
            `💰 Balance: ${balance.toFixed(4)} SOL\n\n` +
            `Send SOL to this address to fund your instabuy transactions.`,
            { parse_mode: 'Markdown' }
          );
        }
      } else {
        // Show existing wallet info with buttons
        const balance = await walletManager.getWalletBalance(walletAddress);

        // Get the wallet details including private key
        const walletInfo = walletManager.getWalletDetails(userId);
        if (walletInfo) {
          await bot.sendMessage(chatId,
            `💼 *Your Solana Wallet*\n\n` +
            `🔑 *Address:* \`${walletAddress}\`\n` +
            `💰 *Balance:* ${balance.toFixed(4)} SOL\n\n` +
            `Send SOL to this address to fund your instabuy transactions.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔐 Show Private Key (Tap to reveal)', callback_data: `show_privatekey_${userId}` }],
                  [{ text: '📋 Copy Wallet Address', callback_data: `copy_address_${userId}` }]
                ]
              }
            }
          );
        } else {
          await bot.sendMessage(chatId,
            `💼 *Your Solana Wallet*\n\n` +
            `🔑 Address: \`${walletAddress}\`\n` +
            `💰 Balance: ${balance.toFixed(4)} SOL\n\n` +
            `Send SOL to this address to fund your instabuy transactions.`,
            { parse_mode: 'Markdown' }
          );
        }
      }
    }
  } catch (error) {
    console.error('Error handling wallet command:', error);
    await bot.sendMessage(chatId, 'Error retrieving wallet information. Please try again later.');
  }
});

bot.onText(/\/start/, (msg) => {
const chatId = msg.chat.id;
const userId = msg.from.id.toString();

// Add this chat to active chats
activeChats.add(chatId);

// Initialize user settings if not already set
if (!userSettings.has(chatId)) {
  userSettings.set(chatId, {
    volumeThreshold: VOLUME_THRESHOLD,
    sentimentThreshold: 50,
    holderThreshold: HOLDER_GROWTH_THRESHOLD,
    marketCapMinSol: 0,
    marketCapMaxSol: 0,
    buySellRatioThreshold: BUY_SELL_RATIO_THRESHOLD,
    priceIncreaseThreshold: PRICE_INCREASE_THRESHOLD,
    requireDexScreenerPaid: false,
    continuousMonitoring: true,
    alertsEnabled: true
  });
}

// Send welcome message
bot.sendMessage(chatId,
  '🤖 *PumpPortal Pro Trader*\n\n' +
  'Bot is now active! You will receive alerts for promising tokens.\n\n' +
  'Use the menu below to navigate:',
  { parse_mode: 'Markdown' }
);

// If keyboard manager is initialized, use it to show the main menu
if (global.keyboardManagerAPI) {
  global.keyboardManagerAPI.sendMenuMessage(
    chatId,
    '🤖 *Main Menu*\n\nSelect an option:',
    global.keyboardManagerAPI.getMainMenuKeyboard()
  );
} else {
  // Fallback to old message if keyboard manager is not available
  bot.sendMessage(chatId,
    'Available commands:\n' +
    '/start - Start the bot\n' +
    '/stop - Stop receiving alerts\n' +
    '/settings - View current settings\n' +
    '/menu - Show main menu\n' +
    '/wallet - Manage your wallet\n' +
    '/trading - Trading options\n' +
    '/stats - View bot statistics\n' +
    '/status - Check system status',
    { parse_mode: 'Markdown' }
  );
}

console.log(`Bot started in chat ${chatId}`);
});

bot.onText(/\/stop/, (msg) => {
const chatId = msg.chat.id;

// Remove this chat from active chats
activeChats.delete(chatId);

bot.sendMessage(chatId, '🛑 Bot stopped. You will no longer receive alerts. Use /start to reactivate.');

console.log(`Bot stopped in chat ${chatId}`);
});

// Add new command handlers for keyboard-based navigation
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;

  if (global.keyboardManagerAPI) {
    global.keyboardManagerAPI.sendMenuMessage(
      chatId,
      '🤖 *Main Menu*\n\nSelect an option:',
      global.keyboardManagerAPI.getMainMenuKeyboard()
    );
  } else {
    bot.sendMessage(chatId, 'Menu system not available. Please try again later.');
  }
});

bot.onText(/\/trading/, (msg) => {
  const chatId = msg.chat.id;

  if (global.keyboardManagerAPI && global.tradingSystemAPI) {
    // Access tradingConfig directly from the API
    const tradingConfig = global.tradingSystemAPI.tradingConfig;
    global.keyboardManagerAPI.sendMenuMessage(
      chatId,
      '💰 *Trading Menu*\n\nManage your trading activities:',
      global.keyboardManagerAPI.getTradingKeyboard(tradingConfig)
    );
  } else {
    bot.sendMessage(chatId, 'Trading menu not available. Please try again later.');
  }
});

bot.onText(/\/settings/, (msg) => {
const chatId = msg.chat.id;

if (!userSettings.has(chatId)) {
  userSettings.set(chatId, {
    volumeThreshold: VOLUME_THRESHOLD,
    sentimentThreshold: 50,
    holderThreshold: HOLDER_GROWTH_THRESHOLD,
    marketCapMinSol: 0,
    marketCapMaxSol: 0,
    buySellRatioThreshold: BUY_SELL_RATIO_THRESHOLD,
    priceIncreaseThreshold: PRICE_INCREASE_THRESHOLD,
    requireDexScreenerPaid: false,
    continuousMonitoring: true,
    alertsEnabled: true
  });
}

const settings = userSettings.get(chatId);

// If keyboard manager is available, use it to show settings menu
if (global.keyboardManagerAPI) {
  global.keyboardManagerAPI.sendMenuMessage(
    chatId,
    '⚙️ *Settings*\n\nConfigure your alert preferences:',
    global.keyboardManagerAPI.getSettingsKeyboard(settings)
  );
} else {
  // Fallback to old settings display if keyboard manager is not available
  // Format market cap range
  let marketCapRange = 'Any';
  if (settings.marketCapMinSol > 0 && settings.marketCapMaxSol > 0) {
    marketCapRange = `${settings.marketCapMinSol}-${settings.marketCapMaxSol} SOL`;
  } else if (settings.marketCapMinSol > 0) {
    marketCapRange = `>${settings.marketCapMinSol} SOL`;
  } else if (settings.marketCapMaxSol > 0) {
    marketCapRange = `<${settings.marketCapMaxSol} SOL`;
  }

  bot.sendMessage(chatId,
    '⚙️ *Current Settings*\n\n' +
    `📊 Volume: *${settings.volumeThreshold} SOL*\n` +
    `🔍 Sentiment: *${settings.sentimentThreshold}/100*\n` +
    `👥 Holders: *${settings.holderThreshold}*\n` +
    `💰 Market Cap: *${marketCapRange}*\n` +
    `📈 Buy/Sell Ratio: *${settings.buySellRatioThreshold}*\n` +
    `🚀 Price Increase: *${settings.priceIncreaseThreshold}%*\n` +
    `💸 Require DEX Paid: *${settings.requireDexScreenerPaid ? 'Yes' : 'No'}*\n` +
    `🔄 Monitoring: *${settings.continuousMonitoring ? 'Enabled' : 'Disabled'}*\n` +
    `🔔 Alerts: *${settings.alertsEnabled ? 'Enabled' : 'Disabled'}*\n\n` +
    '*Commands:*\n' +
    '/volume <num> - Set min SOL volume\n' +
    '/sentiment <num> - Set min sentiment score\n' +
    '/holders <num> - Set min holder count\n' +
    '/mincap <num> - Set min market cap\n' +
    '/maxcap <num> - Set max market cap\n' +
    '/buysell <num> - Set min buy/sell ratio\n' +
    '/pricerise <num> - Set min price increase %\n' +
    '/dexpaid - Toggle requiring DEX paid\n' +
    '/monitoring - Toggle continuous monitoring\n' +
    '/togglealerts - Toggle all alerts',
    { parse_mode: 'Markdown' }
  );
}
});

bot.onText(/\/threshold (.+)/, (msg, match) => {
const chatId = msg.chat.id;
const threshold = parseFloat(match[1]);

if (isNaN(threshold) || threshold <= 0) {
  bot.sendMessage(chatId, '❌ Please provide a valid positive number for the threshold.');
  return;
}

if (!userSettings.has(chatId)) {
  userSettings.set(chatId, {
    volumeThreshold: VOLUME_THRESHOLD,
    sentimentThreshold: 50,
    alertsEnabled: true
  });
}

const settings = userSettings.get(chatId);
settings.volumeThreshold = threshold;
userSettings.set(chatId, settings);

bot.sendMessage(chatId, `✅ Volume threshold updated to *${threshold} SOL*`, { parse_mode: 'Markdown' });
});

bot.onText(/\/sentiment (.+)/, (msg, match) => {
const chatId = msg.chat.id;
const sentiment = parseInt(match[1]);

if (isNaN(sentiment) || sentiment < 0 || sentiment > 100) {
  bot.sendMessage(chatId, '❌ Please provide a valid number between 0 and 100 for the sentiment threshold.');
  return;
}

if (!userSettings.has(chatId)) {
  userSettings.set(chatId, {
    volumeThreshold: VOLUME_THRESHOLD,
    sentimentThreshold: 50,
    holderThreshold: HOLDER_GROWTH_THRESHOLD,
    marketCapMinSol: 0,
    marketCapMaxSol: 0,
    buySellRatioThreshold: BUY_SELL_RATIO_THRESHOLD,
    priceIncreaseThreshold: PRICE_INCREASE_THRESHOLD,
    requireDexScreenerPaid: false,
    continuousMonitoring: true,
    alertsEnabled: true
  });
}

const settings = userSettings.get(chatId);
settings.sentimentThreshold = sentiment;
userSettings.set(chatId, settings);

bot.sendMessage(chatId, `✅ Sentiment threshold updated to *${sentiment}/100*`, { parse_mode: 'Markdown' });
});

// Add all the new command handlers for customization
bot.onText(/\/holders (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const value = parseInt(match[1]);

  if (isNaN(value) || value < 0) {
    bot.sendMessage(chatId, '❌ Please provide a valid positive number.');
    return;
  }

  if (!userSettings.has(chatId)) {
    userSettings.set(chatId, {
      volumeThreshold: VOLUME_THRESHOLD,
      sentimentThreshold: 50,
      holderThreshold: HOLDER_GROWTH_THRESHOLD,
      marketCapMinSol: 0,
      marketCapMaxSol: 0,
      buySellRatioThreshold: BUY_SELL_RATIO_THRESHOLD,
      priceIncreaseThreshold: PRICE_INCREASE_THRESHOLD,
      requireDexScreenerPaid: false,
      continuousMonitoring: true,
      alertsEnabled: true
    });
  }

  const settings = userSettings.get(chatId);
  settings.holderThreshold = value;
  userSettings.set(chatId, settings);

  bot.sendMessage(chatId, `✅ Holder threshold updated to *${value} holders*`, { parse_mode: 'Markdown' });
});

bot.onText(/\/trend (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const mintOrSymbol = match[1];

  // Try to find token by mint or symbol
  let targetMint = null;
  if (tokenRegistry.has(mintOrSymbol)) {
    targetMint = mintOrSymbol;
  } else {
    // Try to find by symbol
    for (const [mint, data] of tokenRegistry.entries()) {
      if (data.symbol && data.symbol.toLowerCase() === mintOrSymbol.toLowerCase()) {
        targetMint = mint;
        break;
      }
    }
  }

  if (!targetMint) {
    bot.sendMessage(chatId, `Could not find token with mint or symbol: ${mintOrSymbol}`);
    return;
  }

  const tokenInfo = tokenRegistry.get(targetMint);
  if (!tokenInfo) {
    bot.sendMessage(chatId, `Token found but no information available.`);
    return;
  }

  // Run trend analysis
  const trendAnalysis = analyzeUptrend(targetMint);
  const volumeAnalysis = analyzeVolumeProfile(targetMint);

  // Create detailed report
  let message = `📈 *Trend Analysis for ${tokenInfo.symbol}*\n\n`;

  // Overall trend status
  message += `*Overall Trend:* ${trendAnalysis.isUptrend ? '✅ UPTREND' : '❌ NO CLEAR UPTREND'}\n\n`;

  // Price pattern details
  message += `*Price Pattern:*\n`;
  message += `• Higher Highs: ${trendAnalysis.hasHigherHighs ? 'YES' : 'NO'} (${trendAnalysis.highsCount || 0} found)\n`;
  message += `• Higher Lows: ${trendAnalysis.hasHigherLows ? 'YES' : 'NO'} (${trendAnalysis.lowsCount || 0} found)\n`;
  message += `• Trend Strength: ${trendAnalysis.strength || 0}\n\n`;

  // Volume analysis
  message += `*Volume Profile:*\n`;
  message += `• Healthy Volume: ${volumeAnalysis.isHealthy ? 'YES' : 'NO'}\n`;
  message += `• Volume Trend: ${volumeAnalysis.volumeTrend > 0 ? 'INCREASING' : 'DECREASING/FLAT'}\n`;
  message += `• Buy Ratio Trend: ${volumeAnalysis.buyRatioTrend > 0 ? 'IMPROVING' : 'WORSENING/FLAT'}\n\n`;

  // Current metrics
  message += `*Current Metrics:*\n`;
  message += `• Price: ${tokenInfo.currentPrice?.toFixed(9) || 'Unknown'} SOL\n`;
  message += `• Market Cap: ${tokenInfo.marketCapSol?.toFixed(2) || 'Unknown'} SOL\n`;
  message += `• Buy/Sell Ratio: ${tokenInfo.buySellRatio?.toFixed(2) || 'Unknown'}\n`;

  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/mincap (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const value = parseFloat(match[1]);

  if (isNaN(value) || value < 0) {
    bot.sendMessage(chatId, '❌ Please provide a valid positive number.');
    return;
  }

  if (!userSettings.has(chatId)) {
    userSettings.set(chatId, getDefaultSettings());
  }

  const settings = userSettings.get(chatId);
  settings.marketCapMinSol = value;
  userSettings.set(chatId, settings);

  bot.sendMessage(chatId, `✅ Minimum market cap updated to *${value} SOL*`, { parse_mode: 'Markdown' });
});

bot.onText(/\/maxcap (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const value = parseFloat(match[1]);

  if (isNaN(value) || value < 0) {
    bot.sendMessage(chatId, '❌ Please provide a valid positive number (or 0 for unlimited).');
    return;
  }

  if (!userSettings.has(chatId)) {
    userSettings.set(chatId, getDefaultSettings());
  }

  const settings = userSettings.get(chatId);
  settings.marketCapMaxSol = value;
  userSettings.set(chatId, settings);

  bot.sendMessage(chatId, `✅ Maximum market cap updated to *${value > 0 ? value + ' SOL' : 'unlimited'}*`, { parse_mode: 'Markdown' });
});

bot.onText(/\/buysell (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const value = parseFloat(match[1]);

  if (isNaN(value) || value < 0) {
    bot.sendMessage(chatId, '❌ Please provide a valid positive number.');
    return;
  }

  if (!userSettings.has(chatId)) {
    userSettings.set(chatId, getDefaultSettings());
  }

  const settings = userSettings.get(chatId);
  settings.buySellRatioThreshold = value;
  userSettings.set(chatId, settings);

  bot.sendMessage(chatId, `✅ Buy/Sell ratio threshold updated to *${value}*`, { parse_mode: 'Markdown' });
});

bot.onText(/\/pricerise (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const value = parseFloat(match[1]);

  if (isNaN(value)) {
    bot.sendMessage(chatId, '❌ Please provide a valid number.');
    return;
  }

  if (!userSettings.has(chatId)) {
    userSettings.set(chatId, getDefaultSettings());
  }

  const settings = userSettings.get(chatId);
  settings.priceIncreaseThreshold = value;
  userSettings.set(chatId, settings);

  bot.sendMessage(chatId, `✅ Price increase threshold updated to *${value}%*`, { parse_mode: 'Markdown' });
});

bot.onText(/\/dexpaid/, (msg) => {
  const chatId = msg.chat.id;

  if (!userSettings.has(chatId)) {
    userSettings.set(chatId, getDefaultSettings());
  }

  const settings = userSettings.get(chatId);
  settings.requireDexScreenerPaid = !settings.requireDexScreenerPaid;
  userSettings.set(chatId, settings);

  bot.sendMessage(chatId, `✅ DEXScreener paid requirement ${settings.requireDexScreenerPaid ? 'enabled' : 'disabled'}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/monitoring/, (msg) => {
  const chatId = msg.chat.id;

  if (!userSettings.has(chatId)) {
    userSettings.set(chatId, getDefaultSettings());
  }

  const settings = userSettings.get(chatId);
  settings.continuousMonitoring = !settings.continuousMonitoring;
  userSettings.set(chatId, settings);

  bot.sendMessage(chatId, `✅ Continuous monitoring ${settings.continuousMonitoring ? 'enabled' : 'disabled'}`, { parse_mode: 'Markdown' });
});

// Helper function to get default settings
function getDefaultSettings() {
  return {
    volumeThreshold: VOLUME_THRESHOLD,
    sentimentThreshold: 50,
    holderThreshold: HOLDER_GROWTH_THRESHOLD,
    marketCapMinSol: 0,
    marketCapMaxSol: 0,
    buySellRatioThreshold: BUY_SELL_RATIO_THRESHOLD,
    priceIncreaseThreshold: PRICE_INCREASE_THRESHOLD,
    requireDexScreenerPaid: false,
    continuousMonitoring: true,
    alertsEnabled: true
  };
}

bot.onText(/\/trending/, (msg) => {
const chatId = msg.chat.id;
const report = generateTrendingReport();
bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, (msg) => {
const chatId = msg.chat.id;

const trackedTokenCount = tokenRegistry.size;
const activeTokens24h = Array.from(tokenRegistry.entries())
  .filter(([_, info]) => (Date.now() - info.createdAt) < 24 * 60 * 60 * 1000)
  .length;

const trendingCount = getTrendingTokens(10).length;
const totalSmartMoneyWallets = smartMoneyWallets.size;

bot.sendMessage(chatId,
  '📊 *Bot Statistics*\n\n' +
  `Tracked tokens: *${trackedTokenCount}*\n` +
  `Tokens added in 24h: *${activeTokens24h}*\n` +
  `Trending tokens: *${trendingCount}*\n` +
  `Active chats: *${activeChats.size}*\n` +
`Smart money wallets: *${totalSmartMoneyWallets}*\n` +
    `Messages processed: *${wsMessageCount}*\n` +
    `Trades processed: *${tokenTradeCount}*\n` +
    `Connection status: *${ws && ws.readyState === WebSocket.OPEN ? 'Connected' : 'Disconnected'}*\n` +
    `Bot version: *${VERSION}*`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;

  // Get system status
  const now = Date.now();
  let wsStatus = 'Disconnected';

  if (ws) {
    const wsStates = ['Connecting', 'Connected', 'Closing', 'Closed'];
    wsStatus = wsStates[ws.readyState] || 'Unknown';
  }

  const uptimeSeconds = process.uptime();
  let uptimeString = '';

  if (uptimeSeconds < 60) {
    uptimeString = `${Math.floor(uptimeSeconds)}s`;
  } else if (uptimeSeconds < 3600) {
    uptimeString = `${Math.floor(uptimeSeconds / 60)}m ${Math.floor(uptimeSeconds % 60)}s`;
  } else {
    uptimeString = `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`;
  }

  const memoryUsage = process.memoryUsage();
  const inactivityTime = (now - lastActivity) / 1000;

  bot.sendMessage(chatId,
    '🔧 *System Status*\n\n' +
    `WebSocket: *${wsStatus}*\n` +
    `Uptime: *${uptimeString}*\n` +
    `Last activity: *${inactivityTime.toFixed(0)}s ago*\n` +
    `Memory usage: *${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB*\n` +
    `Tokens tracked: *${tokenRegistry.size}*\n` +
    `Reconnect attempts: *${reconnectAttempts}*\n` +
    `Messages: *${wsMessageCount}*\n` +
    `Trades: *${tokenTradeCount}*\n`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/showkey/, (msg) => {
  const userId = msg.from.id.toString();
  const chatId = msg.chat.id;

  // Extract and display private key
  privateKeyExtractor.extractPrivateKey(userId, chatId);
});

// Analytics command to show daily token metrics
bot.onText(/\/analytics/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    // Run a token scanner analysis
    await bot.sendMessage(chatId, '📊 Analyzing token data...');

    // Update SOL price
    await analytics.dailyMetrics.updateSolPrice();

    // Run full scanner
    analytics.tokenScanner.runAnalysis(tokenRegistry);

    // Generate and send report
    const report = analytics.dailyMetrics.generateDailyReport();
    await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error generating analytics report:', error);
    await bot.sendMessage(chatId, '❌ Error generating analytics report. Please try again later.');
  }
});



// Generate hot pumps report - currently active milestone tokens
function generateHotPumpsReport() {
  try {
    // Get all tokens from alertTracker that have active milestones
    const activeTokens = [];

    // Process each token in alertTracker
    for (const [mint, alertData] of alertTracker.entries()) {
      // Skip tokens that don't have valid data
      if (!alertData || !alertData.initialMarketCap || alertData.initialMarketCap <= 0) {
        continue;
      }

      // Get token info
      const tokenInfo = tokenRegistry.get(mint);
      if (!tokenInfo) continue;

      // Get current market cap and price
      const currentMarketCap = tokenInfo.marketCapSol || 0;
      const currentPrice = tokenInfo.currentPrice || 0;

      // Calculate current X multiple
      const currentX = currentMarketCap / alertData.initialMarketCap;

      // Skip tokens that aren't performing well (less than 1.5x)
      if (currentX < 1.5) continue;

      // Get volume data
      const volume = volumeTracker.get(mint) || 0;
      const volumeToday = volume; // This is an approximation

      // Get holder count
      const holders = uniqueHolders.get(mint)?.size || 0;

      // Check if token is still in uptrend
      const isUptrend = tokenInfo.isUptrend || false;

      // Add to active tokens list
      activeTokens.push({
        mint,
        symbol: tokenInfo.symbol || mint.slice(0, 6),
        name: tokenInfo.name || 'Unknown',
        initialMarketCap: alertData.initialMarketCap,
        currentMarketCap,
        currentX,
        highestX: alertData.highestX || currentX,
        volume: volumeToday,
        holders,
        isUptrend,
        alertTime: alertData.timestamp,
        reachedMilestones: alertData.reachedMilestones || {}
      });
    }

    // Sort by current X multiple (highest first)
    activeTokens.sort((a, b) => b.currentX - a.currentX);

    // Generate report
    let report = '🔥 *CURRENTLY HOT TOKENS* 🔥\n\n';

    if (activeTokens.length === 0) {
      report += 'No tokens currently meeting hot pump criteria.\n';
      report += 'Check back later or use /trending to see recent activity.';
      return report;
    }

    // Add SOL price for reference
    if (global.solPriceUsd) {
      report += `Current SOL price: $${global.solPriceUsd.toFixed(2)}\n\n`;
    }

    // Create a table for the top tokens
    report += "```\n";
    report += "Symbol | Current X | ATH X | MC (SOL) | Volume | Holders\n";
    report += "-------|-----------|-------|----------|--------|--------\n";

    // Add top 15 tokens to the table
    const topTokens = activeTokens.slice(0, 15);
    topTokens.forEach(token => {
      report += `${token.symbol.padEnd(6)} | ` +
                `${token.currentX.toFixed(1).padStart(9)}x | ` +
                `${token.highestX.toFixed(1).padStart(5)}x | ` +
                `${token.currentMarketCap.toFixed(1).padStart(8)} | ` +
                `${token.volume.toFixed(1).padStart(6)} | ` +
                `${token.holders.toString().padStart(7)}\n`;
    });

    report += "```\n\n";

    // Add detailed info for top 5 tokens
    report += "🏆 *Top Performers Details:*\n\n";

    topTokens.slice(0, 5).forEach((token, index) => {
      // Calculate time since alert
      const hoursSinceAlert = (Date.now() - token.alertTime) / (60 * 60 * 1000);
      const timeString = hoursSinceAlert < 1
        ? `${Math.round(hoursSinceAlert * 60)}m`
        : `${hoursSinceAlert.toFixed(1)}h`;

      // Calculate growth rate per hour
      const growthRate = token.currentX / hoursSinceAlert;

      // Format milestones reached
      const milestones = Object.keys(token.reachedMilestones)
        .map(m => m.replace('x', ''))
        .sort((a, b) => parseInt(a) - parseInt(b))
        .join('x, ') + 'x';

      report += `${index + 1}. *${token.symbol}* (${token.currentX.toFixed(1)}x)\n`;
      report += `   • Initial MC: ${token.initialMarketCap.toFixed(2)} SOL\n`;
      report += `   • Current MC: ${token.currentMarketCap.toFixed(2)} SOL\n`;
      report += `   • Growth: ${growthRate.toFixed(2)}x per hour\n`;
      report += `   • Age: ${timeString} since alert\n`;
      report += `   • Milestones: ${milestones || 'None yet'}\n`;
      report += `   • Trend: ${token.isUptrend ? '📈 Uptrend' : '↔️ Neutral'}\n`;
      report += `   • [View on PumpFun](https://pump.fun/coin/${token.mint})\n\n`;
    });

    // Add footer with refresh info
    report += `Updated: ${new Date().toLocaleString()}\n`;
    report += `Use /hotpumps to refresh this list or /toppumps for all-time best performers.`;

    return report;
  } catch (error) {
    console.error('Error generating hot pumps report:', error);
    return '❌ Error generating hot pumps report. Please try again later.';
  }
}

// Add the /hotpumps command handler
bot.onText(/\/hotpumps/, (msg) => {
  const chatId = msg.chat.id;
  const report = generateHotPumpsReport();
  bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
});

bot.onText(/\/toppumps/, (msg) => {
  const chatId = msg.chat.id;

  try {
    // Create data directory if it doesn't exist
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log(`Created data directory: ${DATA_DIR}`);
    }

    // Load previous top pumps data if available
    let allTimeTopPumps = [];
    const topPumpsPath = path.join(DATA_DIR, 'all_time_top_pumps.json');
    if (fs.existsSync(topPumpsPath)) {
      try {
        const fileContent = fs.readFileSync(topPumpsPath, 'utf8');
        if (fileContent && fileContent.trim().length > 0) {
          allTimeTopPumps = JSON.parse(fileContent);
          console.log(`Loaded ${allTimeTopPumps.length} all-time top pump records`);
        } else {
          console.log("All-time top pumps file exists but is empty");
        }
      } catch (error) {
        console.error('Error loading all-time top pumps data:', error);
        // Continue with empty array
        allTimeTopPumps = [];
      }
    }

    console.log("Getting current alerts data...");
    // Get current alerts data
    const currentAlerts = [];

    // Process each alert in alertTracker
    Array.from(alertTracker.entries()).forEach(([mint, data]) => {
      try {
        if (!data || !mint) {
          console.log("Skipping invalid alert entry");
          return;
        }

        console.log(`Processing alert for ${mint.slice(0, 8)}...`);

        // Get token info
        const tokenInfo = tokenRegistry.get(mint);

        // Skip if invalid market cap data
        if (!data.initialMarketCap || data.initialMarketCap <= 0) {
          console.log(`Skipping token with invalid initial market cap: ${mint.slice(0, 8)}`);
          return;
        }

        const currentMC = tokenInfo?.marketCapSol || 0;
        const currentX = currentMC > 0 ? (currentMC / data.initialMarketCap) : 0;

        // Skip if no meaningful gain
        if (currentX <= 0) {
          console.log(`Skipping token with no gain: ${mint.slice(0, 8)} (${currentX.toFixed(2)}x)`);
          return;
        }

        // Calculate time metrics
        const hoursToHighestX = data.timeToMilestones ?
          Object.values(data.timeToMilestones).reduce((max, t) =>
            max > t.hours ? max : t.hours, 0) : 0;

        // Get momentum score (X per hour)
        const momentum = data.highestX > 1 && hoursToHighestX > 0 ?
          (data.highestX - 1) / hoursToHighestX : 0;

        // Time since alert (in hours)
        const hoursSinceAlert = (Date.now() - data.timestamp) / (1000 * 60 * 60);
        const timeSinceStr = hoursSinceAlert < 1
          ? `${Math.round(hoursSinceAlert * 60)}m`
          : `${Math.floor(hoursSinceAlert)}h ${Math.round((hoursSinceAlert % 1) * 60)}m`;

        // Days since alert (for sorting age-based records)
        const daysSinceAlert = hoursSinceAlert / 24;

        console.log(`Alert ${mint.slice(0, 8)}: Current: ${currentX.toFixed(2)}x, Highest: ${(data.highestX || currentX).toFixed(2)}x`);

        // Create alert data object with more detailed info
        const alertData = {
          mint,
          symbol: data.symbol || tokenInfo?.symbol || 'Unknown',
          name: tokenInfo?.name || 'Unknown',
          initialMC: data.initialMarketCap,
          currentMC,
          currentX,
          highestX: data.highestX || currentX,
          highestXTimestamp: data.highestXTimestamp || data.timestamp,
          type: data.type,
          timestamp: data.timestamp,
          hoursSinceAlert,
          daysSinceAlert,
          timeSinceStr,
          dateStr: new Date(data.timestamp).toISOString().split('T')[0], // YYYY-MM-DD format
          milestones: data.reachedMilestones ? Object.keys(data.reachedMilestones).length : 0,
          timeToHighestX: hoursToHighestX,
          momentum: momentum,
          trendStrength: calculateTrendStrength(mint) || 0,
          alertType: data.type,
          initialPrice: tokenInfo?.initialPrice || 0,
          currentPrice: tokenInfo?.currentPrice || 0,
          highestPrice: (tokenInfo?.initialPrice || 0) * (data.highestX || currentX),
          volumeToday: volumeTracker.get(mint) || 0,
          holderCount: uniqueHolders.get(mint)?.size || 0,
          lastUpdated: Date.now()
        };

        currentAlerts.push(alertData);
      } catch (error) {
        console.error(`Error processing alert for ${mint}:`, error);
        // Continue with next alert
      }
    });

    console.log(`Processed ${currentAlerts.length} current alerts`);

    // Update all-time leaderboard - merge with existing data
    currentAlerts.forEach(currentAlert => {
      // Find if this token already exists in all-time records
      const existingIndex = allTimeTopPumps.findIndex(record => record.mint === currentAlert.mint);

      if (existingIndex >= 0) {
        // Update existing record
        const existingRecord = allTimeTopPumps[existingIndex];

        // Keep track of the all-time highest X (never decrease this)
        if (currentAlert.highestX > existingRecord.highestX) {
          console.log(`New all-time high for ${currentAlert.symbol}: ${currentAlert.highestX.toFixed(2)}x (was ${existingRecord.highestX.toFixed(2)}x)`);

          // Update the all-time high and its timestamp
          existingRecord.highestX = currentAlert.highestX;
          existingRecord.highestXTimestamp = currentAlert.highestXTimestamp || Date.now();
          existingRecord.timeToHighestX = currentAlert.timeToHighestX;
          existingRecord.highestPrice = currentAlert.highestPrice;
        }

        // Always update current status
        existingRecord.currentX = currentAlert.currentX;
        existingRecord.currentMC = currentAlert.currentMC;
        existingRecord.currentPrice = currentAlert.currentPrice;
        existingRecord.holderCount = currentAlert.holderCount;
        existingRecord.trendStrength = currentAlert.trendStrength;
        existingRecord.volumeToday = currentAlert.volumeToday;
        existingRecord.lastUpdated = Date.now();

        // Update time since metrics
        existingRecord.hoursSinceAlert = currentAlert.hoursSinceAlert;
        existingRecord.daysSinceAlert = currentAlert.daysSinceAlert;
        existingRecord.timeSinceStr = currentAlert.timeSinceStr;

        // Update maximum momentum if higher
        if (currentAlert.momentum > (existingRecord.momentum || 0)) {
          existingRecord.momentum = currentAlert.momentum;
        }

        // Update holder count if higher
        if (currentAlert.holderCount > (existingRecord.maxHolderCount || 0)) {
          existingRecord.maxHolderCount = currentAlert.holderCount;
        }
      } else {
        // Add new record to all-time list
        const newRecord = {
          ...currentAlert,
          maxHolderCount: currentAlert.holderCount || 0,
          firstTracked: Date.now()
        };
        allTimeTopPumps.push(newRecord);
      }
    });

    console.log(`Total all-time records: ${allTimeTopPumps.length}`);

    // Filter out any bad data and ensure we have valid records
    const validTopPumps = allTimeTopPumps.filter(a =>
      a && a.highestX >= 1.2 && a.initialMC > 0 && a.mint
    );

    console.log(`After filtering, ${validTopPumps.length} valid all-time records`);

    // Store the updated all-time leaderboard persistently
    try {
      fs.writeFileSync(topPumpsPath, JSON.stringify(validTopPumps, null, 2));
      console.log(`Successfully saved ${validTopPumps.length} records to ${topPumpsPath}`);
    } catch (saveError) {
      console.error('Error saving all-time top pumps file:', saveError);
    }

    // Prepare different leaderboard views
    // 1. All-time highest X multiple
    const allTimeHighestX = [...validTopPumps]
      .sort((a, b) => b.highestX - a.highestX)
      .slice(0, 10);

    // 2. Recent champions (within last 7 days) sorted by X
    const recentChampions = [...validTopPumps]
      .filter(a => a.daysSinceAlert <= 7)
      .sort((a, b) => b.highestX - a.highestX)
      .slice(0, 5);

    // 3. Fastest gainers (highest momentum)
    const fastestGainers = [...validTopPumps]
      .filter(a => a.momentum > 0)
      .sort((a, b) => b.momentum - a.momentum)
      .slice(0, 5);

    // 4. Most holders
    const mostHolders = [...validTopPumps]
      .filter(a => a.maxHolderCount > 0)
      .sort((a, b) => b.maxHolderCount - a.maxHolderCount)
      .slice(0, 3);

    // Generate the message
    let pumpsMsg = `🏆 *ALL-TIME TOP PERFORMING TOKENS* 🏆\n\n`;

    if (validTopPumps.length === 0) {
      pumpsMsg += "No significant tokens recorded yet.";
    } else {
      // Format the all-time highest X leaderboard
      pumpsMsg += "📈 *All-Time Highest X Multiple:*\n";
      pumpsMsg += "``````\n";
      pumpsMsg += "Rank | Symbol | Peak X | Current X | Date | MC\n";
      pumpsMsg += "-----|--------|--------|-----------|------|----\n";

      allTimeHighestX.forEach((token, i) => {
        // Format each row
        pumpsMsg += `${(i+1).toString().padStart(2)} | ` +
                   `${token.symbol.padEnd(6)} | ` +
                   `${token.highestX.toFixed(1).padStart(5)}x | ` +
                   `${token.currentX.toFixed(1).padStart(7)}x | ` +
                   `${token.dateStr.padEnd(10)} | ` +
                   `${token.initialMC.toFixed(1)} SOL\n`;
      });
      pumpsMsg += "``````\n";

      // Format the recent champions section
      if (recentChampions.length > 0) {
        pumpsMsg += `\n🔥 *Last 7 Days Champions:*\n`;
        pumpsMsg += "``````\n";
        pumpsMsg += "Symbol | Peak X | Time Since | Age\n";
        pumpsMsg += "-------|--------|------------|----\n";

        recentChampions.forEach((token) => {
          pumpsMsg += `${token.symbol.padEnd(6)} | ` +
                     `${token.highestX.toFixed(1).padStart(5)}x | ` +
                     `${token.timeSinceStr.padStart(10)} | ` +
                     `${token.dateStr}\n`;
        });
        pumpsMsg += "``````\n";
      }

      // Format the fastest gainers section
      if (fastestGainers.length > 0) {
        pumpsMsg += `\n⚡ *Fastest Gainers (X/Hour):*\n`;
        pumpsMsg += "``````\n";
        fastestGainers.forEach((token, i) => {
          const xPerHour = token.momentum > 0 ? token.momentum.toFixed(2) : "0.00";
          const timeToX = token.timeToHighestX ? `${token.timeToHighestX.toFixed(1)}h` : "N/A";

          pumpsMsg += `${i+1}. ${token.symbol}: ${xPerHour}x/hr to reach ${token.highestX.toFixed(1)}x in ${timeToX}\n`;
        });
        pumpsMsg += "``````\n";
      }

      // Add detailed stats for the all-time #1 performer
      if (allTimeHighestX.length > 0) {
        const topToken = allTimeHighestX[0];

        pumpsMsg += `\n👑 *All-Time Top Performer (${topToken.symbol}):*\n`;
        pumpsMsg += "``````\n";
        pumpsMsg += `• Initial alert: ${new Date(topToken.timestamp).toLocaleString()}\n`;
        pumpsMsg += `• All-time high: ${topToken.highestX.toFixed(2)}x\n`;
        pumpsMsg += `• Reached peak: ${new Date(topToken.highestXTimestamp || topToken.timestamp).toLocaleString()}\n`;
        pumpsMsg += `• Current status: ${topToken.currentX.toFixed(2)}x\n`;
        pumpsMsg += `• Initial price: ${topToken.initialPrice?.toFixed(9) || 'Unknown'} SOL\n`;
        pumpsMsg += `• Peak price: ${topToken.highestPrice?.toFixed(9) || 'Unknown'} SOL\n`;
        pumpsMsg += `• Current price: ${topToken.currentPrice?.toFixed(9) || 'Unknown'} SOL\n`;
        pumpsMsg += `• Initial MC: ${topToken.initialMC.toFixed(2)} SOL\n`;
        pumpsMsg += `• Peak MC: ${(topToken.initialMC * topToken.highestX).toFixed(2)} SOL\n`;
        pumpsMsg += `• Current MC: ${topToken.currentMC.toFixed(2)} SOL\n`;
        pumpsMsg += `• Holders: ${topToken.holderCount || 'Unknown'} (max: ${topToken.maxHolderCount || 'Unknown'})\n`;

        // Add Pump.fun link
        pumpsMsg += `• View: [PumpFun](https://pump.fun/coin/${topToken.mint})\n`;
        pumpsMsg += "``````\n";
      }

      // Add overall stats
      const totalAlerts = validTopPumps.length;
      const over2x = validTopPumps.filter(a => a.highestX >= 2).length;
      const over5x = validTopPumps.filter(a => a.highestX >= 5).length;
      const over10x = validTopPumps.filter(a => a.highestX >= 10).length;
      const over20x = validTopPumps.filter(a => a.highestX >= 20).length;
      const over50x = validTopPumps.filter(a => a.highestX >= 50).length;
      const over100x = validTopPumps.filter(a => a.highestX >= 100).length;

      pumpsMsg += `\n📊 *All-Time X Performance Stats:*\n`;
      pumpsMsg += "``````\n";
      pumpsMsg += `• Total tokens tracked: ${totalAlerts}\n`;
      pumpsMsg += `• 2x+: ${over2x} tokens (${totalAlerts > 0 ? ((over2x / totalAlerts) * 100).toFixed(1) : 0}%)\n`;
      pumpsMsg += `• 5x+: ${over5x} tokens (${totalAlerts > 0 ? ((over5x / totalAlerts) * 100).toFixed(1) : 0}%)\n`;
      pumpsMsg += `• 10x+: ${over10x} tokens (${totalAlerts > 0 ? ((over10x / totalAlerts) * 100).toFixed(1) : 0}%)\n`;
      pumpsMsg += `• 20x+: ${over20x} tokens (${totalAlerts > 0 ? ((over20x / totalAlerts) * 100).toFixed(1) : 0}%)\n`;
      pumpsMsg += `• 50x+: ${over50x} tokens (${totalAlerts > 0 ? ((over50x / totalAlerts) * 100).toFixed(1) : 0}%)\n`;
      pumpsMsg += `• 100x+: ${over100x} tokens (${totalAlerts > 0 ? ((over100x / totalAlerts) * 100).toFixed(1) : 0}%)\n`;
      pumpsMsg += "``````\n";

      // Add record holding stats
      pumpsMsg += `\n🌟 *Special Records:*\n`;
      pumpsMsg += "``````\n";

      // Highest momentum ever
      if (fastestGainers.length > 0) {
        const fastestEver = fastestGainers[0];
        pumpsMsg += `• Fastest rise: ${fastestEver.symbol} at ${fastestEver.momentum.toFixed(2)}x per hour\n`;
      }

      // Most holders
      if (mostHolders.length > 0) {
        const holderChamp = mostHolders[0];
        pumpsMsg += `• Most holders: ${holderChamp.symbol} with ${holderChamp.maxHolderCount} holders\n`;
      }

      // Find highest trends
      const trendLeaders = [...validTopPumps]
        .filter(a => a.trendStrength > 0)
        .sort((a, b) => b.trendStrength - a.trendStrength)
        .slice(0, 1);

      if (trendLeaders.length > 0) {
        const trendLeader = trendLeaders[0];
        pumpsMsg += `• Strongest trend: ${trendLeader.symbol} with ${trendLeader.trendStrength} consecutive higher lows\n`;
      }
      pumpsMsg += "``````\n";

      // Commands help
      pumpsMsg += `\n💡 *Commands:*\n`;
      pumpsMsg += `• /toppumps - Show this all-time leaderboard\n`;
      pumpsMsg += `• /hotpumps - View currently active pumps\n`;
      pumpsMsg += `• /token <symbol> - Get details for a specific token\n`;
    }

    // Send the message in chunks if it's too long
    if (pumpsMsg.length > 4000) {
      // Split by sections
      const sections = pumpsMsg.split('\n\n');
      let currentMessage = '';

      for (const section of sections) {
        // If adding this section would exceed limit, send current message and start a new one
        if (currentMessage.length + section.length + 2 > 4000) {
          bot.sendMessage(chatId, currentMessage, { parse_mode: 'Markdown' });
          currentMessage = section + '\n\n';
        } else {
          currentMessage += section + '\n\n';
        }
      }

      // Send any remaining content
      if (currentMessage.length > 0) {
        bot.sendMessage(chatId, currentMessage, { parse_mode: 'Markdown' });
      }
    } else {
      bot.sendMessage(chatId, pumpsMsg, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error('Error in /toppumps command:', error);
    bot.sendMessage(chatId, "❌ Error processing top pumps data. Please check logs for details.");
  }
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(chatId,
    '🤖 *BuildFI Pro Trader Help*\n\n' +
    '*Alert Commands:*\n' +
    '/start - Start receiving alerts\n' +
    '/stop - Stop receiving alerts\n' +
    '/settings - View your settings\n' +
    '/threshold [num] - Set volume threshold\n' +
    '/sentiment [num] - Set sentiment threshold\n' +
    '/holders [num] - Set minimum holder count\n' +
    '/mincap [num] - Set minimum market cap\n' +
    '/maxcap [num] - Set maximum market cap\n' +
    '/buysell [num] - Set min buy/sell ratio\n' +
    '/pricerise [num] - Set min price increase %\n' +
    '/dexpaid - Toggle requiring DEX paid\n' +
    '/monitoring - Toggle continuous monitoring\n' +
    '/togglealerts - Toggle all alerts\n' +
    '/trending - View trending tokens\n' +
    '/analytics - View token metrics\n' +
    '/stats - View alert statistics\n\n' +

    '*Wallet Commands:*\n' +
    '/wallet - View your wallet\n' +
    '/showkey - Display your private key\n\n' +

    '*Trading Commands:*\n' +
    '/autotrade on|off - Toggle auto-trading\n' +
    '/positions - View all active positions\n' +
    '/position [symbol] - View specific position\n' +
    '/tradehistory [num] - View completed trades\n' +
    '/tradingconfig - View trading settings\n' +
    '/profitstats - View profit statistics\n' +
    '/pnlreport [num] - View detailed P/L report\n' +
    '/closeposition [symbol] - Close specific position\n\n' +

    '*Trading Configuration:*\n' +
    '/setinvestment [amount] - Set default SOL per trade\n' +
    '/settp [percent] - Set default take profit %\n' +
    '/setsl [percent] - Set default stop loss %\n' +
    '/maxpositions [num] - Set max active positions\n' +
    '/minmarketcap [amount] - Set min market cap\n' +
    '/trackall on|off - Toggle tracking all tokens\n' +
    '/profitsim - Run profit simulation\n' +
    '/manualentry [symbol] [mint] [price] - Create manual entry\n' +
    '/resettrading - Reset all trading data\n\n' +

    '*Token Analysis:*\n' +
    '/toppumps - See top performing tokens\n' +
    '/trend [symbol] - View token trend analysis\n' +
    '/token [symbol] - Get token details\n\n' +

    '*System Commands:*\n' +
    '/checkfrequency [sec] - Set position check interval\n' +
    '/status - Check system status\n' +
    '/reset - Reset token tracking data\n\n' +

    'For questions or support, contact @CrazySRTguy',
    { parse_mode: 'Markdown' }
  );
});

// Add position check frequency command
bot.onText(/\/checkfrequency (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const isAdmin = chatId === adminChatId;

  if (!isAdmin) {
    bot.sendMessage(chatId, "❌ Admin only command. This command is restricted to the admin user.");
    return;
  }

  const seconds = parseInt(match[1]);

  if (isNaN(seconds) || seconds <= 0) {
    bot.sendMessage(chatId, "❌ Enter a valid positive number.");
    return;
  }

  // Clear existing interval
  if (global.positionCheckInterval) {
    clearInterval(global.positionCheckInterval);
  }

  // Set new interval
  global.positionCheckInterval = setInterval(() => {
    if (global.tradingSystemAPI && typeof global.tradingSystemAPI.checkAllPositions === 'function') {
      global.tradingSystemAPI.checkAllPositions();
    }
  }, seconds * 1000);

  bot.sendMessage(
    chatId,
    `✅ Position checking set to every ${seconds} seconds.`,
    { parse_mode: 'Markdown' }
  );
});

// Save state to file
function saveState() {
  try {
    const state = {
      activeChats: Array.from(activeChats),
      userSettings: Array.from(userSettings.entries()),
      smartMoneyWallets: Array.from(smartMoneyWallets),
      stats: {
        wsMessageCount,
        tokenTradeCount,
        lastSave: Date.now(),
        version: VERSION
      }
    };

    fs.writeFileSync(path.join(DATA_DIR, 'bot_state.json'), JSON.stringify(state, null, 2));
    console.log('Bot state saved');

    // Also save a debug state file with more detailed info
    const debugState = {
      tokenCount: tokenRegistry.size,
      tokensWithTrades: Array.from(tradeHistory.entries()).filter(([_, trades]) => trades.length > 0).length,
      totalTrades: tokenTradeCount,
      websocket: {
        state: ws ? ws.readyState : 'no_connection',
        stateDescription: ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] : 'NO_CONNECTION',
        connectionId: ws ? (ws.connectionId || wsConnectionId || 'unknown') : null,
        lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
        reconnectAttempts: reconnectAttempts,
        isReconnecting: isReconnecting
      },
      trackedTokensList: Array.from(tokenRegistry.keys()),
      lastSave: new Date().toISOString()
    };

    fs.writeFileSync('debug_state.json', JSON.stringify(debugState, null, 2));
  } catch (error) {
    console.error('Error saving bot state:', error);
  }
}

// Load state from file
function loadState() {
  try {
    const statePath = path.join(DATA_DIR, 'bot_state.json');
    if (fs.existsSync(statePath)) {
      const data = fs.readFileSync(statePath, 'utf8');
      const state = JSON.parse(data);

    // Load alert tracking stats
    loadAlertStats();

      // Restore active chats
      if (state.activeChats && Array.isArray(state.activeChats)) {
        state.activeChats.forEach(chatId => activeChats.add(chatId));
        console.log(`Restored ${state.activeChats.length} active chats`);
      }

      // Restore user settings
      if (state.userSettings && Array.isArray(state.userSettings)) {
        state.userSettings.forEach(([chatId, settings]) => {
          userSettings.set(chatId, settings);
        });
        console.log(`Restored settings for ${state.userSettings.length} chats`);
      }

      // Restore smart money wallets
      if (state.smartMoneyWallets && Array.isArray(state.smartMoneyWallets)) {
        state.smartMoneyWallets.forEach(wallet => smartMoneyWallets.add(wallet));
        console.log(`Restored ${state.smartMoneyWallets.length} smart money wallets`);
      }

      // Restore stats
      if (state.stats) {
        if (state.stats.wsMessageCount) wsMessageCount = state.stats.wsMessageCount;
        if (state.stats.tokenTradeCount) tokenTradeCount = state.stats.tokenTradeCount;
        console.log('Restored bot statistics');
      }

      console.log('Bot state loaded successfully');
    }
  } catch (error) {
    console.error('Error loading bot state:', error);
  }
}

// Load token data from file
function loadTokenData() {
  try {
    const tokenPath = path.join(DATA_DIR, 'token_data.json');
    if (fs.existsSync(tokenPath)) {
      const data = fs.readFileSync(tokenPath, 'utf8');
      const tokenData = JSON.parse(data);

      // Restore token registry
      if (tokenData.registry && Array.isArray(tokenData.registry)) {
        tokenData.registry.forEach(([mint, info]) => {
          // Initialize milestone tracking if it doesn't exist
          if (!info.milestoneTracking) {
            info.milestoneTracking = {
              lastTrackedPrice: info.currentPrice || 0,
              achievedMilestones: {},
              initialAlertTime: info.createdAt || Date.now(),
              initialAlertType: 'newToken'
            };
          }

          tokenRegistry.set(mint, info);
        });
        console.log(`Restored data for ${tokenData.registry.length} tokens`);
      }

      // Subscribe to all tokens when connection is established
      const tokenMints = Array.from(tokenRegistry.keys());
      console.log(`Will subscribe to ${tokenMints.length} tokens when connection is established`);

      // Load milestone data after loading token data
      loadMilestoneData();
    }
  } catch (error) {
    console.error('Error loading token data:', error);
  }
}

// Save token data to file
function saveTokenData() {
  try {
    // Only save essential token data to avoid huge files
    const essentialData = Array.from(tokenRegistry.entries()).map(([mint, info]) => {
      // Create a simplified version with only essential fields
      const essential = {
        name: info.name,
        symbol: info.symbol,
        creator: info.creator,
        createdAt: info.createdAt,
        pool: info.pool,
        uri: info.uri,
        logo: info.logo,
        currentPrice: info.currentPrice,
        marketCapSol: info.marketCapSol,
        migratedTo: info.migratedTo,
        metadataFetched: info.metadataFetched,
        // Add milestone tracking data for persistence
        lowestAlertMarketCap: info.lowestAlertMarketCap,
        milestoneTracking: info.milestoneTracking,
        lastCheckedMultiple: info.lastCheckedMultiple
      };

      return [mint, essential];
    });

    const tokenData = {
      registry: essentialData,
      lastSave: Date.now(),
      count: essentialData.length
    };

    fs.writeFileSync(path.join(DATA_DIR, 'token_data.json'), JSON.stringify(tokenData, null, 2));
    console.log(`Token data saved (${essentialData.length} tokens)`);

    // Also save milestone data separately for redundancy
    saveMilestoneData();
  } catch (error) {
    console.error('Error saving token data:', error);
  }
}

// Save milestone data to file
function saveMilestoneData() {
  try {
    // Initialize global milestone tracker if not already done
    if (!global.milestoneTracker) {
      global.milestoneTracker = {
        recentChecks: new Set(),     // For deduplicating checks in a time window (10 seconds)
        recentAlerts: new Map(),     // For tracking which milestone alerts were sent
        lastCleanup: Date.now(),     // Track when we last cleaned up old entries
        cleanupInterval: 300000      // Clean up every 5 minutes (300,000 ms)
      };
      console.log('Initialized global milestone tracker before saving');
    }

    // Ensure recentChecks is a Set
    if (!(global.milestoneTracker.recentChecks instanceof Set)) {
      console.log('Converting recentChecks to Set before saving');
      global.milestoneTracker.recentChecks = new Set(
        Array.isArray(global.milestoneTracker.recentChecks) ?
        global.milestoneTracker.recentChecks : []
      );
    }

    // Ensure recentAlerts is a Map
    if (!(global.milestoneTracker.recentAlerts instanceof Map)) {
      console.log('Converting recentAlerts to Map before saving');
      global.milestoneTracker.recentAlerts = new Map(
        Array.isArray(global.milestoneTracker.recentAlerts) ?
        global.milestoneTracker.recentAlerts : []
      );
    }

    // Create a dedicated milestone data structure
    const milestoneData = {
      // Save global milestone tracker
      globalTracker: {
        recentChecks: Array.from(global.milestoneTracker.recentChecks),
        recentAlerts: Array.from(global.milestoneTracker.recentAlerts.entries()),
        lastCleanup: global.milestoneTracker.lastCleanup || Date.now(),
        cleanupInterval: global.milestoneTracker.cleanupInterval || 300000
      },
      // Save alert stats milestones
      xMilestones: alertStats.xMilestones || {},
      // Save token-specific milestone data
      tokenMilestones: {}
    };

    // Extract milestone data from each token
    Array.from(tokenRegistry.entries()).forEach(([mint, info]) => {
      if (info.milestoneTracking) {
        milestoneData.tokenMilestones[mint] = {
          symbol: info.symbol,
          lowestAlertMarketCap: info.lowestAlertMarketCap,
          milestoneTracking: info.milestoneTracking,
          lastCheckedMultiple: info.lastCheckedMultiple
        };
      }
    });

    // Save to file
    fs.writeFileSync(path.join(DATA_DIR, 'milestone_data.json'), JSON.stringify(milestoneData, null, 2));
    console.log(`Milestone data saved for ${Object.keys(milestoneData.tokenMilestones).length} tokens`);
  } catch (error) {
    console.error('Error saving milestone data:', error);
  }
}

// Load milestone data from file
function loadMilestoneData() {
  try {
    // Initialize global milestone tracker with default values first
    if (!global.milestoneTracker) {
      global.milestoneTracker = {
        recentChecks: new Set(),     // For deduplicating checks in a time window (10 seconds)
        recentAlerts: new Map(),     // For tracking which milestone alerts were sent
        lastCleanup: Date.now(),     // Track when we last cleaned up old entries
        cleanupInterval: 300000      // Clean up every 5 minutes (300,000 ms)
      };
      console.log('Initialized default global milestone tracker');
    } else {
      // Ensure existing tracker has proper data types
      if (!(global.milestoneTracker.recentChecks instanceof Set)) {
        console.log('Converting existing recentChecks to Set');
        global.milestoneTracker.recentChecks = new Set(
          Array.isArray(global.milestoneTracker.recentChecks) ?
          global.milestoneTracker.recentChecks : []
        );
      }

      if (!(global.milestoneTracker.recentAlerts instanceof Map)) {
        console.log('Converting existing recentAlerts to Map');
        global.milestoneTracker.recentAlerts = new Map(
          Array.isArray(global.milestoneTracker.recentAlerts) ?
          global.milestoneTracker.recentAlerts : []
        );
      }
    }

    const milestonePath = path.join(DATA_DIR, 'milestone_data.json');
    if (fs.existsSync(milestonePath)) {
      const data = fs.readFileSync(milestonePath, 'utf8');
      const milestoneData = JSON.parse(data);

      console.log('Loading milestone data from file...');

      // Restore global milestone tracker
      if (milestoneData.globalTracker) {
        try {
          // Convert arrays back to Set and Map
          const recentChecks = new Set(milestoneData.globalTracker.recentChecks || []);
          const recentAlerts = new Map(milestoneData.globalTracker.recentAlerts || []);

          global.milestoneTracker = {
            recentChecks,
            recentAlerts,
            lastCleanup: milestoneData.globalTracker.lastCleanup || Date.now(),
            cleanupInterval: milestoneData.globalTracker.cleanupInterval || 300000
          };

          console.log(`Restored global milestone tracker with ${recentChecks.size} recent checks and ${recentAlerts.size} recent alerts`);
        } catch (err) {
          console.error('Error restoring global milestone tracker, using default:', err);
          // Keep the default initialized above
        }
      }

      // Restore alert stats milestones
      if (milestoneData.xMilestones) {
        alertStats.xMilestones = milestoneData.xMilestones;
        console.log('Restored milestone achievement counts');
      }

      // Restore token-specific milestone data
      if (milestoneData.tokenMilestones) {
        const tokenMints = Object.keys(milestoneData.tokenMilestones);
        let restoredCount = 0;

        tokenMints.forEach(mint => {
          // Only update if the token exists in registry
          if (tokenRegistry.has(mint)) {
            const tokenInfo = tokenRegistry.get(mint);
            const milestoneInfo = milestoneData.tokenMilestones[mint];

            // Update milestone tracking data
            tokenInfo.lowestAlertMarketCap = milestoneInfo.lowestAlertMarketCap;
            tokenInfo.milestoneTracking = milestoneInfo.milestoneTracking;
            tokenInfo.lastCheckedMultiple = milestoneInfo.lastCheckedMultiple;

            tokenRegistry.set(mint, tokenInfo);
            restoredCount++;
          }
        });

        console.log(`Restored milestone data for ${restoredCount} tokens out of ${tokenMints.length} in milestone file`);
      }
    } else {
      console.log('No milestone data file found, using fresh milestone tracking');
    }

    // Final verification that global.milestoneTracker is properly set up
    console.log(`Final milestone tracker state: recentChecks is ${global.milestoneTracker.recentChecks instanceof Set ? 'a Set' : 'NOT a Set'}`);
    console.log(`Final milestone tracker state: recentAlerts is ${global.milestoneTracker.recentAlerts instanceof Map ? 'a Map' : 'NOT a Map'}`);

  } catch (error) {
    console.error('Error loading milestone data:', error);

    // Ensure we have a valid milestone tracker even after errors
    global.milestoneTracker = {
      recentChecks: new Set(),
      recentAlerts: new Map(),
      lastCleanup: Date.now(),
      cleanupInterval: 300000
    };
    console.log('Created fresh milestone tracker after error');
  }
}

// Properly close the WebSocket connection when the process exits
process.on('SIGINT', () => {
  console.log('Received SIGINT. Closing WebSocket connection gracefully...');
  closeWebSocketAndExit();
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Closing WebSocket connection gracefully...');
  closeWebSocketAndExit();
});

// Function to close WebSocket and exit process
function closeWebSocketAndExit() {
  // Save state before exiting
  saveState();
  saveTokenData();
  saveMilestoneData();
  console.log('Saved all milestone data before shutdown');

  // Notify active chats
  broadcastToChats('🔌 *Bot shutting down. WebSocket connection closing.*', { parse_mode: 'Markdown' })
    .then(() => {
      // Close WebSocket connection if it exists
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log('Closing WebSocket connection...');
        ws.close(1000, 'Application shutting down');

        // Give WebSocket some time to close gracefully before exiting
        setTimeout(() => {
          console.log('Exiting process...');
          process.exit(0);
        }, 1000);
      } else {
        console.log('WebSocket was not connected. Exiting process...');
        process.exit(0);
      }
    })
    .catch(error => {
      console.error('Error during shutdown:', error);
      process.exit(1);
    });
}

// Start the bot
function syncMilestonesWithWinPercentage() {
  try {
    console.log('Starting milestone sync with win percentage...');

    if (!alertStats.xMilestones) {
      alertStats.xMilestones = {
        '2x': 0, '3x': 0, '5x': 0, '10x': 0, '20x': 0, '50x': 0, '100x': 0, '500x': 0, '1000x': 0
      };
    }

    // Find highest X milestone
    const xKeys = Object.keys(alertStats.xMilestones)
      .filter(key => alertStats.xMilestones[key] > 0);

    if (xKeys.length > 0) {
      // Extract numeric values from keys like "5x"
      const xValues = xKeys.map(key => {
        const match = key.match(/(\d+)x/);
        return match ? parseInt(match[1]) : 1;
      });

      const highestX = Math.max(...xValues);
      const expectedHighestPercent = (highestX - 1) * 100;

      if (!alertStats.highestWinPercent || expectedHighestPercent > alertStats.highestWinPercent) {
        console.log(`Synchronizing highest win percentage: ${alertStats.highestWinPercent || 0}% -> ${expectedHighestPercent}% based on ${highestX}x milestone`);
        alertStats.highestWinPercent = expectedHighestPercent;
        saveAlertStats();
      }
    }

    // For each type, ensure win rates are calculated correctly
    const alertTypes = ['tokenAlert', 'smartMoney', 'migration'];
    for (const type of alertTypes) {
      if (!alertStats.alertTypes[type]) {
        alertStats.alertTypes[type] = { total: 0, wins: 0, losses: 0 };
      }

      // Calculate win rate for each type
      const total = alertStats.alertTypes[type].wins + alertStats.alertTypes[type].losses;
      const typeWinRate = total > 0 ?
        (alertStats.alertTypes[type].wins / total) * 100 : 0;

      // Store the calculated win rate
      alertStats.alertTypes[type].winRate = typeWinRate.toFixed(2);
      console.log(`Alert type ${type} win rate: ${alertStats.alertTypes[type].winRate}%`);
    }

    // Recalculate overall stats
    if (alertStats.wins + alertStats.losses > 0) {
      alertStats.winRate = (alertStats.wins / (alertStats.wins + alertStats.losses)) * 100;
    } else {
      alertStats.winRate = 0;
    }

    // Find any tokens that have achieved milestones but aren't counted
    let foundMissing = false;
    for (const [mint, alertData] of alertTracker.entries()) {
      if (alertData.highestX >= 2) {
        const milestones = [2, 3, 5, 10, 20, 50, 100, 500, 1000];
        for (const milestone of milestones) {
          if (alertData.highestX >= milestone) {
            const milestoneKey = `${milestone}x`;

            // If this token has achieved milestone but not in reachedMilestones
            if (!alertData.reachedMilestones || !alertData.reachedMilestones[milestoneKey]) {
              console.log(`Found missing milestone: ${alertData.symbol} achieved ${milestoneKey} (${alertData.highestX.toFixed(2)}x) but not tracked`);

              // Update token tracking
              if (!alertData.reachedMilestones) {
                alertData.reachedMilestones = {};
              }
              alertData.reachedMilestones[milestoneKey] = Date.now();

              // Update global milestone counter
              alertStats.xMilestones[milestoneKey] = (alertStats.xMilestones[milestoneKey] || 0) + 1;
              foundMissing = true;
            }
          }
        }
      }
    }

    if (foundMissing) {
      console.log('Added missing milestone achievements to tracking');
      saveAlertStats();
    }

    console.log('Milestone sync complete');
  } catch (error) {
    console.error('Error syncing milestones with win percentage:', error);
  }
}

// Add this helper function to centralize alert sending
async function sendAlertForToken(mint, alertType, additionalData = {}) {
  try {
    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo) {
      console.log(`Cannot send alert - token info not found for ${mint}`);
      return false;
    }

    // Check if token already has an alert
    if (alertsModule.hasAlertedToken(mint)) {
      console.log(`Skipping duplicate ${alertType} alert for ${tokenInfo.symbol || mint} - token already alerted`);
      return false;
    }

    // Create base alert data
    const alertData = {
      mint,
      tokenInfo,
      marketCapSol: tokenInfo.marketCapSol || 0,
      solPriceUsd: global.solPriceUsd,
      ...additionalData
    };

    // Send alert based on type
    let alertSent = false;
    switch (alertType) {
      case 'smart_money':
        alertSent = await alertsModule.createSmartMoneyAlert(alertData);
        break;
      case 'migration':
        alertSent = await alertsModule.createMigrationAlert(alertData);
        break;
      case 'bullish_token':
      default:
        alertSent = await alertsModule.createBullishTokenAlert(alertData);
        break;
    }

    return alertSent;
  } catch (error) {
    console.error(`Error sending ${alertType} alert for ${mint}:`, error);
    return false;
  }
}

function startBot() {
  try {
    console.log(`Starting PumpPortal Pro Trader v${VERSION}...`);

    // Ensure directories exist
    ensureDirectoriesExist();

    // Fetch initial SOL price
    console.log('Fetching initial SOL price...');
    fetchSolPrice().catch(err => console.error('Error fetching SOL price:', err));

    // Load state
    loadState();

    // Load token data
    loadTokenData();

    // Load alert stats
    loadAlertStats();

    // Load milestone data explicitly (although it's also called in loadTokenData)
    loadMilestoneData();

    // Check subscription status after loading data
    setTimeout(() => {
      console.log('Checking subscription status after startup...');
      checkSubscriptionStatus();
    }, 10000); // Wait 10 seconds after startup to check subscriptions

    // Synchronize milestone data with win percentages
    console.log('Synchronizing milestone data with win percentages...');
    syncMilestonesWithWinPercentage();

    // Initialize bundle analyzer
    bundleAnalyzer = bundleAnalyzerModule;

    // Initialize alerts module with all dependencies
    alertsModule.initialize({
      bundleAnalyzerModule,
      walletManagerModule: walletManager,
      broadcastFunc: broadcastToChats,
      trackAlertFunc: trackAlert,
      alertToTradeHookModule: global.tradingSystemAPI,
      tokenRegistryModule: tokenRegistry
    });

    // Set admin chat ID to your ID
    const adminChatId = 5956309039; // Your admin ID

    // Initialize trading system
    global.tradingSystemAPI = tradingSystem.initialize({
      bot,
      adminChatId: adminChatId, // Use your ID as admin
      DATA_DIR,
      tokenRegistry
    });

    console.log('Trading system initialized and connected to alerts');

    // Initialize keyboard manager
    console.log('Initializing keyboard manager...');
    const keyboardManagerAPI = keyboardManager.initialize({
      walletManagerModule: walletManager,
      tokenRegistryModule: tokenRegistry,
      botInstance: bot
    });

    // Initialize keyboard handlers
    console.log('Initializing keyboard handlers...');
    const keyboardHandlersAPI = keyboardHandlers.initialize({
      botInstance: bot,
      keyboardManagerModule: keyboardManagerAPI,
      walletManagerModule: walletManager,
      tokenRegistryModule: tokenRegistry,
      userSettingsMap: userSettings,
      tradingConfigObj: global.tradingSystemAPI.tradingConfig,
      alertsModuleInstance: alertsModule,
      bundleAnalyzerModule: bundleAnalyzer,
      activeChatsSet: activeChats
    });

    // Store references globally for access in command handlers
    global.keyboardManagerAPI = keyboardManagerAPI;
    global.keyboardHandlersAPI = keyboardHandlersAPI;

    // Register existing callback handlers with the keyboard manager
    // This ensures backward compatibility with existing buttons
    keyboardManagerAPI.registerCallbackHandler('copy_key', async (callbackQuery, data, userId, chatId, messageId) => {
      const targetUserId = data.split('_')[2];

      // Security check - only allow users to copy their own keys
      if (userId === targetUserId) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "✅ Private key copied to clipboard!",
          show_alert: true
        });
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "⚠️ Security Alert: You can only copy your own private key",
          show_alert: true
        });
      }
    });

    keyboardManagerAPI.registerCallbackHandler('show_privatekey', async (callbackQuery, data, userId, chatId, messageId) => {
      const requestUserId = data.split('_')[2];

      // Only show private key to the wallet owner
      if (userId !== requestUserId) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'You are not authorized to view this private key.',
          show_alert: true
        });
        return;
      }

      const walletInfo = walletManager.getWalletDetails(userId);
      if (!walletInfo) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Wallet information not found.',
          show_alert: true
        });
        return;
      }

      // Convert private key to array format for Phantom import
      const privateKeyBuffer = Buffer.from(walletInfo.privateKey, 'hex');
      const privateKeyArray = Array.from(privateKeyBuffer);
      const phantomFormat = JSON.stringify(privateKeyArray);

      // Send private key as a separate message with warning
      await bot.answerCallbackQuery(callbackQuery.id);

      // First send the warning and instructions
      await bot.sendMessage(chatId,
        `🔐 *PRIVATE KEY - KEEP SECURE*\n\n` +
        `⚠️ *WARNING:* Never share this key with anyone!\n\n` +
        `To import into Phantom wallet:\n` +
        `1. Copy the key from the following message\n` +
        `2. In Phantom, click "Add/Connect Wallet"\n` +
        `3. Select "Import Private Key"\n` +
        `4. Paste the key and follow the prompts`,
        { parse_mode: 'Markdown' }
      );

      // Then send just the private key as plain text for easy copying
      const keyMessage = await bot.sendMessage(chatId, phantomFormat, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Delete this message for security', callback_data: 'delete_privatekey_msg' }]
          ]
        }
      });

      // Auto-delete after 1 minute for security
      setTimeout(() => {
        try {
          bot.deleteMessage(chatId, keyMessage.message_id).catch(() => {
            console.log('Auto-delete private key message failed');
          });
        } catch (error) {
          console.error('Error auto-deleting private key message:', error);
        }
      }, 60000);
    });

    keyboardManagerAPI.registerCallbackHandler('copy_address', async (callbackQuery, data, userId, chatId, messageId) => {
      const walletAddress = walletManager.getUserWallet(userId);
      if (!walletAddress) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Wallet address not found.' });
        return;
      }

      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Wallet address copied to clipboard!' });
      await bot.sendMessage(chatId, `\`${walletAddress}\``, { parse_mode: 'Markdown' });
    });

    keyboardManagerAPI.registerCallbackHandler('delete_privatekey_msg', async (callbackQuery, data, userId, chatId, messageId) => {
      try {
        await bot.deleteMessage(chatId, messageId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Message deleted for security.' });

        // Try to delete the previous message (instructions) as well
        try {
          await bot.deleteMessage(chatId, messageId - 1);
        } catch (err) {
          // Silently ignore if we can't delete the previous message
          console.log('Could not delete instructions message');
        }
      } catch (error) {
        console.error('Error deleting message:', error);
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Could not delete message. Please delete it manually for security.',
          show_alert: true
        });
      }
    });

    keyboardManagerAPI.registerCallbackHandler('buy', async (callbackQuery, data, userId, chatId, messageId) => {
      const [_, shortMint, amountStr] = data.split('_');
      const amount = parseFloat(amountStr);

      if (isNaN(amount)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Invalid amount' });
        return;
      }

      // Find the full token mint from the shortened version
      let tokenMint = shortMint;
      let tokenName = "Token";

      // Try to find the full mint by prefix
      Array.from(tokenRegistry.entries()).forEach(([mint, info]) => {
        if (mint.startsWith(shortMint)) {
          tokenMint = mint;
          tokenName = info.name || "Token";
        }
      });

      // Get or create user wallet
      let walletAddress = walletManager.getUserWallet(userId);

      if (!walletAddress) {
        const newWallet = walletManager.assignWalletToUser(userId, chatId);
        walletAddress = newWallet.publicKey;
        await bot.sendMessage(chatId, `Created a new wallet for you: \`${walletAddress}\``, { parse_mode: 'Markdown' });
      }

      // Check wallet balance
      const balance = await walletManager.getWalletBalance(walletAddress);

      if (balance < amount) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: `Insufficient balance. You have ${balance.toFixed(4)} SOL, need ${amount} SOL.`,
          show_alert: true
        });
        return;
      }

      // Show processing message
      await bot.sendMessage(chatId, `Processing purchase of ${tokenName} for ${amount} SOL... Please wait.`);

      // Execute the buy transaction
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Processing purchase...' });

      // Use exactly the requested amount - we'll handle fee adjustments in the wallet_manager
      const result = await walletManager.buyToken(userId, tokenMint, amount);

      if (result.success) {
        await bot.sendMessage(chatId,
          `✅ *Transaction Successful*\n\n` +
          `🪙 Token: ${tokenName} \`${tokenMint.substring(0, 6)}...${tokenMint.substring(tokenMint.length - 4)}\`\n` +
          `💰 Amount: ${amount} SOL\n` +
          `🧾 [View Transaction](${result.explorer})\n` +
          `🧾 Transaction ID: \`${result.txId}\``,
          { parse_mode: 'Markdown' }
        );
      } else {
        await bot.sendMessage(chatId,
          `❌ *Transaction Failed*\n\n` +
          `🪙 Token: ${tokenName} \`${tokenMint.substring(0, 6)}...${tokenMint.substring(tokenMint.length - 4)}\`\n` +
          `💰 Amount: ${amount} SOL\n` +
          `❗ Error: ${result.message}`,
          { parse_mode: 'Markdown' }
        );
      }
    });

    console.log('Keyboard manager and handlers initialized with backward compatibility');

    // Add example tokens if registry is empty
    if (tokenRegistry.size === 0) {
      console.log("No tokens in registry. Adding example tokens to ensure trades work...");

      const exampleTokens = [
        "4PBWYjxpsa4C7xod4wNXLYFETRyx5raHGfSZYQLqpump",
        "GHTW9RyZGVnzKpyBbsrYD4rp2Vd6gs7L363VDbuCb1L2"
      ];

      exampleTokens.forEach(mint => {
        tokenRegistry.set(mint, {
          name: `Token_${mint.slice(0, 6)}`,
          symbol: mint.slice(0, 4).toUpperCase(),
          creator: "ExampleTokenCreator",
          createdAt: Date.now(),
          discoveredThrough: 'example',
          currentPrice: 0,
          marketCapSol: 0
        });

        // Initialize tracking data
        volumeTracker.set(mint, 0);
        tradeHistory.set(mint, []);
        priceTracker.set(mint, []);
        uniqueHolders.set(mint, new Set());
        buyVolumeTracker.set(mint, 0);
        sellVolumeTracker.set(mint, 0);
        volumeTimeframes.set(mint, {});
        whaleTracker.set(mint, 0);
        launchTimeTracker.set(mint, Date.now());
        initialPumpTracker.set(mint, {
          initialPrice: 0,
          highestPrice: 0,
          percentageIncrease: 0,
          pumpDetected: false
        });
      });

      console.log(`Added ${exampleTokens.length} example tokens to registry`);
    }

    // Initialize WebSocket connection
    setupWebSocket();

    // Schedule maintenance tasks
    setInterval(saveState, 300000); // Save state every 5 minutes
    setInterval(saveTokenData, 600000); // Save token data every 10 minutes
    setInterval(saveMilestoneData, 300000); // Save milestone data every 5 minutes
    setInterval(cleanupOldData, 24 * 60 * 60 * 1000); // Clean up old data once a day
    setInterval(checkSystemHealth, 60000); // Check system health every 1 minute for better reliability
    // Removed regular checkSubscriptionStatus interval - now only called on reconnect/restart
    setInterval(checkForDuplicateConnections, 600000); // Check for duplicate connections every 10 minutes
    setInterval(fetchSolPrice, 300000); // Update SOL price every 5 minutes

    // Keep-alive ping to prevent disconnections
    setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
          console.log('Sent WebSocket ping to keep connection alive');

          // Re-subscribe to standard messages first
          console.log('Re-subscribing to standard event types...');

          // 1. New token events
          let payload = {
            method: "subscribeNewToken"
          };
          ws.send(JSON.stringify(payload));

          // 2. Migration events
          payload = {
            method: "subscribeMigration"
          };
          ws.send(JSON.stringify(payload));

          // 3. Smart money accounts
          if (smartMoneyWallets.size > 0) {
            payload = {
              method: "subscribeAccountTrade",
              keys: Array.from(smartMoneyWallets)
            };
            ws.send(JSON.stringify(payload));
          }

          // Also subscribe to known tokens again - this is critical for receiving trades
          if (tokenRegistry.size > 0) {
            const knownTokens = Array.from(tokenRegistry.keys());

            // Just send our example tokens first to ensure we get some trades
            const exampleTokens = [
              "4PBWYjxpsa4C7xod4wNXLYFETRyx5raHGfSZYQLqpump",
              "GHTW9RyZGVnzKpyBbsrYD4rp2Vd6gs7L363VDbuCb1L2"
            ];

            const activeExamples = exampleTokens.filter(token => tokenRegistry.has(token));
            if (activeExamples.length > 0) {
              console.log(`Re-subscribing to ${activeExamples.length} example tokens first...`);
              payload = {
                method: "subscribeTokenTrade",
                keys: activeExamples
              };
              ws.send(JSON.stringify(payload));
            }

            // Then subscribe to all other tokens
            console.log(`Re-subscribing to all ${knownTokens.length} known tokens...`);

            // Subscribe in smaller batches to avoid message size limits - using smaller batch size
            const BATCH_SIZE = 5;
            for (let i = 0; i < knownTokens.length; i += BATCH_SIZE) {
              const batch = knownTokens.slice(i, i + BATCH_SIZE);
              payload = {
                method: "subscribeTokenTrade",
                keys: batch
              };
              ws.send(JSON.stringify(payload));
              console.log(`Sent subscription batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(knownTokens.length/BATCH_SIZE)}`);
            }
          } else {
            console.log("No known tokens to subscribe to yet");
          }
        } catch (e) {
          console.error('Error sending ping:', e);
        }
      }
    }, 3000000); // Every 30 seconds

    // Schedule trending reports
    scheduleTrendingReports();

    // Schedule regular milestone sync to fix any discrepancies
    setInterval(syncMilestonesWithWinPercentage, 1800000); // Every 30 minutes

    console.log('Bot successfully started');

    // Send startup message to active chats
    if (activeChats.size > 0) {
      const startupMsg = '🤖 *BuildFI Pro Trader*\n\n' +
                         'Bot has been restarted and is now active.\n' +
                         `Version: *${VERSION}*\n` +
                         'Monitoring for trading opportunities...';

      broadcastToChats(startupMsg, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error('Error starting bot:', error);
  }
}

// Run the bot
startBot();

// Export key functions for programmatic use
module.exports = {
  startBot,
  stopBot: () => {
    if (ws) {
      ws.close();
      console.log("WebSocket connection closed");
    }
    clearInterval(pingInterval);
    console.log("Bot stopped");
  },
  resetTracking,
  broadcastToChats
};