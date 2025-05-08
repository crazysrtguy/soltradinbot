/**
 * Keyboard Handlers Module
 *
 * Provides handlers for keyboard callback queries
 */

// Module state
let bot;
let keyboardManager;
let walletManager;
let tokenRegistry;
let userSettings;
let tradingConfig;
let alertsModule;
let bundleAnalyzer;
let activeChats;

/**
 * Initialize the keyboard handlers
 * @param {Object} dependencies - Module dependencies
 */
function initialize(dependencies) {
  const {
    botInstance,
    keyboardManagerModule,
    walletManagerModule,
    tokenRegistryModule,
    userSettingsMap,
    tradingConfigObj,
    alertsModuleInstance,
    bundleAnalyzerModule,
    activeChatsSet
  } = dependencies;

  bot = botInstance;
  keyboardManager = keyboardManagerModule;
  walletManager = walletManagerModule;
  tokenRegistry = tokenRegistryModule;
  userSettings = userSettingsMap;
  tradingConfig = tradingConfigObj;
  alertsModule = alertsModuleInstance;
  bundleAnalyzer = bundleAnalyzerModule;
  activeChats = activeChatsSet;

  // Register all callback handlers
  registerAllHandlers();

  return {
    // Public methods
    handleCommand
  };
}

/**
 * Register all callback handlers with the keyboard manager
 */
function registerAllHandlers() {
  // Menu navigation handlers
  keyboardManager.registerCallbackHandler('menu', handleMenuNavigation);

  // Settings handlers
  keyboardManager.registerCallbackHandler('settings', handleSettingsAction);

  // Trading handlers
  keyboardManager.registerCallbackHandler('trading', handleTradingAction);

  // Wallet handlers
  keyboardManager.registerCallbackHandler('wallet', handleWalletAction);

  // Token action handlers
  keyboardManager.registerCallbackHandler('buy', handleBuyAction);
  keyboardManager.registerCallbackHandler('sell', handleSellAction);
  keyboardManager.registerCallbackHandler('moonbag', handleMoonbagAction);
  keyboardManager.registerCallbackHandler('target', handleTargetAction);
  keyboardManager.registerCallbackHandler('view', handleViewAction);

  // Default handler for unrecognized actions
  keyboardManager.registerCallbackHandler('default', handleDefaultAction);
}

/**
 * Handle a command from a user
 * @param {Object} msg - Telegram message object
 * @param {string} command - Command name (without the slash)
 * @param {string} args - Command arguments
 */
async function handleCommand(msg, command, args) {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();

  try {
    switch (command) {
      case 'start':
        await handleStartCommand(chatId, userId);
        break;
      case 'menu':
        await handleMenuCommand(chatId);
        break;
      case 'settings':
        await handleSettingsCommand(chatId);
        break;
      case 'trading':
        await handleTradingCommand(chatId);
        break;
      case 'wallet':
        await handleWalletCommand(chatId, userId);
        break;
      // Add more command handlers as needed
      default:
        // Unknown command, show main menu
        await bot.sendMessage(chatId,
          "I don't recognize that command. Here's the main menu:",
          { parse_mode: 'Markdown' }
        );
        await keyboardManager.sendMenuMessage(
          chatId,
          '🤖 *Main Menu*\n\nSelect an option:',
          keyboardManager.getMainMenuKeyboard()
        );
    }
  } catch (error) {
    console.error(`Error handling command /${command}:`, error);
    await bot.sendMessage(chatId,
      "❌ An error occurred while processing your command. Please try again later.",
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Handle the /start command
 * @param {number} chatId - Chat ID
 * @param {string} userId - User ID
 */
async function handleStartCommand(chatId, userId) {
  // Add this chat to active chats
  activeChats.add(chatId);

  // Initialize user settings if needed
  if (!userSettings.has(chatId)) {
    userSettings.set(chatId, {
      volumeThreshold: 1.0, // Default volume threshold
      sentimentThreshold: 50, // Default sentiment threshold
      alertsEnabled: true,
      requireDexPaid: false,
      continuousMonitoring: true,
      minMarketCap: 0,
      maxMarketCap: 0, // 0 means no limit
      minBuySellRatio: 1.3,
      minPriceRise: 40
    });
  }

  // Send welcome message with main menu
  await bot.sendMessage(chatId,
    '🤖 *Welcome to PumpPortal Pro Trader*\n\n' +
    'Bot is now active! You will receive alerts for promising tokens.\n\n' +
    'Use the menu below to navigate:',
    { parse_mode: 'Markdown' }
  );

  await keyboardManager.sendMenuMessage(
    chatId,
    '🤖 *Main Menu*\n\nSelect an option:',
    keyboardManager.getMainMenuKeyboard()
  );
}

/**
 * Handle the /menu command
 * @param {number} chatId - Chat ID
 */
async function handleMenuCommand(chatId) {
  await keyboardManager.sendMenuMessage(
    chatId,
    '🤖 *Main Menu*\n\nSelect an option:',
    keyboardManager.getMainMenuKeyboard()
  );
}

/**
 * Handle the /settings command
 * @param {number} chatId - Chat ID
 */
async function handleSettingsCommand(chatId) {
  const settings = userSettings.get(chatId) || {
    alertsEnabled: true,
    requireDexPaid: false,
    continuousMonitoring: true
  };

  await keyboardManager.sendMenuMessage(
    chatId,
    '⚙️ *Settings*\n\nConfigure your alert preferences:',
    keyboardManager.getSettingsKeyboard(settings)
  );
}

/**
 * Handle the /trading command
 * @param {number} chatId - Chat ID
 */
async function handleTradingCommand(chatId) {
  await keyboardManager.sendMenuMessage(
    chatId,
    '💰 *Trading Menu*\n\nManage your trading activities:',
    keyboardManager.getTradingKeyboard(tradingConfig)
  );
}

/**
 * Handle the /wallet command
 * @param {number} chatId - Chat ID
 * @param {string} userId - User ID
 */
async function handleWalletCommand(chatId, userId) {
  const walletAddress = walletManager.getUserWallet(userId);
  const balance = await walletManager.getWalletBalance(walletAddress);

  const walletMsg = `👛 *Your Wallet*\n\n` +
    `Address: \`${walletAddress}\`\n` +
    `Balance: *${balance.toFixed(4)} SOL*\n\n` +
    `Select an action:`;

  await keyboardManager.sendMenuMessage(
    chatId,
    walletMsg,
    keyboardManager.getWalletActionsKeyboard()
  );
}

/**
 * Handle menu navigation callbacks
 * @param {Object} callbackQuery - Telegram callback query
 * @param {string} data - Callback data
 * @param {string} userId - User ID
 * @param {number} chatId - Chat ID
 * @param {number} messageId - Message ID
 */
async function handleMenuNavigation(callbackQuery, data, userId, chatId, messageId) {
  const menuType = data.split('_')[1];

  try {
    switch (menuType) {
      case 'main':
        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          '🤖 *Main Menu*\n\nSelect an option:',
          keyboardManager.getMainMenuKeyboard()
        );
        break;
      case 'settings':
        const settings = userSettings.get(chatId) || {
          alertsEnabled: true,
          requireDexPaid: false,
          continuousMonitoring: true
        };

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          '⚙️ *Settings*\n\nConfigure your alert preferences:',
          keyboardManager.getSettingsKeyboard(settings)
        );
        break;
      case 'trading':
        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          '💰 *Trading Menu*\n\nManage your trading activities:',
          keyboardManager.getTradingKeyboard(tradingConfig)
        );
        break;
      case 'wallet':
        const walletAddress = walletManager.getUserWallet(userId);
        const balance = await walletManager.getWalletBalance(walletAddress);

        const walletMsg = `👛 *Your Wallet*\n\n` +
          `Address: \`${walletAddress}\`\n` +
          `Balance: *${balance.toFixed(4)} SOL*\n\n` +
          `Select an action:`;

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          walletMsg,
          keyboardManager.getWalletActionsKeyboard()
        );
        break;
      // Add more menu handlers as needed
      default:
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'This menu is not yet implemented.',
          show_alert: true
        });
    }
  } catch (error) {
    console.error('Error handling menu navigation:', error);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'An error occurred while navigating menus.',
      show_alert: true
    });
  }
}

