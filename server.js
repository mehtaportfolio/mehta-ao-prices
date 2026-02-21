require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { SmartAPI } = require('smartapi-javascript');
const { TOTP } = require('totp-generator');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';
app.use(cors({
    origin: FRONTEND_URL.split(','),
    credentials: true
}));

const port = process.env.PORT || 3000;
const MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

// Supabase Setup
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

let smartApi = new SmartAPI({
    api_key: process.env.API_KEY,
});

let sessionData = null;

async function refreshStocks() {
    try {
        console.log("Downloading Angel One instrument master...");
        const response = await axios.get(MASTER_URL, { timeout: 60000 });
        const instruments = response.data;

        console.log("Total instruments:", instruments.length);

        const eqStocks = instruments.filter(item =>
            (item.exch_seg === "NSE" || item.exch_seg === "BSE") &&
            item.instrumenttype === "" &&
            item.token &&
            item.symbol &&
            !/\d/.test(item.symbol)
        );

        console.log("Total EQ Stocks found:", eqStocks.length);

        const { data: existingNSE, error: fetchError } = await supabase
            .from('stock_symbols')
            .select('name')
            .eq('exchange', 'NSE');

        if (fetchError) throw fetchError;

        const nseNames = new Set(existingNSE?.map(s => s.name) || []);
        console.log(`Found ${nseNames.size} existing NSE stocks`);

        const nseStocks = eqStocks.filter(item => item.exch_seg === "NSE");
        const nseNamesFromMaster = new Set(nseStocks.map(s => s.name));
        const allNseNames = new Set([...nseNames, ...nseNamesFromMaster]);
        
        const bseStocks = eqStocks.filter(item => 
            item.exch_seg === "BSE" && !allNseNames.has(item.name)
        );

        console.log(`Processing ${nseStocks.length} NSE stocks and ${bseStocks.length} BSE stocks (duplicates filtered)`);

        const formatted = [...nseStocks, ...bseStocks].map(item => ({
            symbol: item.symbol,
            name: item.name,
            exchange: item.exch_seg,
            symbol_token: item.token
        }));

        const batchSize = 2000;
        const promises = [];
        
        for (let i = 0; i < formatted.length; i += batchSize) {
            const batch = formatted.slice(i, i + batchSize);
            promises.push(
                supabase
                    .from('stock_symbols')
                    .upsert(batch, { onConflict: 'symbol,exchange' })
                    .then(({ error }) => {
                        if (error) console.error(`Batch error:`, error.message);
                    })
            );
        }

        await Promise.all(promises);
        console.log("✅ All batches processed.");
        return { success: true, count: formatted.length };

    } catch (error) {
        console.error("❌ Error:", error.message || error);
        console.error("Stack:", error.stack);
        throw error;
    }
}

function isMarketOpen() {
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    
    const dayOfWeek = istTime.getDay();
    const hours = istTime.getHours();
    const minutes = istTime.getMinutes();
    const currentTime = hours * 60 + minutes;
    
    const MARKET_OPEN = 9 * 60 + 15;
    const MARKET_CLOSE = 15 * 60 + 30;
    
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const isWithinHours = currentTime >= MARKET_OPEN && currentTime <= MARKET_CLOSE;
    
    return isWeekday && isWithinHours;
}

async function login(totpInput) {
    try {
        let totp = totpInput;
        if (!totp) {
            const result = await TOTP.generate(process.env.TOTP_SECRET);
            totp = result.otp;
        }
        console.log(`Attempting login with TOTP: ${totp}`);
        const data = await smartApi.generateSession(process.env.CLIENT_ID, process.env.PASSWORD, totp);
        
        if (data.status) {
            sessionData = data.data;
            console.log('Login successful');
            return { success: true };
        } else {
            console.error('Login failed:', data.message);
            return { success: false, message: data.message };
        }
    } catch (error) {
        console.error('Error during login:', error);
        return { success: false, message: error.message };
    }
}

async function fetchMarketDataChunked(exchangeTokens) {
    const CHUNK_SIZE = 50; // API limit usually around 50-100 for some modes
    const allFetchedData = [];
    const exchanges = Object.keys(exchangeTokens);

    for (const exch of exchanges) {
        const tokens = exchangeTokens[exch];
        for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
            const chunk = tokens.slice(i, i + CHUNK_SIZE);
            try {
                const response = await smartApi.marketData({
                    mode: "FULL",
                    exchangeTokens: { [exch]: chunk }
                });
                if (response.status && response.data.fetched) {
                    allFetchedData.push(...response.data.fetched);
                }
            } catch (err) {
                console.error(`Error fetching chunk for ${exch}:`, err.message);
            }
        }
    }
    return allFetchedData;
}

