// trading-system.js - Complete implementation for profit tracking and trading system
const path = require('path');
const fs = require('fs');

// Configuration object for profit tracking settings
const tradingConfig = {
  defaultInvestment: 2.0, // Default SOL amount to invest per token
  defaultTakeProfit: 50, // Default take profit percentage (50%)
  defaultStopLoss: 30, // Default stop loss percentage (30%)
  autoTrading: false, // Whether to enable auto trading (default off)
  notifyOnSignals: false, // Whether to notify on buy/sell signals (default off)
  showAutoTradingMessages: true, // Whether to display auto trading messages in console
  maxActivePositions: 100, // Maximum number of active positions to prevent overexposure
  feesPercent: 0.5, // Estimated trading fees in percentage
  slippageEstimate: 2, // Estimated slippage in percentage for calculations
  trackAllTokens: false, // Whether to track all tokens or only selected ones
  trackedTokens: new Set(), // Set of mints to track if not tracking all
  minMarketCap: 0.5, // Minimum market cap in SOL to consider for trading
  tradeHistory: [], // Array to store all completed trades
  activePositions: new Map(), // Map to store all active positions
  profitStats: {
    totalInvested: 0,
    totalReturned: 0,
    totalProfit: 0,
    winCount: 0,
    lossCount: 0,
    activeInvestment: 0
  }
};

// Module references
let bot, adminChatId, DATA_DIR, tokenRegistry;

// Initialize module with dependencies
function initialize(config) {
  ({
    bot,
    adminChatId,
    DATA_DIR,
    tokenRegistry
  } = config);

  loadTradingConfig();
  setupTradingCommands();
  setupCallbackHandlers();

  // Set up a periodic check for position status (every 5 seconds)
  setInterval(checkAllPositions, 5 * 1000);

  // Set up periodic retries for failed sales (every 10 minutes)
  setInterval(retryFailedSales, 10 * 60 * 1000);

  console.log('Trading system initialized');
  console.log(`Auto-trading is ${tradingConfig.autoTrading ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Auto-trading messages are ${tradingConfig.showAutoTradingMessages ? 'ENABLED' : 'DISABLED'}`);

  return {
    tradingConfig,
    processAlertForTrading,
    checkPosition,
    checkAllPositions,
    closePosition,
    updateProfitStats,
    hookIntoAlertTracker,
    retryFailedSales,
    forceUpdateAllPositionPrices // Add new function to API
  };
}

// Setup callback handlers for trade operations
function setupCallbackHandlers() {
  // Handler for callback queries (button clicks)
  bot.on('callback_query', async (callbackQuery) => {
    const callbackData = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;

    try {
      // Only process if from admin chat
      if (chatId !== adminChatId) {
        bot.answerCallbackQuery(callbackQuery.id, { text: "This action is restricted to admin." });
        return;
      }

      // Sell all tokens action
      if (callbackData.startsWith('sell_all_')) {
        const mint = callbackData.replace('sell_all_', '');
        await handleSellAllAction(callbackQuery.id, mint, chatId, messageId);
      }
      // Save moonbag (sell 75%, keep 25%)
      else if (callbackData.startsWith('moonbag_')) {
        const mint = callbackData.replace('moonbag_', '');
        await handleMoonbagAction(callbackQuery.id, mint, chatId, messageId);
      }
      // Target setting (2x, 5x, 10x)
      else if (callbackData.startsWith('target_')) {
        const parts = callbackData.replace('target_', '').split('_');
        const mint = parts[0];
        const multiplier = parseInt(parts[1]);
        await handleTargetAction(callbackQuery.id, mint, multiplier, chatId, messageId);
      }
      // View position details
      else if (callbackData.startsWith('view_position_')) {
        const symbol = callbackData.replace('view_position_', '');
        await handleViewPositionAction(callbackQuery.id, symbol, chatId);
      }
      // Sell all positions at once
      else if (callbackData === 'sell_all_positions') {
        await handleSellAllPositionsAction(callbackQuery.id, chatId, messageId);
      }
      // Manually retry all failed sales
      else if (callbackData === 'retry_all_failed') {
        await handleRetryAllFailedAction(callbackQuery.id, chatId, messageId);
      }
      // Clear failed sales queue
      else if (callbackData === 'clear_failed_queue') {
        await handleClearFailedQueueAction(callbackQuery.id, chatId, messageId);
      }

    } catch (error) {
      console.error('Error handling callback query:', error);
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "Error processing action. Please try again.",
        show_alert: true
      });
    }
  });
}