/**
 * Handle settings action callbacks
 * @param {Object} callbackQuery - Telegram callback query
 * @param {string} data - Callback data
 * @param {string} userId - User ID
 * @param {number} chatId - Chat ID
 * @param {number} messageId - Message ID
 */
async function handleSettingsAction(callbackQuery, data, userId, chatId, messageId) {
  const action = data.split('_')[1];
  let settings = userSettings.get(chatId) || {
    volumeThreshold: 1.0,
    sentimentThreshold: 50,
    alertsEnabled: true,
    requireDexPaid: false,
    continuousMonitoring: true,
    minMarketCap: 0,
    maxMarketCap: 0,
    minBuySellRatio: 1.3,
    minPriceRise: 40
  };

  try {
    switch (action) {
      case 'togglealerts':
        settings.alertsEnabled = !settings.alertsEnabled;
        userSettings.set(chatId, settings);

        await bot.answerCallbackQuery(callbackQuery.id, {
          text: `Alerts ${settings.alertsEnabled ? 'enabled' : 'disabled'}.`
        });

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          '⚙️ *Settings*\n\nConfigure your alert preferences:',
          keyboardManager.getSettingsKeyboard(settings)
        );
        break;

      case 'togglemonitoring':
        settings.continuousMonitoring = !settings.continuousMonitoring;
        userSettings.set(chatId, settings);

        await bot.answerCallbackQuery(callbackQuery.id, {
          text: `Continuous monitoring ${settings.continuousMonitoring ? 'enabled' : 'disabled'}.`
        });

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          '⚙️ *Settings*\n\nConfigure your alert preferences:',
          keyboardManager.getSettingsKeyboard(settings)
        );
        break;

      case 'toggledexpaid':
        settings.requireDexPaid = !settings.requireDexPaid;
        userSettings.set(chatId, settings);

        await bot.answerCallbackQuery(callbackQuery.id, {
          text: `DEX Paid requirement ${settings.requireDexPaid ? 'enabled' : 'disabled'}.`
        });

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          '⚙️ *Settings*\n\nConfigure your alert preferences:',
          keyboardManager.getSettingsKeyboard(settings)
        );
        break;

      case 'volume':
        // Send a message asking for the new volume threshold
        await bot.answerCallbackQuery(callbackQuery.id);

        const volumeMsg = await bot.sendMessage(chatId,
          `🔢 *Set Volume Threshold*\n\n` +
          `Current value: *${settings.volumeThreshold} SOL*\n\n` +
          `Please enter a new volume threshold in SOL (e.g., 1.5):`,
          { parse_mode: 'Markdown' }
        );

        // Store the message ID for later reference
        if (!global.settingsPrompts) global.settingsPrompts = {};
        global.settingsPrompts[chatId] = {
          type: 'volume',
          messageId: volumeMsg.message_id,
          settingsMenuId: messageId
        };
        break;

      case 'sentiment':
        // Send a message asking for the new sentiment threshold
        await bot.answerCallbackQuery(callbackQuery.id);

        const sentimentMsg = await bot.sendMessage(chatId,
          `🔢 *Set Sentiment Threshold*\n\n` +
          `Current value: *${settings.sentimentThreshold}*\n\n` +
          `Please enter a new sentiment threshold (0-100):`,
          { parse_mode: 'Markdown' }
        );

        // Store the message ID for later reference
        if (!global.settingsPrompts) global.settingsPrompts = {};
        global.settingsPrompts[chatId] = {
          type: 'sentiment',
          messageId: sentimentMsg.message_id,
          settingsMenuId: messageId
        };
        break;

      case 'mincap':
        // Send a message asking for the new min market cap
        await bot.answerCallbackQuery(callbackQuery.id);

        const minCapMsg = await bot.sendMessage(chatId,
          `🔢 *Set Minimum Market Cap*\n\n` +
          `Current value: *${settings.minMarketCap} SOL*\n\n` +
          `Please enter a new minimum market cap in SOL (e.g., 10):`,
          { parse_mode: 'Markdown' }
        );

        // Store the message ID for later reference
        if (!global.settingsPrompts) global.settingsPrompts = {};
        global.settingsPrompts[chatId] = {
          type: 'mincap',
          messageId: minCapMsg.message_id,
          settingsMenuId: messageId
        };
        break;

      case 'maxcap':
        // Send a message asking for the new max market cap
        await bot.answerCallbackQuery(callbackQuery.id);

        const maxCapMsg = await bot.sendMessage(chatId,
          `🔢 *Set Maximum Market Cap*\n\n` +
          `Current value: *${settings.maxMarketCap} SOL* (0 = no limit)\n\n` +
          `Please enter a new maximum market cap in SOL (e.g., 1000), or 0 for no limit:`,
          { parse_mode: 'Markdown' }
        );

        // Store the message ID for later reference
        if (!global.settingsPrompts) global.settingsPrompts = {};
        global.settingsPrompts[chatId] = {
          type: 'maxcap',
          messageId: maxCapMsg.message_id,
          settingsMenuId: messageId
        };
        break;

      case 'buysell':
        // Send a message asking for the new buy/sell ratio
        await bot.answerCallbackQuery(callbackQuery.id);

        const buySellMsg = await bot.sendMessage(chatId,
          `🔢 *Set Buy/Sell Ratio Threshold*\n\n` +
          `Current value: *${settings.minBuySellRatio}*\n\n` +
          `Please enter a new buy/sell ratio threshold (e.g., 1.5):`,
          { parse_mode: 'Markdown' }
        );

        // Store the message ID for later reference
        if (!global.settingsPrompts) global.settingsPrompts = {};
        global.settingsPrompts[chatId] = {
          type: 'buysell',
          messageId: buySellMsg.message_id,
          settingsMenuId: messageId
        };
        break;

      case 'pricerise':
        // Send a message asking for the new price rise percentage
        await bot.answerCallbackQuery(callbackQuery.id);

        const priceRiseMsg = await bot.sendMessage(chatId,
          `🔢 *Set Price Rise Percentage*\n\n` +
          `Current value: *${settings.minPriceRise}%*\n\n` +
          `Please enter a new price rise percentage (e.g., 40):`,
          { parse_mode: 'Markdown' }
        );

        // Store the message ID for later reference
        if (!global.settingsPrompts) global.settingsPrompts = {};
        global.settingsPrompts[chatId] = {
          type: 'pricerise',
          messageId: priceRiseMsg.message_id,
          settingsMenuId: messageId
        };
        break;

      default:
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'This setting is not yet implemented.',
          show_alert: true
        });
    }
  } catch (error) {
    console.error('Error handling settings action:', error);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'An error occurred while updating settings.',
      show_alert: true
    });
  }
}