async function syncPrices() {
    if (!isMarketOpen()) {
        console.log('Market is closed. Skipping CMP sync.');
        return;
    }

    if (!sessionData) {
        console.log('Skipping sync: Not authenticated with Angel One.');
        return;
    }

    try {
        console.log('Syncing current market prices (CMP) to Supabase...');
        const { data: symbols, error: fetchError } = await supabase
            .from('stock_mapping')
            .select('symbol_ao, exchange, symbol_token');

        if (fetchError) throw fetchError;
        if (!symbols || symbols.length === 0) return;

        const exchangeTokens = {};
        symbols.forEach(s => {
            if (s.exchange && s.symbol_token) {
                if (!exchangeTokens[s.exchange]) exchangeTokens[s.exchange] = [];
                exchangeTokens[s.exchange].push(s.symbol_token);
            }
        });

        const fetchedData = await fetchMarketDataChunked(exchangeTokens);
        console.log(`Fetched ${fetchedData.length} records from API. Expected ~${symbols.length}.`);

        if (fetchedData.length > 0) {
            // Update only cmp and last_updated columns
            const BATCH_SIZE = 1000;
            const promises = [];
            
            for (let i = 0; i < fetchedData.length; i += BATCH_SIZE) {
                const batch = fetchedData.slice(i, i + BATCH_SIZE);
                
                batch.forEach(stock => {
                    promises.push(
                        supabase
                            .from('stock_mapping')
                            .update({
                                cmp: stock.ltp,
                                last_updated: new Date().toISOString()
                            })
                            .eq('symbol_ao', stock.tradingSymbol)
                            .eq('symbol_token', stock.symbolToken)
                            .eq('exchange', stock.exchange)
                            .then(({ error }) => { if (error) console.error("Batch update error:", error.message); })
                    );
                });
            }
            
            await Promise.all(promises);
            console.log(`CMP Sync complete. Updated ${fetchedData.length} symbols.`);
        }
    } catch (error) {
        console.error('Error during price sync:', error.message);
    }
}

async function syncLCP() {
    const istTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const hours = istTime.getHours();
    const minutes = istTime.getMinutes();
    const currentTime = hours * 60 + minutes;
    const MARKET_CLOSE = 15 * 60 + 30;
    
    if (currentTime < MARKET_CLOSE) {
        console.log('Market is still open. Skipping LCP sync (runs after 3:30 PM IST).');
        return;
    }

    if (!sessionData) {
        console.log('Skipping LCP sync: Not authenticated.');
        await login();
        if (!sessionData) return;
    }

    try {
        console.log('Syncing last closing prices (LCP)...');
        const { data: symbols, error: fetchError } = await supabase
            .from('stock_mapping')
            .select('symbol_ao, exchange, symbol_token');

        if (fetchError) throw fetchError;
        if (!symbols || symbols.length === 0) return;

        const exchangeTokens = {};
        symbols.forEach(s => {
            if (s.exchange && s.symbol_token) {
                if (!exchangeTokens[s.exchange]) exchangeTokens[s.exchange] = [];
                exchangeTokens[s.exchange].push(s.symbol_token);
            }
        });

        const fetchedData = await fetchMarketDataChunked(exchangeTokens);

        if (fetchedData.length > 0) {
            // Update only lcp and last_updated columns
            const BATCH_SIZE = 1000;
            const promises = [];
            
            for (let i = 0; i < fetchedData.length; i += BATCH_SIZE) {
                const batch = fetchedData.slice(i, i + BATCH_SIZE);
                
                batch.forEach(stock => {
                    promises.push(
                        supabase
                            .from('stock_mapping')
                            .update({
                                lcp: stock.close,
                                last_updated: new Date().toISOString()
                            })
                            .eq('symbol_ao', stock.tradingSymbol)
                            .eq('symbol_token', stock.symbolToken)
                            .eq('exchange', stock.exchange)
                            .then(({ error }) => { if (error) console.error("Batch LCP error:", error.message); })
                    );
                });
            }
            
            await Promise.all(promises);
            console.log(`LCP Sync complete. Updated ${fetchedData.length} symbols.`);
        }
    } catch (error) {
        console.error('Error during LCP sync:', error.message);
    }
}

