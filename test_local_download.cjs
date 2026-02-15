const http = require('http');

const url = 'http://localhost:3001/api/download?url=https://www.youtube.com/watch?v=jNQXAC9IVRw';

console.log(`Fetching ${url}...`);

http.get(url, (res) => {
    console.log('Status:', res.statusCode);
    console.log('Headers:', res.headers);

    let chunks = 0;
    res.on('data', (chunk) => {
        chunks++;
        if (chunks % 100 === 0) process.stdout.write('.');
    });
    res.on('end', () => {
        console.log('\nDownload complete.');
    });
}).on('error', (err) => {
    console.error('Error:', err.message);
});
