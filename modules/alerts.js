let bundleAnalyzer;
let walletManager;
let broadcastToChats;
let trackAlert;

// Tracking hook for trading system
let alertToTradeHook;
let globalAlertDeduplication = new Set();
let tokenRegistry;
let bot; // Reference to the Telegram bot

function initialize(dependencies) {
  const {
    bundleAnalyzerModule,
    walletManagerModule,
    broadcastFunc,
    trackAlertFunc,
    alertToTradeHookModule,
    tokenRegistryModule,  // Token registry dependency
    botInstance           // Telegram bot instance
  } = dependencies;

  bundleAnalyzer = bundleAnalyzerModule;
  walletManager = walletManagerModule;
  broadcastToChats = broadcastFunc;
  trackAlert = trackAlertFunc;
  alertToTradeHook = alertToTradeHookModule;
  tokenRegistry = tokenRegistryModule; // Store token registry for reference
  bot = botInstance;                   // Store bot instance for sending photos

  // Reset deduplication set on initialize
  globalAlertDeduplication = new Set();

  return {
    createSmartMoneyAlert,
    createMigrationAlert,
    createBullishTokenAlert,
    hasAlertedToken,
    resetDedupe
  };
}

// Function to broadcast a photo to all active chats
async function broadcastPhotoToChats(photoUrl, options = {}) {
  console.log(`PHOTO ALERT: Attempting to send photo alert with URL: ${photoUrl}`);

  if (!bot) {
    console.error('PHOTO ALERT: Cannot send photo: bot instance not initialized');
    // Fall back to text message
    console.log('PHOTO ALERT: Falling back to text message');
    return broadcastToChats(options.caption, {
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup
    });
  }

  // Get active chats from the global scope (same as used by broadcastToChats)
  // This is passed from tradingbot.js
  const activeChats = global.activeChats;
  if (!activeChats || activeChats.size === 0) {
    console.error('PHOTO ALERT: No active chats to broadcast to');
    return null;
  }

  console.log(`PHOTO ALERT: Sending to ${activeChats.size} chats`);

  // Send to the first chat and return that message for reference storage
  try {
    const firstChatId = Array.from(activeChats)[0];
    console.log(`PHOTO ALERT: Sending to first chat: ${firstChatId}`);

    // Validate the photo URL
    if (!photoUrl || typeof photoUrl !== 'string' || !photoUrl.startsWith('http')) {
      console.error(`PHOTO ALERT: Invalid photo URL: ${photoUrl}`);
      // Fall back to text message
      console.log('PHOTO ALERT: Falling back to text message due to invalid URL');
      return broadcastToChats(options.caption, {
        parse_mode: options.parse_mode,
        reply_markup: options.reply_markup
      });
    }

    // Try to send the photo
    let sentMessage;
    try {
      console.log(`PHOTO ALERT: Sending photo to ${firstChatId} with URL: ${photoUrl}`);
      sentMessage = await bot.sendPhoto(firstChatId, photoUrl, options);
      console.log(`PHOTO ALERT: Successfully sent photo to first chat`);
    } catch (photoError) {
      console.error(`PHOTO ALERT: Error sending photo to first chat:`, photoError);
      // Fall back to text message
      console.log('PHOTO ALERT: Falling back to text message due to error');
      return broadcastToChats(options.caption, {
        parse_mode: options.parse_mode,
        reply_markup: options.reply_markup
      });
    }

    // Send to all other chats
    for (const chatId of activeChats) {
      // Skip the first chat as we already sent to it
      if (chatId === firstChatId) continue;

      try {
        console.log(`PHOTO ALERT: Sending photo to chat: ${chatId}`);
        await bot.sendPhoto(chatId, photoUrl, options).catch(error => {
          console.error(`PHOTO ALERT: Error sending photo to chat ${chatId}:`, error);
          // If this chat is no longer valid, suggest removing it
          if (error.code === 'ETELEGRAM' &&
              (error.response.body.error_code === 403 || error.response.body.error_code === 400)) {
            console.log(`PHOTO ALERT: Invalid chat ID detected: ${chatId} - should be removed`);
          }

          // Try to send as text instead
          try {
            console.log(`PHOTO ALERT: Falling back to text message for chat ${chatId}`);
            bot.sendMessage(chatId, options.caption, {
              parse_mode: options.parse_mode,
              reply_markup: options.reply_markup
            });
          } catch (textError) {
            console.error(`PHOTO ALERT: Error sending fallback text to chat ${chatId}:`, textError);
          }
        });
      } catch (error) {
        console.error(`PHOTO ALERT: Error sending photo to chat ${chatId}:`, error);
      }
    }

    // Return the first sent message for reference
    return sentMessage;
  } catch (error) {
    console.error('PHOTO ALERT: Error broadcasting photo to chats:', error);

    // Fall back to text message
    console.log('PHOTO ALERT: Falling back to text message due to general error');
    return broadcastToChats(options.caption, {
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup
    });
  }
}

