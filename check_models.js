
const key = process.env.GEMINI_API_KEY;
console.log("Checking models with key:", key ? "Key Present" : "No Key");
fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`)
    .then(r => r.json())
    .then(d => {
        if (d.error) {
            console.error("Error:", d.error);
        } else {
            console.log("Available Models:");
            d.models.forEach(m => console.log(m.name));
        }
    })
    .catch(e => console.error("Fetch Error:", e));
