const http = require('http');

const url = 'http://localhost:3001/api/transcript?url=https://www.youtube.com/watch?v=jNQXAC9IVRw';

console.log(`Fetching ${url}...`);

http.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Body length:', data.length);
        if (data.length > 500) console.log('Body:', data.substring(0, 500) + '...');
        else console.log('Body:', data);
    });
}).on('error', (err) => {
    console.error('Error:', err.message);
});
