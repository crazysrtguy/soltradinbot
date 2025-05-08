const axios = require('axios');

class BundleAnalyzer {
  constructor(config = {}) {
    this.config = {
      baseUrl: 'https://trench.bot/api/bundle/bundle_advanced/',
      riskThresholds: {
        highRiskBundlePercentage: 30, // If total bundled percentage > 30%, it's high risk
        rugCreatorPercentage: 25, // If creator has > 25% rug rate, it's high risk
        maxRecentRugs: 2, // If creator has > 2 recent rugs, it's high risk
        suspiciousHolderPatterns: 5, // If more than 5 bundles with suspicious patterns
        highConcentrationThreshold: 50, // If any bundle has > 50% concentration in 1-2 wallets
      },
      ...config
    };
  }

  async analyzeBundles(mint) {
    try {
      if (!mint) {
        throw new Error('Invalid mint address');
      }
      
      console.log(`🔍 Analyzing bundles for: ${mint}`);
      
      const response = await axios.get(`${this.config.baseUrl}${mint}`, {
        timeout: 30000, // 30 second timeout
        headers: {
          'User-Agent': 'SolanaAlertBot/1.0' 
        }
      });
      
      const data = response.data;
      
      if (!data) {
        throw new Error('Empty response from bundle API');
      }
      
      // Initialize analysis with safe default values
      const analysis = {
        risk_level: 'MEDIUM', // Default to medium if can't analyze properly
        risk_factors: [],
        bundle_metrics: {
          total_bundles: 0,
          total_bundled_percentage: 0,
          suspicious_patterns: 0,
          high_concentration_bundles: 0,
          new_wallet_bundles: 0,
          sniper_patterns: 0,
          holding_percentage: 0,
          distribution_score: 50 // Default to neutral score
        },
        creator_metrics: {
          risk_level: 'UNKNOWN',
          rug_percentage: 0,
          recent_rugs: 0,
          total_coins_created: 0,
          average_market_cap: 0,
          holding_percentage: 0,
          warning_flags: [],
          has_success_history: false,
          consistent_rug_pattern: false
        },
        recommendation: 'Analysis pending'
      };

      // Analyze bundle patterns if data exists
      if (data) {
        analysis.bundle_metrics = this.analyzeBundleMetrics(data);
        
        // Analyze creator history (handle case where creator_analysis might be missing)
        if (data.creator_analysis) {
          analysis.creator_metrics = this.analyzeCreatorHistory(data.creator_analysis);
        } else {
          console.log(`⚠️ No creator analysis data available for ${mint}`);
        }
        
        // Calculate risk level
        analysis.risk_level = this.calculateRiskLevel(analysis);
        
        // Generate risk factors
        analysis.risk_factors = this.generateRiskFactors(analysis);
        
        // Generate recommendation
        analysis.recommendation = this.generateRecommendation(analysis);
      }
      
      console.log(`✅ Bundle analysis complete for ${mint}: ${analysis.risk_level} risk`);
      return analysis;
    } catch (error) {
      console.error(`❌ Bundle analysis failed: ${error.message}`);
      // Return a default analysis object instead of failing
      return {
        risk_level: 'UNKNOWN',
        risk_factors: [`Analysis error: ${error.message}`],
        bundle_metrics: {
          total_bundles: 0,
          total_bundled_percentage: 0,
          suspicious_patterns: 0,
          high_concentration_bundles: 0,
          new_wallet_bundles: 0,
          sniper_patterns: 0,
          holding_percentage: 0,
          distribution_score: 50
        },
        creator_metrics: {
          risk_level: 'UNKNOWN',
          rug_percentage: 0,
          recent_rugs: 0,
          total_coins_created: 0,
          average_market_cap: 0,
          holding_percentage: 0,
          warning_flags: [],
          has_success_history: false,
          consistent_rug_pattern: false
        },
        recommendation: 'Unable to complete analysis, proceed with caution',
        error: error.message
      };
    }
  }