// Helper function to check if a token has been alerted already
function hasAlertedToken(mint) {
  // First check if the token is in the global deduplication set
  if (!globalAlertDeduplication.has(mint)) {
    return false; // Token has not been alerted yet
  }

  // If token is in the registry, check if it has gained more than 200% since last alert
  if (tokenRegistry && tokenRegistry.has(mint)) {
    const tokenInfo = tokenRegistry.get(mint);
    const lastAlertPrice = tokenInfo.lastAlertPrice || 0;
    const currentPrice = tokenInfo.currentPrice || 0;

    if (lastAlertPrice > 0 && currentPrice > 0) {
      const priceChangeSinceLastAlert = ((currentPrice - lastAlertPrice) / lastAlertPrice) * 100;

      // If price has gained more than 200%, allow another alert
      if (priceChangeSinceLastAlert >= 200) {
        console.log(`Token ${tokenInfo.symbol || mint} has gained ${priceChangeSinceLastAlert.toFixed(2)}% since last alert (>200%), allowing new alert`);
        return false;
      }
    }
  }

  // Default case: token has been alerted and doesn't meet criteria for a new alert
  return true;
}

// Function to reset deduplication if needed
function resetDedupe() {
  globalAlertDeduplication.clear();
}


async function createSmartMoneyAlert(data) {
  const {
    mint,
    tokenInfo,
    traderPublicKey,
    solAmount,
    price,
    isFollowup,
    lastAlert = {},
    marketCapSol,
    solPriceUsd,
    bundleAnalysisResult
  } = data;

  try {
    // Check global deduplication first using our enhanced function
    // This will automatically check if the token has gained more than 200% since last alert
    if (hasAlertedToken(mint)) {
      console.log(`GLOBAL DEDUPE: Skipping smart money alert for ${tokenInfo.symbol || mint} - token already alerted and price gain < 200%`);
      return false;
    }

    // Add to global deduplication set immediately
    globalAlertDeduplication.add(mint);
    console.log(`Added to global deduplication: ${mint} (smart money alert)`);

    // Format market cap in SOL and USD
    const marketCapFormatted = marketCapSol < 1000
      ? `${marketCapSol.toFixed(2)} SOL`
      : `${(marketCapSol / 1000).toFixed(2)}K SOL`;

    // Calculate USD market cap if SOL price is available
    let marketCapUsdFormatted = "";
    if (solPriceUsd) {
      const marketCapUsd = marketCapSol * solPriceUsd;
      marketCapUsdFormatted = marketCapUsd < 1000000
        ? ` ($${Math.round(marketCapUsd).toLocaleString()})`
        : ` ($${(marketCapUsd / 1000000).toFixed(2)}M)`;
    }

    // Generate URLs
    const pumpFunUrl = `https://pump.fun/coin/${mint}`;
    const solscanUrl = `https://solscan.io/token/${mint}`;
    const neoUrl = `https://neo.bullx.io/terminal?chainId=1399811149&address=${mint}`;
    const axiomUrl = `https://axiom.trade/meme/${mint}`;
    const walletUrl = `https://solscan.io/account/${traderPublicKey}`;

    // Process bundle data if available
    let bundleInfoSection = '';
    if (bundleAnalysisResult) {
      const bundleData = bundleAnalyzer.extractBundleAnalytics(bundleAnalysisResult);
      const creatorData = bundleAnalyzer.extractCreatorAnalytics(bundleAnalysisResult.creator_analysis);
      bundleInfoSection = bundleAnalyzer.formatBundleInfoForAlert(bundleData, creatorData);
    }

    // Create alert message
    const alertMsg = `🧠 *${isFollowup ? "ADDITIONAL" : "INITIAL"} SMART MONEY ACTIVITY* 🧠\n\n` +
      `💼 *${tokenInfo.symbol || tokenInfo.name} being purchased by tracked wallet*\n\n` +
      `📊 *Key Metrics:*\n` +
      `🔹 Wallet: \`${traderPublicKey.slice(0, 8)}...\`\n` +
      `🔹 Action: *BUY*\n` +
      `🔹 Amount: *${solAmount.toFixed(4)} SOL*\n` +
      (isFollowup ? `🔹 Previous amount: *${lastAlert.amount.toFixed(4)} SOL*\n` : '') +
      `🔹 Price: *${price.toFixed(9)} SOL*\n` +
      `🔹 Market cap: *${marketCapFormatted}${marketCapUsdFormatted}*\n` +
      (tokenInfo.dexScreenerPaid ? `🔹 Paid on DEXScreener: *Yes* (${tokenInfo.dexScreenerOrderTypes.join(', ')}) 💸\n` : '') +
      `\n🔍 *Analysis:*\n` +
      `• ${isFollowup ? "Smart money wallet increasing position" : "Identified smart money wallet taking a new position"}\n` +
      `• This wallet has a history of profitable trades\n` +
      `• Consider monitoring this token closely for further accumulation\n` +
      `${bundleInfoSection}\n\n` +
      `🔗 [Token](${pumpFunUrl}) | [Wallet](${walletUrl})\n` +
      `🔗 [Solscan](${solscanUrl})\n` +
      `🔗 [NeoBullX](${neoUrl})\n` +
      `🔗 [AxiomTrade](${axiomUrl})\n\n` +
      `\`${mint}\``;

    // Add instabuy buttons to the alert
    const inlineKeyboard = walletManager.generateInstabuyButtons(mint);

    // Send the alert
    broadcastToChats(alertMsg, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });

    // Track the alert for analytics
    trackAlert(mint, 'smart_money', marketCapSol);

    // Call the trading hook if available
    if (alertToTradeHook && tokenInfo) {
      try {
        alertToTradeHook(mint, {
          symbol: tokenInfo.symbol || tokenInfo.name,
          type: 'smart_money',
          timestamp: Date.now(),
          initialMarketCap: marketCapSol,
          initialPriceUsd: marketCapSol * (solPriceUsd || 0)
        });
        console.log(`Smart money alert sent to trading system for ${mint}`);
      } catch (error) {
        console.error(`Error sending smart money alert to trading system: ${error.message}`);
      }
    }

    return true;
  } catch (error) {
    console.error('Error creating smart money alert:', error);
    return false;
  }
}

