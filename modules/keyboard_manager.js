/**
 * Keyboard Manager Module
 * 
 * Provides a centralized system for creating and managing Telegram inline keyboards
 * and handling callback queries for the trading bot.
 */

// Dependencies
const TelegramBot = require('node-telegram-bot-api');

// Module state
let walletManager;
let tokenRegistry;
let bot;
let callbackHandlers = {};

/**
 * Initialize the keyboard manager
 * @param {Object} dependencies - Module dependencies
 */
function initialize(dependencies) {
  const {
    walletManagerModule,
    tokenRegistryModule,
    botInstance
  } = dependencies;

  walletManager = walletManagerModule;
  tokenRegistry = tokenRegistryModule;
  bot = botInstance;

  // Register the callback query handler
  setupCallbackQueryHandler();

  return {
    // Keyboard generators
    getMainMenuKeyboard,
    getSettingsKeyboard,
    getTradingKeyboard,
    getTokenActionsKeyboard,
    getWalletActionsKeyboard,
    getInstabuyKeyboard,
    getBackButton,
    
    // Callback registration
    registerCallbackHandler,
    
    // Utility functions
    sendMenuMessage,
    updateMenuMessage
  };
}

/**
 * Setup the callback query handler
 */
function setupCallbackQueryHandler() {
  if (!bot) {
    console.error('Cannot setup callback handler: bot instance not provided');
    return;
  }

  bot.on('callback_query', async (callbackQuery) => {
    const userId = callbackQuery.from.id.toString();
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    
    console.log(`Received callback query: ${data} from user ${userId} in chat ${chatId}`);
    
    try {
      // Extract the action prefix (everything before the first underscore)
      const actionPrefix = data.includes('_') ? data.split('_')[0] : data;
      
      // Find the appropriate handler
      const handler = callbackHandlers[actionPrefix] || callbackHandlers['default'];
      
      if (handler) {
        await handler(callbackQuery, data, userId, chatId, messageId);
      } else {
        // No handler found, provide a generic response
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'This action is not yet implemented.',
          show_alert: true
        });
      }
    } catch (error) {
      console.error('Error handling callback query:', error);
      
      // Provide a generic error response
      try {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'An error occurred while processing your request.',
          show_alert: true
        });
      } catch (answerError) {
        console.error('Error sending callback answer:', answerError);
      }
    }
  });
}

/**
 * Register a callback handler for a specific action prefix
 * @param {string} actionPrefix - The action prefix to handle (e.g., 'buy', 'settings')
 * @param {Function} handler - The handler function
 */
function registerCallbackHandler(actionPrefix, handler) {
  callbackHandlers[actionPrefix] = handler;
  console.log(`Registered callback handler for action prefix: ${actionPrefix}`);
}

/**
 * Get the main menu keyboard
 * @returns {Object} Telegram inline keyboard markup
 */
function getMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '💰 Trading', callback_data: 'menu_trading' },
        { text: '⚙️ Settings', callback_data: 'menu_settings' }
      ],
      [
        { text: '📊 Stats', callback_data: 'menu_stats' },
        { text: '👛 My Wallet', callback_data: 'menu_wallet' }
      ],
      [
        { text: '📈 Trending Tokens', callback_data: 'menu_trending' },
        { text: '🔍 System Status', callback_data: 'menu_status' }
      ]
    ]
  };
}

/**
 * Get the settings menu keyboard
 * @returns {Object} Telegram inline keyboard markup
 */
function getSettingsKeyboard(settings) {
  const alertsStatus = settings?.alertsEnabled ? '✅ ON' : '❌ OFF';
  const dexPaidStatus = settings?.requireDexPaid ? '✅ ON' : '❌ OFF';
  const monitoringStatus = settings?.continuousMonitoring ? '✅ ON' : '❌ OFF';
  
  return {
    inline_keyboard: [
      [
        { text: `🔔 Alerts: ${alertsStatus}`, callback_data: 'settings_togglealerts' },
        { text: `🔄 Monitoring: ${monitoringStatus}`, callback_data: 'settings_togglemonitoring' }
      ],
      [
        { text: `💸 Require DEX Paid: ${dexPaidStatus}`, callback_data: 'settings_toggledexpaid' }
      ],
      [
        { text: '📊 Volume Threshold', callback_data: 'settings_volume' },
        { text: '😊 Sentiment Threshold', callback_data: 'settings_sentiment' }
      ],
      [
        { text: '💰 Min Market Cap', callback_data: 'settings_mincap' },
        { text: '💰 Max Market Cap', callback_data: 'settings_maxcap' }
      ],
      [
        { text: '📈 Buy/Sell Ratio', callback_data: 'settings_buysell' },
        { text: '📈 Price Rise %', callback_data: 'settings_pricerise' }
      ],
      [
        { text: '🔙 Back to Main Menu', callback_data: 'menu_main' }
      ]
    ]
  };
}

