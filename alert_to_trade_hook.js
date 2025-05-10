/**
 * alert_to_trade_hook.js
 *
 * This module hooks into all alert types (bullish tokens, smart money, migrations)
 * and forwards them to the trading system for potential trades.
 */

// Track alert IDs to prevent duplicate trading on the same alert
const processedAlerts = new Set();

let tradingSystemAPI = null;
let tokenRegistry = null;

/**
 * Initialize the hook with required dependencies
 * @param {Object} dependencies - Required dependencies
 */
function initialize(dependencies) {
  tradingSystemAPI = dependencies.tradingSystemAPI;
  tokenRegistry = dependencies.tokenRegistry;

  console.log('Alert-to-trade hook initialized');
  return {
    processBullishAlert,
    processSmartMoneyAlert,
    processMigrationAlert,
    processAnyAlert
  };
}

/**
 * Process a bullish token alert
 * @param {Object} alertData - Bullish token alert data
 */
function processBullishAlert(alertData) {
  const { mint, marketCapSol, volume, symbol } = alertData;

  // Skip if already processed
  const alertId = `bullish-${mint}-${Date.now()}`;
  if (processedAlerts.has(alertId)) return;
  processedAlerts.add(alertId);

  // Log and send to trading system
  console.log(`[ALERT-TO-TRADE] Processing bullish token alert for ${symbol || mint}`);

  if (tradingSystemAPI && typeof tradingSystemAPI.hookIntoAlertTracker === 'function') {
    // Get token info from registry
    const tokenInfo = tokenRegistry ? tokenRegistry.get(mint) : null;

    // Ensure all required fields are present and valid
    const alertData = {
      type: 'tokenAlert',
      symbol: symbol || (tokenInfo?.symbol) || mint.slice(0, 6),
      initialMarketCap: marketCapSol || (tokenInfo?.marketCap) || (tokenInfo?.marketCapSol) || 0,
      volume: volume || 0
    };

    console.log(`Sending tokenAlert to trading system: ${JSON.stringify(alertData)}`);
    tradingSystemAPI.hookIntoAlertTracker(mint, alertData);
  }
}

/**
 * Process a smart money wallet alert
 * @param {Object} alertData - Smart money alert data
 */
function processSmartMoneyAlert(alertData) {
  const { mint, price, marketCap, symbol, walletAddress } = alertData;

  // Skip if already processed
  const alertId = `smartmoney-${mint}-${walletAddress || 'unknown'}-${Date.now()}`;
  if (processedAlerts.has(alertId)) return;
  processedAlerts.add(alertId);

  // Log and send to trading system
  console.log(`[ALERT-TO-TRADE] Processing smart money alert for ${symbol || mint}`);

  if (tradingSystemAPI && typeof tradingSystemAPI.hookIntoAlertTracker === 'function') {
    // Get token info from registry
    const tokenInfo = tokenRegistry ? tokenRegistry.get(mint) : null;

    // Ensure all required fields are present and valid
    const alertData = {
      type: 'smartMoney',
      symbol: symbol || (tokenInfo?.symbol) || mint.slice(0, 6),
      initialMarketCap: marketCap || (tokenInfo?.marketCap) || (tokenInfo?.marketCapSol) || 0,
      walletAddress: walletAddress || 'unknown'
    };

    console.log(`Sending smartMoney alert to trading system: ${JSON.stringify(alertData)}`);
    tradingSystemAPI.hookIntoAlertTracker(mint, alertData);
  }
}

/**
 * Process a migration alert
 * @param {Object} alertData - Migration alert data
 */
function processMigrationAlert(alertData) {
  const { mint, marketCapSol, symbol, pool } = alertData;

  // Skip if already processed
  const alertId = `migration-${mint}-${pool || 'unknown'}-${Date.now()}`;
  if (processedAlerts.has(alertId)) return;
  processedAlerts.add(alertId);

  // Log and send to trading system
  console.log(`[ALERT-TO-TRADE] Processing migration alert for ${symbol || mint}`);

  if (tradingSystemAPI && typeof tradingSystemAPI.hookIntoAlertTracker === 'function') {
    // Get token info from registry
    const tokenInfo = tokenRegistry ? tokenRegistry.get(mint) : null;

    // Ensure all required fields are present and valid
    const alertData = {
      type: 'migration',
      symbol: symbol || (tokenInfo?.symbol) || mint.slice(0, 6),
      initialMarketCap: marketCapSol || (tokenInfo?.marketCap) || (tokenInfo?.marketCapSol) || 0
    };

    console.log(`Sending migration alert to trading system: ${JSON.stringify(alertData)}`);
    tradingSystemAPI.hookIntoAlertTracker(mint, alertData);
  }
}

/**
 * Process any type of alert
 * @param {Object} alertData - Any alert data
 * @param {string} alertType - The type of alert
 */
function processAnyAlert(alertData, alertType) {
  switch (alertType.toLowerCase()) {
    case 'tokenalert':
    case 'bullish':
      processBullishAlert(alertData);
      break;
    case 'smartmoney':
      processSmartMoneyAlert(alertData);
      break;
    case 'migration':
      processMigrationAlert(alertData);
      break;
    default:
      console.log(`[ALERT-TO-TRADE] Unknown alert type: ${alertType}`);
  }
}

module.exports = {
  initialize
};