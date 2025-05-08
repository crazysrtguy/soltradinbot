// Extract private key for Phantom wallet import
const fs = require('fs');
const path = require('path');

// TELEGRAM INTEGRATION
// =====================================
// For Telegram bot integration
let telegramBot = null;
let isInTelegram = false;

// Setup function to be called from tradingbot.cjs when in Telegram context
function setupTelegramIntegration(bot) {
  telegramBot = bot;
  isInTelegram = true;
  console.log('Telegram integration enabled for private key extraction');
}

// Check if this file is being directly executed or imported
if (require.main === module) {
  // This file is being run directly
  console.log('Running in standalone mode');
} else {
  // This file is being imported/required
  console.log('Running as a module, Telegram integration available');
  
  // Export the setup function
  module.exports = {
    extractPrivateKey: function(userId, chatId) {
      // This function will be called from tradingbot.cjs
      if (!telegramBot) {
        console.error('Telegram bot not initialized');
        return false;
      }
      
      // Extract and send private key for the specified user
      try {
        const walletData = JSON.parse(fs.readFileSync(WALLET_DATA_PATH, 'utf8'));
        const userPublicKey = walletData.userWallets[userId];
        
        if (!userPublicKey || !walletData.wallets[userPublicKey]) {
          telegramBot.sendMessage(chatId, 'No wallet found for your account.');
          return false;
        }
        
        const wallet = walletData.wallets[userPublicKey];
        const privateKeyBuffer = Buffer.from(wallet.privateKey, 'hex');
        const privateKeyArray = Array.from(privateKeyBuffer);
        const phantomFormat = JSON.stringify(privateKeyArray);
        
        // Format for telegram with special formatting to make it pre-formatted and clickable
        telegramBot.sendMessage(
          chatId,
          `*YOUR PRIVATE KEY (CLICK TO COPY)*\n\`\`\`\n${phantomFormat}\n\`\`\`\n\nIMPORTANT: Keep this secure! Anyone with this key can access your wallet.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📋 Copy Private Key', callback_data: `copy_key_${userId}` }]
              ]
            }
          }
        );
        return true;
      } catch (error) {
        console.error('Error extracting private key for Telegram:', error);
        telegramBot.sendMessage(chatId, 'Error extracting private key. Please try again later.');
        return false;
      }
    },
    setupTelegramIntegration
  };
}

// Add click-to-copy functionality for browser environments
if (typeof window !== 'undefined') {
  const originalConsoleLog = console.log;
  console.log = function(...args) {
    // Check if this is a styled log with our private key
    if (args.length >= 2 && typeof args[0] === 'string' && args[0].startsWith('%c')) {
      const privateKey = args[0].substring(2); // Remove %c
      
      // Create a clickable element that copies to clipboard when clicked
      const el = document.createElement('div');
      el.textContent = privateKey;
      el.style.cursor = 'pointer';
      el.style.textDecoration = 'underline';
      el.style.color = 'blue';
      el.onclick = () => {
        navigator.clipboard.writeText(privateKey)
          .then(() => alert('Private key copied to clipboard!'))
          .catch(err => console.error('Failed to copy: ', err));
      };
      
      // Replace console.log with our element
      document.body.appendChild(el);
      return;
    }
    
    // Pass through normal logs
    originalConsoleLog.apply(console, args);
  };
}

// Configuration
const WALLET_DATA_PATH = path.join(__dirname, 'data', 'wallets.json');

try {
  // Read wallet data
  if (!fs.existsSync(WALLET_DATA_PATH)) {
    console.error('No wallet data found at:', WALLET_DATA_PATH);
    process.exit(1);
  }

  const walletData = JSON.parse(fs.readFileSync(WALLET_DATA_PATH, 'utf8'));
  
  if (!walletData || !walletData.wallets || Object.keys(walletData.wallets).length === 0) {
    console.error('No wallets found in wallet data');
    process.exit(1);
  }

  // Display all available wallets
  console.log('Available wallets:');
  console.log('------------------');
  
  const wallets = Object.values(walletData.wallets);
  
  wallets.forEach((wallet, index) => {
    // Convert hex private key to proper format for Phantom import
    const privateKeyBuffer = Buffer.from(wallet.privateKey, 'hex');
    
    // Convert to array of numbers for Phantom import format
    const privateKeyArray = Array.from(privateKeyBuffer);
    const phantomFormat = JSON.stringify(privateKeyArray);
    
    // Display wallet information
    console.log(`Wallet #${index + 1}`);
    console.log(`Public Key: ${wallet.publicKey}`);
    console.log(`Private Key (for Phantom import):`);
    
    // Make the key copiable with a click in browser environments
    if (typeof window !== 'undefined') {
      // We're in a browser, create clickable element
      console.log(`%c${phantomFormat}`, 'cursor:pointer; text-decoration:underline; color:blue;');
      console.log('(Click the key above to copy it)');
    } else {
      // We're in Node.js environment
      console.log(phantomFormat);
      
      // Add platform-specific copy commands as hints
      const platform = process.platform;
      if (platform === 'darwin') {
        // macOS
        console.log(`  Copy command: echo '${phantomFormat}' | pbcopy`);
      } else if (platform === 'win32') {
        // Windows
        console.log(`  Copy command: echo ${phantomFormat} | clip`);
      } else {
        // Linux/Unix with xclip or xsel
        console.log(`  Copy command: echo '${phantomFormat}' | xclip -selection clipboard`);
        console.log(`  Or: echo '${phantomFormat}' | xsel -b`);
      }
    }
    
    console.log(`Created: ${new Date(wallet.createdAt).toLocaleString()}`);
    console.log('------------------');
  });

  // Display user wallets if available
  if (walletData.userWallets && Object.keys(walletData.userWallets).length > 0) {
    console.log('\nUser wallet assignments:');
    console.log('------------------');
    
    Object.entries(walletData.userWallets).forEach(([userId, publicKey]) => {
      console.log(`User ID: ${userId} => Wallet: ${publicKey}`);
    });
  }

  console.log('\nIMPORTANT: To import into Phantom wallet:');
  console.log('1. Copy the private key array shown above');
  console.log('2. Open Phantom wallet and click "Add/Connect Wallet"');
  console.log('3. Select "Import Private Key"');
  console.log('4. Paste the private key array and follow the prompts');
  console.log('\nNote: If Phantom requires the key in a different format, try using the Solana CLI:');
  console.log('solana-keygen recover -o wallet.json');
  console.log('\nWARNING: Keep your private key secure! Anyone with access to your private key can control your wallet.');

} catch (error) {
  console.error('Error extracting private key:', error);
}