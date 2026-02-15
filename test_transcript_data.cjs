const { getTranscript } = require('./server/transcript.cjs');

async function test() {
    try {
        console.log('Fetching transcript for sp79zufiyO0...');
        const data = await getTranscript('sp79zufiyO0');
        console.log('Title:', data.title);
        console.log('Segment Count:', data.segments.length);
        if (data.segments.length > 0) {
            console.log('First Segment:', JSON.stringify(data.segments[0], null, 2));
            console.log('Last Segment:', JSON.stringify(data.segments[data.segments.length - 1], null, 2));
        }
    } catch (e) {
        console.error('Error:', e);
    }
}

test();