/**
 * Get the trading menu keyboard
 * @returns {Object} Telegram inline keyboard markup
 */
function getTradingKeyboard(tradingConfig) {
  const autoTradingStatus = tradingConfig?.autoTrading ? '✅ ON' : '❌ OFF';
  
  return {
    inline_keyboard: [
      [
        { text: `🤖 Auto-Trading: ${autoTradingStatus}`, callback_data: 'trading_toggleauto' }
      ],
      [
        { text: '📊 Active Positions', callback_data: 'trading_positions' },
        { text: '📜 Trade History', callback_data: 'trading_history' }
      ],
      [
        { text: '💰 Profit Stats', callback_data: 'trading_profitstats' },
        { text: '📝 PnL Report', callback_data: 'trading_pnlreport' }
      ],
      [
        { text: '⚙️ Trading Config', callback_data: 'trading_config' },
        { text: '❌ Failed Sales', callback_data: 'trading_failedsales' }
      ],
      [
        { text: '🔙 Back to Main Menu', callback_data: 'menu_main' }
      ]
    ]
  };
}

/**
 * Get token actions keyboard
 * @param {string} mint - Token mint address
 * @returns {Object} Telegram inline keyboard markup
 */
function getTokenActionsKeyboard(mint) {
  // Limit token mint length to avoid callback_data size limit
  const shortMint = mint.substring(0, 16);
  
  return {
    inline_keyboard: [
      [
        { text: '🔴 Sell All', callback_data: `sell_all_${shortMint}` },
        { text: '📈 Save Moonbag (25%)', callback_data: `moonbag_${shortMint}` }
      ],
      [
        { text: '2x Target', callback_data: `target_${shortMint}_2` },
        { text: '5x Target', callback_data: `target_${shortMint}_5` },
        { text: '10x Target', callback_data: `target_${shortMint}_10` }
      ],
      [
        { text: '📊 View Position', callback_data: `view_position_${shortMint}` },
        { text: '🔙 Back', callback_data: 'trading_positions' }
      ]
    ]
  };
}

/**
 * Get wallet actions keyboard
 * @returns {Object} Telegram inline keyboard markup
 */
function getWalletActionsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔑 Show Private Key', callback_data: 'wallet_showkey' },
        { text: '💸 Send SOL', callback_data: 'wallet_send' }
      ],
      [
        { text: '🔄 Refresh Balance', callback_data: 'wallet_refresh' },
        { text: '📋 Copy Address', callback_data: 'wallet_copy' }
      ],
      [
        { text: '🔙 Back to Main Menu', callback_data: 'menu_main' }
      ]
    ]
  };
}

/**
 * Get instabuy keyboard for a token
 * @param {string} tokenMint - Token mint address
 * @returns {Object} Telegram inline keyboard markup
 */
function getInstabuyKeyboard(tokenMint) {
  // Limit token mint length to avoid callback_data size limit
  const shortMint = tokenMint.substring(0, 16);
  
  return {
    inline_keyboard: [
      [
        { text: '🪙 Buy with 0.05 SOL', callback_data: `buy_${shortMint}_0.05` },
        { text: '🪙 Buy with 0.1 SOL', callback_data: `buy_${shortMint}_0.1` }
      ],
      [
        { text: '🪙 Buy with 0.5 SOL', callback_data: `buy_${shortMint}_0.5` },
        { text: '🪙 Buy with 1 SOL', callback_data: `buy_${shortMint}_1.0` }
      ],
      [
        { text: '💼 View My Wallet', callback_data: 'menu_wallet' }
      ]
    ]
  };
}

/**
 * Get a back button
 * @param {string} destination - Destination menu
 * @returns {Object} Telegram inline keyboard markup
 */
function getBackButton(destination = 'menu_main') {
  return {
    inline_keyboard: [
      [
        { text: '🔙 Back', callback_data: destination }
      ]
    ]
  };
}

/**
 * Send a message with a menu keyboard
 * @param {number} chatId - Chat ID to send the message to
 * @param {string} text - Message text
 * @param {Object} keyboard - Keyboard markup
 * @returns {Promise<Object>} Sent message
 */
async function sendMenuMessage(chatId, text, keyboard) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

/**
 * Update an existing message with a new menu
 * @param {number} chatId - Chat ID
 * @param {number} messageId - Message ID to update
 * @param {string} text - New message text
 * @param {Object} keyboard - New keyboard markup
 * @returns {Promise<Object>} Updated message
 */
async function updateMenuMessage(chatId, messageId, text, keyboard) {
  return bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

module.exports = {
  initialize
};