// Handler for trading actions
async function handleTradingAction(callbackQuery, data, userId, chatId, messageId) {
  const action = data.split('_')[1];

  try {
    switch (action) {
      case 'toggleauto':
        // Toggle auto-trading
        tradingConfig.autoTrading = !tradingConfig.autoTrading;

        await bot.answerCallbackQuery(callbackQuery.id, {
          text: `Auto-trading ${tradingConfig.autoTrading ? 'enabled' : 'disabled'}.`
        });

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          '💰 *Trading Menu*\n\nManage your trading activities:',
          keyboardManager.getTradingKeyboard(tradingConfig)
        );
        break;

      case 'positions':
        // Show active positions
        await bot.answerCallbackQuery(callbackQuery.id);

        // Get active positions from trading system
        const positions = Array.from(tradingConfig.activePositions || new Map());

        if (positions.length === 0) {
          await keyboardManager.updateMenuMessage(
            chatId,
            messageId,
            '📊 *Active Positions*\n\nNo active positions found.',
            keyboardManager.getBackButton('menu_trading')
          );
          break;
        }

        // Format positions message
        let positionsMsg = '📊 *Active Positions*\n\n';

        // Sort positions by profit percentage (descending)
        positions.sort((a, b) => {
          const [, posA] = a;
          const [, posB] = b;

          const profitA = posA.currentPrice ? ((posA.currentPrice / posA.entryPrice) - 1) * 100 : 0;
          const profitB = posB.currentPrice ? ((posB.currentPrice / posB.entryPrice) - 1) * 100 : 0;

          return profitB - profitA;
        });

        // Create position list
        positions.forEach(([mint, position], index) => {
          const profitPercent = position.currentPrice ?
            ((position.currentPrice / position.entryPrice) - 1) * 100 : 0;

          const profitSign = profitPercent >= 0 ? '+' : '';
          const profitEmoji = profitPercent >= 0 ? '🟢' : '🔴';

          positionsMsg += `${profitEmoji} *${position.symbol}*\n`;
          positionsMsg += `• Entry: ${position.entryPrice.toFixed(9)} SOL\n`;
          positionsMsg += `• Current: ${(position.currentPrice || 0).toFixed(9)} SOL\n`;
          positionsMsg += `• P/L: ${profitSign}${profitPercent.toFixed(2)}%\n`;
          positionsMsg += `• Investment: ${position.investmentAmount.toFixed(3)} SOL\n\n`;

          // Add separator between positions
          if (index < positions.length - 1) {
            positionsMsg += `---\n\n`;
          }
        });

        // Create keyboard with position actions
        const positionsKeyboard = {
          inline_keyboard: [
            [
              { text: '🔄 Refresh Prices', callback_data: 'trading_refreshprices' },
              { text: '🔴 Sell All Positions', callback_data: 'trading_sellall' }
            ],
            [
              { text: '🔙 Back to Trading Menu', callback_data: 'menu_trading' }
            ]
          ]
        };

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          positionsMsg,
          positionsKeyboard
        );
        break;

      case 'history':
        // Show trade history
        await bot.answerCallbackQuery(callbackQuery.id);

        // Get trade history from trading system
        const history = tradingConfig.tradeHistory || [];

        if (history.length === 0) {
          await keyboardManager.updateMenuMessage(
            chatId,
            messageId,
            '📜 *Trade History*\n\nNo completed trades found.',
            keyboardManager.getBackButton('menu_trading')
          );
          break;
        }

        // Format history message
        let historyMsg = '📜 *Recent Trade History*\n\n';

        // Sort history by timestamp (most recent first)
        const sortedHistory = [...history].sort((a, b) => b.exitTimestamp - a.exitTimestamp);

        // Show only the 5 most recent trades
        const recentTrades = sortedHistory.slice(0, 5);

        // Create trade history list
        recentTrades.forEach((trade, index) => {
          const profitSign = trade.profitAmount >= 0 ? '+' : '';
          const profitEmoji = trade.profitAmount >= 0 ? '🟢' : '🔴';
          const date = new Date(trade.exitTimestamp).toLocaleString();

          historyMsg += `${profitEmoji} *${trade.symbol}*\n`;
          historyMsg += `• Exit: ${date}\n`;
          historyMsg += `• Entry price: ${trade.entryPrice.toFixed(9)} SOL\n`;
          historyMsg += `• Exit price: ${trade.exitPrice.toFixed(9)} SOL\n`;
          historyMsg += `• P/L: ${profitSign}${trade.profitAmount.toFixed(3)} SOL (${profitSign}${trade.profitPercent.toFixed(2)}%)\n\n`;

          // Add separator between trades
          if (index < recentTrades.length - 1) {
            historyMsg += `---\n\n`;
          }
        });

        // Add summary
        historyMsg += `Total trades: ${history.length}\n`;

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          historyMsg,
          keyboardManager.getBackButton('menu_trading')
        );
        break;

      case 'profitstats':
        // Show profit statistics
        await bot.answerCallbackQuery(callbackQuery.id);

        // Get profit stats from trading system
        const stats = tradingConfig.profitStats || {
          totalInvested: 0,
          totalReturned: 0,
          totalProfit: 0,
          winCount: 0,
          lossCount: 0,
          activeInvestment: 0
        };

        // Calculate additional metrics
        const totalTrades = stats.winCount + stats.lossCount;
        const winRate = totalTrades > 0 ? (stats.winCount / totalTrades) * 100 : 0;
        const roi = stats.totalInvested > 0 ? (stats.totalProfit / stats.totalInvested) * 100 : 0;

        // Format stats message
        const statsMsg = `💰 *Trading Profit Statistics*\n\n` +
          `• Total profit: ${stats.totalProfit.toFixed(3)} SOL\n` +
          `• Total invested: ${stats.totalInvested.toFixed(3)} SOL\n` +
          `• Total returned: ${stats.totalReturned.toFixed(3)} SOL\n` +
          `• ROI: ${roi.toFixed(2)}%\n\n` +
          `• Win count: ${stats.winCount}\n` +
          `• Loss count: ${stats.lossCount}\n` +
          `• Win rate: ${winRate.toFixed(2)}%\n\n` +
          `• Active investment: ${stats.activeInvestment.toFixed(3)} SOL\n`;

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          statsMsg,
          keyboardManager.getBackButton('menu_trading')
        );
        break;

      case 'pnlreport':
        // Show PnL report
        await bot.answerCallbackQuery(callbackQuery.id);

        // Get trade history from trading system
        const tradeHistory = tradingConfig.tradeHistory || [];

        if (tradeHistory.length === 0) {
          await keyboardManager.updateMenuMessage(
            chatId,
            messageId,
            '📝 *PnL Report*\n\nNo completed trades found.',
            keyboardManager.getBackButton('menu_trading')
          );
          break;
        }

        // Calculate daily PnL
        const dailyPnL = {};
        tradeHistory.forEach(trade => {
          const date = new Date(trade.exitTimestamp).toISOString().split('T')[0];
          if (!dailyPnL[date]) {
            dailyPnL[date] = {
              profit: 0,
              trades: 0,
              wins: 0,
              losses: 0
            };
          }

          dailyPnL[date].profit += trade.profitAmount;
          dailyPnL[date].trades += 1;
          if (trade.profitAmount >= 0) {
            dailyPnL[date].wins += 1;
          } else {
            dailyPnL[date].losses += 1;
          }
        });

        // Format PnL report
        let pnlMsg = '📝 *PnL Report*\n\n';

        // Sort dates (most recent first)
        const sortedDates = Object.keys(dailyPnL).sort().reverse();

        // Show only the 7 most recent days
        const recentDates = sortedDates.slice(0, 7);

        // Create daily PnL list
        recentDates.forEach(date => {
          const day = dailyPnL[date];
          const profitSign = day.profit >= 0 ? '+' : '';
          const profitEmoji = day.profit >= 0 ? '🟢' : '🔴';
          const winRate = day.trades > 0 ? (day.wins / day.trades) * 100 : 0;

          pnlMsg += `${profitEmoji} *${date}*\n`;
          pnlMsg += `• P/L: ${profitSign}${day.profit.toFixed(3)} SOL\n`;
          pnlMsg += `• Trades: ${day.trades} (${day.wins} wins, ${day.losses} losses)\n`;
          pnlMsg += `• Win rate: ${winRate.toFixed(2)}%\n\n`;
        });

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          pnlMsg,
          keyboardManager.getBackButton('menu_trading')
        );
        break;

      case 'config':
        // Show trading configuration
        await bot.answerCallbackQuery(callbackQuery.id);

        // Format config message
        const configMsg = `⚙️ *Trading Configuration*\n\n` +
          `• Auto-trading: ${tradingConfig.autoTrading ? 'Enabled' : 'Disabled'}\n` +
          `• Default investment: ${tradingConfig.defaultInvestment} SOL\n` +
          `• Default take profit: ${tradingConfig.defaultTakeProfit}%\n` +
          `• Default stop loss: ${tradingConfig.defaultStopLoss}%\n` +
          `• Max active positions: ${tradingConfig.maxActivePositions}\n` +
          `• Fees estimate: ${tradingConfig.feesPercent}%\n` +
          `• Slippage estimate: ${tradingConfig.slippageEstimate}%\n` +
          `• Min market cap: ${tradingConfig.minMarketCap} SOL\n`;

        // Create keyboard with config actions
        const configKeyboard = {
          inline_keyboard: [
            [
              {
                text: `🤖 Auto-Trading: ${tradingConfig.autoTrading ? 'ON' : 'OFF'}`,
                callback_data: 'trading_toggleauto'
              }
            ],
            [
              { text: '💰 Set Default Investment', callback_data: 'trading_setinvestment' },
              { text: '📈 Set Take Profit', callback_data: 'trading_settakeprofit' }
            ],
            [
              { text: '🔙 Back to Trading Menu', callback_data: 'menu_trading' }
            ]
          ]
        };

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          configMsg,
          configKeyboard
        );
        break;

      case 'failedsales':
        // Show failed sales
        await bot.answerCallbackQuery(callbackQuery.id);

        // Get failed sales from trading system
        const failedSales = tradingConfig.failedSales || [];

        if (failedSales.length === 0) {
          await keyboardManager.updateMenuMessage(
            chatId,
            messageId,
            '❌ *Failed Sales*\n\nNo failed sales in the queue.',
            keyboardManager.getBackButton('menu_trading')
          );
          break;
        }

        // Format failed sales message
        let failedMsg = '❌ *Failed Sales Queue*\n\n';

        // Create failed sales list
        failedSales.forEach((sale, index) => {
          const date = new Date(sale.timestamp).toLocaleString();

          failedMsg += `*${sale.symbol || 'Unknown'}*\n`;
          failedMsg += `• Mint: ${sale.mint.substring(0, 8)}...\n`;
          failedMsg += `• Failed at: ${date}\n`;
          failedMsg += `• Reason: ${sale.reason || 'Unknown error'}\n`;
          failedMsg += `• Attempts: ${sale.attempts || 1}\n\n`;

          // Add separator between sales
          if (index < failedSales.length - 1) {
            failedMsg += `---\n\n`;
          }
        });

        // Create keyboard with failed sales actions
        const failedKeyboard = {
          inline_keyboard: [
            [
              { text: '🔄 Retry All', callback_data: 'retry_all_failed' },
              { text: '🗑️ Clear Queue', callback_data: 'clear_failed_queue' }
            ],
            [
              { text: '🔙 Back to Trading Menu', callback_data: 'menu_trading' }
            ]
          ]
        };

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          failedMsg,
          failedKeyboard
        );
        break;

      case 'refreshprices':
        // Refresh position prices
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Refreshing position prices...'
        });

        // Call trading system to update all position prices
        if (typeof tradingConfig.forceUpdateAllPositionPrices === 'function') {
          await tradingConfig.forceUpdateAllPositionPrices();
        }

        // Redirect back to positions view
        await handleTradingAction(
          callbackQuery,
          'trading_positions',
          userId,
          chatId,
          messageId
        );
        break;

      case 'sellall':
        // Sell all positions
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Preparing to sell all positions...'
        });

        // Get active positions
        const activePositions = Array.from(tradingConfig.activePositions || new Map());

        if (activePositions.length === 0) {
          await keyboardManager.updateMenuMessage(
            chatId,
            messageId,
            '❌ *Sell All Positions*\n\nNo active positions to sell.',
            keyboardManager.getBackButton('menu_trading')
          );
          break;
        }

        // Confirm message
        const confirmMsg = `⚠️ *Confirm Sell All Positions*\n\n` +
          `You are about to sell ${activePositions.length} active positions.\n\n` +
          `This action cannot be undone. Are you sure?`;

        // Create confirmation keyboard
        const confirmKeyboard = {
          inline_keyboard: [
            [
              { text: '✅ Yes, Sell All', callback_data: 'sell_all_positions' },
              { text: '❌ No, Cancel', callback_data: 'trading_positions' }
            ]
          ]
        };

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          confirmMsg,
          confirmKeyboard
        );
        break;

      case 'setinvestment':
        // Set default investment amount
        await bot.answerCallbackQuery(callbackQuery.id);

        const investmentMsg = await bot.sendMessage(chatId,
          `🔢 *Set Default Investment*\n\n` +
          `Current value: *${tradingConfig.defaultInvestment} SOL*\n\n` +
          `Please enter a new default investment amount in SOL (e.g., 2.0):`,
          { parse_mode: 'Markdown' }
        );

        // Store the message ID for later reference
        if (!global.tradingPrompts) global.tradingPrompts = {};
        global.tradingPrompts[chatId] = {
          type: 'investment',
          messageId: investmentMsg.message_id,
          tradingMenuId: messageId
        };
        break;

      case 'settakeprofit':
        // Set default take profit percentage
        await bot.answerCallbackQuery(callbackQuery.id);

        const takeProfitMsg = await bot.sendMessage(chatId,
          `🔢 *Set Default Take Profit*\n\n` +
          `Current value: *${tradingConfig.defaultTakeProfit}%*\n\n` +
          `Please enter a new default take profit percentage (e.g., 50):`,
          { parse_mode: 'Markdown' }
        );

        // Store the message ID for later reference
        if (!global.tradingPrompts) global.tradingPrompts = {};
        global.tradingPrompts[chatId] = {
          type: 'takeprofit',
          messageId: takeProfitMsg.message_id,
          tradingMenuId: messageId
        };
        break;

      default:
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'This trading action is not yet implemented.',
          show_alert: true
        });
    }
  } catch (error) {
    console.error('Error handling trading action:', error);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'An error occurred while processing trading action.',
      show_alert: true
    });
  }
}

