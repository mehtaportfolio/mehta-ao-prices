# Deployment Guide for Render

## Overview
This project has **2 separate services**:
- **Service 1: server.js** - Market data syncing (CMP/LCP) with auto cron jobs
- **Service 2: search.js** - Stock inventory refresh

Both should be deployed as separate Render Web Services.

---

## Environment Variables

### Service 1: server.js
```env
PORT=3000
FRONTEND_URL=https://your-frontend.vercel.app
API_KEY=<Angel One API Key>
CLIENT_ID=<Angel One Client ID>
PASSWORD=<Angel One Password>
TOTP_SECRET=<Your TOTP Secret Key>
SUPABASE_URL=<Supabase Project URL>
SUPABASE_KEY=<Supabase Service Role Key>
```

### Service 2: search.js
```env
PORT=3000
FRONTEND_URL=https://your-frontend.vercel.app
SUPABASE_URL=<Supabase Project URL>
SUPABASE_KEY=<Supabase Service Role Key>
```

**Note**: `FRONTEND_URL` can have multiple URLs separated by commas:
```
FRONTEND_URL=https://your-frontend.vercel.app,http://localhost:3001
```

---

## Step-by-Step Render Deployment

### Prerequisites
- GitHub account with this repository
- Render account (render.com)
- Supabase account with credentials
- Angel One API credentials (for server.js only)

### Deploy Service 1 (server.js)

1. Go to **Render Dashboard** → **New +** → **Web Service**
2. Connect your GitHub repository
3. Fill in the details:
   - **Name**: `angel-one-server` (or your choice)
   - **Region**: Choose closest to your location
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`

4. **Add Environment Variables**:
   ```
   PORT=3000
   FRONTEND_URL=https://your-frontend-url.vercel.app
   API_KEY=<your_api_key>
   CLIENT_ID=<your_client_id>
   PASSWORD=<your_password>
   TOTP_SECRET=<your_totp_secret>
   SUPABASE_URL=<your_supabase_url>
   SUPABASE_KEY=<your_supabase_key>
   ```
   
   **For development/multiple URLs**:
   ```
   FRONTEND_URL=https://your-frontend-url.vercel.app,http://localhost:3001
   ```

5. Click **Create Web Service**

6. **Auto-disable free instance spinning down**:
   - Go to **Settings** → **Instance Type**
   - Select **Standard** (paid) to prevent restarts that would break cron jobs
   - Or keep **Free** if okay with cron jobs being delayed on cold starts

### Deploy Service 2 (search.js)

1. Go to **Render Dashboard** → **New +** → **Web Service**
2. Connect your GitHub repository (same repo)
3. Fill in the details:
   - **Name**: `angel-one-search` (or your choice)
   - **Region**: Same as Service 1
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node search.js`

4. **Add Environment Variables**:
   ```
   PORT=3000
   FRONTEND_URL=https://your-frontend-url.vercel.app
   SUPABASE_URL=<your_supabase_url>
   SUPABASE_KEY=<your_supabase_key>
   ```
   
   **For development/multiple URLs**:
   ```
   FRONTEND_URL=https://your-frontend-url.vercel.app,http://localhost:3001
   ```

5. Click **Create Web Service**

---

## Indian Market Hours

The `server.js` is configured to respect Indian stock market trading hours:

**Market Open**: 9:15 AM IST
**Market Close**: 3:30 PM IST  
**Trading Days**: Monday - Friday
**Timezone**: IST (Asia/Kolkata)

### How It Works

1. **CMP Sync (Every 5 minutes)**
   - Scheduled to run every 5 minutes
   - Only executes during market hours (9:15 AM - 3:30 PM IST, weekdays)
   - Silently skips if called outside market hours

2. **LCP Sync (Daily at 4:30 PM)**
   - Runs after market close at 3:30 PM
   - Scheduled at 16:30 (4:30 PM IST) to capture day's closing prices
   - Skips if called before market closes

3. **Manual API Calls**
   - `/sync-cmp`: Returns error if market is closed
   - `/sync-lcp`: Returns error if market is still open
   - `/status`: Shows current market status and IST time

### Status Endpoint Response

```json
{
  "status": "online",
  "authenticated": true,
  "marketOpen": true,
  "istTime": "20/2/2026, 11:30:45 am",
  "lastLogin": "20/2/2026, 10:06:16 am"
}
```

### Error Responses

**When calling CMP sync outside market hours**:
```json
{
  "error": "Market is closed",
  "message": "CMP sync only works during market hours (9:15 AM - 3:30 PM IST, weekdays)",
  "marketOpen": false
}
```

