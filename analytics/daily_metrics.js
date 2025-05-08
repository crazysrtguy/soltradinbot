// Daily Token Analytics Module
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Configuration
const ANALYTICS_DIR = path.join(__dirname, '..', 'data', 'analytics');
const SOL_PRICE_API = 'https://frontend-api-v3.pump.fun/sol-price';
const RUG_THRESHOLD = 6000; // $6000 market cap threshold for defining a rug
const RUG_THRESHOLD_LOWER = 4000; // $4000 market cap threshold for confirming a rug

// Ensure analytics data directory exists
if (!fs.existsSync(ANALYTICS_DIR)) {
  fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
}

// Initialize data store
let dailyMetrics = {
  date: new Date().toISOString().split('T')[0],
  newTokens: 0,
  totalVolume: 0,
  migrations: 0,
  keywordCounts: {},
  rugPulls: 0,
  solPrice: 0,
  topTokens: [],
  topVolume: []
};

// Load metrics for today or create new record
function loadDailyMetrics() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const metricsPath = path.join(ANALYTICS_DIR, `metrics_${today}.json`);
    
    if (fs.existsSync(metricsPath)) {
      dailyMetrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
    } else {
      // Initialize new day
      dailyMetrics = {
        date: today,
        newTokens: 0,
        totalVolume: 0,
        migrations: 0,
        keywordCounts: {},
        rugPulls: 0,
        solPrice: 0,
        topTokens: [],
        topVolume: []
      };
    }
    
    // Update SOL price
    updateSolPrice();
    
    return dailyMetrics;
  } catch (error) {
    console.error('Error loading daily metrics:', error);
    return dailyMetrics;
  }
}

// Save metrics to file
function saveDailyMetrics() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const metricsPath = path.join(ANALYTICS_DIR, `metrics_${today}.json`);
    
    fs.writeFileSync(metricsPath, JSON.stringify(dailyMetrics, null, 2));
  } catch (error) {
    console.error('Error saving daily metrics:', error);
  }
}

// Update SOL price from API
async function updateSolPrice() {
  try {
    const response = await axios.get(SOL_PRICE_API);
    if (response.data && response.data.solPrice) {
      dailyMetrics.solPrice = response.data.solPrice;
      console.log(`Updated SOL price: $${dailyMetrics.solPrice}`);
    }
  } catch (error) {
    console.error('Error updating SOL price:', error);
  }
}

// Record a new token creation
function recordNewToken(tokenInfo) {
  try {
    // Increment token counter
    dailyMetrics.newTokens++;
    
    // Extract keywords from token name and track frequency
    const keywords = extractKeywords(tokenInfo.name);
    keywords.forEach(keyword => {
      dailyMetrics.keywordCounts[keyword] = (dailyMetrics.keywordCounts[keyword] || 0) + 1;
    });
    
    // Update top tokens if needed (sorting by market cap)
    if (tokenInfo.marketCapSol && dailyMetrics.solPrice) {
      const marketCapUSD = tokenInfo.marketCapSol * dailyMetrics.solPrice;
      
      // Add to top tokens if list is not full or if this token has a higher market cap
      if (dailyMetrics.topTokens.length < 10 || 
          dailyMetrics.topTokens.some(token => token.marketCapUSD < marketCapUSD)) {
        
        // Add the token
        dailyMetrics.topTokens.push({
          mint: tokenInfo.mint,
          name: tokenInfo.name,
          symbol: tokenInfo.symbol,
          marketCapSol: tokenInfo.marketCapSol,
          marketCapUSD: marketCapUSD,
          createdAt: tokenInfo.createdAt
        });
        
        // Sort and limit to top 10
        dailyMetrics.topTokens.sort((a, b) => b.marketCapUSD - a.marketCapUSD);
        if (dailyMetrics.topTokens.length > 10) {
          dailyMetrics.topTokens = dailyMetrics.topTokens.slice(0, 10);
        }
      }
    }
    
    saveDailyMetrics();
  } catch (error) {
    console.error('Error recording new token:', error);
  }
}

// Record token volume
function recordTokenVolume(mint, volume) {
  try {
    // Add to total volume
    dailyMetrics.totalVolume += volume;
    
    // Update top volume tokens
    const existingIndex = dailyMetrics.topVolume.findIndex(item => item.mint === mint);
    
    if (existingIndex >= 0) {
      // Update existing entry
      dailyMetrics.topVolume[existingIndex].volume += volume;
    } else {
      // Add new entry if we have room or if this volume is higher than the lowest current entry
      if (dailyMetrics.topVolume.length < 10 || 
          (dailyMetrics.topVolume.length > 0 && 
           dailyMetrics.topVolume[dailyMetrics.topVolume.length - 1].volume < volume)) {
        
        // Get token name if available
        let tokenName = mint.substring(0, 6) + '...';
        try {
          const tokenRegistry = require('../token_registry');
          const tokenInfo = tokenRegistry.get(mint);
          if (tokenInfo && tokenInfo.name) {
            tokenName = tokenInfo.name;
          }
        } catch (e) {
          // Ignore errors, just use the shortened mint
        }
        
        // Add the token
        dailyMetrics.topVolume.push({
          mint: mint,
          name: tokenName,
          volume: volume
        });
      }
    }
    
    // Sort and limit to top 10
    dailyMetrics.topVolume.sort((a, b) => b.volume - a.volume);
    if (dailyMetrics.topVolume.length > 10) {
      dailyMetrics.topVolume = dailyMetrics.topVolume.slice(0, 10);
    }
    
    saveDailyMetrics();
  } catch (error) {
    console.error('Error recording token volume:', error);
  }
}