  analyzeBundleMetrics(data) {
    // Use safe defaults if data is missing
    const safeData = data || {};
    
    const metrics = {
      total_bundles: safeData.total_bundles || 0,
      total_bundled_percentage: safeData.total_percentage_bundled || 0,
      suspicious_patterns: 0,
      high_concentration_bundles: 0,
      new_wallet_bundles: 0,
      sniper_patterns: 0,
      holding_percentage: safeData.total_holding_percentage || 0,
      distribution_score: 50 // Default neutral score
    };

    // Safely analyze each bundle if available
    try {
      if (safeData.bundles && typeof safeData.bundles === 'object') {
        Object.values(safeData.bundles).forEach(bundle => {
          // Skip if bundle is null/undefined
          if (!bundle) return;
          
          // Check for suspicious patterns (safely access nested properties)
          if (bundle.bundle_analysis && bundle.bundle_analysis.is_likely_bundle) {
            metrics.suspicious_patterns++;
          }

          // Check for high concentration in few wallets
          let maxWalletPercentage = 0;
          if (bundle.wallet_info && typeof bundle.wallet_info === 'object') {
            Object.values(bundle.wallet_info).forEach(wallet => {
              if (wallet && wallet.token_percentage > maxWalletPercentage) {
                maxWalletPercentage = wallet.token_percentage;
              }
            });
          }

          if (maxWalletPercentage > this.config.riskThresholds.highConcentrationThreshold) {
            metrics.high_concentration_bundles++;
          }

          // Count new wallet patterns
          if (bundle.bundle_analysis && bundle.bundle_analysis.primary_category === 'new_wallet') {
            metrics.new_wallet_bundles++;
          }
          
          // Check for sniper patterns
          if (bundle.wallet_categories && typeof bundle.wallet_categories === 'object') {
            Object.values(bundle.wallet_categories).forEach(category => {
              if (category === 'sniper') {
                metrics.sniper_patterns++;
              }
            });
          }
        });
      } else {
        console.log('⚠️ No bundle data available for analysis');
      }

      // Calculate distribution score
      metrics.distribution_score = this.calculateDistributionScore(safeData);
      
    } catch (error) {
      console.error(`❌ Error during bundle metrics analysis: ${error.message}`);
      // Keep default metrics if analysis fails
    }

    return metrics;
  }

  analyzeCreatorHistory(creatorAnalysis) {
    // Use default safe values
    const metrics = {
      risk_level: 'UNKNOWN',
      rug_percentage: 0,
      recent_rugs: 0,
      total_coins_created: 0,
      average_market_cap: 0,
      holding_percentage: 0,
      warning_flags: [],
      has_success_history: false,
      consistent_rug_pattern: false
    };
    
    try {
      // Safely access nested properties
      if (!creatorAnalysis) return metrics;
      
      metrics.risk_level = creatorAnalysis.risk_level || 'UNKNOWN';
      
      // Safe access to history data
      if (creatorAnalysis.history) {
        metrics.rug_percentage = creatorAnalysis.history.rug_percentage || 0;
        metrics.recent_rugs = creatorAnalysis.history.recent_rugs || 0;
        metrics.total_coins_created = creatorAnalysis.history.total_coins_created || 0;
        metrics.average_market_cap = creatorAnalysis.history.average_market_cap || 0;
        
        // Check for previous coins
        if (Array.isArray(creatorAnalysis.history.previous_coins)) {
          // Success history exists if at least one coin is not a rug
          metrics.has_success_history = creatorAnalysis.history.previous_coins.some(coin => coin && !coin.is_rug);
          
          // Check for consistent rug pattern in last 3 coins
          const recentCoins = creatorAnalysis.history.previous_coins.slice(-3);
          metrics.consistent_rug_pattern = recentCoins.length >= 3 && 
            recentCoins.every(coin => coin && coin.is_rug);
        }
      }
      
      // Safe access to holding percentage
      metrics.holding_percentage = creatorAnalysis.holding_percentage || 0;
      
      // Safe access to warning flags
      if (Array.isArray(creatorAnalysis.warning_flags)) {
        metrics.warning_flags = creatorAnalysis.warning_flags.filter(flag => flag !== null && flag !== undefined);
      }
      
    } catch (error) {
      console.error(`❌ Error analyzing creator history: ${error.message}`);
      // Keep default metrics if analysis fails
    }

    return metrics;
  }

  calculateDistributionScore(data) {
    // Score from 0-100 based on how well distributed the token is
    try {
      let score = 100;

      // Safely use values with defaults
      const bundledPercentage = data.total_percentage_bundled || 0;
      const distributedWallets = data.distributed_wallets || 0;
      let creatorHolding = 0;
      
      // Safely access creator holding percentage
      if (data.creator_analysis && typeof data.creator_analysis.holding_percentage === 'number') {
        creatorHolding = data.creator_analysis.holding_percentage;
      }

      // Penalize for high bundle concentration
      if (bundledPercentage > 60) {
        score -= (bundledPercentage - 60);
      }

      // Penalize for few distributed wallets
      if (distributedWallets < 100) {
        score -= (100 - distributedWallets) / 2;
      }

      // Penalize for creator holding
      score -= (creatorHolding * 2);

      return Math.max(0, Math.min(100, score)); // Ensure score is between 0-100
    } catch (error) {
      console.error(`❌ Error calculating distribution score: ${error.message}`);
      return 50; // Default neutral score on error
    }
  }

