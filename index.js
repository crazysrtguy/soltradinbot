/**
 * Entry point for the trading bot
 * This file serves as a wrapper to load the main tradingbot.js file
 */

console.log('Starting trading bot via index.js entry point...');

try {
  // Load the main trading bot file
  require('./tradingbot.js');
  
  console.log('Trading bot loaded successfully');
} catch (error) {
  console.error('Error loading trading bot:', error);
  process.exit(1);
}
