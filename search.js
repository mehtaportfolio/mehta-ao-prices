require('dotenv').config();
const express = require("express");
const axios = require("axios");
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';
app.use(cors({
    origin: FRONTEND_URL.split(','),
    credentials: true
}));

const port = process.env.PORT || 3000;

// Supabase Setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

async function refreshStocks() {
  try {
    console.log("Downloading Angel One instrument master...");
    const response = await axios.get(MASTER_URL, { timeout: 60000 });
    const instruments = response.data;

    console.log("Total instruments:", instruments.length);

    // Equity Filter (NSE + BSE) + No numeric digits (special chars like - allowed)
    const eqStocks = instruments.filter(item =>
      (item.exch_seg === "NSE" || item.exch_seg === "BSE") &&
      item.instrumenttype === "" &&
      item.token &&
      item.symbol &&
      !/\d/.test(item.symbol) // No numeric digits allowed
    );

    console.log("Total EQ Stocks found:", eqStocks.length);

    // Fetch existing NSE stocks to avoid duplicates
    const { data: existingNSE, error: fetchError } = await supabase
      .from('stock_symbols')
      .select('name')
      .eq('exchange', 'NSE');

    if (fetchError) throw fetchError;

    const nseNames = new Set(existingNSE?.map(s => s.name) || []);
    console.log(`Found ${nseNames.size} existing NSE stocks`);

    // Separate NSE and BSE, then filter BSE to exclude NSE duplicates based on name
    const nseStocks = eqStocks.filter(item => item.exch_seg === "NSE");
    const nseNamesFromMaster = new Set(nseStocks.map(s => s.name));
    const allNseNames = new Set([...nseNames, ...nseNamesFromMaster]);
    
    const bseStocks = eqStocks.filter(item => 
      item.exch_seg === "BSE" && !allNseNames.has(item.name)
    );

    console.log(`Processing ${nseStocks.length} NSE stocks and ${bseStocks.length} BSE stocks (duplicates filtered)`);

    // Prepare data for Supabase
    const formatted = [...nseStocks, ...bseStocks].map(item => ({
      symbol: item.symbol,
      name: item.name,
      exchange: item.exch_seg,
      symbol_token: item.token
      // created_at is handled by DB default now()
    }));

    // Insert/Upsert in parallel batches
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

    // Run all batches in parallel
    await Promise.all(promises);
    console.log("✅ All batches processed.");
    return { success: true, count: formatted.length };

  } catch (error) {
    console.error("❌ Error:", error.message || error);
    console.error("Stack:", error.stack);
    throw error;
  }
}

app.get("/refresh-stocks", (req, res) => {
  // Start the process and respond immediately
  refreshStocks()
    .then(result => console.log(`Refresh completed: ${result.count} stocks`))
    .catch(error => console.error("Background refresh failed:", error.message));

  res.json({ 
    status: "Processing", 
    message: "Stock refresh started in background. It will take a few seconds to complete." 
  });
});

app.get("/", (req, res) => {
  res.send("Angel One Stock Refresher Server is running. Call /refresh-stocks to update list.");
});

app.listen(port, () => {
  console.log(`Server running at port ${port}`);
});