async function handleWalletAction(callbackQuery, data, userId, chatId, messageId) {
  const action = data.split('_')[1];

  try {
    switch (action) {
      case 'showkey':
        // Show private key
        await bot.answerCallbackQuery(callbackQuery.id);

        // Get wallet details
        const walletInfo = walletManager.getWalletDetails(userId);
        if (!walletInfo) {
          await bot.sendMessage(chatId,
            '❌ *Error*\n\nWallet information not found.',
            { parse_mode: 'Markdown' }
          );
          return;
        }

        // Convert private key to array format for Phantom import
        const privateKeyBuffer = Buffer.from(walletInfo.privateKey, 'hex');
        const privateKeyArray = Array.from(privateKeyBuffer);
        const phantomFormat = JSON.stringify(privateKeyArray);

        // Send warning message
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

        // Send private key with delete button
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
        break;

      case 'send':
        // Send SOL to another address
        await bot.answerCallbackQuery(callbackQuery.id);

        // Send message asking for the recipient address
        const sendMsg = await bot.sendMessage(chatId,
          `💸 *Send SOL*\n\n` +
          `Please enter the recipient's wallet address:`,
          { parse_mode: 'Markdown' }
        );

        // Store the message ID for later reference
        if (!global.walletPrompts) global.walletPrompts = {};
        global.walletPrompts[chatId] = {
          type: 'send_address',
          messageId: sendMsg.message_id,
          walletMenuId: messageId
        };
        break;

      case 'refresh':
        // Refresh wallet balance
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Refreshing wallet balance...'
        });

        // Get wallet address and balance
        const walletAddress = walletManager.getUserWallet(userId);
        const balance = await walletManager.getWalletBalance(walletAddress);

        // Update wallet message
        const walletMsg = `👛 *Your Wallet*\n\n` +
          `Address: \`${walletAddress}\`\n` +
          `Balance: *${balance.toFixed(4)} SOL*\n\n` +
          `Select an action:`;

        await keyboardManager.updateMenuMessage(
          chatId,
          messageId,
          walletMsg,
          keyboardManager.getWalletActionsKeyboard()
        );
        break;

      case 'copy':
        // Copy wallet address
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Wallet address copied to clipboard!'
        });

        // Get wallet address
        const address = walletManager.getUserWallet(userId);

        // Send wallet address as plain text for easy copying
        await bot.sendMessage(chatId, `\`${address}\``, { parse_mode: 'Markdown' });
        break;

      default:
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'This wallet action is not yet implemented.',
          show_alert: true
        });
    }
  } catch (error) {
    console.error('Error handling wallet action:', error);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'An error occurred while processing wallet action.',
      show_alert: true
    });
  }
}

