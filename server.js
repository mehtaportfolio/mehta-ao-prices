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

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
app.use(cors({
    origin: FRONTEND_URL.split(','),
    credentials: true
}));

const port = process.env.PORT || 4000;
const MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";
const PORTFOLIO_BACKEND_URL = process.env.PORTFOLIO_BACKEND_URL;

// Supabase Setup
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

let smartApi = new SmartAPI({
    api_key: process.env.API_KEY,
});

let sessionData = null;

async function notifyStatus(success, message) {
    try {
        const istTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
        console.log(`Sending notification to portfolio backend: ${success ? 'SUCCESS' : 'FAILURE'}`);
        
        await axios.post(`${PORTFOLIO_BACKEND_URL}/api/angel-one-status`, {
            source: 'angel-one-backend',
            success,
            message,
            timestamp: istTime,
            authenticated: !!sessionData
        }, { timeout: 10000 });
    } catch (error) {
        console.error('Failed to notify portfolio backend:', error.message);
    }
}

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

    const day = istTime.getDay(); // 0=Sun, 6=Sat
    const hours = istTime.getHours();
    const minutes = istTime.getMinutes();
    const currentTime = hours * 60 + minutes;

    const MARKET_OPEN = 9 * 60;       // 9:00 AM
    const MARKET_CLOSE = 16 * 60; // 4:00 PM

    const isWeekday = day >= 1 && day <= 5;
    const isWithinTime = currentTime >= MARKET_OPEN && currentTime <= MARKET_CLOSE;

    return isWeekday && isWithinTime;
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
            console.log('Login successful. Session updated.');
            return { success: true };
        } else {
            console.error('Login failed response:', JSON.stringify(data));
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
                if (response.status && response.data && response.data.fetched) {
                    allFetchedData.push(...response.data.fetched);
                } else {
                    const msg = response.message || 'Unknown error';
                    console.error(`API response error for ${exch}:`, msg);
                    if (msg === 'Invalid Token' || msg.includes('Token expired') || response.errorcode === 'AG8001') {
                        throw new Error(msg);
                    }
                }
            } catch (err) {
                console.error(`Exception fetching chunk for ${exch}:`, err.message);
                if (err.message === 'Invalid Token' || err.message.includes('Token expired')) {
                    throw err;
                }
            }
        }
    }
    return allFetchedData;
}

async function syncPrices() {
    if (!sessionData) {
        console.log('Session missing in syncPrices. Attempting automated login...');
        if (process.env.TOTP_SECRET) {
            const loginResult = await login();
            if (!loginResult.success) {
                console.log('Automated login failed in syncPrices. Skipping sync.');
                await notifyStatus(false, `Automated login failed during syncPrices: ${loginResult.message}`);
                return;
            }
        } else {
            console.log('Skipping sync: Not authenticated and no TOTP_SECRET.');
            await notifyStatus(false, 'Session missing in syncPrices and no TOTP_SECRET available.');
            return;
        }
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
            const BATCH_SIZE = 500;
            const now = new Date().toISOString();
            
            for (let i = 0; i < fetchedData.length; i += BATCH_SIZE) {
                const batch = fetchedData.slice(i, i + BATCH_SIZE).map(stock => ({
                    symbol_ao: stock.tradingSymbol,
                    symbol_token: stock.symbolToken,
                    exchange: stock.exchange,
                    cmp: stock.ltp,
                    last_updated: now
                }));

                const { error } = await supabase
                    .from('stock_mapping')
                    .upsert(batch, { onConflict: 'symbol_ao,exchange' });

                if (error) {
                    console.error(`Batch sync error (CMP):`, error.message);
                } else {
                    console.log(`Processed CMP batch ${i / BATCH_SIZE + 1}`);
                }
            }
            console.log(`CMP Sync complete. Updated ${fetchedData.length} symbols.`);
        }
    } catch (error) {
        console.error('Error during price sync:', error.message);
        if (error.message.includes('Token expired') || error.message === 'Invalid Token' || error.errorcode === 'AG8001') {
            console.log('Session expired during sync. Clearing sessionData.');
            sessionData = null;
        }
    }
}