**When calling LCP sync before market closes**:
```json
{
  "error": "Market still open",
  "message": "LCP sync runs after market close (3:30 PM IST)",
  "marketClosed": false
}
```

---

## CORS Configuration

Both services are configured with CORS support to allow requests from your frontend.

**How it works**:
- Each service reads the `FRONTEND_URL` environment variable
- Requests from that URL are allowed (credentials supported)
- All other origins are blocked

**For Multiple URLs** (dev + production):
```
FRONTEND_URL=https://production-app.vercel.app,http://localhost:3001
```

**Frontend Code Example**:
```javascript
const SERVER_URL = 'https://angel-one-server.onrender.com';
const SEARCH_URL = 'https://angel-one-search.onrender.com';

// Requests will work because frontend URL is in FRONTEND_URL env var
fetch(`${SERVER_URL}/status`)
  .then(res => res.json())
  .catch(err => console.error('CORS error:', err));
```

---

## API Endpoints

### Service 1 (server.js)
- **Status Check**: `GET https://your-server.onrender.com/status`
- **Manual CMP Sync**: `POST https://your-server.onrender.com/sync-cmp`
- **Manual LCP Sync**: `POST https://your-server.onrender.com/sync-lcp`
- **Get LTP**: `GET https://your-server.onrender.com/ltp/{exchange}/{symbolToken}`
- **Login**: `POST https://your-server.onrender.com/login` (with TOTP in body)

**Automatic Runs** (Market Hours Aware):
- CMP Sync: Every 5 minutes, but only during market hours (9:15 AM - 3:30 PM IST, weekdays)
- LCP Sync: Daily at 4:30 PM IST (after market close at 3:30 PM)
- Auto-login: Daily at 8:00 AM IST (before market opens)

**Market Hours**:
- **Open**: 9:15 AM - 3:30 PM IST
- **Days**: Monday to Friday
- **Closed**: Weekends and holidays

### Service 2 (search.js)
- **Refresh Stocks**: `GET https://your-search.onrender.com/refresh-stocks`
- **Status**: `GET https://your-search.onrender.com/`

---

## Frontend Integration (React)

```javascript
const SERVER_URL = 'https://your-server.onrender.com';
const SEARCH_URL = 'https://your-search.onrender.com';

// Get market status
const getStatus = async () => {
  const res = await fetch(`${SERVER_URL}/status`);
  return res.json();
};

// Manual CMP sync
const syncCMP = async () => {
  const res = await fetch(`${SERVER_URL}/sync-cmp`, { method: 'POST' });
  return res.json();
};

// Manual LCP sync
const syncLCP = async () => {
  const res = await fetch(`${SERVER_URL}/sync-lcp`, { method: 'POST' });
  return res.json();
};

// Refresh stock list
const refreshStocks = async () => {
  const res = await fetch(`${SEARCH_URL}/refresh-stocks`);
  return res.json();
};

// Get LTP for a stock
const getLTP = async (exchange, symbolToken) => {
  const res = await fetch(`${SERVER_URL}/ltp/${exchange}/${symbolToken}`);
  return res.json();
};

// Login with TOTP
const login = async (totp) => {
  const res = await fetch(`${SERVER_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ totp })
  });
  return res.json();
};
```

---

## Monitoring & Logs

1. Go to each service on Render
2. Click **Logs** tab to view real-time logs
3. Check for:
   - `Login successful` → Authentication working
   - `CMP Sync complete` → Price updates working
   - `✅ All batches processed` → Stock refresh working

---

## Troubleshooting

### Service not starting
- Check logs: `npm install` might be failing
- Verify Node version: `.nvmrc` file should have `20.11.0` or higher

### Cron jobs not running
- Ensure instance type is **Standard** (not Free)
- Check timezone settings match your IST requirements
- View logs for cron execution

### Database errors
- Verify SUPABASE_URL and SUPABASE_KEY are correct
- Ensure stock_mapping table exists with correct columns
- Check Supabase database network access settings

### Angel One API errors
- Verify API_KEY, CLIENT_ID, PASSWORD are correct
- Ensure TOTP_SECRET is valid and hasn't expired
- Check Angel One API status page

---

## Cost Estimate
- **Service 1 (Standard)**: ~$12/month (prevents cold starts)
- **Service 2 (Free)**: $0/month
- **Total**: ~$12/month for reliable operation

If using Free tier for both, expect delays after inactivity periods.
