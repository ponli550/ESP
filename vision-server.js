
// Run this cmd before running
// export GOOGLE_APPLICATION_CREDENTIALS="esp32-484513-e5aae62b1117.json"

require('dotenv').config();

let fs = require('fs');
const http = require('http');
const server = http.createServer();
// Store image in memory instead of file
let currentImageBuffer = null;

server.on('request', (request, response) => {
    if (request.method == 'POST' && request.url === "/imageUpdate") {

        let chunks = [];
        request.on('data', function (data) {
            chunks.push(data);
        });

        request.on('end', async function () {
            // Combine chunks into a single buffer
            currentImageBuffer = Buffer.concat(chunks);
            console.log(`Received image. Size: ${currentImageBuffer.length} bytes`);

            try {
                const labels = await labelAPI(currentImageBuffer);
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(labels));
                console.log(JSON.stringify(labels, null, 2));
            } catch (error) {
                console.error("Error in label detection:", error);
                // Return 500 but also JSON error if possible
                response.writeHead(500, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: error.message }));
            }
        });

    } else if (request.method == 'GET' && request.url == '/') {
        fs.readFile('./index.html', function (err, data) {
            if (err) {
                response.writeHead(500);
                response.end("Error loading index.html");
                return;
            }
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end(data);
        });
    } else if (request.method == 'GET' && request.url.startsWith('/saveImage.jpg')) {
        if (currentImageBuffer) {
            response.writeHead(200, { 'Content-Type': 'image/jpeg' });
            response.end(currentImageBuffer);
        } else {
            response.writeHead(404);
            response.end("No image received yet");
        }
    } else {
        console.log(`Received unhandled request: ${request.method} ${request.url}`);
        response.writeHead(405, { 'Content-Type': 'text/plain' });
        response.end("Method Not Allowed");
    }
});

async function labelAPI(imageBuffer) {
    let o = [];
    // Imports the Google Cloud client library
    const vision = require('@google-cloud/vision');

    // Creates a client
    const clientOptions = {};
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
        try {
            clientOptions.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        } catch (e) {
            console.error("Failed to parse GOOGLE_CREDENTIALS_JSON", e);
        }
    }
    const client = new vision.ImageAnnotatorClient(clientOptions);


    // Performs label detection on the image buffer
    console.log("Perform label detections on image buffer...");
    // Passing the buffer directly involves constructing the request object
    const [result] = await client.labelDetection(imageBuffer);
    const labels = result.labelAnnotations;

    if (labels) {
        labels.forEach(label => {
            o.push({ description: label.description, score: label.score });
        });
    }
    return o;
}

const port = process.env.PORT || 8888;
server.listen(port);
console.log(`Listening at ${port}`);