async function syncLCP() {
    if (!sessionData) {
        console.log('Session missing in syncLCP. Attempting automated login...');
        if (process.env.TOTP_SECRET) {
            await login();
        }
        
        if (!sessionData) {
            console.log('Skipping LCP sync: Not authenticated and no session.');
            return;
        }
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
            const BATCH_SIZE = 500;
            const now = new Date().toISOString();
            
            for (let i = 0; i < fetchedData.length; i += BATCH_SIZE) {
                const batch = fetchedData.slice(i, i + BATCH_SIZE).map(stock => ({
                    symbol_ao: stock.tradingSymbol,
                    symbol_token: stock.symbolToken,
                    exchange: stock.exchange,
                    lcp: stock.close,
                    last_updated: now
                }));

                const { error } = await supabase
                    .from('stock_mapping')
                    .upsert(batch, { onConflict: 'symbol_ao,exchange' });

                if (error) {
                    console.error(`Batch sync error (LCP):`, error.message);
                } else {
                    console.log(`Processed LCP batch ${i / BATCH_SIZE + 1}`);
                }
            }
            console.log(`LCP Sync complete. Updated ${fetchedData.length} symbols.`);
        }
    } catch (error) {
        console.error('Error during LCP sync:', error.message);
        if (error.message.includes('Token expired') || error.message === 'Invalid Token' || error.errorcode === 'AG8001') {
            console.log('Session expired during LCP sync. Clearing sessionData.');
            sessionData = null;
        }
    }
}

// Sync current prices (CMP) every 5 minutes (runs anytime)
cron.schedule('*/5 * * * *', () => {
    console.log(`Cron triggered at ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} IST`);
    syncPrices();
}, {
    timezone: "Asia/Kolkata"
});

// Sync daily close (LCP) at 4:30 PM IST (16:30 is after 3:30 PM market close)
cron.schedule('30 16 * * *', () => {
    console.log('Running daily LCP sync at 16:30 IST (after market close)...');
    syncLCP();
}, {
    timezone: "Asia/Kolkata"
});

// Manual trigger for CMP sync
// Manual trigger for refresh stocks
app.get('/refresh-stocks', async (req, res) => {
    try {
        const result = await refreshStocks();
        res.json({ 
            status: "success",
            message: `✅ Stock refresh completed: ${result.count} stocks processed`
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: `❌ Stock refresh failed: ${error.message}`
        });
    }
});

async function fetchAngelHoldings() {
    if (!sessionData) {
        const loginResult = await login();
        if (!loginResult.success) return;
    }

    try {
        console.log("Fetching holdings...");
        const response = await smartApi.getHolding();

        if (!response.status) {
            console.error("API failed:", response);
            if (response.message === 'Invalid Token' || response.message.includes('Token expired') || response.errorcode === 'AG8001') {
                sessionData = null;
            }
            return;
        }

        const holdings = response.data || [];
        console.log(`Fetched ${holdings.length} holdings`);
        // You might want to store these in Supabase too, similar to fetchTodayBuyTrades
        // For now just logging to satisfy the call
    } catch (error) {
        console.error("Error fetching holdings:", error.message);
    }
}

