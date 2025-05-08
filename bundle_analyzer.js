// Bundle Analyzer Module for PumpPortal Trading Bot
const axios = require('axios');

// API endpoint for bundle analysis
const BUNDLE_API_URL = 'https://trench.bot/api/bundle/bundle_advanced';

/**
 * Fetch bundle and creator analysis for a given token
 * @param {string} mint - Token mint address
 * @returns {Promise<Object>} - Bundle and creator analysis data
 */
async function fetchBundleAnalysis(mint) {
  try {
    console.log(`Fetching bundle analysis for ${mint}...`);
    const response = await axios.get(`${BUNDLE_API_URL}/${mint}`, {
      timeout: 2000, // Very short timeout to ensure alerts don't get blocked
      headers: {
        'User-Agent': 'PumpPortalBot/1.0'
      }
    });
    
    if (response.data) {
      return response.data;
    } else {
      console.log(`No data returned for bundle analysis of ${mint}`);
      return null;
    }
  } catch (error) {
    // Minimal logging to avoid console spam
    console.log(`Bundle analysis fetch failed for ${mint}: ${error.code || 'error'}`);
    return null;
  }
}

/**
 * Extract important creator analytics for alerts
 * @param {Object} creatorAnalysis - Creator analysis data from API
 * @returns {Object} - Simplified creator analytics for alerts
 */
function extractCreatorAnalytics(creatorAnalysis) {
  if (!creatorAnalysis) return null;
  
  return {
    address: creatorAnalysis.address,
    riskLevel: creatorAnalysis.risk_level || 'UNKNOWN',
    totalCoinsCreated: creatorAnalysis.history?.total_coins_created || 0,
    rugCount: creatorAnalysis.history?.rug_count || 0,
    rugPercentage: creatorAnalysis.history?.rug_percentage || 0,
    averageMarketCap: creatorAnalysis.history?.average_market_cap || 0,
    warningFlags: creatorAnalysis.warning_flags?.filter(flag => flag !== null) || [],
    holdingPercentage: creatorAnalysis.holding_percentage || 0,
    recentRugs: creatorAnalysis.history?.recent_rugs || 0,
    hasHighRisk: creatorAnalysis.history?.high_risk || false
  };
}

/**
 * Extract important bundle analytics for alerts
 * @param {Object} bundleData - Bundle data from API
 * @returns {Object} - Simplified bundle analytics for alerts
 */
function extractBundleAnalytics(bundleData) {
  if (!bundleData) return null;
  
  // Calculate the number of likely bundles
  let likelyBundleCount = 0;
  const bundleDetails = [];
  
  if (bundleData.bundles) {
    for (const [bundleId, bundle] of Object.entries(bundleData.bundles)) {
      if (bundle.bundle_analysis && bundle.bundle_analysis.is_likely_bundle) {
        likelyBundleCount++;
      }
      
      // Extract relevant bundle details for top 3 bundles by token percentage
      bundleDetails.push({
        id: bundleId,
        totalSol: bundle.total_sol || 0,
        totalTokens: bundle.total_tokens || 0,
        tokenPercentage: bundle.token_percentage || 0,
        uniqueWallets: bundle.unique_wallets || 0,
        primaryCategory: bundle.bundle_analysis?.primary_category || 'unknown',
        isLikelyBundle: bundle.bundle_analysis?.is_likely_bundle || false,
        walletCategories: Object.values(bundle.wallet_categories || {})
      });
    }
  }
  
  // Sort bundles by token percentage descending
  bundleDetails.sort((a, b) => b.tokenPercentage - a.tokenPercentage);
  
  return {
    totalBundles: bundleData.total_bundles || 0,
    totalSolSpent: bundleData.total_sol_spent || 0,
    totalPercentageBundled: bundleData.total_percentage_bundled || 0,
    likelyBundleCount,
    totalTokensBundled: bundleData.total_tokens_bundled || 0,
    distributedPercentage: bundleData.distributed_percentage || 0,
    topBundles: bundleDetails.slice(0, 3), // Get top 3 bundles
    ticker: bundleData.ticker || ''
  };
}

/**
 * Format bundle and creator data for alert messages
 * @param {Object} bundleData - Bundle analysis data
 * @param {Object} creatorData - Creator analysis data
 * @returns {string} - Formatted bundle and creator info for alerts
 */
function formatBundleInfoForAlert(bundleData, creatorData) {
  if (!bundleData && !creatorData) return '';
  
  let message = '';
  
  try {
    // Shorter, more compact bundle information
    if (bundleData) {
      message += `\n📦 *Bundle Analysis:*\n`;
      
      // Core stats in one line
      message += `• Bundles: *${bundleData.totalBundles}* | Bundled: *${bundleData.totalPercentageBundled.toFixed(1)}%*`;
      
      // Add top bundle if available
      if (bundleData.topBundles && bundleData.topBundles.length > 0) {
        const topBundle = bundleData.topBundles[0];
        message += ` | Top: *${topBundle.tokenPercentage.toFixed(1)}%*\n`;
      } else {
        message += `\n`;
      }
      
      // Warning only for high bundling
      if (bundleData.totalPercentageBundled > 40) {
        message += `⚠️ *High bundling detected*\n`;
      }
    }
    
    // Shorter creator info
    if (creatorData) {
      message += `👤 *Creator:* Risk: *${creatorData.riskLevel}* | Tokens: *${creatorData.totalCoinsCreated}*`;
      
      // Add rug info only if it exists
      if (creatorData.rugCount > 0) {
        message += ` | Rugs: *${creatorData.rugCount}*`;
      }
      
      message += `\n`;
      
      // Only add high risk warning
      if (creatorData.hasHighRisk) {
        message += `⚠️ *High-risk creator detected*\n`;
      }
    }
  } catch (error) {
    // Safety - never let formatting errors block alerts
    console.log('Error formatting bundle info, using simplified version');
    
    // Fallback to ultra-simple format
    if (bundleData) {
      message += `\n📦 *Bundle:* ${bundleData.totalPercentageBundled.toFixed(1)}% bundled\n`;
    }
    if (creatorData && creatorData.riskLevel) {
      message += `👤 *Creator:* ${creatorData.riskLevel} risk\n`;
    }
  }
  
  return message;
}

// Export all functions
module.exports = {
  fetchBundleAnalysis,
  extractCreatorAnalytics,
  extractBundleAnalytics,
  formatBundleInfoForAlert
};