  calculateRiskLevel(analysis) {
    try {
      let riskScore = 0;

      // Creator risk factors (safely access values)
      const creatorRugPercentage = analysis.creator_metrics.rug_percentage || 0;
      const recentRugs = analysis.creator_metrics.recent_rugs || 0;
      const consistentRugPattern = analysis.creator_metrics.consistent_rug_pattern || false;

      if (creatorRugPercentage > this.config.riskThresholds.rugCreatorPercentage) {
        riskScore += 3;
      }
      if (recentRugs > this.config.riskThresholds.maxRecentRugs) {
        riskScore += 2;
      }
      if (consistentRugPattern) {
        riskScore += 4;
      }

      // Bundle risk factors
      const bundledPercentage = analysis.bundle_metrics.total_bundled_percentage || 0;
      const highConcentration = analysis.bundle_metrics.high_concentration_bundles || 0;
      const sniperPatterns = analysis.bundle_metrics.sniper_patterns || 0;
      const distributionScore = analysis.bundle_metrics.distribution_score || 50;

      if (bundledPercentage > this.config.riskThresholds.highRiskBundlePercentage) {
        riskScore += 3;
      }
      if (highConcentration > this.config.riskThresholds.suspiciousHolderPatterns) {
        riskScore += 2;
      }
      if (sniperPatterns > 0) {
        riskScore += 1;
      }

      // Distribution score impact
      if (distributionScore < 50) {
        riskScore += 2;
      }

      // Determine risk level
      if (riskScore >= 8) return 'HIGH';
      if (riskScore >= 5) return 'MEDIUM';
      return 'LOW';
    } catch (error) {
      console.error(`❌ Error calculating risk level: ${error.message}`);
      return 'MEDIUM'; // Default to medium risk on error
    }
  }

  generateRiskFactors(analysis) {
    const factors = [];

    try {
      // Creator-based risks
      const creatorRugPercentage = analysis.creator_metrics.rug_percentage || 0;
      const recentRugs = analysis.creator_metrics.recent_rugs || 0;
      const consistentRugPattern = analysis.creator_metrics.consistent_rug_pattern || false;

      if (creatorRugPercentage > this.config.riskThresholds.rugCreatorPercentage) {
        factors.push(`Creator has ${creatorRugPercentage.toFixed(1)}% rug rate`);
      }
      if (recentRugs > 0) {
        factors.push(`Creator has ${recentRugs} recent rugs`);
      }
      if (consistentRugPattern) {
        factors.push(`Creator shows consistent rug pattern`);
      }

      // Bundle-based risks
      const bundledPercentage = analysis.bundle_metrics.total_bundled_percentage || 0;
      const highConcentration = analysis.bundle_metrics.high_concentration_bundles || 0;
      const sniperPatterns = analysis.bundle_metrics.sniper_patterns || 0;
      const distributionScore = analysis.bundle_metrics.distribution_score || 50;

      if (bundledPercentage > this.config.riskThresholds.highRiskBundlePercentage) {
        factors.push(`High bundle concentration: ${bundledPercentage.toFixed(1)}%`);
      }
      if (highConcentration > 0) {
        factors.push(`${highConcentration} bundles with high wallet concentration`);
      }
      if (sniperPatterns > 0) {
        factors.push(`Sniper wallet patterns detected: ${sniperPatterns}`);
      }

      // Distribution risks
      if (distributionScore < 50) {
        factors.push(`Poor distribution score: ${distributionScore.toFixed(1)}`);
      }
    } catch (error) {
      console.error(`❌ Error generating risk factors: ${error.message}`);
      factors.push('Error analyzing risk factors');
    }

    return factors;
  }

  generateRecommendation(analysis) {
    try {
      // Get required values safely
      const riskLevel = analysis.risk_level || 'UNKNOWN';
      const riskFactors = analysis.risk_factors || [];
      const distributionScore = analysis.bundle_metrics.distribution_score || 0;
      const hasSuccessHistory = analysis.creator_metrics.has_success_history || false;
      
      // Format risk factors for display
      const formattedRiskFactors = riskFactors.length > 0 
        ? riskFactors.join(', ')
        : 'unknown factors';
      
      if (riskLevel === 'HIGH') {
        return `HIGH RISK: Token shows multiple concerning patterns including ${formattedRiskFactors}. Exercise extreme caution.`;
      } else if (riskLevel === 'MEDIUM') {
        return `MEDIUM RISK: Some concerning patterns detected including ${formattedRiskFactors}. Proceed with caution.`;
      } else if (riskLevel === 'LOW') {
        if (distributionScore > 80 && hasSuccessHistory) {
          return `LOW RISK: Good distribution and positive creator history. Potential for growth.`;
        } else {
          return `LOW RISK: No major red flags detected but monitor carefully.`;
        }
      } else {
        return `UNKNOWN RISK: Unable to determine risk level. Proceed with extreme caution.`;
      }
    } catch (error) {
      console.error(`❌ Error generating recommendation: ${error.message}`);
      return `Analysis error: Unable to generate recommendation. Proceed with caution.`;
    }
  }