app.all(['/fetch-buy-trades'], async (req, res) => {
    try {
        await fetchTodayBuyTrades();
        res.json({ status: 'success', message: '✅ Buy trades aggregated & stored' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Manual trigger for CMP sync
app.all(['/sync', '/sync-cmp'], async (req, res) => {
    try {
        await syncPrices();
        res.json({ status: 'success', message: '✅ CMP Sync completed successfully' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: `❌ CMP Sync failed: ${error.message}` });
    }
});

// Manual trigger for LCP sync
app.all(['/sync-lcp'], async (req, res) => {
    try {
        await syncLCP();
        res.json({ 
            status: 'success', 
            message: '✅ LCP Sync completed successfully'
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            message: `❌ LCP Sync failed: ${error.message}` 
        });
    }
});



function aggregateBuyTrades(trades) {
    const grouped = {};

    trades.forEach(t => {
        // ✅ ONLY BUY TRADES
        if (t.transactiontype !== "BUY") return;

        const symbol = t.tradingsymbol || t.tradingSymbol || t.symbol;
        const exchange = t.exchange || t.exch_seg;
        const key = `${symbol}_${exchange}`;

        if (!grouped[key]) {
            grouped[key] = {
                symbol: symbol,
                exchange: exchange,
                isin: t.isin || null,
                product: t.producttype || t.product,

                totalQty: 0,
                totalValue: 0
            };
        }

        const qty = Number(t.quantity || t.fillsize || t.fillquantity || 0);
        const price = Number(t.price || t.fillprice || t.averageprice || 0);

        if (!isNaN(qty) && !isNaN(price)) {
            grouped[key].totalQty += qty;
            grouped[key].totalValue += qty * price;
        }
    });

    // ✅ FINAL FORMAT
    return Object.values(grouped).map(g => ({
        broker: "angel",
        account_id: process.env.CLIENT_ID,

        symbol: g.symbol,
        isin: g.isin,

        quantity: g.totalQty,
        average_price: g.totalQty > 0 ? Number((g.totalValue / g.totalQty).toFixed(2)) : 0,
        last_price: 0, // will replace with CMP later
        pnl: 0,

        product: g.product,
        exchange: g.exchange,

        position_date: new Date().toISOString().split("T")[0],
        fetched_at: new Date().toISOString()
    }));
}

async function fetchTodayBuyTrades() {
    if (!sessionData) {
        const loginResult = await login();
        if (!loginResult.success) return;
    }

    try {
        console.log("Fetching tradebook...");

        const response = await smartApi.getTradeBook();

        if (!response.status) {
            console.error("API failed:", response);
            if (response.message === 'Invalid Token' || response.message.includes('Token expired') || response.errorcode === 'AG8001') {
                sessionData = null;
            }
            return;
        }

        const trades = response.data || [];

        if (trades.length === 0) {
            console.log("No trades found today");
            return;
        }

        console.log("RAW TRADES:", trades);

        // 🔥 AGGREGATION
        const formatted = aggregateBuyTrades(trades);

        console.log("AGGREGATED BUY TRADES:", formatted);

        const today = new Date().toISOString().split("T")[0];

        // ✅ DELETE TODAY’S OLD DATA (SAFE SNAPSHOT APPROACH)
        await supabase
            .from('equity_positions')
            .delete()
            .eq('broker', 'angel')
            .eq('account_id', process.env.CLIENT_ID)
            .eq('position_date', today);

        // ✅ INSERT CLEAN DATA
        const { error } = await supabase
            .from('equity_positions')
            .insert(formatted);

        if (error) {
            console.error("Insert error:", error.message);
        } else {
            console.log(`✅ Inserted ${formatted.length} aggregated BUY trades`);
        }

    } catch (error) {
        console.error("Error:", error.message);
    }
}

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
            if (response.message === 'Invalid Token' || response.message.includes('Token expired') || response.errorcode === 'AG8001') {
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

// Health check for UptimeRobot
app.get('/', (req, res) => {
    res.status(200).json({
        status: "ok",
        service: "angel-one-backend",
        time: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.status(200).send("OK");
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

// Daily session invalidation and re-login at 8:00 AM IST
cron.schedule('0 8 * * *', async () => {
    console.log('Automated Daily Login at 8:00 AM IST...');
    sessionData = null;
    const result = await login();
    await notifyStatus(result.success, result.success ? 'Daily automated login successful' : `Daily automated login failed: ${result.message}`);
}, {
    timezone: "Asia/Kolkata"
});

// Daily session snapshot after market close
cron.schedule('35 15 * * *', async () => {
    console.log('Fetching Angel holdings after market close...');
    await fetchAngelHoldings();
}, {
    timezone: "Asia/Kolkata"
});

app.listen(port, async () => {
    console.log(`Server running at http://localhost:${port}`);
    if (process.env.TOTP_SECRET) {
        console.log('TOTP Secret found. Attempting initial automated login...');
        const result = await login();
        await notifyStatus(result.success, result.success ? 'Initial startup login successful' : `Initial startup login failed: ${result.message}`);
    } else {
        console.log('Waiting for manual TOTP login at /login endpoint...');
    }
});