/**
 * Migration Alert - When tokens migrate to a new liquidity pool
 */
async function createMigrationAlert(data) {
  const {
    mint,
    pool,
    tokenInfo,
    marketCapSol,
    solPriceUsd,
    bundleAnalysisResult
  } = data;

  try {
    // Check global deduplication first using our enhanced function
    // This will automatically check if the token has gained more than 200% since last alert
    if (hasAlertedToken(mint)) {
      console.log(`GLOBAL DEDUPE: Skipping migration alert for ${tokenInfo.symbol || mint} - token already alerted and price gain < 200%`);
      return false;
    }

    // Add to global deduplication set immediately
    globalAlertDeduplication.add(mint);
    console.log(`Added to global deduplication: ${mint} (migration alert)`);

    // Format market cap in SOL and USD
    const marketCapFormatted = marketCapSol < 1000
      ? `${marketCapSol.toFixed(2)} SOL`
      : `${(marketCapSol / 1000).toFixed(2)}K SOL`;

    // Calculate USD market cap if SOL price is available
    let marketCapUsdFormatted = "";
    if (solPriceUsd) {
      const marketCapUsd = marketCapSol * solPriceUsd;
      marketCapUsdFormatted = marketCapUsd < 1000000
        ? ` ($${Math.round(marketCapUsd).toLocaleString()})`
        : ` ($${(marketCapUsd / 1000000).toFixed(2)}M)`;
    }

    // Token Explorer URLs
    const pumpFunUrl = `https://pump.fun/coin/${mint}`;
    const solscanUrl = `https://solscan.io/token/${mint}`;
    const neoUrl = `https://neo.bullx.io/terminal?chainId=1399811149&address=${mint}`;
    const axiomUrl = `https://axiom.trade/meme/${mint}`;

    // Handle pool that could be a string ID or an address
    let poolUrl;
    if (pool && pool.length > 30) {
      // It's probably an address
      poolUrl = `https://solscan.io/account/${pool}`;
    } else {
      // It's a string identifier, just use the token URL
      poolUrl = pumpFunUrl;
    }

    // Process bundle data if available
    let bundleInfoSection = '';
    if (bundleAnalysisResult) {
      const bundleData = bundleAnalyzer.extractBundleAnalytics(bundleAnalysisResult);
      const creatorData = bundleAnalyzer.extractCreatorAnalytics(bundleAnalysisResult.creator_analysis);
      bundleInfoSection = bundleAnalyzer.formatBundleInfoForAlert(bundleData, creatorData);
    }

    // Create alert message
    const alertMsg = `🔄 *TOKEN MIGRATION DETECTED* 🔄\n\n` +
      `📊 *${tokenInfo.name || 'Unknown'} (${tokenInfo.symbol || 'Unknown'})*\n\n` +
      `📊 *Key Details:*\n` +
      `🔹 Original token: \`${mint.slice(0, 10)}...\`\n` +
      `🔹 New pool: \`${typeof pool === 'string' ? pool : pool.slice(0, 10) + '...'}\`\n` +
      `🔹 Migration time: *${new Date().toLocaleString()}*\n` +
      `🔹 Market cap: *${marketCapFormatted}${marketCapUsdFormatted}*\n` +
      (tokenInfo.dexScreenerPaid ? `🔹 Paid on DEXScreener: *Yes* (${tokenInfo.dexScreenerOrderTypes.join(', ')}) 💸\n` : '') +
      `\n🔍 *Analysis:*\n` +
      `• Token has been migrated to a new liquidity pool\n` +
      `• This may indicate upgrades or improvements to the token\n` +
      `• Check the new pool for updated trading parameters\n` +
      `${bundleInfoSection}\n\n` +
      `🔗 [Token](${pumpFunUrl}) | [New Pool](${poolUrl})\n` +
      `🔗 [Solscan](${solscanUrl})\n` +
      `🔗 [NeoBullX](${neoUrl})\n` +
      `🔗 [AxiomTrade](${axiomUrl})\n\n` +
      `\`${mint}\``;

    // Add instabuy buttons to the alert
    const inlineKeyboard = walletManager.generateInstabuyButtons(mint);

    // Send the alert
    broadcastToChats(alertMsg, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });

    // Track the alert for analytics
    trackAlert(mint, 'migration', marketCapSol);

    // Call the trading hook if available
    if (alertToTradeHook && tokenInfo) {
      try {
        alertToTradeHook(mint, {
          symbol: tokenInfo.symbol || tokenInfo.name,
          type: 'migration',
          timestamp: Date.now(),
          initialMarketCap: marketCapSol,
          initialPriceUsd: marketCapSol * (solPriceUsd || 0)
        });
        console.log(`Migration alert sent to trading system for ${mint}`);
      } catch (error) {
        console.error(`Error sending migration alert to trading system: ${error.message}`);
      }
    }

    return true;
  } catch (error) {
    console.error('Error creating migration alert:', error);
    return false;
  }
}