async function handleBuyAction(callbackQuery, data, userId, chatId, messageId) {
  try {
    // Parse the data to get token mint and amount
    const parts = data.split('_');
    if (parts.length < 3) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Invalid buy action format.',
        show_alert: true
      });
      return;
    }

    const tokenMint = parts[1];
    const solAmount = parseFloat(parts[2]);

    if (isNaN(solAmount) || solAmount <= 0) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Invalid SOL amount.',
        show_alert: true
      });
      return;
    }

    // Answer callback to show we're processing
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: `Buying token with ${solAmount} SOL...`
    });

    // Update message to show processing
    await bot.editMessageText(
      `🔄 *PROCESSING BUY ORDER*\n\nBuying token with ${solAmount} SOL...\nPlease wait while transaction completes.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      }
    );

    // Execute buy transaction
    try {
      const buyResult = await walletManager.buyToken(userId, tokenMint, solAmount);

      if (!buyResult.success) {
        await bot.editMessageText(
          `❌ *BUY FAILED*\n\nFailed to buy token.\nError: ${buyResult.message}`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown'
          }
        );
        return;
      }

      // Get token info
      const tokenInfo = tokenRegistry.get(tokenMint) || { symbol: 'Unknown' };

      // Format success message
      let resultMsg = `✅ *BUY COMPLETE*\n\n` +
                     `• Token: ${tokenInfo.symbol || 'Unknown'}\n` +
                     `• Amount: ${solAmount} SOL\n`;

      if (buyResult.txId) {
        resultMsg += `\n• [Transaction](${buyResult.explorer}): \`${buyResult.txId.substring(0, 8)}...\`\n`;
      }

      // Send result message
      await bot.editMessageText(resultMsg, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      });

    } catch (error) {
      console.error('Error executing buy transaction:', error);

      await bot.editMessageText(
        `❌ *BUY ERROR*\n\nAn error occurred while buying the token:\n${error.message}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        }
      );
    }

  } catch (error) {
    console.error('Error handling buy action:', error);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'An error occurred while processing buy action.',
      show_alert: true
    });
  }
}

async function handleSellAction(callbackQuery, data, userId, chatId, messageId) {
  try {
    // Parse the data to get token mint
    const parts = data.split('_');
    if (parts.length < 3) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Invalid sell action format.',
        show_alert: true
      });
      return;
    }

    const action = parts[1]; // 'all' or specific amount
    const tokenMint = parts[2];

    // Answer callback to show we're processing
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: `Selling token...`
    });

    // Update message to show processing
    await bot.editMessageText(
      `🔄 *PROCESSING SELL ORDER*\n\nSelling token...\nPlease wait while transaction completes.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      }
    );

    // Execute sell transaction
    try {
      // If this is a position from the trading system
      if (tradingConfig.activePositions && tradingConfig.activePositions.has(tokenMint)) {
        // Get position information
        const position = tradingConfig.activePositions.get(tokenMint);

        // Get current price from token registry
        const tokenInfo = tokenRegistry.get(tokenMint);
        const currentPrice = tokenInfo?.currentPrice || position.entryPrice;

        // Close position (which will execute sell if autoTrading is enabled)
        const closedTrade = tradingConfig.closePosition(tokenMint, 'manual_button', currentPrice);

        if (!closedTrade) {
          await bot.editMessageText(
            `❌ *SELL FAILED*\n\nFailed to sell ${position.symbol} tokens. Please try again or check logs.`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown'
            }
          );
          return;
        }

        // Format success message
        const profitSign = closedTrade.profitAmount >= 0 ? '+' : '';
        const profitColor = closedTrade.profitAmount >= 0 ? '🟢' : '🔴';

        let resultMsg = `${profitColor} *SELL COMPLETE: ${closedTrade.symbol}*\n\n` +
                       `• Exit price: ${closedTrade.exitPrice.toFixed(9)} SOL\n` +
                       `• Entry price: ${closedTrade.entryPrice.toFixed(9)} SOL\n` +
                       `• Investment: ${closedTrade.investmentAmount.toFixed(3)} SOL\n` +
                       `• Return: ${closedTrade.returnAmount.toFixed(3)} SOL\n` +
                       `• P/L: ${profitSign}${closedTrade.profitAmount.toFixed(3)} SOL (${profitSign}${closedTrade.profitPercent.toFixed(2)}%)\n`;

        if (closedTrade.sellTxId) {
          resultMsg += `\n• [Transaction](${closedTrade.sellTxUrl}): \`${closedTrade.sellTxId.substring(0, 8)}...\`\n`;
        }

        // Send result message
        await bot.editMessageText(resultMsg, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });
      } else {
        // Regular wallet sell
        const sellResult = await walletManager.sellToken(userId, tokenMint);

        if (!sellResult.success) {
          await bot.editMessageText(
            `❌ *SELL FAILED*\n\nFailed to sell token.\nError: ${sellResult.message}`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown'
            }
          );
          return;
        }

        // Get token info
        const tokenInfo = tokenRegistry.get(tokenMint) || { symbol: 'Unknown' };

        // Format success message
        let resultMsg = `✅ *SELL COMPLETE*\n\n` +
                       `• Token: ${tokenInfo.symbol || 'Unknown'}\n` +
                       `• Amount: ${sellResult.amount || 'All'}\n` +
                       `• Return: ${sellResult.solAmount?.toFixed(3) || 'Unknown'} SOL\n`;

        if (sellResult.txId) {
          resultMsg += `\n• [Transaction](${sellResult.explorer}): \`${sellResult.txId.substring(0, 8)}...\`\n`;
        }

        // Send result message
        await bot.editMessageText(resultMsg, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });
      }

    } catch (error) {
      console.error('Error executing sell transaction:', error);

      await bot.editMessageText(
        `❌ *SELL ERROR*\n\nAn error occurred while selling the token:\n${error.message}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        }
      );
    }

  } catch (error) {
    console.error('Error handling sell action:', error);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'An error occurred while processing sell action.',
      show_alert: true
    });
  }
}

async function handleMoonbagAction(callbackQuery, data, userId, chatId, messageId) {
  try {
    // Parse the data to get token mint
    const parts = data.split('_');
    if (parts.length < 2) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Invalid moonbag action format.',
        show_alert: true
      });
      return;
    }

    const tokenMint = parts[1];

    // Check if position exists
    if (!tradingConfig.activePositions || !tradingConfig.activePositions.has(tokenMint)) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Position not found. It may have been closed already.',
        show_alert: true
      });
      return;
    }

    // Get position information
    const position = tradingConfig.activePositions.get(tokenMint);

    // Answer callback to show we're processing
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Saving 25% moonbag...'
    });

    // Update message to show processing
    await bot.editMessageText(
      `🔄 *PROCESSING PARTIAL SELL*\n\nSelling 75% of ${position.symbol} tokens...\nKeeping 25% as moonbag.\nPlease wait while transaction completes.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      }
    );

    // Check if auto-trading is enabled
    if (!tradingConfig.autoTrading) {
      await bot.editMessageText(
        `❌ *MOONBAG FEATURE REQUIRES AUTO-TRADING*\n\nPlease enable auto-trading with /autotrade on first.`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        }
      );
      return;
    }

    try {
      // Calculate token amount to sell (75% of total)
      const sellAmount = position.tokenAmount * 0.75;

      // Get current price from token registry
      const tokenInfo = tokenRegistry.get(tokenMint);
      const currentPrice = tokenInfo?.currentPrice || position.entryPrice;

      // Execute partial sell transaction
      const sellResult = await walletManager.sellToken(
        userId,
        tokenMint,
        sellAmount // Specific amount (75% of tokens)
      );

      if (!sellResult.success) {
        await bot.editMessageText(
          `❌ *PARTIAL SELL FAILED*\n\nFailed to sell partial amount of ${position.symbol} tokens.\nError: ${sellResult.message}`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown'
          }
        );
        return;
      }

      // Calculate return based on sold amount
      const soldValue = sellAmount * currentPrice;
      const returnRatio = soldValue / (position.investmentAmount * 0.75);
      const profitAmount = soldValue - (position.investmentAmount * 0.75);
      const profitPercent = (profitAmount / (position.investmentAmount * 0.75)) * 100;

      // Update position to reflect remaining tokens (25%)
      position.tokenAmount = position.tokenAmount * 0.25;
      position.investmentAmount = position.investmentAmount * 0.25;
      position.moonbagSaved = true;
      position.moonbagTimestamp = Date.now();
      position.moonbagExitPrice = currentPrice;

      // Format success message
      const profitSign = profitAmount >= 0 ? '+' : '';
      const profitColor = profitAmount >= 0 ? '🟢' : '🔴';

      let resultMsg = `${profitColor} *MOONBAG SAVED: ${position.symbol}*\n\n` +
                     `• Sold: 75% of position (${(sellAmount).toFixed(0)} tokens)\n` +
                     `• Exit price: ${currentPrice.toFixed(9)} SOL\n` +
                     `• Return: ${soldValue.toFixed(3)} SOL\n` +
                     `• P/L: ${profitSign}${profitAmount.toFixed(3)} SOL (${profitSign}${profitPercent.toFixed(2)}%)\n\n` +
                     `🔮 *MOONBAG SAVED*\n` +
                     `• Remaining: ${position.tokenAmount.toFixed(0)} tokens (25%)\n` +
                     `• Investment remaining: ${position.investmentAmount.toFixed(3)} SOL\n`;

      if (sellResult.txId) {
        resultMsg += `\n• [Transaction](${sellResult.explorer}): \`${sellResult.txId.substring(0, 8)}...\`\n`;
      }

      // Add buttons for setting moonbag sell targets
      const moonbagKeyboard = {
        inline_keyboard: [
          [
            { text: '✨ 5x Target', callback_data: `target_${tokenMint}_5` },
            { text: '🚀 10x Target', callback_data: `target_${tokenMint}_10` },
            { text: '🌕 20x Target', callback_data: `target_${tokenMint}_20` }
          ],
          [
            { text: '🔴 Sell Moonbag', callback_data: `sell_all_${tokenMint}` }
          ]
        ]
      };

      // Send result message
      await bot.editMessageText(resultMsg, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: moonbagKeyboard
      });

    } catch (error) {
      console.error('Error in moonbag action:', error);

      await bot.editMessageText(
        `❌ *MOONBAG ERROR*\n\nAn error occurred: ${error.message}\nPlease try again or check logs.`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        }
      );
    }

  } catch (error) {
    console.error('Error handling moonbag action:', error);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'An error occurred while processing moonbag action.',
      show_alert: true
    });
  }
}

