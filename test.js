const axios = require('axios');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function testServer() {
    try {
        console.log('--- Angel One Backend Test ---');
        
        // Check initial status
        const status = await axios.get('http://localhost:3000/status');
        console.log('Initial Status:', status.data);

        if (!status.data.authenticated) {
            const totp = await question('Enter TOTP from your mobile app: ');
            
            console.log('\n--- Attempting Login ---');
            const loginRes = await axios.post('http://localhost:3000/login', { totp });
            console.log(loginRes.data.message);
        }

        const ltp = await axios.get('http://localhost:3000/ltp/BSE/99919000');
        console.log('LTP Result:', ltp.data);

    } catch (error) {
        console.error('Test Failed:', error.response ? error.response.data : error.message);
    } finally {
        rl.close();
    }
}

testServer();
