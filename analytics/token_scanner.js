// Token Scanner for identifying rugs and tracking market changes
const fs = require('fs');
const path = require('path');
const dailyMetrics = require('./daily_metrics');

// Scan for potential rug pulls
function scanForRugPulls(tokenRegistry) {
  try {
    console.log('Scanning for potential rug pulls...');
    let rugCount = 0;
    
    // Check all tokens in the registry
    for (const [mint, tokenInfo] of tokenRegistry.entries()) {
      // Skip tokens less than 1 hour old
      if (Date.now() - tokenInfo.createdAt < 60 * 60 * 1000) {
        continue;
      }
      
      // Skip tokens with no volume history
      if (!tokenInfo.totalVolume || tokenInfo.totalVolume < 0.5) {
        continue;
      }
      
      // Check for price crash
      if (dailyMetrics.checkForRugPull(tokenInfo)) {
        rugCount++;
        console.log(`Detected rug pull: ${tokenInfo.name || mint}`);
      }
    }
    
    console.log(`Finished rug scan. Found ${rugCount} potential rug pulls.`);
    return rugCount;
  } catch (error) {
    console.error('Error scanning for rug pulls:', error);
    return 0;
  }
}

// Track volume trends
function trackVolumeTrends(tokenRegistry) {
  try {
    console.log('Tracking volume trends...');
    let totalVolume = 0;
    
    // Get tokens with volume in the last 24 hours
    const activeTokens = Array.from(tokenRegistry.entries())
      .filter(([_, info]) => {
        // Has trade history and has trades in the last 24 hours
        return info.tradeHistory && info.tradeHistory.some(trade => 
          Date.now() - trade.timestamp < 24 * 60 * 60 * 1000
        );
      });
    
    // Calculate 24h volume
    for (const [mint, info] of activeTokens) {
      const last24hTrades = info.tradeHistory.filter(trade => 
        Date.now() - trade.timestamp < 24 * 60 * 60 * 1000
      );
      
      const volume24h = last24hTrades.reduce((sum, trade) => sum + trade.amount, 0);
      totalVolume += volume24h;
      
      // Record volume for top tracking
      dailyMetrics.recordTokenVolume(mint, volume24h);
    }
    
    console.log(`Total 24h volume tracked: ${totalVolume.toFixed(2)} SOL`);
    return totalVolume;
  } catch (error) {
    console.error('Error tracking volume trends:', error);
    return 0;
  }
}

// Extract keyword trends from token names
function analyzeKeywordTrends(tokenRegistry) {
  try {
    console.log('Analyzing keyword trends...');
    
    // Get tokens created in the last 24 hours
    const newTokens = Array.from(tokenRegistry.entries())
      .filter(([_, info]) => Date.now() - info.createdAt < 24 * 60 * 60 * 1000);
    
    console.log(`Found ${newTokens.length} tokens created in the last 24 hours`);
    
    // Process each new token
    for (const [mint, tokenInfo] of newTokens) {
      dailyMetrics.recordNewToken(tokenInfo);
    }
    
    return newTokens.length;
  } catch (error) {
    console.error('Error analyzing keyword trends:', error);
    return 0;
  }
}

// Run a full analysis
function runAnalysis(tokenRegistry) {
  try {
    // Update SOL price
    dailyMetrics.updateSolPrice();
    
    // Run all analysis functions
    const newTokenCount = analyzeKeywordTrends(tokenRegistry);
    const totalVolume = trackVolumeTrends(tokenRegistry);
    const rugCount = scanForRugPulls(tokenRegistry);
    
    return {
      newTokenCount,
      totalVolume,
      rugCount
    };
  } catch (error) {
    console.error('Error running token analysis:', error);
    return {
      newTokenCount: 0,
      totalVolume: 0,
      rugCount: 0
    };
  }
}

module.exports = {
  scanForRugPulls,
  trackVolumeTrends,
  analyzeKeywordTrends,
  runAnalysis
};