async function handleTargetAction(callbackQuery, data, userId, chatId, messageId) {
  try {
    // Parse the data to get token mint and multiplier
    const parts = data.split('_');
    if (parts.length < 3) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Invalid target action format.',
        show_alert: true
      });
      return;
    }

    const tokenMint = parts[1];
    const multiplier = parseInt(parts[2]);

    if (isNaN(multiplier) || multiplier <= 0) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Invalid multiplier value.',
        show_alert: true
      });
      return;
    }

    // Check if position exists
    if (!tradingConfig.activePositions || !tradingConfig.activePositions.has(tokenMint)) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Position not found. It may have been closed already.',
        show_alert: true
      });
      return;
    }

    // Get position information
    const position = tradingConfig.activePositions.get(tokenMint);

    // Set target as a multiple of entry price
    const targetPrice = position.entryPrice * multiplier;

    // Update position with target
    position.customTarget = targetPrice;
    position.customTargetMultiplier = multiplier;
    position.customTargetSet = Date.now();

    // Answer callback
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: `${multiplier}x target set! Will sell at ${targetPrice.toFixed(9)} SOL`,
      show_alert: true
    });

    // Try to update the message with target information
    try {
      // Get current message text
      const message = await bot.getChat(chatId, messageId);
      const messageText = message.text || '';

      // Add target info if not already present
      if (!messageText.includes('Target set')) {
        const updatedText = messageText + `\n\n🎯 *${multiplier}x Target Set*: Will sell at ${targetPrice.toFixed(9)} SOL`;

        await bot.editMessageText(updatedText, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: message.reply_markup
        });
      }
    } catch (error) {
      console.error('Error updating message with target info:', error);
      // Continue without updating the message
    }

  } catch (error) {
    console.error('Error handling target action:', error);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'An error occurred while processing target action.',
      show_alert: true
    });
  }
}