async function createBullishTokenAlert(data) {
  const {
    mint,
    tokenInfo,
    marketCapSol,
    solPriceUsd,
    sentimentScore,
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
    // totalScore is not used directly but may be passed from the caller
    bundleAnalysisResult,
    PRICE_INCREASE_THRESHOLD = 40,
    BUY_SELL_RATIO_THRESHOLD = 1.3,
    HOLDER_GROWTH_THRESHOLD = 45,
    analysisText // Custom analysis text parameter
  } = data;

  try {
    // Check global deduplication first using our enhanced function
    // This will automatically check if the token has gained more than 200% since last alert
    if (hasAlertedToken(mint)) {
      console.log(`GLOBAL DEDUPE: Skipping bullish token alert for ${tokenInfo.symbol || mint} - token already alerted and price gain < 200%`);
      return false;
    }

    // Add to global deduplication set immediately
    globalAlertDeduplication.add(mint);
    console.log(`Added to global deduplication: ${mint} (bullish token alert)`);

    // Format market cap in SOL and USD
    const marketCapFormatted = marketCapSol < 1000
      ? `${marketCapSol.toFixed(2)} SOL`
      : `${(marketCapSol / 1000).toFixed(2)}K SOL`;

    // Calculate USD market cap if SOL price is available
    let marketCapUsdFormatted = "";
    if (solPriceUsd) {
      const marketCapUsd = marketCapSol * solPriceUsd;
      marketCapUsdFormatted = marketCapUsd < 1000000
        ? ` ($${Math.round(marketCapUsd).toLocaleString()})`
        : ` ($${(marketCapUsd / 1000000).toFixed(2)}M)`;
    }

    // Generate URLs
    const pumpFunUrl = `https://pump.fun/coin/${mint}`;
    const solscanUrl = `https://solscan.io/token/${mint}`;
    const neoUrl = `https://neo.bullx.io/terminal?chainId=1399811149&address=${mint}`;
    const axiomUrl = `https://axiom.trade/meme/${mint}`;

    // Process bundle data if available
    let bundleInfoSection = '';
    if (bundleAnalysisResult) {
      if (bundleAnalysisResult.bundleInfoSection) {
        bundleInfoSection = bundleAnalysisResult.bundleInfoSection;
      } else if (bundleAnalyzer) {
        const bundleData = bundleAnalyzer.extractBundleAnalytics(bundleAnalysisResult);
        const creatorData = bundleAnalyzer.extractCreatorAnalytics(bundleAnalysisResult.creator_analysis);
        bundleInfoSection = bundleAnalyzer.formatBundleInfoForAlert(bundleData, creatorData);
      }
    }

    // Helper function for bullish signals
    const getBullishSignal = (value, threshold) => {
      if (value >= threshold * 2) return '🟢🟢';
      if (value >= threshold) return '🟢';
      return '⚪';
    };

    // Determine alert type based on sentiment
    let alertType, alertEmoji;
    if (sentimentScore >= 95) {
      alertType = '💎💎 *EXTREMELY BULLISH TOKEN* 💎💎';
      alertEmoji = '🔥🔥';
    } else if (sentimentScore >= 85) {
      alertType = '💎 *VERY BULLISH TOKEN* 💎';
      alertEmoji = '🔥';
    } else {
      // Skip this alert - we only want bullish tokens
      console.log(`Skipping alert for ${tokenInfo.symbol || mint} - sentiment not high enough (${sentimentScore})`);
      return false;
    }

    // Format market cap change if this is a follow-up alert
    let marketCapChangeInfo = '';
    if (tokenInfo.initialMarketCapSol && tokenInfo.initialMarketCapSol > 0 && tokenInfo.initialAnalysisTime) {
      const marketCapChange = ((marketCapSol - tokenInfo.initialMarketCapSol) / tokenInfo.initialMarketCapSol) * 100;
      const timeSinceInitial = Math.floor((Date.now() - tokenInfo.initialAnalysisTime) / 60000); // in minutes
      marketCapChangeInfo = `\n🔹 Market cap change: *${marketCapChange.toFixed(2)}%* since initial alert (${timeSinceInitial}m ago)`;
    }

    // Add King of the Hill status if applicable
    let kingOfHillInfo = '';
    if (tokenInfo.isKingOfTheHill) {
      const kohTime = new Date(tokenInfo.kingOfTheHillTimestamp).toLocaleString();
      kingOfHillInfo = `👑 *King of the Hill since:* ${kohTime}\n`;
    }

    // Add social links if available
    let socialLinks = '';
    if (tokenInfo.twitter) {
      socialLinks += `🐦 [Twitter](${tokenInfo.twitter})\n`;
    }
    if (tokenInfo.telegram) {
      socialLinks += `📱 [Telegram](${tokenInfo.telegram})\n`;
    }
    if (tokenInfo.website) {
      socialLinks += `🌐 [Website](${tokenInfo.website})\n`;
    }

    // If we have social links, add a header
    if (socialLinks) {
      socialLinks = `📱 *Social Media:*\n${socialLinks}`;
    }

    // Add natural trading analysis if available
    let naturalTradingInfo = '';
    if (tokenInfo.naturalAnalysis) {
      const naturalAnalysis = tokenInfo.naturalAnalysis;
      const naturalEmoji = naturalAnalysis.isNatural ? '✅' : '⚠️';
      const naturalScore = naturalAnalysis.naturalScore || 0;
      naturalTradingInfo = `🔹 Natural trading score: *${naturalScore}/100* ${naturalEmoji}\n`;

      // Add manipulation warning if score is low but we're still alerting for evaluation
      if (!naturalAnalysis.isNatural) {
        naturalTradingInfo += `⚠️ *Caution:* Possible manipulation detected\n`;
      }
    }

    // Prepare image if available
    let messageOptions = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: walletManager.generateInstabuyButtons(mint)
      }
    };

    // Check if token has an image URL
    const hasImage = tokenInfo.imageUrl || tokenInfo.logo;

    // Create alert message
    let alertMsg;

    if (hasImage) {
      // If we have an image, we'll send it as a photo with caption
      messageOptions.caption = `${alertType}\n\n` +
        `${alertEmoji} *${tokenInfo.name} (${tokenInfo.symbol})*\n\n` +
        `${kingOfHillInfo}` +
        `📊 *Key Metrics:*\n` +
        `🔹 Volume: *${volume.toFixed(4)} SOL* (${volumeVelocity?.toFixed(4) || '0.0000'} SOL/min)\n` +
        `🔹 Market cap: *${marketCapFormatted}${marketCapUsdFormatted}*${marketCapChangeInfo}\n` +
        `🔹 Age: *${ageString || Math.floor(minutesSinceCreation) + 'm'}*\n` +
        `🔹 Price change: *${priceChangePercent.toFixed(2)}%* ${getBullishSignal(priceChangePercent, PRICE_INCREASE_THRESHOLD)}\n` +
        `🔹 Current price: *${tokenInfo.currentPrice?.toFixed(9) || '0.000000000'} SOL*\n` +
        `🔹 Buy/Sell ratio: *${buySellRatio.toFixed(2)}* ${getBullishSignal(buySellRatio, BUY_SELL_RATIO_THRESHOLD)}\n` +
        `🔹 Buy: *${buyPercentage.toFixed(1)}%* | Sell: *${sellPercentage.toFixed(1)}%*\n` +
        `🔹 Unique holders: *${holderCount}* ${getBullishSignal(holderCount, HOLDER_GROWTH_THRESHOLD)}\n` +
        `🔹 Trend analysis: *${tokenInfo.isUptrend ? 'Confirmed Uptrend' : 'No Clear Trend'}*\n` +
        `🔹 Trend strength: *${tokenInfo.trendStrength}* higher highs/lows\n` +
        `🔹 Volume trend: *${tokenInfo.healthyVolume ? 'Healthy' : 'Unstable'}*\n` +
        naturalTradingInfo + // Add natural trading info here
        (whaleCount > 0 ? `🔹 Whale activity: *${whaleCount}* 🐋\n` : '') +
        (smartMoneyInterest ? `🔹 Smart money interest: *Yes* 🧠\n` : '') +
        (tokenInfo.dexScreenerPaid ? `🔹 Paid on DEXScreener: *Yes* (${tokenInfo.dexScreenerOrderTypes.join(', ')}) 💸\n` : '') +
        `🔹 Sentiment: *${tokenInfo.sentimentCategory || ''}* (*${sentimentScore.toFixed(1)}*/100)\n` +
        (tokenInfo.replyCount ? `🔹 Community: *${tokenInfo.replyCount}* messages\n` : '') +
        (tokenInfo.athMarketCap ? `🔹 ATH Market Cap: *${tokenInfo.athMarketCap.toFixed(2)} SOL*\n` : '') +
        `\n🔍 *Analysis:*\n` +
        // Use the custom analysis from the main bot if provided, otherwise use a fallback
        `${analysisText || `• Token detected with exceptional metrics\n• ${buySellRatio >= BUY_SELL_RATIO_THRESHOLD ? 'Strong buy pressure with minimal selling' : 'Balanced trading activity'}\n• ${priceChangePercent >= PRICE_INCREASE_THRESHOLD ? 'Significant price appreciation since launch' : 'Steady price movement'}`}\n\n` +
        `${bundleInfoSection || ''}\n\n` +
        `🔗 [PumpFun](${pumpFunUrl})\n` +
        `🔗 [Solscan](${solscanUrl})\n` +
        `🔗 [NeoBull](${neoUrl})\n` +
        `🔗 [AxiomTrade](${axiomUrl})\n` +
        (socialLinks ? `\n${socialLinks}` : '') +
        `\n\`${mint}\``;

      // Set the image URL
      messageOptions.photo = tokenInfo.imageUrl || tokenInfo.logo;
      messageOptions.parse_mode = 'Markdown';

      // For photo messages, we'll use the caption instead of text
      alertMsg = null;
    } else {
      // If no image, use regular text message
      alertMsg = `${alertType}\n\n` +
        `${alertEmoji} *${tokenInfo.name} (${tokenInfo.symbol})*\n\n` +
        `${kingOfHillInfo}` +
        `📊 *Key Metrics:*\n` +
        `🔹 Volume: *${volume.toFixed(4)} SOL* (${volumeVelocity?.toFixed(4) || '0.0000'} SOL/min)\n` +
        `🔹 Market cap: *${marketCapFormatted}${marketCapUsdFormatted}*${marketCapChangeInfo}\n` +
        `🔹 Age: *${ageString || Math.floor(minutesSinceCreation) + 'm'}*\n` +
        `🔹 Price change: *${priceChangePercent.toFixed(2)}%* ${getBullishSignal(priceChangePercent, PRICE_INCREASE_THRESHOLD)}\n` +
        `🔹 Current price: *${tokenInfo.currentPrice?.toFixed(9) || '0.000000000'} SOL*\n` +
        `🔹 Buy/Sell ratio: *${buySellRatio.toFixed(2)}* ${getBullishSignal(buySellRatio, BUY_SELL_RATIO_THRESHOLD)}\n` +
        `🔹 Buy: *${buyPercentage.toFixed(1)}%* | Sell: *${sellPercentage.toFixed(1)}%*\n` +
        `🔹 Unique holders: *${holderCount}* ${getBullishSignal(holderCount, HOLDER_GROWTH_THRESHOLD)}\n` +
        `🔹 Trend analysis: *${tokenInfo.isUptrend ? 'Confirmed Uptrend' : 'No Clear Trend'}*\n` +
        `🔹 Trend strength: *${tokenInfo.trendStrength}* higher highs/lows\n` +
        `🔹 Volume trend: *${tokenInfo.healthyVolume ? 'Healthy' : 'Unstable'}*\n` +
        naturalTradingInfo + // Add natural trading info here
        (whaleCount > 0 ? `🔹 Whale activity: *${whaleCount}* 🐋\n` : '') +
        (smartMoneyInterest ? `🔹 Smart money interest: *Yes* 🧠\n` : '') +
        (tokenInfo.dexScreenerPaid ? `🔹 Paid on DEXScreener: *Yes* (${tokenInfo.dexScreenerOrderTypes.join(', ')}) 💸\n` : '') +
        `🔹 Sentiment: *${tokenInfo.sentimentCategory || ''}* (*${sentimentScore.toFixed(1)}*/100)\n` +
        (tokenInfo.replyCount ? `🔹 Community: *${tokenInfo.replyCount}* messages\n` : '') +
        (tokenInfo.athMarketCap ? `🔹 ATH Market Cap: *${tokenInfo.athMarketCap.toFixed(2)} SOL*\n` : '') +
        `\n🔍 *Analysis:*\n` +
        // Use the custom analysis from the main bot if provided, otherwise use a fallback
        `${analysisText || `• Token detected with exceptional metrics\n• ${buySellRatio >= BUY_SELL_RATIO_THRESHOLD ? 'Strong buy pressure with minimal selling' : 'Balanced trading activity'}\n• ${priceChangePercent >= PRICE_INCREASE_THRESHOLD ? 'Significant price appreciation since launch' : 'Steady price movement'}`}\n\n` +
        `${bundleInfoSection || ''}\n\n` +
        `🔗 [PumpFun](${pumpFunUrl})\n` +
        `🔗 [Solscan](${solscanUrl})\n` +
        `🔗 [NeoBull](${neoUrl})\n` +
        `🔗 [AxiomTrade](${axiomUrl})\n` +
        (socialLinks ? `\n${socialLinks}` : '') +
        `\n\`${mint}\``;
    }

    // Send the alert
    let sentMessage;

    if (hasImage) {
      // For image alerts, we need to use sendPhoto instead of sendMessage
      console.log(`Sending bullish token alert with image for ${mint}: ${tokenInfo.imageUrl || tokenInfo.logo}`);

      // We'll use a custom broadcast function for photos
      sentMessage = await broadcastPhotoToChats(messageOptions.photo, messageOptions);
    } else {
      // For regular text alerts, use the standard broadcast function
      console.log(`Sending bullish token alert without image for ${mint}`);
      sentMessage = await broadcastToChats(alertMsg, messageOptions);
    }

    // Store the message reference for future milestone alerts if we got a message back
    if (sentMessage && sentMessage.chat && sentMessage.message_id) {
      tokenInfo.originalAlertRef = `${sentMessage.chat.id}:${sentMessage.message_id}`;
      tokenRegistry.set(mint, tokenInfo);
      console.log(`Stored original alert reference: ${tokenInfo.originalAlertRef} for ${mint}`);
    }

    // Track the alert for analytics
    trackAlert(mint, 'bullish_token', marketCapSol);

    // Call the trading hook if available
    if (alertToTradeHook && tokenInfo) {
      try {
        alertToTradeHook(mint, {
          symbol: tokenInfo.symbol || tokenInfo.name,
          type: 'bullish_token',
          timestamp: Date.now(),
          initialMarketCap: marketCapSol,
          initialPriceUsd: marketCapSol * (solPriceUsd || 0)
        });
        console.log(`Bullish token alert sent to trading system for ${mint}`);
      } catch (error) {
        console.error(`Error sending bullish token alert to trading system: ${error.message}`);
      }
    }

    return true;
  } catch (error) {
    console.error('Error creating bullish token alert:', error);
    return false;
  }
}

module.exports = {
  initialize,
  createSmartMoneyAlert,
  createMigrationAlert,
  createBullishTokenAlert,
  hasAlertedToken,
  resetDedupe
};