  // Integration with the alert bot
  async enrichAlertWithBundleAnalysis(alert) {
    try {
      if (!alert || !alert.mint) {
        throw new Error('Invalid alert object');
      }
      
      console.log(`🔍 Enriching alert for ${alert.symbol} with bundle analysis`);
      const bundleAnalysis = await this.analyzeBundles(alert.mint);
      
      // Ensure scores object exists
      if (!alert.scores) {
        alert.scores = { total: 0 };
      }
      
      // Add bundle analysis to alert
      alert.bundleAnalysis = bundleAnalysis;
      
      // Adjust alert score based on bundle analysis
      const distributionScore = bundleAnalysis.bundle_metrics.distribution_score || 0;
      const riskLevel = bundleAnalysis.risk_level || 'MEDIUM';
      
      if (riskLevel === 'LOW' && distributionScore > 70) {
        alert.scores.total += 10; // Boost score for well-distributed tokens
      } else if (riskLevel === 'HIGH') {
        alert.scores.total -= 20; // Reduce score for high risk tokens
      }
      
      // Add bundle score to alert scores
      alert.scores.bundle = this.calculateBundleScore(bundleAnalysis);
      
      // Add bundle analysis information to alert
      alert.bundleInfo = {
        distribution_score: distributionScore,
        risk_level: riskLevel,
        key_metrics: {
          total_bundled_percentage: bundleAnalysis.bundle_metrics.total_bundled_percentage || 0,
          distributed_wallets: distributionScore > 50 ? 'Good' : 'Poor',
          creator_risk: bundleAnalysis.creator_metrics.rug_percentage || 0
        },
        recommendation: bundleAnalysis.recommendation || 'Proceed with caution'
      };
      
      console.log(`✅ Bundle analysis enrichment complete for ${alert.symbol}: ${riskLevel} risk`);
      return alert;
    } catch (error) {
      console.error(`❌ Failed to enrich alert with bundle analysis: ${error.message}`);
      
      // Return alert with default bundle values instead of failing
      if (!alert.bundleAnalysis) {
        alert.bundleAnalysis = {
          risk_level: 'UNKNOWN',
          risk_factors: [`Analysis error: ${error.message}`],
          bundle_metrics: { distribution_score: 50, total_bundled_percentage: 0 },
          creator_metrics: { rug_percentage: 0 },
          recommendation: 'Unable to complete analysis, proceed with caution'
        };
      }
      
      if (!alert.scores) {
        alert.scores = { total: 0 };
      }
      
      // Add a default bundle score
      alert.scores.bundle = 50;
      
      // Add default bundle info
      alert.bundleInfo = {
        distribution_score: 50,
        risk_level: 'UNKNOWN',
        key_metrics: {
          total_bundled_percentage: 0,
          distributed_wallets: 'Unknown',
          creator_risk: 0
        },
        recommendation: 'Unable to complete analysis, proceed with caution'
      };
      
      return alert;
    }
  }

  // Calculate a score from bundle analysis (0-100)
  calculateBundleScore(bundleAnalysis) {
    try {
      if (!bundleAnalysis) return 50;
    
      let score = 100;
    
      // Adjust based on risk level
      const riskLevel = bundleAnalysis.risk_level || 'MEDIUM';
      if (riskLevel === 'HIGH') {
        score -= 40;
      } else if (riskLevel === 'MEDIUM') {
        score -= 20;
      }
    
      // Adjust based on distribution score
      const distributionScore = bundleAnalysis.bundle_metrics.distribution_score || 50;
      score = score * (distributionScore / 100);
    
      // Bonus for good creator history
      const hasSuccessHistory = bundleAnalysis.creator_metrics.has_success_history || false;
      const rugPercentage = bundleAnalysis.creator_metrics.rug_percentage || 0;
      if (hasSuccessHistory && rugPercentage < 10) {
        score += 10;
      }
    
      // Penalty for high concentration bundles
      const highConcentrationBundles = bundleAnalysis.bundle_metrics.high_concentration_bundles || 0;
      score -= highConcentrationBundles * 5;
    
      // Penalty for sniper patterns
      const sniperPatterns = bundleAnalysis.bundle_metrics.sniper_patterns || 0;
      score -= sniperPatterns * 5;
    
      return Math.max(0, Math.min(100, score));
    } catch (error) {
      console.error(`❌ Error calculating bundle score: ${error.message}`);
      return 50; // Default neutral score on error
    }
  }
}

module.exports = BundleAnalyzer;