// Record a token migration
function recordMigration(mint, pool) {
  try {
    dailyMetrics.migrations++;
    saveDailyMetrics();
  } catch (error) {
    console.error('Error recording migration:', error);
  }
}

// Record a rug pull
function recordRugPull(mint, tokenInfo) {
  try {
    dailyMetrics.rugPulls++;
    saveDailyMetrics();
  } catch (error) {
    console.error('Error recording rug pull:', error);
  }
}

// Check if a token is a rug pull
function checkForRugPull(tokenInfo) {
  try {
    // Calculate market cap in USD
    const marketCapUSD = tokenInfo.marketCapSol * dailyMetrics.solPrice;
    
    // Check if it had significant volume but now has low market cap
    if (tokenInfo.totalVolume > 1.0 && marketCapUSD < RUG_THRESHOLD_LOWER) {
      // Check if there was a price crash or consistently low market cap
      if (tokenInfo.highestPrice && tokenInfo.currentPrice) {
        const priceCrashPercent = (tokenInfo.highestPrice - tokenInfo.currentPrice) / tokenInfo.highestPrice * 100;
        
        if (priceCrashPercent > 80) { // Reduced from 90% to 80% crash
          // Mark as rug pull
          recordRugPull(tokenInfo.mint, tokenInfo);
          
          // Signal to remove token from tracking
          return {
            isRug: true,
            rugType: 'crash',
            marketCapUSD: marketCapUSD,
            priceCrashPercent: priceCrashPercent
          };
        }
      }
      
      // Also consider consistently low market cap as a rug indicator
      const timeElapsed = Date.now() - (tokenInfo.createdAt || Date.now());
      const hoursElapsed = timeElapsed / (1000 * 60 * 60);
      
      // If token has been below threshold for a while (12 hours) and had decent volume
      if (hoursElapsed > 12 && marketCapUSD < RUG_THRESHOLD_LOWER) {
        recordRugPull(tokenInfo.mint, tokenInfo);
        return {
          isRug: true,
          rugType: 'lowMcap',
          marketCapUSD: marketCapUSD,
          hoursElapsed: hoursElapsed
        };
      }
    }
    
    // Check if token is between the caution thresholds
    if (marketCapUSD >= RUG_THRESHOLD_LOWER && marketCapUSD < RUG_THRESHOLD) {
      return {
        isRug: false,
        inDangerZone: true,
        marketCapUSD: marketCapUSD
      };
    }
    
    return {
      isRug: false,
      inDangerZone: false
    };
  } catch (error) {
    console.error('Error checking for rug pull:', error);
    return {
      isRug: false,
      error: error.message
    };
  }
}

// Extract keywords from token name
function extractKeywords(name) {
  try {
    if (!name) return [];
    
    // Split name into words
    const words = name.toLowerCase()
      .replace(/[^\w\s]/g, '') // Remove non-alphanumeric characters
      .split(/\s+/); // Split on whitespace
    
    // Filter out common words and short words
    const commonWords = ['the', 'a', 'an', 'is', 'in', 'on', 'at', 'to', 'for', 'with', 'of', 'and'];
    return words
      .filter(word => word.length > 2) // Remove words shorter than 3 characters
      .filter(word => !commonWords.includes(word)); // Remove common words
  } catch (error) {
    console.error('Error extracting keywords:', error);
    return [];
  }
}

// Generate a daily report
function generateDailyReport() {
  try {
    // Get top keywords
    const topKeywords = Object.entries(dailyMetrics.keywordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([keyword, count]) => `${keyword} (${count})`);
    
    // Format top tokens
    const topTokensFormatted = dailyMetrics.topTokens
      .map((token, index) => 
        `${index + 1}. ${token.name} - $${token.marketCapUSD.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
      );
    
    // Format top volume tokens
    const topVolumeFormatted = dailyMetrics.topVolume
      .map((token, index) => 
        `${index + 1}. ${token.name} - ${token.volume.toFixed(2)} SOL`
      );
    
    // Create report
    const report = 
      `📊 *DAILY TOKEN METRICS*\n` +
      `📅 *Date:* ${dailyMetrics.date}\n\n` +
      `🪙 *New Tokens:* ${dailyMetrics.newTokens}\n` +
      `💰 *Total Volume:* ${dailyMetrics.totalVolume.toFixed(2)} SOL ($${(dailyMetrics.totalVolume * dailyMetrics.solPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })})\n` +
      `🔄 *Migrations:* ${dailyMetrics.migrations}\n` +
      `⚠️ *Rug Pulls:* ${dailyMetrics.rugPulls}\n` +
      `💵 *SOL Price:* $${dailyMetrics.solPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}\n\n` +
      
      `🔑 *Trending Keywords:*\n${topKeywords.join(', ')}\n\n` +
      
      `📈 *Top Tokens by Market Cap:*\n${topTokensFormatted.join('\n')}\n\n` +
      
      `🔝 *Top Volume Tokens:*\n${topVolumeFormatted.join('\n')}`;
    
    return report;
  } catch (error) {
    console.error('Error generating daily report:', error);
    return 'Error generating daily report';
  }
}

// Initialize on startup
loadDailyMetrics();

// Schedule automatic SOL price updates
setInterval(updateSolPrice, 15 * 60 * 1000); // Every 15 minutes

// Automatic daily reset
setInterval(() => {
  const today = new Date().toISOString().split('T')[0];
  if (dailyMetrics.date !== today) {
    loadDailyMetrics(); // This will create a new record for today
  }
}, 60 * 60 * 1000); // Check every hour

module.exports = {
  recordNewToken,
  recordTokenVolume,
  recordMigration,
  recordRugPull,
  checkForRugPull,
  generateDailyReport,
  loadDailyMetrics,
  updateSolPrice
};