async function handleViewAction(callbackQuery, data, userId, chatId, messageId) {
  try {
    // Parse the data to get view type and token mint
    const parts = data.split('_');
    if (parts.length < 3) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Invalid view action format.',
        show_alert: true
      });
      return;
    }

    const viewType = parts[1]; // 'position', 'token', etc.
    const tokenMint = parts[2];

    // Answer callback to show we're processing
    await bot.answerCallbackQuery(callbackQuery.id);

    if (viewType === 'position') {
      // Check if position exists
      if (!tradingConfig.activePositions || !tradingConfig.activePositions.has(tokenMint)) {
        await bot.sendMessage(chatId,
          '❌ *Position Not Found*\n\nThis position may have been closed already.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Get position information
      const position = tradingConfig.activePositions.get(tokenMint);

      // Get token info
      const tokenInfo = tokenRegistry.get(tokenMint) || {};

      // Calculate profit percentage
      const profitPercent = position.currentPrice ?
        ((position.currentPrice / position.entryPrice) - 1) * 100 : 0;

      const profitSign = profitPercent >= 0 ? '+' : '';
      const profitEmoji = profitPercent >= 0 ? '🟢' : '🔴';

      // Format position details
      const positionMsg = `${profitEmoji} *Position Details: ${position.symbol}*\n\n` +
                         `• Entry price: ${position.entryPrice.toFixed(9)} SOL\n` +
                         `• Current price: ${(position.currentPrice || 0).toFixed(9)} SOL\n` +
                         `• P/L: ${profitSign}${profitPercent.toFixed(2)}%\n` +
                         `• Investment: ${position.investmentAmount.toFixed(3)} SOL\n` +
                         `• Token amount: ${position.tokenAmount.toFixed(0)}\n` +
                         `• Entry time: ${new Date(position.entryTimestamp).toLocaleString()}\n` +
                         `• Holding time: ${formatDuration(Date.now() - position.entryTimestamp)}\n\n` +
                         `• Market cap: ${(tokenInfo.marketCapSol || 0).toFixed(2)} SOL\n` +
                         `• Holders: ${tokenInfo.holderCount || 'Unknown'}\n`;

      // Create keyboard with position actions
      const positionKeyboard = keyboardManager.getTokenActionsKeyboard(tokenMint);

      // Send position details
      await bot.sendMessage(chatId, positionMsg, {
        parse_mode: 'Markdown',
        reply_markup: positionKeyboard
      });
    } else {
      await bot.sendMessage(chatId,
        `❌ *View Type Not Supported*\n\nThe view type "${viewType}" is not supported.`,
        { parse_mode: 'Markdown' }
      );
    }

  } catch (error) {
    console.error('Error handling view action:', error);
    await bot.sendMessage(chatId,
      `❌ *Error*\n\nAn error occurred while viewing details: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

async function handleDefaultAction(callbackQuery, data, userId, chatId, messageId) {
  // Handle any callback queries that don't match other handlers
  await bot.answerCallbackQuery(callbackQuery.id, {
    text: 'This action is not recognized.',
    show_alert: true
  });
}

// Helper function to format duration
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

module.exports = {
  initialize
};