// Handler for retry all failed sales action
async function handleRetryAllFailedAction(callbackId, chatId, messageId) {
  try {
    // Check if there are any failed sales
    if (!tradingConfig.failedSales || tradingConfig.failedSales.length === 0) {
      bot.answerCallbackQuery(callbackId, {
        text: "No failed sales to retry.",
        show_alert: true
      });
      return;
    }

    // Answer the callback
    bot.answerCallbackQuery(callbackId, { text: "Retrying all failed sales..." });

    // Update message to show processing
    await bot.editMessageText(
      `🔄 *RETRYING FAILED SALES*\n\nAttempting to sell ${tradingConfig.failedSales.length} tokens...\nPlease wait while transactions complete.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      }
    );

    // Execute the retry function
    await retryFailedSales();

    // Update message with results
    await bot.editMessageText(
      `✅ *RETRY PROCESS COMPLETE*\n\n` +
      `${tradingConfig.failedSales.length > 0 ?
        `${tradingConfig.failedSales.length} sales still remaining in queue.\nUse /failedsales to check status.` :
        `All sales have been successfully processed!`}`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.error('Error handling retry all failed action:', error);
    bot.answerCallbackQuery(callbackId, {
      text: "Error retrying failed sales. Please try again.",
      show_alert: true
    });
  }
}

// Handler for clearing failed sales queue
async function handleClearFailedQueueAction(callbackId, chatId, messageId) {
  try {
    // Check if there are any failed sales
    if (!tradingConfig.failedSales || tradingConfig.failedSales.length === 0) {
      bot.answerCallbackQuery(callbackId, {
        text: "No failed sales to clear.",
        show_alert: true
      });
      return;
    }

    // Get count for confirmation message
    const count = tradingConfig.failedSales.length;

    // Answer the callback
    bot.answerCallbackQuery(callbackId, {
      text: `Queue cleared: ${count} items removed.`,
      show_alert: true
    });

    // Clear the queue
    tradingConfig.failedSales = [];
    saveTradingConfig();

    // Update message
    await bot.editMessageText(
      `✅ *FAILED SALES QUEUE CLEARED*\n\n${count} items have been removed from the retry queue.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.error('Error handling clear failed queue action:', error);
    bot.answerCallbackQuery(callbackId, {
      text: "Error clearing failed sales queue. Please try again.",
      show_alert: true
    });
  }
}

// Handler for the "Sell All" action
async function handleSellAllAction(callbackId, mint, chatId, messageId) {
  try {
    // Check if position exists
    if (!tradingConfig.activePositions.has(mint)) {
      bot.answerCallbackQuery(callbackId, {
        text: "Position not found. It may have been closed already.",
        show_alert: true
      });
      return;
    }

    // Get position information
    const position = tradingConfig.activePositions.get(mint);

    // Answer the callback to show action is processing
    bot.answerCallbackQuery(callbackId, { text: "Selling all tokens..." });

    // Update message to show processing
    await bot.editMessageText(
      `🔄 *PROCESSING SELL ORDER*\n\nSelling all ${position.symbol} tokens...\nPlease wait while transaction completes.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      }
    );

    // Get current price from token registry
    const tokenInfo = tokenRegistry.get(mint);
    const currentPrice = tokenInfo?.currentPrice || position.entryPrice;

    // Close position (which will execute sell if autoTrading is enabled)
    const closedTrade = closePosition(mint, 'manual_button', currentPrice);

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
                   `• P/L: ${profitSign}${closedTrade.profitAmount.toFixed(3)} SOL (${profitSign}${closedTrade.profitPercent.toFixed(2)}%)\n` +
                   `• Holding time: ${formatDuration(closedTrade.durationMs)}\n`;

    if (closedTrade.sellTxId) {
      resultMsg += `\n• [Transaction](${closedTrade.sellTxUrl}): \`${closedTrade.sellTxId.substring(0, 8)}...\`\n`;
    }

    // Send result message (edit the original message)
    await bot.editMessageText(resultMsg, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Error handling sell action:', error);
    bot.answerCallbackQuery(callbackId, {
      text: "Error processing sell. Please try again.",
      show_alert: true
    });
  }
}

// Handler for the "Save Moonbag" action (sell 75%, keep 25%)
async function handleMoonbagAction(callbackId, mint, chatId, messageId) {
  try {
    // Check if position exists
    if (!tradingConfig.activePositions.has(mint)) {
      bot.answerCallbackQuery(callbackId, {
        text: "Position not found. It may have been closed already.",
        show_alert: true
      });
      return;
    }

    // Get position information
    const position = tradingConfig.activePositions.get(mint);

    // Answer the callback to show action is processing
    bot.answerCallbackQuery(callbackId, { text: "Saving 25% moonbag..." });

    // Calculate token amount to sell (75% of total)
    const sellAmount = position.tokenAmount * 0.75;

    // Update message to show processing
    await bot.editMessageText(
      `🔄 *PROCESSING PARTIAL SELL*\n\nSelling 75% of ${position.symbol} tokens...\nKeeping 25% as moonbag.\nPlease wait while transaction completes.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      }
    );

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
      // Import wallet manager to perform partial sell
      const walletManager = require('./wallet_manager.js');

      // Get current price from token registry
      const tokenInfo = tokenRegistry.get(mint);
      const currentPrice = tokenInfo?.currentPrice || position.entryPrice;

      // Execute partial sell transaction
      const sellResult = await walletManager.sellToken(
        adminChatId.toString(),
        mint,
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

      // Save config
      saveTradingConfig();

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
            { text: '✨ 5x Target', callback_data: `target_${mint}_5` },
            { text: '🚀 10x Target', callback_data: `target_${mint}_10` },
            { text: '🌕 20x Target', callback_data: `target_${mint}_20` }
          ],
          [
            { text: '💰 Custom Target', callback_data: `custom_target_${mint}` },
            { text: '🔴 Sell Moonbag', callback_data: `sell_all_${mint}` }
          ]
        ]
      };

      // Send result message (edit the original message)
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
    bot.answerCallbackQuery(callbackId, {
      text: "Error processing moonbag action. Please try again.",
      show_alert: true
    });
  }
}

// Handler for setting a target (2x, 5x, 10x, etc)
async function handleTargetAction(callbackId, mint, multiplier, chatId, messageId) {
  try {
    // Check if position exists
    if (!tradingConfig.activePositions.has(mint)) {
      bot.answerCallbackQuery(callbackId, {
        text: "Position not found. It may have been closed already.",
        show_alert: true
      });
      return;
    }

    // Get position information
    const position = tradingConfig.activePositions.get(mint);

    // Set target as a multiple of entry price
    const targetPrice = position.entryPrice * multiplier;

    // Update position with target
    position.customTarget = targetPrice;
    position.customTargetMultiplier = multiplier;
    position.customTargetSet = Date.now();

    // Save config
    saveTradingConfig();

    // Answer callback
    bot.answerCallbackQuery(callbackId, {
      text: `${multiplier}x target set! Will sell at ${targetPrice.toFixed(9)} SOL`,
      show_alert: true
    });

    // Optionally update message with target information
    if (messageId) {
      try {
        // Get message text
        const messageText = callbackQuery.message.text;

        // Add target info if not already present
        if (!messageText.includes('Target set')) {
          const updatedText = messageText + `\n\n🎯 *${multiplier}x Target Set*: Will sell at ${targetPrice.toFixed(9)} SOL`;

          await bot.editMessageText(updatedText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: callbackQuery.message.reply_markup
          });
        }
      } catch (error) {
        console.error('Error updating message with target info:', error);
        // Continue - not critical
      }
    }

  } catch (error) {
    console.error('Error handling target action:', error);
    bot.answerCallbackQuery(callbackId, {
      text: "Error setting target. Please try again.",
      show_alert: true
    });
  }
}

// Handler for selling all positions at once via the wallet keyboard
async function handleSellAllPositionsAction(callbackId, chatId, messageId) {
  try {
    // Get the positions
    const activePositions = Array.from(tradingConfig.activePositions.entries());

    if (activePositions.length === 0) {
      bot.answerCallbackQuery(callbackId, {
        text: "No active positions to close.",
        show_alert: true
      });
      return;
    }

    // Answer the callback
    bot.answerCallbackQuery(callbackId, { text: "Closing all positions..." });

    // Update message to show processing
    await bot.editMessageText(
      `🔄 *SELLING ALL POSITIONS*\n\nClosing ${activePositions.length} positions...\nPlease wait while transactions complete.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      }
    );

    // Track results
    let successCount = 0;
    let failCount = 0;
    let results = [];

    // Process each position - make a copy for iteration safety
    const positionsArray = [...activePositions];
    for (const [mint, position] of positionsArray) {
      try {
        console.log(`Attempting to close position for ${position.symbol} (${mint})`);

        // Check if wallet has this token before trying to close position
        if (tradingConfig.autoTrading) {
          try {
            // Import the wallet manager to check token balance
            const walletManager = require('./wallet_manager.js');

            // Get current price
            const tokenInfo = tokenRegistry.get(mint);
            const currentPrice = tokenInfo?.currentPrice || position.entryPrice;

            // Execute sell with wrap in try-catch so errors don't stop the loop
            const result = await walletManager.sellToken(
              adminChatId.toString(), // Using admin chat ID as user ID
              mint,                    // Token mint address
              0                        // Sell all tokens (0 means all)
            );

            if (result.success) {
              successCount++;
              // Close position in our tracking system too
              const closedTrade = closePosition(mint, 'manual_bulk', currentPrice);
              if (closedTrade) {
                results.push({
                  symbol: position.symbol,
                  success: true,
                  profitAmount: closedTrade.profitAmount,
                  profitPercent: closedTrade.profitPercent
                });
                console.log(`Successfully closed position for ${position.symbol}`);
              } else {
                // Transaction was successful but position tracking update failed
                results.push({
                  symbol: position.symbol,
                  success: true,
                  profitAmount: 0,
                  profitPercent: 0,
                  note: "Transaction success but tracking error"
                });
              }
            } else {
              // The sell API returned an error but we'll continue with other tokens
              failCount++;

              // Even if API says token doesn't exist, still clean up our tracking
              if (result.message && (
                  result.message.includes("doesn't exist") ||
                  result.message.includes("not found") ||
                  result.message.includes("0 tokens") ||
                  result.message.includes("may have already been sold") ||
                  result.message.includes("no tokens found") ||
                  result.message.includes("no balance")
              )) {
                // Token doesn't exist in wallet - clean up tracking to match reality
                const closedTrade = closePosition(mint, 'manual_bulk', currentPrice);
                results.push({
                  symbol: position.symbol,
                  success: false,
                  error: result.message,
                  note: "Token not in wallet, tracking updated"
                });
              } else {
                // Add to failed sales queue for retry later
                if (!tradingConfig.failedSales) {
                  tradingConfig.failedSales = [];
                }
                tradingConfig.failedSales.push({
                  mint,
                  timestamp: Date.now(),
                  attempts: 1
                });

                results.push({
                  symbol: position.symbol,
                  success: false,
                  error: result.message,
                  note: "Added to retry queue"
                });
              }

              console.log(`Failed to close position for ${position.symbol}: ${result.message}`);
            }
          } catch (error) {
            // Error in wallet interaction but continue with other tokens
            console.error(`Error with wallet for ${mint}:`, error);
            failCount++;

            // Add to retry queue
            if (!tradingConfig.failedSales) {
              tradingConfig.failedSales = [];
            }
            tradingConfig.failedSales.push({
              mint,
              timestamp: Date.now(),
              attempts: 1,
              error: error.message
            });

            // Still update our tracking system even if the sell fails
            closePosition(mint, 'manual_bulk', position.entryPrice);
            results.push({
              symbol: position.symbol || mint.slice(0, 6),
              success: false,
              error: error.message,
              note: "Added to retry queue"
            });
          }
        } else {
          // Simulation mode - just close the position in our tracking
          const tokenInfo = tokenRegistry.get(mint);
          const currentPrice = tokenInfo?.currentPrice || position.entryPrice;
          const closedTrade = closePosition(mint, 'manual_bulk', currentPrice);

          if (closedTrade) {
            successCount++;
            results.push({
              symbol: position.symbol,
              success: true,
              profitAmount: closedTrade.profitAmount,
              profitPercent: closedTrade.profitPercent
            });
            console.log(`Successfully closed position for ${position.symbol}`);
          } else {
            failCount++;
            results.push({
              symbol: position.symbol,
              success: false
            });
            console.log(`Failed to close position for ${position.symbol}`);
          }
        }
      } catch (error) {
        // Catch any unexpected errors but continue with other tokens
        console.error(`Error closing position for ${mint}:`, error);
        failCount++;

        // Add to retry queue even for unexpected errors
        if (!tradingConfig.failedSales) {
          tradingConfig.failedSales = [];
        }
        tradingConfig.failedSales.push({
          mint,
          timestamp: Date.now(),
          attempts: 1,
          error: error.message
        });

        results.push({
          symbol: position.symbol || mint.slice(0, 6),
          success: false,
          error: error.message,
          note: "Added to retry queue"
        });
      }

      // Brief pause to prevent rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Save config to make sure all positions changes are persisted
    saveTradingConfig();

    // Update stats
    updateProfitStats();

    // Prepare result message
    let resultMsg = `✅ *Position Closing Results:*\n\n`;
    resultMsg += `Closed positions: ${successCount} successful, ${failCount} failed\n\n`;

    if (results.length > 0) {
      resultMsg += `*Results:*\n`;

      // Show the all results, sorted by profit (highest first)
      results.sort((a, b) => {
        if (a.success && b.success) return b.profitAmount - a.profitAmount;
        if (a.success) return -1;
        if (b.success) return 1;
        return 0;
      });

      results.forEach(result => {
        if (result.success) {
          const profitSign = result.profitAmount >= 0 ? '+' : '';
          resultMsg += `• ${result.symbol}: ${profitSign}${result.profitAmount.toFixed(2)} SOL (${profitSign}${result.profitPercent.toFixed(2)}%)\n`;
        } else {
          resultMsg += `• ${result.symbol}: Failed to close\n`;
        }
      });
    }

    // Check if positions were all closed
    const remainingPositions = tradingConfig.activePositions.size;
    if (remainingPositions > 0) {
      resultMsg += `\n⚠️ Warning: ${remainingPositions} positions still remain active. Some positions may not have closed properly.`;
    }

    // Send result message
    await bot.editMessageText(resultMsg, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Error in sell all positions action:', error);
    bot.answerCallbackQuery(callbackId, {
      text: "Error closing all positions. Please try again.",
      show_alert: true
    });
  }
}

// Handler for viewing position details
async function handleViewPositionAction(callbackId, symbol, chatId) {
  try {
    // Find position with matching symbol
    let targetMint = null;
    let targetPosition = null;

    for (const [mint, position] of tradingConfig.activePositions.entries()) {
      if (position.symbol.toUpperCase() === symbol.toUpperCase()) {
        targetMint = mint;
        targetPosition = position;
        break;
      }
    }

    if (!targetMint || !targetPosition) {
      bot.answerCallbackQuery(callbackId, {
        text: `No active position found for ${symbol}.`,
        show_alert: true
      });
      return;
    }

    // Answer callback
    bot.answerCallbackQuery(callbackId);

    // Execute the view position logic (reuse existing command)
    // Check and update position
    checkPosition(targetMint);

    // Get updated position
    targetPosition = tradingConfig.activePositions.get(targetMint);

    if (!targetPosition) {
      bot.sendMessage(chatId, `⚠️ Position for ${symbol} was just closed during the check.`);
      return;
    }

    // Get current token info
    const tokenInfo = tokenRegistry.get(targetMint);
    const currentPrice = tokenInfo?.currentPrice || 0;

    // Calculate current status
    const currentValue = targetPosition.tokenAmount * currentPrice;
    const profitLoss = currentValue - targetPosition.investmentAmount;
    const profitLossPercent = (profitLoss / targetPosition.investmentAmount) * 100;

    // Format detailed message
    let detailMsg = `💼 *Position Details: ${targetPosition.symbol}*\n\n`;

    detailMsg += `• Entry price: ${targetPosition.entryPrice.toFixed(9)} SOL\n`;
    detailMsg += `• Current price: ${currentPrice.toFixed(9)} SOL\n`;
    detailMsg += `• Highest price: ${targetPosition.highestPrice.toFixed(9)} SOL\n\n`;

    detailMsg += `• Investment: ${targetPosition.investmentAmount.toFixed(2)} SOL\n`;
    detailMsg += `• Current value: ${currentValue.toFixed(2)} SOL\n`;
    detailMsg += `• P/L: ${profitLoss.toFixed(2)} SOL (${profitLossPercent >= 0 ? '+' : ''}${profitLossPercent.toFixed(2)}%)\n\n`;

    detailMsg += `• Take profit: ${targetPosition.takeProfitPrice.toFixed(9)} SOL (+${targetPosition.takeProfitPercent * 100}%)\n`;
    detailMsg += `• Stop loss: ${targetPosition.stopLossPrice.toFixed(9)} SOL (-${targetPosition.stopLossPercent * 100}%)\n`;

    // Add custom target if set
    if (targetPosition.customTarget) {
      detailMsg += `• Custom target: ${targetPosition.customTarget.toFixed(9)} SOL (${targetPosition.customTargetMultiplier}x)\n`;
    }

    detailMsg += `\n• Entry time: ${new Date(targetPosition.entryTimestamp).toLocaleString()}\n`;
    detailMsg += `• Holding time: ${formatDuration(Date.now() - targetPosition.entryTimestamp)}\n`;

    // Add moonbag info if this is a moonbag
    if (targetPosition.moonbagSaved) {
      detailMsg += `\n🔮 *MOONBAG INFO:*\n`;
      detailMsg += `• Moonbag saved on: ${new Date(targetPosition.moonbagTimestamp).toLocaleString()}\n`;
      detailMsg += `• Exit price at save: ${targetPosition.moonbagExitPrice.toFixed(9)} SOL\n`;
      detailMsg += `• Current multiple: ${(currentPrice / targetPosition.entryPrice).toFixed(2)}x\n`;
    }

    // Add position action buttons
    const actionKeyboard = {
      inline_keyboard: [
        [
          { text: '🔴 Sell All', callback_data: `sell_all_${targetMint}` },
          { text: '📈 Save Moonbag (25%)', callback_data: `moonbag_${targetMint}` }
        ],
        [
          { text: '2x Target', callback_data: `target_${targetMint}_2` },
          { text: '5x Target', callback_data: `target_${targetMint}_5` },
          { text: '10x Target', callback_data: `target_${targetMint}_10` }
        ]
      ]
    };

    // Send position details
    bot.sendMessage(chatId, detailMsg, {
      parse_mode: 'Markdown',
      reply_markup: actionKeyboard
    });

  } catch (error) {
    console.error('Error handling view position action:', error);
    bot.answerCallbackQuery(callbackId, {
      text: "Error viewing position. Please try again.",
      show_alert: true
    });
  }
}

// Paths to save trading configuration
function getConfigPaths() {
  return {
    tradingConfigPath: path.join(DATA_DIR, 'trading_config.json'),
    tradeHistoryPath: path.join(DATA_DIR, 'trade_history.json'),
    activePositionsPath: path.join(DATA_DIR, 'active_positions.json')
  };
}

// Save trading configuration
function saveTradingConfig() {
  try {
    const { tradingConfigPath, tradeHistoryPath, activePositionsPath } = getConfigPaths();

    // Create directory if it doesn't exist
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Prepare a serializable version of the config
    const serializableConfig = {
      ...tradingConfig,
      trackedTokens: Array.from(tradingConfig.trackedTokens),
      activePositions: Array.from(tradingConfig.activePositions.entries()),
    };

    fs.writeFileSync(tradingConfigPath, JSON.stringify(serializableConfig, null, 2));
    console.log('Trading configuration saved successfully');

    // Save trade history separately (it might get large)
    fs.writeFileSync(tradeHistoryPath, JSON.stringify(tradingConfig.tradeHistory, null, 2));
    console.log('Trade history saved successfully');

    // Save active positions separately for easier access
    const serializablePositions = Array.from(tradingConfig.activePositions.entries());
    fs.writeFileSync(activePositionsPath, JSON.stringify(serializablePositions, null, 2));
    console.log('Active positions saved successfully');
  } catch (error) {
    console.error('Error saving trading configuration:', error);
  }
}

// Load trading configuration
function loadTradingConfig() {
  try {
    const { tradingConfigPath, tradeHistoryPath, activePositionsPath } = getConfigPaths();

    // Create data directory if it doesn't exist
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log(`Created data directory: ${DATA_DIR}`);
    }

    // Load main config
    if (fs.existsSync(tradingConfigPath)) {
      const configData = JSON.parse(fs.readFileSync(tradingConfigPath, 'utf8'));

      // Restore configuration values
      Object.keys(configData).forEach(key => {
        if (key !== 'trackedTokens' && key !== 'activePositions' && key !== 'tradeHistory') {
          tradingConfig[key] = configData[key];
        }
      });

      // Restore tracked tokens as a Set
      if (Array.isArray(configData.trackedTokens)) {
        tradingConfig.trackedTokens = new Set(configData.trackedTokens);
      }

      console.log('Trading configuration loaded');
    }

    // Load trade history
    if (fs.existsSync(tradeHistoryPath)) {
      const historyData = JSON.parse(fs.readFileSync(tradeHistoryPath, 'utf8'));
      if (Array.isArray(historyData)) {
        tradingConfig.tradeHistory = historyData;
      }
      console.log(`Loaded ${tradingConfig.tradeHistory.length} historical trades`);
    }

    // Load active positions
    if (fs.existsSync(activePositionsPath)) {
      const positionsData = JSON.parse(fs.readFileSync(activePositionsPath, 'utf8'));
      if (Array.isArray(positionsData)) {
        tradingConfig.activePositions = new Map(positionsData);
      }
      console.log(`Loaded ${tradingConfig.activePositions.size} active positions`);
    }

    // Calculate profit stats from history
    updateProfitStats();

  } catch (error) {
    console.error('Error loading trading configuration:', error);
    // Initialize with defaults if loading fails
  }
}

// Calculate and update profit statistics
function updateProfitStats() {
  const stats = {
    totalInvested: 0,
    totalReturned: 0,
    totalProfit: 0,
    winCount: 0,
    lossCount: 0,
    activeInvestment: 0
  };

  // Calculate from completed trades
  tradingConfig.tradeHistory.forEach(trade => {
    stats.totalInvested += trade.investmentAmount;
    stats.totalReturned += trade.returnAmount;

    if (trade.returnAmount > trade.investmentAmount) {
      stats.winCount++;
    } else {
      stats.lossCount++;
    }
  });

  // Calculate active investment
  tradingConfig.activePositions.forEach(position => {
    stats.activeInvestment += position.investmentAmount;
  });

  // Calculate total profit
  stats.totalProfit = stats.totalReturned - stats.totalInvested;

  // Update the stats
  tradingConfig.profitStats = stats;

  return stats;
}

// Process new alert for potential entry
function processAlertForTrading(mint, alertData, tokenInfo) {
  // Log that we received an alert for trading consideration
  if (tradingConfig.showAutoTradingMessages) {
    console.log(`[TRADING] Received ${alertData.type} alert for ${alertData.symbol || mint}: Evaluating for potential ${tradingConfig.autoTrading ? 'real' : 'simulated'} trading`);
  }

  // For simulation, we'll still track the position but note that it's just a simulation
  const isSimulation = !tradingConfig.autoTrading;

  // Skip if we're only tracking specific tokens and this isn't one of them
  if (!tradingConfig.trackAllTokens && !tradingConfig.trackedTokens.has(mint)) {
    console.log(`[TRADING] Skipping ${alertData.symbol || mint} - not in tracked tokens list`);
    return;
  }

  // Skip if market cap is too low
  if (alertData.initialMarketCap < tradingConfig.minMarketCap) {
    console.log(`Skipping ${alertData.symbol} for trading - market cap too low: ${alertData.initialMarketCap} SOL`);
    return;
  }

  // Skip if we already have an active position for this token
  if (tradingConfig.activePositions.has(mint)) {
    console.log(`Already have an active position for ${alertData.symbol} - skipping`);
    return;
  }

  // Skip if we have reached the maximum number of active positions
  if (tradingConfig.activePositions.size >= tradingConfig.maxActivePositions) {
    console.log(`Maximum active positions reached (${tradingConfig.maxActivePositions}) - skipping new entry`);
    return;
  }

  // Calculate entry details
  const entryPrice = tokenInfo.currentPrice || 0;
  const investmentAmount = tradingConfig.defaultInvestment;
  const tokenAmount = entryPrice > 0 ? investmentAmount / entryPrice : 0;

  // Calculate take profit and stop loss prices
  const takeProfitPercent = tradingConfig.defaultTakeProfit / 100;
  const stopLossPercent = tradingConfig.defaultStopLoss / 100;

  const takeProfitPrice = entryPrice * (1 + takeProfitPercent);
  const stopLossPrice = entryPrice * (1 - stopLossPercent);

  // Create position object
  const position = {
    mint,
    symbol: alertData.symbol,
    entryTimestamp: Date.now(),
    entryPrice,
    investmentAmount,
    tokenAmount,
    takeProfitPrice,
    stopLossPrice,
    takeProfitPercent,
    stopLossPercent,
    highestPrice: entryPrice,
    alertType: alertData.type,
    status: 'active',
    market: 'solana', // Default market
    lastChecked: Date.now(),
    isSimulation: !tradingConfig.autoTrading // Flag to mark simulation entries
  };

  // Add to active positions
  tradingConfig.activePositions.set(mint, position);

  // Update profit stats
  updateProfitStats();

  // Save updated configuration
  saveTradingConfig();

  // Execute the actual buy order if auto-trading is enabled
  if (tradingConfig.autoTrading) {
    if (tradingConfig.showAutoTradingMessages) {
      console.log(`[REAL TRADE] Executing real buy for ${position.symbol} with ${investmentAmount} SOL`);
    }
    executeBuyOrder(position).then(success => {
      if (tradingConfig.showAutoTradingMessages) {
        if (success) {
          console.log(`Successfully placed buy order for ${position.symbol}`);
        } else {
          console.log(`Failed to place buy order for ${position.symbol}`);
        }
      }
    });
  } else {
    if (tradingConfig.showAutoTradingMessages) {
      console.log(`[SIMULATION] Would buy ${position.symbol} with ${investmentAmount} SOL (simulation mode)`);
    }
  }

  // Send notification
  if (tradingConfig.notifyOnSignals) {
    notifyBuySignal(position);
  }

  console.log(`Added new position for ${position.symbol} at ${position.entryPrice} SOL`);
  return position;
}

// Check a single position for take profit or stop loss
function checkPosition(mint) {
  const position = tradingConfig.activePositions.get(mint);
  if (!position) {
    return null;
  }

  // Update last checked timestamp
  position.lastChecked = Date.now();

  // Get current token info (price data comes from the websocket updates in the main bot)
  const tokenInfo = tokenRegistry.get(mint);
  if (!tokenInfo) {
    console.log(`Unable to check position for ${position.symbol} - token info not available`);
    return position;
  }

  // Get current price - WebSocket provides real-time price data
  // This ensures we're using the same price source as the milestone checker
  let currentPrice = 0;

  if (tokenInfo.currentPrice) {
    // Primary source: currentPrice from tokenRegistry (from WS)
    currentPrice = tokenInfo.currentPrice;
  } else if (tokenInfo.price) {
    // Alternative source: 'price' field from tokenRegistry (sometimes used)
    currentPrice = tokenInfo.price;
  } else {
    console.log(`Unable to check position for ${position.symbol} - price data not available`);
    return position;
  }

  // Sanity check - make sure price is a positive number
  if (isNaN(currentPrice) || currentPrice <= 0) {
    console.log(`Invalid price data for ${position.symbol}: ${currentPrice}`);
    return position;
  }

  // Update highest observed price
  if (currentPrice > position.highestPrice) {
    position.highestPrice = currentPrice;
    console.log(`New highest price for ${position.symbol}: ${currentPrice} SOL`);
  }

  // Calculate current return ratio
  const currentReturnRatio = currentPrice / position.entryPrice;
  const currentReturnPercent = (currentReturnRatio - 1) * 100;

  // Log position status for monitoring (only occasionally to avoid spam)
  if (Math.random() < 0.05) { // Log roughly 5% of the time
    console.log(`Position status for ${position.symbol}: Current ${currentPrice.toFixed(9)} SOL (${currentReturnPercent > 0 ? '+' : ''}${currentReturnPercent.toFixed(2)}%), TP: ${position.takeProfitPrice.toFixed(9)}, SL: ${position.stopLossPrice.toFixed(9)}`);
  }

  // Check for custom target condition (if set)
  if (position.customTarget && currentPrice >= position.customTarget) {
    console.log(`Custom target (${position.customTargetMultiplier}x) triggered for ${position.symbol} at ${currentPrice} SOL (+${currentReturnPercent.toFixed(2)}%)`);
    closePosition(mint, 'custom_target', currentPrice);
    return null;
  }

  // Check for take profit condition
  if (currentPrice >= position.takeProfitPrice) {
    console.log(`Take profit triggered for ${position.symbol} at ${currentPrice} SOL (+${currentReturnPercent.toFixed(2)}%)`);
    closePosition(mint, 'take_profit', currentPrice);
    return null;
  }

  // Check for stop loss condition
  if (currentPrice <= position.stopLossPrice) {
    console.log(`Stop loss triggered for ${position.symbol} at ${currentPrice} SOL (${currentReturnPercent.toFixed(2)}%)`);
    closePosition(mint, 'stop_loss', currentPrice);
    return null;
  }

  // Return updated position
  return position;
}

// Check all active positions
function checkAllPositions() {
  console.log(`Checking ${tradingConfig.activePositions.size} active positions...`);

  // Store mints to avoid modification during iteration
  const mints = Array.from(tradingConfig.activePositions.keys());

  // Check each position
  mints.forEach(mint => {
    try {
      checkPosition(mint);
    } catch (error) {
      console.error(`Error checking position for ${mint}:`, error);
    }
  });

  // Save after batch checking
  saveTradingConfig();

  console.log('Position check completed');
}

// Force update all position prices from tokenRegistry and check for take profit/stop loss
// This can be called manually when needed to ensure all positions have current prices
function forceUpdateAllPositionPrices() {
  console.log(`Force updating prices for ${tradingConfig.activePositions.size} active positions...`);

  // Store mints to avoid modification during iteration
  const mints = Array.from(tradingConfig.activePositions.keys());
  let updatedCount = 0;

  // Check each position
  mints.forEach(mint => {
    try {
      // Get the position
      const position = tradingConfig.activePositions.get(mint);
      if (!position) return;

      // Get current token info (price data from the tokenRegistry - updated by websocket)
      const tokenInfo = tokenRegistry.get(mint);
      if (!tokenInfo) {
        console.log(`No token registry data for ${position.symbol} (${mint})`);
        return;
      }

      // Get current price from tokenRegistry
      const currentPrice = tokenInfo.currentPrice || 0;

      if (currentPrice <= 0) {
        console.log(`Invalid price (${currentPrice}) for ${position.symbol} (${mint})`);
        return;
      }

      // Log the price update
      console.log(`[FORCE UPDATE] ${position.symbol}: ${position.lastPrice?.toExponential(6) || 'N/A'} -> ${currentPrice.toExponential(6)}`);

      // Update position last price
      position.lastPrice = position.lastPrice || currentPrice;

      // Check for take profit/stop loss based on the latest price
      checkPosition(mint);
      updatedCount++;

    } catch (error) {
      console.error(`Error force updating price for ${mint}:`, error);
    }
  });

  // Save after batch checking
  saveTradingConfig();

  console.log(`Force update completed. Updated ${updatedCount} positions.`);
  return updatedCount;
}

// Close a position (take profit or stop loss)
function closePosition(mint, reason, exitPrice) {
  const position = tradingConfig.activePositions.get(mint);
  if (!position) {
    console.log(`Position not found for ${mint}`);
    return null;
  }

  // Calculate return amount
  const grossReturnAmount = position.tokenAmount * exitPrice;
  const fees = grossReturnAmount * (tradingConfig.feesPercent / 100);
  const slippage = grossReturnAmount * (tradingConfig.slippageEstimate / 100);
  const returnAmount = grossReturnAmount - fees - slippage;

  // Calculate profit
  const profitAmount = returnAmount - position.investmentAmount;
  const profitPercent = (profitAmount / position.investmentAmount) * 100;

  // Create closed trade record
  const trade = {
    ...position,
    exitPrice,
    exitTimestamp: Date.now(),
    reason,
    grossReturnAmount,
    fees,
    slippage,
    returnAmount,
    profitAmount,
    profitPercent,
    durationMs: Date.now() - position.entryTimestamp,
    status: 'closed'
  };

  // Add to trade history
  tradingConfig.tradeHistory.push(trade);

  // Remove from active positions
  tradingConfig.activePositions.delete(mint);

  // Execute the actual sell order if auto-trading is enabled
  if (tradingConfig.autoTrading) {
    console.log(`Executing sell order for ${trade.symbol} (${mint})`);
    executeSellOrder(trade).then(success => {
      if (success) {
        console.log(`Successfully placed sell order for ${trade.symbol}`);
        saveTradingConfig(); // Save config after successful sell
      } else {
        console.log(`Failed to place sell order for ${trade.symbol}`);
      }
    }).catch(error => {
      console.error(`Error executing sell order for ${trade.symbol}:`, error);
    });
  } else {
    saveTradingConfig(); // Still save config even if auto-trading is disabled
  }

  // Send notification
  if (tradingConfig.notifyOnSignals) {
    notifySellSignal(trade);
  }

  // Update profit stats
  updateProfitStats();

  // Save updated configuration
  saveTradingConfig();

  console.log(`Closed position for ${position.symbol} with ${profitAmount.toFixed(3)} SOL ${profitAmount >= 0 ? 'profit' : 'loss'} (${profitPercent.toFixed(2)}%)`);

  return trade;
}

// Execute buy order using wallet_manager
async function executeBuyOrder(position) {
  if (!tradingConfig.autoTrading) {
    // In simulation mode, always return success
    console.log(`[SIMULATION] Would buy ${position.investmentAmount} SOL of ${position.symbol} at ${position.entryPrice} SOL`);
    return true;
  }

  try {
    console.log(`[AUTO-TRADE] Buying ${position.investmentAmount} SOL of ${position.symbol} at ${position.entryPrice} SOL`);

    // Import the wallet manager (only when needed)
    const walletManager = require('./wallet_manager.js');

    // Use the admin's wallet for trading
    const result = await walletManager.buyToken(
      adminChatId.toString(), // Using admin chat ID as user ID
      position.mint,           // Token mint address
      position.investmentAmount // Amount in SOL
    );

    if (result.success) {
      console.log(`[AUTO-TRADE] Successfully bought ${position.symbol}. Transaction: ${result.txId}`);

      // Add transaction information to the position
      position.buyTxId = result.txId;
      position.buyTxUrl = result.explorer;

      return true;
    } else {
      console.error(`[AUTO-TRADE] Failed to buy ${position.symbol}: ${result.message}`);
      return false;
    }
  } catch (error) {
    console.error(`[AUTO-TRADE] Error buying ${position.symbol}:`, error);
    return false;
  }
}

// Execute sell order using wallet_manager with the new sellToken function
async function executeSellOrder(trade) {
  if (!tradingConfig.autoTrading) {
    // In simulation mode, always return success
    console.log(`[SIMULATION] Would sell ${trade.tokenAmount} ${trade.symbol} tokens at ${trade.exitPrice} SOL`);
    return true;
  }

  try {
    console.log(`[AUTO-TRADE] Selling ${trade.tokenAmount} ${trade.symbol} tokens at ${trade.exitPrice} SOL`);

    // Import the wallet manager (only when needed)
    const walletManager = require('./wallet_manager.js');

    // Configure retry parameters
    const maxRetries = 3;
    const retryDelay = 2000; // 2 seconds
    let attempt = 0;
    let lastError = null;

    // Retry loop for failed transactions
    while (attempt < maxRetries) {
      attempt++;
      console.log(`[AUTO-TRADE] Attempt ${attempt}/${maxRetries} to sell ${trade.symbol}`);

      try {
        // Use the admin's wallet for trading
        const result = await walletManager.sellToken(
          adminChatId.toString(), // Using admin chat ID as user ID
          trade.mint,             // Token mint address
          0                       // Sell all tokens (0 means all)
        );

        if (result.success) {
          console.log(`[AUTO-TRADE] Successfully sold ${trade.symbol} on attempt ${attempt}. Transaction: ${result.txId}`);

          // Add transaction information to the trade
          trade.sellTxId = result.txId;
          trade.sellTxUrl = result.explorer;
          trade.sellAttempts = attempt;

          // Send success notification if it took multiple attempts
          if (attempt > 1) {
            bot.sendMessage(
              adminChatId,
              `✅ *AUTO-SELL RECOVERED*: Successfully sold ${trade.symbol} after ${attempt} attempts.\n\n` +
              `[Transaction](${result.explorer}): \`${result.txId.substring(0, 8)}...\``,
              { parse_mode: 'Markdown' }
            );
          }

          return true;
        } else {
          lastError = result.message;
          console.warn(`[AUTO-TRADE] Attempt ${attempt} failed for ${trade.symbol}: ${result.message}`);

          // Exit retry loop for specific errors that won't benefit from retrying
          if (result.message && (
              result.message.includes("doesn't exist") ||
              result.message.includes("not found") ||
              result.message.includes("0 tokens") ||
              result.message.includes("insufficient") ||
              result.message.includes("no accounts found")
          )) {
            console.warn(`[AUTO-TRADE] Not retrying ${trade.symbol} due to terminal error: ${result.message}`);
            throw new Error(result.message); // Break out of retry loop
          }

          // Wait before next attempt - increase delay for each retry
          if (attempt < maxRetries) {
            const currentDelay = retryDelay * attempt;
            console.log(`[AUTO-TRADE] Waiting ${currentDelay}ms before retry ${attempt+1} for ${trade.symbol}`);
            await new Promise(resolve => setTimeout(resolve, currentDelay));
          }
        }
      } catch (attemptError) {
        lastError = attemptError.message;
        console.error(`[AUTO-TRADE] Error on attempt ${attempt} for ${trade.symbol}:`, attemptError);

        // Exit retry loop for specific errors that won't benefit from retrying
        if (attemptError.message && (
            attemptError.message.includes("doesn't exist") ||
            attemptError.message.includes("not found") ||
            attemptError.message.includes("0 tokens") ||
            attemptError.message.includes("insufficient") ||
            attemptError.message.includes("no accounts found")
        )) {
          console.warn(`[AUTO-TRADE] Not retrying ${trade.symbol} due to terminal error: ${attemptError.message}`);
          break;
        }

        // Wait before next attempt
        if (attempt < maxRetries) {
          const currentDelay = retryDelay * attempt;
          console.log(`[AUTO-TRADE] Waiting ${currentDelay}ms before retry ${attempt+1} for ${trade.symbol}`);
          await new Promise(resolve => setTimeout(resolve, currentDelay));
        }
      }
    }

    // If we get here, all retries failed
    console.error(`[AUTO-TRADE] All ${maxRetries} attempts failed to sell ${trade.symbol}`);

    // Create a more helpful error message with retry details
    let errorMsg = `⚠️ *AUTO-SELL FAILED*: Could not sell ${trade.symbol} after ${maxRetries} attempts.\n\n`;
    errorMsg += `Error: ${lastError}\n\n`;
    errorMsg += `⚙️ *ACTIONS NEEDED*:\n`;
    errorMsg += `• The token may be added to an auto-retry queue\n`;
    errorMsg += `• You can also try selling manually on Jupiter: https://jup.ag/swap/SOL-${trade.mint}\n`;
    errorMsg += `• Or check token in your wallet: https://solscan.io/token/${trade.mint}`;

    // Notify about the failure with manual link
    bot.sendMessage(adminChatId, errorMsg, { parse_mode: 'Markdown' });

    // Add to failed sales list for future retries
    addFailedSaleForRetry(trade);

    return false;
  } catch (error) {
    console.error(`[AUTO-TRADE] Error selling ${trade.symbol}:`, error);

    // Notify about the error with manual link
    bot.sendMessage(
      adminChatId,
      `⚠️ *AUTO-SELL ERROR*: Error selling ${trade.symbol}.\n\n` +
      `Error: ${error.message}\n\n` +
      `Please sell manually on Jupiter: https://jup.ag/swap/SOL-${trade.mint}`,
      { parse_mode: 'Markdown' }
    );

    // Add to failed sales list for future retries
    addFailedSaleForRetry(trade);

    return false;
  }
}

// Add a failed sale to the retry queue
function addFailedSaleForRetry(trade) {
  try {
    // Initialize failedSales if not already in config
    if (!tradingConfig.failedSales) {
      tradingConfig.failedSales = [];
    }

    // Check if this token is already in the retry queue
    const existingIndex = tradingConfig.failedSales.findIndex(sale => sale.mint === trade.mint);

    if (existingIndex >= 0) {
      // Update existing retry entry
      tradingConfig.failedSales[existingIndex].lastAttempt = Date.now();
      tradingConfig.failedSales[existingIndex].attempts++;
      tradingConfig.failedSales[existingIndex].exitPrice = trade.exitPrice; // Update with latest price
      console.log(`Updated existing retry entry for ${trade.symbol}. Attempts: ${tradingConfig.failedSales[existingIndex].attempts}`);
    } else {
      // Add to failed sales with timestamp
      tradingConfig.failedSales.push({
        mint: trade.mint,
        symbol: trade.symbol,
        timeAdded: Date.now(),
        lastAttempt: Date.now(),
        attempts: 1,
        maxAttempts: 5, // Will try up to 5 times in periodic retries
        exitPrice: trade.exitPrice,
        entryPrice: trade.entryPrice,
        investmentAmount: trade.investmentAmount,
        tokenAmount: trade.tokenAmount,
        reason: trade.reason
      });
      console.log(`Added ${trade.symbol} to failed sales retry queue. Queue size: ${tradingConfig.failedSales.length}`);
    }

    // Clean up old retries (if they've been in the queue for more than 24 hours)
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    tradingConfig.failedSales = tradingConfig.failedSales.filter(sale => {
      return sale.timeAdded > oneDayAgo || sale.attempts < sale.maxAttempts;
    });

    // Save trading config
    saveTradingConfig();
  } catch (error) {
    console.error('Error adding failed sale to retry queue:', error);
  }
}

// Retry failed sales periodically
async function retryFailedSales() {
  try {
    if (!tradingConfig.autoTrading) {
      console.log('Auto-trading is disabled. Skipping failed sales retry.');
      return;
    }

    // Check if there are any failed sales to retry
    if (!tradingConfig.failedSales || tradingConfig.failedSales.length === 0) {
      console.log('No failed sales to retry.');
      return;
    }

    console.log(`Starting retry for ${tradingConfig.failedSales.length} failed sales...`);

    // Import wallet manager
    const walletManager = require('./wallet_manager.js');

    // Track which sales to remove from the queue (successful ones)
    let salesToRemove = [];
    let updatedSales = [];
    let notificationsSent = 0;

    // Process each failed sale
    for (const sale of tradingConfig.failedSales) {
      try {
        // Skip if max attempts reached
        if (sale.attempts >= sale.maxAttempts) {
          console.log(`Skipping retry for ${sale.symbol} - max attempts (${sale.maxAttempts}) reached`);
          continue;
        }

        // Check if enough time has passed since last attempt
        // Progressively increase wait time between attempts
        const waitTime = Math.min(15, sale.attempts) * 60 * 1000; // 1min, 2min, 3min... up to 15min max
        const timeToWait = sale.lastAttempt + waitTime - Date.now();

        if (timeToWait > 0) {
          console.log(`Skipping retry for ${sale.symbol} - next attempt in ${Math.ceil(timeToWait/1000)} seconds`);
          continue;
        }

        console.log(`Attempting retry #${sale.attempts + 1} for ${sale.symbol} (${sale.mint})`);

        // Try to sell the token
        const result = await walletManager.sellToken(
          adminChatId.toString(),
          sale.mint,
          0 // Sell all tokens
        );

        // Update the sale record
        sale.attempts++;
        sale.lastAttempt = Date.now();

        if (result.success) {
          console.log(`Successfully sold ${sale.symbol} on retry #${sale.attempts}`);

          // Mark for removal from queue
          salesToRemove.push(sale.mint);

          // Send success notification (limit to prevent spam)
          if (notificationsSent < 3) {
            bot.sendMessage(
              adminChatId,
              `✅ *AUTO-RETRY SUCCESS*: Finally sold ${sale.symbol} after ${sale.attempts} attempts.\n\n` +
              `[Transaction](${result.explorer}): \`${result.txId.substring(0, 8)}...\``,
              { parse_mode: 'Markdown' }
            );
            notificationsSent++;
          }

          // Also close the position in our tracking (create a trade record)
          // If the position is still in activePositions, close it properly
          if (tradingConfig.activePositions.has(sale.mint)) {
            console.log(`Closing position tracking for ${sale.symbol}`);
            closePosition(sale.mint, 'auto_retry', sale.exitPrice);
          }
        } else {
          console.log(`Failed retry #${sale.attempts} for ${sale.symbol}: ${result.message}`);

          // Check if we should keep trying based on error message
          if (result.message && (
              result.message.includes("doesn't exist") ||
              result.message.includes("not found") ||
              result.message.includes("0 tokens") ||
              result.message.includes("no accounts found")
          )) {
            console.log(`Removing ${sale.symbol} from retry queue - token doesn't exist in wallet`);
            salesToRemove.push(sale.mint);

            // Send notification about terminal error
            if (notificationsSent < 3) {
              bot.sendMessage(
                adminChatId,
                `ℹ️ *TOKEN NOT FOUND*: ${sale.symbol} was not found in wallet during auto-retry.\n\n` +
                `It may have been sold already or cleared in a wallet cleanup.`,
                { parse_mode: 'Markdown' }
              );
              notificationsSent++;
            }
          } else {
            // Keep in queue for future retries
            updatedSales.push(sale);
          }
        }
      } catch (error) {
        console.error(`Error retrying sale for ${sale.symbol}:`, error);

        // Update attempt count and keep in queue
        sale.attempts++;
        sale.lastAttempt = Date.now();
        updatedSales.push(sale);
      }

      // Brief pause between retries to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Update the failed sales list
    tradingConfig.failedSales = tradingConfig.failedSales.filter(sale =>
      !salesToRemove.includes(sale.mint));

    // Save updated config
    saveTradingConfig();

    // Send summary notification if we had enough activity
    if (salesToRemove.length > 0 || (notificationsSent > 0 && notificationsSent < 3)) {
      bot.sendMessage(
        adminChatId,
        `🔄 *AUTO-RETRY SUMMARY*:\n\n` +
        `• Successfully sold: ${salesToRemove.length} tokens\n` +
        `• Remaining in queue: ${tradingConfig.failedSales.length} tokens\n\n` +
        `Auto-retry will continue running periodically.`,
        { parse_mode: 'Markdown' }
      );
    }

    console.log(`Retry session completed. Sold: ${salesToRemove.length}, Remaining: ${tradingConfig.failedSales.length}`);
  } catch (error) {
    console.error('Error in retry failed sales:', error);
  }
}

// Send notification when a buy signal is detected
function notifyBuySignal(position) {
  try {
    // Generate URLs
    const pumpFunUrl = `https://pump.fun/coin/${position.mint}`;
    const solscanUrl = `https://solscan.io/token/${position.mint}`;
    const neoUrl = `https://neo.bullx.io/terminal?chainId=1399811149&address=${position.mint}`;
    const axiomUrl = `https://axiom.trade/meme/${position.mint}`;

    // Format message for Telegram
    let buyMsg = `🟢 *TRADING BOT BUY SIGNAL: ${position.symbol}*\n\n` +
                  `• Entry price: ${position.entryPrice.toFixed(9)} SOL\n` +
                  `• Investment: ${position.investmentAmount.toFixed(2)} SOL\n` +
                  `• Take profit: ${position.takeProfitPrice.toFixed(9)} SOL (+${position.takeProfitPercent * 100}%)\n` +
                  `• Stop loss: ${position.stopLossPrice.toFixed(9)} SOL (-${position.stopLossPercent * 100}%)\n` +
                  `• Alert type: ${position.alertType || 'Unknown'}\n`;

    if (tradingConfig.autoTrading) {
      buyMsg += `• Auto-executed: Yes ✅\n`;

      // Add transaction info if available
      if (position.buyTxId) {
        buyMsg += `• [Transaction](${position.buyTxUrl}): \`${position.buyTxId.substring(0, 8)}...\`\n`;
      } else {
        buyMsg += `• Transaction: Pending/Simulated\n`;
      }
    } else {
      buyMsg += `• Auto-executed: No (Simulation) 📊\n`;
    }

    buyMsg += `\n🔗 [PumpFun](${pumpFunUrl})\n` +
              `🔗 [Solscan](${solscanUrl})\n` +
              `🔗 [NeoBull](${neoUrl})\n` +
              `🔗 [AxiomTrade](${axiomUrl})\n\n` +
              `\`${position.mint}\``;

    // Add simulation notice if not auto-trading
    if (!tradingConfig.autoTrading) {
      buyMsg += `\n\n📊 *SIMULATION MODE*: No real trade executed. Use /autotrade on to enable real trading.`;
    }

    // Create inline keyboard with sell options
    const sellKeyboard = {
      inline_keyboard: [
        [
          { text: '🔴 Sell Now', callback_data: `sell_all_${position.mint}` },
          { text: '📈 Save Moonbag (25%)', callback_data: `moonbag_${position.mint}` }
        ],
        [
          { text: '2x Target', callback_data: `target_${position.mint}_2` },
          { text: '5x Target', callback_data: `target_${position.mint}_5` },
          { text: '10x Target', callback_data: `target_${position.mint}_10` }
        ],
        [
          { text: '📊 View Position', callback_data: `view_position_${position.symbol}` }
        ]
      ]
    };

    // Send to admin chat with sell buttons
    bot.sendMessage(adminChatId, buyMsg, {
      parse_mode: 'Markdown',
      reply_markup: sellKeyboard
    });

  } catch (error) {
    console.error('Error sending buy signal notification:', error);
  }
}

// Send notification when a sell signal is detected
function notifySellSignal(trade) {
  try {
    // Generate URLs
    const pumpFunUrl = `https://pump.fun/coin/${trade.mint}`;
    const solscanUrl = `https://solscan.io/token/${trade.mint}`;
    const jupUrl = `https://jup.ag/swap/SOL-${trade.mint}`;

    // Format message for Telegram
    let sellMsg = `${trade.profitAmount >= 0 ? '🔴' : '🔻'} *TRADING BOT ${trade.reason.toUpperCase()} SIGNAL: ${trade.symbol}*\n\n` +
                  `• Exit price: ${trade.exitPrice.toFixed(9)} SOL\n` +
                  `• ${trade.reason === 'take_profit' ? 'Take profit' : 'Stop loss'} triggered\n` +
                  `• Entry price: ${trade.entryPrice.toFixed(9)} SOL\n` +
                  `• Investment: ${trade.investmentAmount.toFixed(2)} SOL\n` +
                  `• Return: ${trade.returnAmount.toFixed(2)} SOL\n` +
                  `• P/L: ${trade.profitAmount.toFixed(2)} SOL (${trade.profitPercent.toFixed(2)}%)\n` +
                  `• Holding time: ${formatDuration(trade.durationMs)}\n`;

    if (tradingConfig.autoTrading) {
      sellMsg += `• Auto-executed: Yes ✅\n`;

      // Add transaction info if available
      if (trade.sellTxId) {
        sellMsg += `• [Transaction](${trade.sellTxUrl}): \`${trade.sellTxId.substring(0, 8)}...\`\n`;
      } else {
        sellMsg += `• Transaction: Processing or failed\n`;
      }
    } else {
      sellMsg += `• Auto-executed: No (Simulation) 📊\n`;
    }

    sellMsg += `\n🔗 [PumpFun](${pumpFunUrl})\n` +
              `🔗 [Solscan](${solscanUrl})\n`;

    // Add Jupiter swap link when auto-trading is enabled and sell failed
    if (tradingConfig.autoTrading && !trade.sellTxId) {
      sellMsg += `🔗 [Sell on Jupiter](${jupUrl})\n`;
    }

    sellMsg += `\n\`${trade.mint}\``;

    // Add simulation notice if not auto-trading
    if (!tradingConfig.autoTrading) {
      sellMsg += `\n\n📊 *SIMULATION MODE*: No real trade executed.`;
    } else if (!trade.sellTxId) {
      // Only show manual action if sell transaction failed or is missing
      sellMsg += `\n\n⚠️ *MANUAL ACTION MAY BE REQUIRED*: If auto-sell fails, please sell this token manually on Jupiter.`;
    }

    // Send to admin chat
    bot.sendMessage(adminChatId, sellMsg, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Error sending sell signal notification:', error);
  }
}

// Format duration in ms to a human-readable string
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

// Calculate potential profit for simulation
function calculatePotentialProfit(investmentAmount, entryX, takeProfit, stopLoss, hitRate) {
  const winAmount = investmentAmount * (1 + takeProfit / 100);
  const lossAmount = investmentAmount * (1 - stopLoss / 100);

  const expectedWins = hitRate / 100;
  const expectedLosses = 1 - expectedWins;

  const expectedReturn = (winAmount * expectedWins) + (lossAmount * expectedLosses);
  const expectedProfit = expectedReturn - investmentAmount;
  const expectedRoi = (expectedProfit / investmentAmount) * 100;

  return {
    investmentAmount,
    winAmount,
    lossAmount,
    expectedWins,
    expectedLosses,
    expectedReturn,
    expectedProfit,
    expectedRoi
  };
}

// Manual entry for testing or custom entries
function manualEntry(symbol, mint, entryPrice, investmentAmount, takeProfitPercent, stopLossPercent) {
  if (!mint || !entryPrice || !investmentAmount) {
    console.log('Missing required parameters for manual entry');
    return null;
  }

  // Create position
  const tokenAmount = entryPrice > 0 ? investmentAmount / entryPrice : 0;
  const takeProfitPrice = entryPrice * (1 + takeProfitPercent / 100);
  const stopLossPrice = entryPrice * (1 - stopLossPercent / 100);

  const position = {
    mint,
    symbol: symbol || 'MANUAL',
    entryTimestamp: Date.now(),
    entryPrice,
    investmentAmount,
    tokenAmount,
    takeProfitPrice,
    stopLossPrice,
    takeProfitPercent: takeProfitPercent / 100,
    stopLossPercent: stopLossPercent / 100,
    highestPrice: entryPrice,
    alertType: 'manual',
    status: 'active',
    market: 'solana',
    lastChecked: Date.now()
  };

  // Add to active positions
  tradingConfig.activePositions.set(mint, position);

  // Update stats
  updateProfitStats();

  // Save
  saveTradingConfig();

  return position;
}

// Hook into alertTracker to process new alerts for trading
function hookIntoAlertTracker(mint, alertData) {
  try {
    if (!mint || !alertData) {
      console.log("Skipping trade hook - invalid alert data");
      return;
    }

    // Get token info
    const tokenInfo = tokenRegistry.get(mint);
    if (!tokenInfo) {
      console.log(`Skipping trade hook - token info not found for ${mint}`);
      return;
    }

    console.log(`Processing alert for trading: ${alertData.symbol || mint}`);

    // Process for trading
    processAlertForTrading(mint, alertData, tokenInfo);
  } catch (error) {
    console.error(`Error processing alert for trading (${mint}):`, error);
  }
}

// Setup trading commands
function setupTradingCommands() {
  // Command to toggle auto-trading
  bot.onText(/\/autotrade (on|off)/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId; // Check if user is admin

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const command = match[1].toLowerCase();
    const enable = command === 'on';

    tradingConfig.autoTrading = enable;
    tradingConfig.notifyOnSignals = enable; // Notifications follow auto-trading setting
    saveTradingConfig();

    bot.sendMessage(
      chatId,
      `🤖 Auto-trading has been turned ${enable ? 'ON' : 'OFF'}.\n` +
      `📊 Trading notifications have also been turned ${enable ? 'ON' : 'OFF'}.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Command to toggle auto-trading messages
  bot.onText(/\/tradingmsgs (on|off)/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId; // Check if user is admin

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const command = match[1].toLowerCase();
    const enable = command === 'on';

    tradingConfig.showAutoTradingMessages = enable;
    saveTradingConfig();

    bot.sendMessage(
      chatId,
      `📊 Auto-trading console messages have been turned ${enable ? 'ON' : 'OFF'}.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Command to toggle trade notifications
  bot.onText(/\/notifications (on|off)/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId; // Check if user is admin

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const command = match[1].toLowerCase();
    const enable = command === 'on';

    tradingConfig.notifyOnSignals = enable;
    saveTradingConfig();

    bot.sendMessage(
      chatId,
      `📣 Trading notifications have been turned ${enable ? 'ON' : 'OFF'}.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Command to show trading help
  bot.onText(/\/tradinghelp/, (msg) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const helpMessage = `
🤖 *Trading System Commands*

*Configuration:*
• /autotrade on|off - Enable or disable automatic trading (also toggles notifications)
• /notifications on|off - Enable or disable trading notifications separately
• /tradingmsgs on|off - Enable or disable auto-trading console messages
• /setinvestment [amount] - Set default investment amount (SOL)
• /settakeprofit [percent] - Set default take profit percentage
• /setstoploss [percent] - Set default stop loss percentage

*Status & Actions:*
• /positions - List all active positions
• /forceupdate - Force update all position prices
• /failedsales - Show failed sales queue
• /tradingstats - Show trading statistics

*Additional Features:*
• Use buttons on trading notifications to manage positions
`;

    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
  });

  // Command to force update all position prices from tokenRegistry
  bot.onText(/\/forceupdate/, (msg) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    try {
      // Send initial status message
      bot.sendMessage(chatId, "🔄 Force updating all position prices from real-time data...");

      // Call the force update function
      const updatedCount = forceUpdateAllPositionPrices();

      // Send result message
      bot.sendMessage(
        chatId,
        `✅ Successfully force-updated ${updatedCount} positions with latest price data.\n\n` +
        `This ensures all active positions are using the most current prices for take profit and stop loss calculations.`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Error in force update command:', error);
      bot.sendMessage(chatId, "❌ Error updating position prices. Check logs for details.");
    }
  });

  // Command to view failed sales and retry them manually
  bot.onText(/\/failedsales/, async (msg) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    try {
      // Check if there are any failed sales
      if (!tradingConfig.failedSales || tradingConfig.failedSales.length === 0) {
        bot.sendMessage(chatId, "✅ No failed sales in the retry queue.");
        return;
      }

      // Show failed sales list
      let message = `🔄 *Failed Sales Queue (${tradingConfig.failedSales.length}):*\n\n`;

      tradingConfig.failedSales.forEach((sale, index) => {
        const timeAgo = formatDuration(Date.now() - sale.timeAdded);
        const lastAttemptAgo = formatDuration(Date.now() - sale.lastAttempt);

        message += `${index+1}. *${sale.symbol}*:\n`;
        message += `  • Attempts: ${sale.attempts}/${sale.maxAttempts}\n`;
        message += `  • Added: ${timeAgo} ago\n`;
        message += `  • Last attempt: ${lastAttemptAgo} ago\n\n`;
      });

      // Add retry button
      const keyboard = {
        inline_keyboard: [
          [
            { text: '🔄 Retry All Now', callback_data: 'retry_all_failed' },
            { text: '❌ Clear Queue', callback_data: 'clear_failed_queue' }
          ]
        ]
      };

      bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (error) {
      console.error('Error processing failed sales command:', error);
      bot.sendMessage(chatId, "❌ Error processing failed sales.");
    }
  });

  // Command to view active positions
  bot.onText(/\/positions/, (msg) => {
    const chatId = msg.chat.id;

    try {
      const positions = Array.from(tradingConfig.activePositions.values());

      if (positions.length === 0) {
        bot.sendMessage(chatId, "💼 No active positions at the moment.");
        return;
      }

      // Update all positions before displaying
      const mints = Array.from(tradingConfig.activePositions.keys());
      mints.forEach(mint => {
        try {
          checkPosition(mint);
        } catch (error) {
          console.error(`Error checking position for ${mint}:`, error);
        }
      });

      // Get updated positions
      const updatedPositions = Array.from(tradingConfig.activePositions.values());

      // Sort by entry timestamp (most recent first)
      updatedPositions.sort((a, b) => b.entryTimestamp - a.entryTimestamp);

      let positionsMsg = `💼 *Active Positions (${updatedPositions.length}):*\n\n`;

      // Create table header
      positionsMsg += "Symbol | Entry | Current | P/L | Time\n";
      positionsMsg += "-------|-------|---------|-----|------\n";

      // Calculate total investment and current value
      let totalInvested = 0;
      let totalCurrentValue = 0;

      updatedPositions.forEach((position, i) => {
        const tokenInfo = tokenRegistry.get(position.mint);
        const currentPrice = tokenInfo?.currentPrice || 0;

        const currentValue = position.tokenAmount * currentPrice;
        const profitLoss = currentValue - position.investmentAmount;
        const profitLossPercent = (profitLoss / position.investmentAmount) * 100;

        // Add to totals
        totalInvested += position.investmentAmount;
        totalCurrentValue += currentValue;

        // Format entry time
        const timeAgo = formatDuration(Date.now() - position.entryTimestamp);

        // Format table row
        positionsMsg += `${position.symbol.padEnd(7)} | ` +
                       `${position.entryPrice.toFixed(6)} | ` +
                       `${currentPrice.toFixed(6)} | ` +
                       `${profitLossPercent >= 0 ? '+' : ''}${profitLossPercent.toFixed(1)}% | ` +
                       `${timeAgo}\n`;
      });

      // Add summary
      const totalProfitLoss = totalCurrentValue - totalInvested;
      const totalProfitLossPercent = (totalProfitLoss / totalInvested) * 100;

      positionsMsg += `\n📊 *Summary:*\n`;
      positionsMsg += `• Total invested: ${totalInvested.toFixed(2)} SOL\n`;
      positionsMsg += `• Current value: ${totalCurrentValue.toFixed(2)} SOL\n`;
      positionsMsg += `• Overall P/L: ${totalProfitLoss.toFixed(2)} SOL (${totalProfitLossPercent >= 0 ? '+' : ''}${totalProfitLossPercent.toFixed(2)}%)\n`;

      // Add command help
      positionsMsg += `\n💡 Use /position <symbol> for details on a specific position`;

      bot.sendMessage(chatId, positionsMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error in /positions command:', error);
      bot.sendMessage(chatId, "❌ Error processing positions data.");
    }
  });

  // Command to view details of a specific position
  bot.onText(/\/position (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const symbolQuery = match[1].toUpperCase();

    try {
      // Find position with matching symbol
      let targetPosition = null;
      let targetMint = null;

      for (const [mint, position] of tradingConfig.activePositions.entries()) {
        if (position.symbol.toUpperCase() === symbolQuery) {
          targetPosition = position;
          targetMint = mint;
          break;
        }
      }

      if (!targetPosition) {
        bot.sendMessage(chatId, `❌ No active position found for ${symbolQuery}.`);
        return;
      }

      // Check and update position
      checkPosition(targetMint);

      // Get updated position
      targetPosition = tradingConfig.activePositions.get(targetMint);

      if (!targetPosition) {
        bot.sendMessage(chatId, `⚠️ Position for ${symbolQuery} was just closed during the check.`);
        return;
      }

      // Get current token info
      const tokenInfo = tokenRegistry.get(targetMint);
      const currentPrice = tokenInfo?.currentPrice || 0;

      // Calculate current status
      const currentValue = targetPosition.tokenAmount * currentPrice;
      const profitLoss = currentValue - targetPosition.investmentAmount;
      const profitLossPercent = (profitLoss / targetPosition.investmentAmount) * 100;

      // Format detailed message
      let detailMsg = `💼 *Position Details: ${targetPosition.symbol}*\n\n`;

      detailMsg += `• Entry price: ${targetPosition.entryPrice.toFixed(9)} SOL\n`;
      detailMsg += `• Current price: ${currentPrice.toFixed(9)} SOL\n`;
      detailMsg += `• Highest price: ${targetPosition.highestPrice.toFixed(9)} SOL\n\n`;

      detailMsg += `• Investment: ${targetPosition.investmentAmount.toFixed(2)} SOL\n`;
      detailMsg += `• Current value: ${currentValue.toFixed(2)} SOL\n`;
      detailMsg += `• P/L: ${profitLoss.toFixed(2)} SOL (${profitLossPercent >= 0 ? '+' : ''}${profitLossPercent.toFixed(2)}%)\n\n`;

      detailMsg += `• Take profit: ${targetPosition.takeProfitPrice.toFixed(9)} SOL (+${targetPosition.takeProfitPercent * 100}%)\n`;
      detailMsg += `• Stop loss: ${targetPosition.stopLossPrice.toFixed(9)} SOL (-${targetPosition.stopLossPercent * 100}%)\n\n`;

      detailMsg += `• Entry time: ${new Date(targetPosition.entryTimestamp).toLocaleString()}\n`;
      detailMsg += `• Holding time: ${formatDuration(Date.now() - targetPosition.entryTimestamp)}\n`;
      detailMsg += `• Alert type: ${targetPosition.alertType || 'Unknown'}\n\n`;

      // Add pump.fun link
      detailMsg += `• View: [PumpFun](https://pump.fun/coin/${targetPosition.mint})\n\n`;

      // Add close commands
      detailMsg += `💡 *Actions:*\n`;
      detailMsg += `• /closeposition ${targetPosition.symbol} - Close this position at market price\n`;
      detailMsg += `• /setsl ${targetPosition.symbol} <percent> - Change stop loss\n`;
      detailMsg += `• /settp ${targetPosition.symbol} <percent> - Change take profit`;

      bot.sendMessage(chatId, detailMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error in /position command:', error);
      bot.sendMessage(chatId, "❌ Error retrieving position details.");
    }
  });

  // Command to view trading history
  bot.onText(/\/tradehistory(?:\s+(\d+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const limit = match[1] ? parseInt(match[1]) : 10; // Default to 10 trades

    try {
      // Get completed trades, sorted by exit timestamp (most recent first)
      const trades = [...tradingConfig.tradeHistory]
        .sort((a, b) => b.exitTimestamp - a.exitTimestamp)
        .slice(0, limit);

      if (trades.length === 0) {
        bot.sendMessage(chatId, "📜 No trade history available yet.");
        return;
      }

      let historyMsg = `📜 *Trade History (Last ${Math.min(limit, trades.length)}):*\n\n`;

      // Create table header
      historyMsg += "Symbol | Result | Entry | Exit | P/L | Duration\n";
      historyMsg += "-------|--------|-------|------|-----|----------\n";

      // Format each trade
      trades.forEach((trade) => {
        const result = trade.profitAmount >= 0 ? '✅' : '❌';
        const profitLoss = trade.profitAmount;
        const profitLossPercent = trade.profitPercent;

        historyMsg += `${trade.symbol.padEnd(7)} | ` +
                      `${result} | ` +
                      `${trade.entryPrice.toFixed(6)} | ` +
                      `${trade.exitPrice.toFixed(6)} | ` +
                      `${profitLossPercent >= 0 ? '+' : ''}${profitLossPercent.toFixed(1)}% | ` +
                      `${formatDuration(trade.durationMs)}\n`;
      });

      // Add summary statistics
      const stats = tradingConfig.profitStats;

      historyMsg += `\n📊 *Trading Performance:*\n`;
      historyMsg += `• Total completed trades: ${stats.winCount + stats.lossCount}\n`;
      historyMsg += `• Win rate: ${stats.winCount}/${stats.winCount + stats.lossCount} (${stats.winCount + stats.lossCount > 0 ? ((stats.winCount / (stats.winCount + stats.lossCount)) * 100).toFixed(1) : 0}%)\n`;
      historyMsg += `• Total profit: ${stats.totalProfit.toFixed(2)} SOL\n`;
      historyMsg += `• ROI: ${stats.totalInvested > 0 ? ((stats.totalProfit / stats.totalInvested) * 100).toFixed(2) : 0}%\n`;

      // Add note about active positions
      if (tradingConfig.activePositions.size > 0) {
        historyMsg += `\n💼 *Current Status:*\n`;
        historyMsg += `• Active positions: ${tradingConfig.activePositions.size}\n`;
        historyMsg += `• Active investment: ${stats.activeInvestment.toFixed(2)} SOL\n`;
        historyMsg += `\nUse /positions to view active positions.`;
      }

      bot.sendMessage(chatId, historyMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error in /tradehistory command:', error);
      bot.sendMessage(chatId, "❌ Error retrieving trade history.");
    }
  });

  // Command to set trade parameters
  bot.onText(/\/tradingconfig/, (msg) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId; // Check if user is admin

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    try {
      let configMsg = `⚙️ *Trading Configuration:*\n\n`;

      configMsg += `• Auto-trading: ${tradingConfig.autoTrading ? 'Enabled ✅' : 'Disabled ❌'}\n`;
      configMsg += `• Default investment: ${tradingConfig.defaultInvestment.toFixed(2)} SOL\n`;
      configMsg += `• Default take profit: ${tradingConfig.defaultTakeProfit}%\n`;
      configMsg += `• Default stop loss: ${tradingConfig.defaultStopLoss}%\n`;
      configMsg += `• Max active positions: ${tradingConfig.maxActivePositions}\n`;
      configMsg += `• Minimum market cap: ${tradingConfig.minMarketCap} SOL\n`;
      configMsg += `• Fee estimate: ${tradingConfig.feesPercent}%\n`;
      configMsg += `• Slippage estimate: ${tradingConfig.slippageEstimate}%\n`;
      configMsg += `• Track all tokens: ${tradingConfig.trackAllTokens ? 'Yes' : 'No'}\n`;
      configMsg += `• Tracked tokens: ${tradingConfig.trackedTokens.size}\n`;

      configMsg += `\n💡 *Commands:*\n`;
      configMsg += `• /setinvestment <amount> - Set default SOL investment\n`;
      configMsg += `• /settp <percent> - Set default take profit %\n`;
      configMsg += `• /setsl <percent> - Set default stop loss %\n`;
      configMsg += `• /maxpositions <number> - Set max active positions\n`;
      configMsg += `• /minmarketcap <amount> - Set minimum market cap\n`;
      configMsg += `• /trackall on|off - Toggle tracking all tokens\n`;
      configMsg += `• /autotrade on|off - Toggle auto-trading\n`;
      configMsg += `• /profitstats - View profit statistics\n`;
      configMsg += `• /profitsim - Run profit simulation\n`;

      bot.sendMessage(chatId, configMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error in /tradingconfig command:', error);
      bot.sendMessage(chatId, "❌ Error retrieving trading configuration.");
    }
  });

  // Command to set default investment amount
  bot.onText(/\/setinvestment (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const amount = parseFloat(match[1]);

    if (isNaN(amount) || amount <= 0) {
      bot.sendMessage(chatId, "❌ Please provide a valid positive number.");
      return;
    }

    tradingConfig.defaultInvestment = amount;
    saveTradingConfig();

    bot.sendMessage(
      chatId,
      `✅ Default investment amount set to ${amount.toFixed(2)} SOL.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Command to set default take profit percentage
  bot.onText(/\/settp (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const percent = parseFloat(match[1]);

    if (isNaN(percent) || percent <= 0) {
      bot.sendMessage(chatId, "❌ Please provide a valid positive number.");
      return;
    }

    tradingConfig.defaultTakeProfit = percent;
    saveTradingConfig();

    bot.sendMessage(
      chatId,
      `✅ Default take profit set to ${percent}%.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Command to set default stop loss percentage
  bot.onText(/\/setsl (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const percent = parseFloat(match[1]);

    if (isNaN(percent) || percent <= 0) {
      bot.sendMessage(chatId, "❌ Please provide a valid positive number.");
      return;
    }

    tradingConfig.defaultStopLoss = percent;
    saveTradingConfig();

    bot.sendMessage(
      chatId,
      `✅ Default stop loss set to ${percent}%.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Command to set max positions
  bot.onText(/\/maxpositions (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const maxPositions = parseInt(match[1]);

    if (isNaN(maxPositions) || maxPositions <= 0) {
      bot.sendMessage(chatId, "❌ Please provide a valid positive number.");
      return;
    }

    tradingConfig.maxActivePositions = maxPositions;
    saveTradingConfig();

    bot.sendMessage(
      chatId,
      `✅ Maximum active positions set to ${maxPositions}.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Command to set minimum market cap
  bot.onText(/\/minmarketcap (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const minMarketCap = parseFloat(match[1]);

    if (isNaN(minMarketCap) || minMarketCap <= 0) {
      bot.sendMessage(chatId, "❌ Please provide a valid positive number.");
      return;
    }

    tradingConfig.minMarketCap = minMarketCap;
    saveTradingConfig();

    bot.sendMessage(
      chatId,
      `✅ Minimum market cap set to ${minMarketCap} SOL.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Command to toggle track all tokens
  bot.onText(/\/trackall (on|off)/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const command = match[1].toLowerCase();
    const enable = command === 'on';

    tradingConfig.trackAllTokens = enable;
    saveTradingConfig();

    bot.sendMessage(
      chatId,
      `🔍 Track all tokens has been turned ${enable ? 'ON' : 'OFF'}.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Command to close a specific position
  bot.onText(/\/closeposition (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const symbolQuery = match[1].toUpperCase();

    try {
      // Find position with matching symbol
      let targetMint = null;

      for (const [mint, position] of tradingConfig.activePositions.entries()) {
        if (position.symbol.toUpperCase() === symbolQuery) {
          targetMint = mint;
          break;
        }
      }

      if (!targetMint) {
        bot.sendMessage(chatId, `❌ No active position found for ${symbolQuery}.`);
        return;
      }

      // Get current price
      const tokenInfo = tokenRegistry.get(targetMint);
      const currentPrice = tokenInfo?.currentPrice || 0;

      if (currentPrice <= 0) {
        bot.sendMessage(chatId, `❌ Cannot close position for ${symbolQuery} - current price not available.`);
        return;
      }

      // Close position
      const closedTrade = closePosition(targetMint, 'manual', currentPrice);

      if (!closedTrade) {
        bot.sendMessage(chatId, `❌ Failed to close position for ${symbolQuery}.`);
        return;
      }

      // Format message
      let closeMsg = `✅ *Position Closed: ${closedTrade.symbol}*\n\n`;
      closeMsg += `• Exit price: ${closedTrade.exitPrice.toFixed(9)} SOL\n`;
      closeMsg += `• Entry price: ${closedTrade.entryPrice.toFixed(9)} SOL\n`;
      closeMsg += `• Investment: ${closedTrade.investmentAmount.toFixed(2)} SOL\n`;
      closeMsg += `• Return: ${closedTrade.returnAmount.toFixed(2)} SOL\n`;
      closeMsg += `• P/L: ${closedTrade.profitAmount.toFixed(2)} SOL (${closedTrade.profitPercent.toFixed(2)}%)\n`;
      closeMsg += `• Holding time: ${formatDuration(closedTrade.durationMs)}\n`;

      bot.sendMessage(chatId, closeMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error in /closeposition command:', error);
      bot.sendMessage(chatId, "❌ Error closing position.");
    }
  });

  // Command to set stop loss for a specific position
  bot.onText(/\/setsl (.+) (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const symbolQuery = match[1].toUpperCase();
    const newStopLossPercent = parseFloat(match[2]);

    if (isNaN(newStopLossPercent) || newStopLossPercent <= 0) {
      bot.sendMessage(chatId, "❌ Please provide a valid positive number for stop loss percentage.");
      return;
    }

    try {
      // Find position with matching symbol
      let targetMint = null;
      let targetPosition = null;

      for (const [mint, position] of tradingConfig.activePositions.entries()) {
        if (position.symbol.toUpperCase() === symbolQuery) {
          targetMint = mint;
          targetPosition = position;
          break;
        }
      }

      if (!targetMint || !targetPosition) {
        bot.sendMessage(chatId, `❌ No active position found for ${symbolQuery}.`);
        return;
      }

      // Update stop loss
      const stopLossPercent = newStopLossPercent / 100;
      const newStopLossPrice = targetPosition.entryPrice * (1 - stopLossPercent);

      targetPosition.stopLossPercent = stopLossPercent;
      targetPosition.stopLossPrice = newStopLossPrice;

      // Save changes
      saveTradingConfig();

      // Send confirmation
      bot.sendMessage(
        chatId,
        `✅ Stop loss for ${symbolQuery} updated to ${newStopLossPercent}% (${newStopLossPrice.toFixed(9)} SOL).`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Error in position stop loss update:', error);
      bot.sendMessage(chatId, "❌ Error updating stop loss.");
    }
  });

  // Command to set take profit for a specific position
  bot.onText(/\/settp (.+) (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    const symbolQuery = match[1].toUpperCase();
    const newTakeProfitPercent = parseFloat(match[2]);

    if (isNaN(newTakeProfitPercent) || newTakeProfitPercent <= 0) {
      bot.sendMessage(chatId, "❌ Please provide a valid positive number for take profit percentage.");
      return;
    }

    try {
      // Find position with matching symbol
      let targetMint = null;
      let targetPosition = null;

      for (const [mint, position] of tradingConfig.activePositions.entries()) {
        if (position.symbol.toUpperCase() === symbolQuery) {
          targetMint = mint;
          targetPosition = position;
          break;
        }
      }

      if (!targetMint || !targetPosition) {
        bot.sendMessage(chatId, `❌ No active position found for ${symbolQuery}.`);
        return;
      }

      // Update take profit
      const takeProfitPercent = newTakeProfitPercent / 100;
      const newTakeProfitPrice = targetPosition.entryPrice * (1 + takeProfitPercent);

      targetPosition.takeProfitPercent = takeProfitPercent;
      targetPosition.takeProfitPrice = newTakeProfitPrice;

      // Save changes
      saveTradingConfig();

      // Send confirmation
      bot.sendMessage(
        chatId,
        `✅ Take profit for ${symbolQuery} updated to ${newTakeProfitPercent}% (${newTakeProfitPrice.toFixed(9)} SOL).`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Error in position take profit update:', error);
      bot.sendMessage(chatId, "❌ Error updating take profit.");
    }
  });

  // Command to run profit simulation
  bot.onText(/\/profitsim(?:\s+(\d+))?(?:\s+(\d+))?(?:\s+(\d+))?(?:\s+(\d+))?/, (msg, match) => {
    const chatId = msg.chat.id;

    try {
      // Parse parameters with defaults
      const investment = parseFloat(match[1]) || tradingConfig.defaultInvestment;
      const takeProfit = parseFloat(match[2]) || tradingConfig.defaultTakeProfit;
      const stopLoss = parseFloat(match[3]) || tradingConfig.defaultStopLoss;
      const hitRate = parseFloat(match[4]) || 50; // Default to 50% hit rate

      // Run simulation
      const sim = calculatePotentialProfit(investment, 1, takeProfit, stopLoss, hitRate);

      // Format message
      let simMsg = `🧮 *Profit Simulation:*\n\n`;
      simMsg += `• Investment: ${sim.investmentAmount.toFixed(2)} SOL per trade\n`;
      simMsg += `• Take profit: +${takeProfit}%\n`;
      simMsg += `• Stop loss: -${stopLoss}%\n`;
      simMsg += `• Assumed hit rate: ${hitRate}%\n\n`;

      simMsg += `*Results:*\n`;
      simMsg += `• Win amount: ${sim.winAmount.toFixed(2)} SOL (+${takeProfit}%)\n`;
      simMsg += `• Loss amount: ${sim.lossAmount.toFixed(2)} SOL (-${stopLoss}%)\n`;
      simMsg += `• Expected return per trade: ${sim.expectedReturn.toFixed(2)} SOL\n`;
      simMsg += `• Expected profit per trade: ${sim.expectedProfit.toFixed(2)} SOL\n`;
      simMsg += `• Expected ROI: ${sim.expectedRoi.toFixed(2)}%\n\n`;

      // Add risk-reward ratio
      const riskRewardRatio = takeProfit / stopLoss;
      simMsg += `• Risk-reward ratio: 1:${riskRewardRatio.toFixed(2)}\n`;

      // Add break-even hit rate
      const breakEvenHitRate = (stopLoss / (takeProfit + stopLoss)) * 100;
      simMsg += `• Break-even hit rate: ${breakEvenHitRate.toFixed(1)}%\n\n`;

      // 10-trade simulation
      const tradesCount = 10;
      const expectedProfitForTrades = sim.expectedProfit * tradesCount;

      simMsg += `*${tradesCount}-Trade Projection:*\n`;
      simMsg += `• Total investment: ${(sim.investmentAmount * tradesCount).toFixed(2)} SOL\n`;
      simMsg += `• Expected winning trades: ${(sim.expectedWins * tradesCount).toFixed(1)}\n`;
      simMsg += `• Expected losing trades: ${(sim.expectedLosses * tradesCount).toFixed(1)}\n`;
      simMsg += `• Projected profit: ${expectedProfitForTrades.toFixed(2)} SOL\n`;

      // Add custom parameters note
      simMsg += `\n💡 *Usage:*\n`;
      simMsg += `/profitsim <investment> <take_profit> <stop_loss> <hit_rate>\n`;
      simMsg += `All parameters are optional. Defaults will be used if not specified.`;

      bot.sendMessage(chatId, simMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error in profit simulation:', error);
      bot.sendMessage(chatId, "❌ Error running profit simulation.");
    }
  });

  // Command to run manual entry
  bot.onText(/\/manualentry (.+) (.+) (.+)(?:\s+(\d+))?(?:\s+(\d+))?(?:\s+(\d+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    try {
      const symbol = match[1].toUpperCase();
      const mint = match[2]; // Mint address
      const entryPrice = parseFloat(match[3]);
      const investmentAmount = parseFloat(match[4]) || tradingConfig.defaultInvestment;
      const takeProfitPercent = parseFloat(match[5]) || tradingConfig.defaultTakeProfit;
      const stopLossPercent = parseFloat(match[6]) || tradingConfig.defaultStopLoss;

      // Validate inputs
      if (!mint || mint.length < 10) {
        bot.sendMessage(chatId, "❌ Please provide a valid mint address.");
        return;
      }

      if (isNaN(entryPrice) || entryPrice <= 0) {
        bot.sendMessage(chatId, "❌ Please provide a valid positive number for entry price.");
        return;
      }

      // Create manual entry
      const position = manualEntry(symbol, mint, entryPrice, investmentAmount, takeProfitPercent, stopLossPercent);

      if (!position) {
        bot.sendMessage(chatId, "❌ Failed to create manual entry.");
        return;
      }

      // Send confirmation
      let entryMsg = `✅ *Manual Entry Created:*\n\n`;
      entryMsg += `• Symbol: ${position.symbol}\n`;
      entryMsg += `• Entry price: ${position.entryPrice.toFixed(9)} SOL\n`;
      entryMsg += `• Investment: ${position.investmentAmount.toFixed(2)} SOL\n`;
      entryMsg += `• Token amount: ${position.tokenAmount.toFixed(2)}\n`;
      entryMsg += `• Take profit: ${position.takeProfitPrice.toFixed(9)} SOL (+${position.takeProfitPercent * 100}%)\n`;
      entryMsg += `• Stop loss: ${position.stopLossPrice.toFixed(9)} SOL (-${position.stopLossPercent * 100}%)\n`;

      bot.sendMessage(chatId, entryMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error in manual entry:', error);
      bot.sendMessage(chatId, "❌ Error creating manual entry.");
    }
  });

  // Command to display profit stats
  bot.onText(/\/profitstats/, (msg) => {
    const chatId = msg.chat.id;

    try {
      // Update stats
      const stats = updateProfitStats();

      // Calculate overall metrics
      const totalTrades = stats.winCount + stats.lossCount;
      const winRate = totalTrades > 0 ? (stats.winCount / totalTrades) * 100 : 0;
      const roi = stats.totalInvested > 0 ? (stats.totalProfit / stats.totalInvested) * 100 : 0;

      // Calculate active metrics
      const activePositions = Array.from(tradingConfig.activePositions.values());
      let totalCurrentValue = 0;
      let unrealizedProfit = 0;

      activePositions.forEach(position => {
        const tokenInfo = tokenRegistry.get(position.mint);
        const currentPrice = tokenInfo?.currentPrice || 0;
        const currentValue = position.tokenAmount * currentPrice;

        totalCurrentValue += currentValue;
        unrealizedProfit += (currentValue - position.investmentAmount);
      });

      // Format message
      let statsMsg = `💰 *Profit Statistics:*\n\n`;

      // Completed trades section
      statsMsg += `*Completed Trades:*\n`;
      statsMsg += `• Total trades: ${totalTrades}\n`;
      statsMsg += `• Winning trades: ${stats.winCount} (${winRate.toFixed(1)}%)\n`;
      statsMsg += `• Losing trades: ${stats.lossCount}\n`;
      statsMsg += `• Total invested: ${stats.totalInvested.toFixed(2)} SOL\n`;
      statsMsg += `• Total returned: ${stats.totalReturned.toFixed(2)} SOL\n`;
      statsMsg += `• Realized profit: ${stats.totalProfit.toFixed(2)} SOL\n`;
      statsMsg += `• ROI: ${roi.toFixed(2)}%\n\n`;

      // Active trades section
      statsMsg += `*Active Positions:*\n`;
      statsMsg += `• Active positions: ${activePositions.length}\n`;
      statsMsg += `• Active investment: ${stats.activeInvestment.toFixed(2)} SOL\n`;
      statsMsg += `• Current value: ${totalCurrentValue.toFixed(2)} SOL\n`;
      statsMsg += `• Unrealized P/L: ${unrealizedProfit.toFixed(2)} SOL (${stats.activeInvestment > 0 ? (unrealizedProfit / stats.activeInvestment * 100).toFixed(2) : 0}%)\n\n`;

      // Overall section
      statsMsg += `*Overall Status:*\n`;
      statsMsg += `• Total P/L: ${(stats.totalProfit + unrealizedProfit).toFixed(2)} SOL\n`;
      statsMsg += `• Total investment: ${(stats.totalInvested + stats.activeInvestment).toFixed(2)} SOL\n`;
      statsMsg += `• Overall ROI: ${((stats.totalInvested + stats.activeInvestment) > 0 ? ((stats.totalProfit + unrealizedProfit) / (stats.totalInvested + stats.activeInvestment) * 100).toFixed(2) : 0)}%\n`;

      // Add commands help
      statsMsg += `\n💡 Use /tradehistory to view detailed trade history.`;
      statsMsg += `\n💡 Use /pnlreport for a detailed profit/loss breakdown.`;

      bot.sendMessage(chatId, statsMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error in profit stats:', error);
      bot.sendMessage(chatId, "❌ Error retrieving profit statistics.");
    }
  });

  // Command to display detailed PnL report
  bot.onText(/\/pnlreport(?:\s+(\d+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const limit = match[1] ? parseInt(match[1]) : 10; // Default to 10 most recent trades

    try {
      // Update stats first
      updateProfitStats();

      // Get completed trades, sorted by exit timestamp (most recent first)
      const trades = [...tradingConfig.tradeHistory]
        .sort((a, b) => b.exitTimestamp - a.exitTimestamp)
        .slice(0, limit);

      // Get active positions
      const activePositions = Array.from(tradingConfig.activePositions.values());

      // Calculate unrealized PnL for active positions
      const activePnL = activePositions.map(position => {
        const tokenInfo = tokenRegistry.get(position.mint);
        const currentPrice = tokenInfo?.currentPrice || 0;
        const currentValue = position.tokenAmount * currentPrice;
        const unrealizedProfit = currentValue - position.investmentAmount;
        const unrealizedPercent = position.investmentAmount > 0 ? (unrealizedProfit / position.investmentAmount) * 100 : 0;

        return {
          symbol: position.symbol,
          entryPrice: position.entryPrice,
          currentPrice: currentPrice,
          investmentAmount: position.investmentAmount,
          currentValue: currentValue,
          pnlAmount: unrealizedProfit,
          pnlPercent: unrealizedPercent,
          type: position.isSimulation ? 'Simulation' : 'Real',
          duration: formatDuration(Date.now() - position.entryTimestamp)
        };
      });

      // Format message
      let pnlMsg = `📊 *Detailed PnL Report:*\n\n`;

      // Section 1: Total PnL Summary
      const totalStats = tradingConfig.profitStats;
      pnlMsg += `*PnL Summary:*\n`;
      pnlMsg += `• *Realized PnL*: ${totalStats.totalProfit.toFixed(2)} SOL\n`;

      // Calculate unrealized total
      const totalUnrealized = activePnL.reduce((sum, pos) => sum + pos.pnlAmount, 0);
      pnlMsg += `• *Unrealized PnL*: ${totalUnrealized.toFixed(2)} SOL\n`;
      pnlMsg += `• *Combined PnL*: ${(totalStats.totalProfit + totalUnrealized).toFixed(2)} SOL\n\n`;

      // Section 2: Recent Closed Trades
      if (trades.length > 0) {
        pnlMsg += `*Recent Closed Trades:*\n`;
        pnlMsg += "```\n";
        pnlMsg += "Symbol    | P/L (SOL) | P/L (%)  | Type\n";
        pnlMsg += "----------|-----------|----------|--------\n";

        trades.forEach(trade => {
          const symbol = trade.symbol.padEnd(9).substring(0, 9);
          const pnlAmount = trade.profitAmount.toFixed(2).padStart(8);
          const pnlPercent = trade.profitPercent.toFixed(1).padStart(7) + '%';
          const type = (trade.isSimulation ? 'Sim' : 'Real').padEnd(7);

          pnlMsg += `${symbol} | ${pnlAmount} | ${pnlPercent} | ${type}\n`;
        });

        pnlMsg += "```\n\n";
      }

      // Section 3: Active Positions
      if (activePnL.length > 0) {
        pnlMsg += `*Current Active Positions:*\n`;
        pnlMsg += "```\n";
        pnlMsg += "Symbol    | P/L (SOL) | P/L (%)  | Type\n";
        pnlMsg += "----------|-----------|----------|--------\n";

        activePnL.forEach(position => {
          const symbol = position.symbol.padEnd(9).substring(0, 9);
          const pnlAmount = position.pnlAmount.toFixed(2).padStart(8);
          const pnlPercent = position.pnlPercent.toFixed(1).padStart(7) + '%';
          const type = (position.type === 'Simulation' ? 'Sim' : 'Real').padEnd(7);

          pnlMsg += `${symbol} | ${pnlAmount} | ${pnlPercent} | ${type}\n`;
        });

        pnlMsg += "```\n\n";
      }

      // Section 4: Performance Stats
      pnlMsg += `*Trading Performance:*\n`;
      pnlMsg += `• Win rate: ${totalStats.winCount}/${totalStats.winCount + totalStats.lossCount} (${(totalStats.winCount / (totalStats.winCount + totalStats.lossCount) * 100).toFixed(1)}%)\n`;

      // Calculate average win and loss percentages
      const winningTrades = tradingConfig.tradeHistory.filter(t => t.profitAmount > 0);
      const losingTrades = tradingConfig.tradeHistory.filter(t => t.profitAmount < 0);

      const avgWinPercent = winningTrades.length > 0
        ? winningTrades.reduce((sum, t) => sum + t.profitPercent, 0) / winningTrades.length
        : 0;

      const avgLossPercent = losingTrades.length > 0
        ? losingTrades.reduce((sum, t) => sum + t.profitPercent, 0) / losingTrades.length
        : 0;

      pnlMsg += `• Avg win: ${avgWinPercent.toFixed(1)}%\n`;
      pnlMsg += `• Avg loss: ${avgLossPercent.toFixed(1)}%\n`;

      // Send message
      bot.sendMessage(chatId, pnlMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error generating PnL report:', error);
      bot.sendMessage(chatId, "❌ Error generating PnL report.");
    }
  });

  // Command to reset all trading data (admin only with confirmation)
  bot.onText(/\/resettrading/, (msg) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    // Send confirmation request
    const confirmationMsg = `⚠️ *WARNING: This will reset all trading data!* ⚠️\n\n` +
                           `This action will:\n` +
                           `• Close all active positions\n` +
                           `• Delete all trade history\n` +
                           `• Reset all profit statistics\n\n` +
                           `To confirm, reply with: /confirmreset`;

    bot.sendMessage(chatId, confirmationMsg, { parse_mode: 'Markdown' });
  });

  // Command to close all positions (admin only)
  bot.onText(/\/closeallpositions/, async (msg) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    try {
      const activePositions = Array.from(tradingConfig.activePositions.entries());

      if (activePositions.length === 0) {
        bot.sendMessage(chatId, "ℹ️ No active positions to close.");
        return;
      }

      // Send initial message
      const initialMsg = await bot.sendMessage(
        chatId,
        `🔄 Closing ${activePositions.length} active positions. Please wait...`,
        { parse_mode: 'Markdown' }
      );

      // Track results
      let successCount = 0;
      let failCount = 0;
      let results = [];

      // Process each position - make a copy for iteration safety
      const positionsArray = [...activePositions];
      for (const [mint, position] of positionsArray) {
        try {
          console.log(`Attempting to close position for ${position.symbol} (${mint})`);
          // Get current price
          const tokenInfo = tokenRegistry.get(mint);
          const currentPrice = tokenInfo?.currentPrice || position.entryPrice;

          // Close position
          const closedTrade = closePosition(mint, 'manual_bulk', currentPrice);

          if (closedTrade) {
            successCount++;
            results.push({
              symbol: position.symbol,
              success: true,
              profitAmount: closedTrade.profitAmount,
              profitPercent: closedTrade.profitPercent
            });
            console.log(`Successfully closed position for ${position.symbol}`);
          } else {
            failCount++;
            results.push({
              symbol: position.symbol,
              success: false
            });
            console.log(`Failed to close position for ${position.symbol}`);
          }
        } catch (error) {
          console.error(`Error closing position for ${mint}:`, error);
          failCount++;
          results.push({
            symbol: position.symbol || mint.slice(0, 6),
            success: false,
            error: error.message
          });
        }

        // Brief pause to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Update stats
      updateProfitStats();

      // Prepare result message
      let resultMsg = `🏁 *Position Closing Complete*\n\n`;
      resultMsg += `• Total positions: ${activePositions.length}\n`;
      resultMsg += `• Successfully closed: ${successCount}\n`;

      if (failCount > 0) {
        resultMsg += `• Failed to close: ${failCount}\n`;
      }

      // Add details about positions
      if (results.length > 0) {
        resultMsg += `\n*Position Details:*\n`;

        // Sort by success/fail and then by profit
        results.sort((a, b) => {
          if (a.success !== b.success) return b.success ? 1 : -1;
          if (!a.success || !b.success) return 0;
          return b.profitAmount - a.profitAmount;
        });

        // Add top 5 positions (or all if less than 5)
        const topResults = results.slice(0, Math.min(5, results.length));
        topResults.forEach(result => {
          if (result.success) {
            const profitSign = result.profitAmount >= 0 ? '+' : '';
            resultMsg += `• ${result.symbol}: ${profitSign}${result.profitAmount.toFixed(2)} SOL (${profitSign}${result.profitPercent.toFixed(2)}%)\n`;
          } else {
            resultMsg += `• ${result.symbol}: Failed to close\n`;
          }
        });

        if (results.length > 5) {
          resultMsg += `• ... and ${results.length - 5} more positions\n`;
        }
      }

      // Check if positions were all closed
      const remainingPositions = tradingConfig.activePositions.size;
      if (remainingPositions > 0) {
        resultMsg += `\n⚠️ Warning: ${remainingPositions} positions still remain active. Some positions may not have closed properly.`;
      }

      // Save config to make sure all positions changes are persisted
      saveTradingConfig();

      // Send result message
      await bot.editMessageText(resultMsg, {
        chat_id: chatId,
        message_id: initialMsg.message_id,
        parse_mode: 'Markdown'
      });

    } catch (error) {
      console.error('Error in closeAllPositions command:', error);
      bot.sendMessage(chatId, "❌ Error closing positions. Please check logs.");
    }
  });

  // Command to view active positions with sell buttons (wallet-style keyboard)
  bot.onText(/\/wallet/, (msg) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId; // Check if user is admin

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    try {
      const positions = Array.from(tradingConfig.activePositions.values());

      if (positions.length === 0) {
        bot.sendMessage(chatId, "💼 No active positions in your wallet at the moment.");
        return;
      }

      // Update all positions before displaying
      const mints = Array.from(tradingConfig.activePositions.keys());
      mints.forEach(mint => {
        try {
          checkPosition(mint);
        } catch (error) {
          console.error(`Error checking position for ${mint}:`, error);
        }
      });

      // Get updated positions
      const updatedPositions = Array.from(tradingConfig.activePositions.values());

      // Sort by profit (best performing first)
      updatedPositions.sort((a, b) => {
        const entryPriceA = a.entryPrice || 0.000001;
        const entryPriceB = b.entryPrice || 0.000001;
        const currentPriceA = a.currentPrice || entryPriceA;
        const currentPriceB = b.currentPrice || entryPriceB;

        const profitA = ((currentPriceA / entryPriceA) - 1) * 100;
        const profitB = ((currentPriceB / entryPriceB) - 1) * 100;

        // Handle NaN or Infinity
        const safeA = isFinite(profitA) ? profitA : 0;
        const safeB = isFinite(profitB) ? profitB : 0;

        return safeB - safeA;
      });

      // Calculate total wallet value
      let totalInvested = 0;
      let totalCurrentValue = 0;

      updatedPositions.forEach(position => {
        // Get current price from tokenRegistry if possible
        const tokenInfo = tokenRegistry.get(position.mint);
        const currentPrice = tokenInfo?.currentPrice || position.currentPrice || position.entryPrice || 0;

        // Debug log
        console.log(`Wallet position ${position.symbol}: investmentAmount=${position.investmentAmount}, tokenAmount=${position.tokenAmount}, currentPrice=${currentPrice}`);

        // Update position's current price to ensure it's valid
        position.currentPrice = currentPrice;

        totalInvested += position.investmentAmount || 0;
        totalCurrentValue += position.tokenAmount * currentPrice;
      });

      // Calculate overall P&L
      const totalProfit = totalCurrentValue - totalInvested;
      const totalProfitPercent = (totalInvested > 0) ? (totalProfit / totalInvested) * 100 : 0;
      const profitSign = totalProfit >= 0 ? '+' : '';

      let walletMsg = `🏦 *Wallet Holdings*\n\n`;
      walletMsg += `Total Value: ${totalCurrentValue.toFixed(2)} SOL\n`;
      walletMsg += `Total Invested: ${totalInvested.toFixed(2)} SOL\n`;
      walletMsg += `Overall P/L: ${profitSign}${totalProfit.toFixed(2)} SOL (${profitSign}${totalProfitPercent.toFixed(2)}%)\n\n`;
      walletMsg += `Click on a token below to sell it:\n`;

      // Create keyboard with buttons for each position
      const keyboard = {
        inline_keyboard: []
      };

      // Create rows with 2 buttons per row
      for (let i = 0; i < updatedPositions.length; i += 2) {
        const row = [];

        // Add first position in row
        const pos1 = updatedPositions[i];
        // Calculate profit safely
        const entryPrice1 = pos1.entryPrice || 0.000001; // Avoid division by zero
        const currentPrice1 = pos1.currentPrice || entryPrice1;
        const profit1 = entryPrice1 > 0 ? ((currentPrice1 / entryPrice1) - 1) * 100 : 0;
        const profitSign1 = profit1 >= 0 ? '+' : '';
        row.push({
          text: `${pos1.symbol} (${profitSign1}${profit1.toFixed(2)}%)`,
          callback_data: `sell_all_${pos1.mint}`
        });

        // Add second position if available
        if (i + 1 < updatedPositions.length) {
          const pos2 = updatedPositions[i + 1];
          // Calculate profit safely
          const entryPrice2 = pos2.entryPrice || 0.000001; // Avoid division by zero
          const currentPrice2 = pos2.currentPrice || entryPrice2;
          const profit2 = entryPrice2 > 0 ? ((currentPrice2 / entryPrice2) - 1) * 100 : 0;
          const profitSign2 = profit2 >= 0 ? '+' : '';
          row.push({
            text: `${pos2.symbol} (${profitSign2}${profit2.toFixed(2)}%)`,
            callback_data: `sell_all_${pos2.mint}`
          });
        }

        keyboard.inline_keyboard.push(row);
      }

      // Add a "Sell All" button at the bottom
      keyboard.inline_keyboard.push([
        { text: '🔴 SELL ALL POSITIONS', callback_data: 'sell_all_positions' }
      ]);

      bot.sendMessage(chatId, walletMsg, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (error) {
      console.error('Error in /wallet command:', error);
      bot.sendMessage(chatId, "❌ Error retrieving wallet positions.");
    }
  });

  // Confirmation for trading data reset
  bot.onText(/\/confirmreset/, (msg) => {
    const chatId = msg.chat.id;
    const isAdmin = chatId === adminChatId;

    if (!isAdmin) {
      bot.sendMessage(chatId, "❌ This command is restricted to admin use only.");
      return;
    }

    try {
      // Reset trading data
      tradingConfig.tradeHistory = [];
      tradingConfig.activePositions = new Map();
      tradingConfig.profitStats = {
        totalInvested: 0,
        totalReturned: 0,
        totalProfit: 0,
        winCount: 0,
        lossCount: 0,
        activeInvestment: 0
      };

      // Save the reset configuration
      saveTradingConfig();

      // Send confirmation
      bot.sendMessage(chatId, "✅ All trading data has been reset.");
    } catch (error) {
      console.error('Error resetting trading data:', error);
      bot.sendMessage(chatId, "❌ Error resetting trading data.");
    }
  });
}

// Add trading information to /toppumps command
function addTradingInfoToTopPumps(pumpsMsg) {
  if (!tradingConfig.autoTrading) {
    return pumpsMsg;
  }

  // Get updated stats
  const stats = updateProfitStats();

  // Calculate overall metrics
  const totalTrades = stats.winCount + stats.lossCount;
  const winRate = totalTrades > 0 ? (stats.winCount / totalTrades) * 100 : 0;

  // Active positions summary
  const activePositions = Array.from(tradingConfig.activePositions.values());
  const activeTokens = activePositions.map(p => p.symbol).join(', ') || 'None';

  // Add trading section to message
  pumpsMsg += `\n💹 *Trading Performance:*\n`;
  pumpsMsg += "``````\n";
  pumpsMsg += `• Active positions: ${activePositions.length} (${activeTokens})\n`;
  pumpsMsg += `• Completed trades: ${totalTrades}\n`;
  pumpsMsg += `• Win rate: ${winRate.toFixed(1)}%\n`;
  pumpsMsg += `• Total profit: ${stats.totalProfit.toFixed(2)} SOL\n`;
  pumpsMsg += "``````\n";
  pumpsMsg += `Use /profitstats for detailed profit statistics`;

  return pumpsMsg;
}

/**
 * Get the current trading configuration
 * @returns {Object} The trading configuration object
 */
function getTradingConfig() {
  return tradingConfig;
}

// Export all functions
module.exports = {
  initialize,
  processAlertForTrading,
  checkPosition,
  checkAllPositions,
  closePosition,
  updateProfitStats,
  hookIntoAlertTracker,
  addTradingInfoToTopPumps,
  manualEntry,
  calculatePotentialProfit,
  getTradingConfig
};