// Sync current prices (CMP) every 5 minutes (runs only during market hours)
cron.schedule('*/5 * * * *', () => {
    if (isMarketOpen()) {
        syncPrices();
    }
});

// Sync daily close (LCP) at 4:30 PM IST (16:30 is after 3:30 PM market close)
cron.schedule('30 16 * * *', () => {
    console.log('Running daily LCP sync at 16:30 IST (after market close)...');
    syncLCP();
});

// Manual trigger for CMP sync
app.all(['/sync', '/sync-cmp'], async (req, res) => {
    if (!isMarketOpen()) {
        return res.status(400).json({ 
            error: 'Market is closed',
            message: 'CMP sync only works during market hours (9:15 AM - 3:30 PM IST, weekdays)',
            marketOpen: false
        });
    }
    syncPrices();
    res.json({ message: 'CMP Sync triggered in background', marketOpen: true });
});

// Manual trigger for LCP sync
app.all(['/sync-lcp'], async (req, res) => {
    const istTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const hours = istTime.getHours();
    const minutes = istTime.getMinutes();
    const currentTime = hours * 60 + minutes;
    const MARKET_CLOSE = 15 * 60 + 30;
    
    if (currentTime < MARKET_CLOSE) {
        return res.status(400).json({ 
            error: 'Market still open',
            message: 'LCP sync runs after market close (3:30 PM IST)',
            marketClosed: false
        });
    }
    
    syncLCP();
    res.json({ message: 'LCP Sync triggered in background', marketClosed: true });
});

// LTP Fetching endpoint
app.get('/ltp/:exchange/:symbolToken', async (req, res) => {
    try {
        if (!sessionData) {
            return res.status(401).json({ error: 'Not logged in. Please submit TOTP via /login first.' });
        }

        const { exchange, symbolToken } = req.params;
        const response = await smartApi.marketData({
            mode: "FULL",
            exchangeTokens: {
                [exchange]: [symbolToken]
            }
        });

        if (response.status) {
            const data = response.data.fetched[0];
            res.json({
                tradingSymbol: data.tradingSymbol,
                symbolToken: data.symbolToken,
                ltp: data.ltp,
                yesterdayClose: data.close, // Previous day's closing price
                high: data.high,
                low: data.low,
                open: data.open
            });
        } else {
            // Check if token expired
            if (response.message.includes('Token expired') || response.errorcode === 'AG8001') {
                sessionData = null;
                return res.status(401).json({ error: 'Session expired. Please re-login with new TOTP.' });
            }
            res.status(500).json({ error: response.message });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Manual login with TOTP
app.post('/login', async (req, res) => {
    const { totp } = req.body;
    if (!totp) {
        return res.status(400).json({ error: 'TOTP is required' });
    }
    
    const result = await login(totp);
    if (result.success) {
        res.json({ message: 'Login successful. LTP fetching started.' });
    } else {
        res.status(401).json({ error: 'Login failed', message: result.message });
    }
});

app.get('/status', (req, res) => {
    const istTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    res.json({
        status: 'online',
        authenticated: !!sessionData,
        lastLogin: sessionData ? new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : 'Never',
        marketOpen: isMarketOpen(),
        istTime: istTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
    });
});

app.get('/refresh-stocks', (req, res) => {
    refreshStocks()
        .then(result => console.log(`Refresh completed: ${result.count} stocks`))
        .catch(error => console.error("Background refresh failed:", error.message));

    res.json({ 
        status: "Processing", 
        message: "Stock refresh started in background. It will take a few seconds to complete." 
    });
});

// Daily session invalidation and re-login at 8:00 AM
cron.schedule('0 8 * * *', async () => {
    console.log('Automated Daily Login at 8:00 AM...');
    sessionData = null;
    await login();
});

app.listen(port, async () => {
    console.log(`Server running at http://localhost:${port}`);
    if (process.env.TOTP_SECRET) {
        console.log('TOTP Secret found. Attempting initial automated login...');
        await login();
    } else {
        console.log('Waiting for manual TOTP login at /login endpoint...');
    }
});
