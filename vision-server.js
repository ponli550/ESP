
// Run this cmd before running
// export GOOGLE_APPLICATION_CREDENTIALS="esp32-484513-e5aae62b1117.json"

require('dotenv').config();

let fs = require('fs');
const http = require('http');
const WebSocket = require('ws'); // Import WebSocket

const server = http.createServer();
const wss = new WebSocket.Server({ server }); // Attach WebSocket to HTTP server

// Store image in memory instead of file
let currentImageBuffer = null;
let currentLabels = [];

// Auth Config
const SERVER_PASSWORD = process.env.PASSWORD || "admin";
const COOKIE_NAME = "cameraview_auth";
const SESSION_VAL = "authenticated_session";

function isAuthorized(request) {
    const cookie = request.headers.cookie;
    if (cookie && cookie.includes(`${COOKIE_NAME}=${SESSION_VAL}`)) {
        return true;
    }
    return false;
}

// Broadcast to all connected WebSocket clients
function broadcastUpdate() {
    const data = JSON.stringify({
        type: 'frame',
        image: currentImageBuffer ? currentImageBuffer.toString('base64') : null,
        labels: currentLabels
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

server.on('request', (request, response) => {
    // 1. ESP32 Upload Endpoint (Public)
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
                currentLabels = labels; // Update global labels

                // Broadcast update to WebSockets immediately
                broadcastUpdate();

                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(labels));
                console.log(JSON.stringify(labels, null, 2));
            } catch (error) {
                console.error("Error in label detection:", error);

                // Still broadcast image even if API fails
                broadcastUpdate();

                response.writeHead(500, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: error.message }));
            }
        });
        return;
    }

    // 2. Login Endpoint
    if (request.method == 'POST' && request.url === "/login") {
        let body = '';
        request.on('data', chunk => body += chunk.toString());
        request.on('end', () => {
            try {
                const { password } = JSON.parse(body);
                if (password === SERVER_PASSWORD) {
                    response.writeHead(200, {
                        'Set-Cookie': `${COOKIE_NAME}=${SESSION_VAL}; HttpOnly; Path=/;`,
                        'Content-Type': 'application/json'
                    });
                    response.end(JSON.stringify({ success: true }));
                } else {
                    response.writeHead(401, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ success: false }));
                }
            } catch (e) {
                response.writeHead(400);
                response.end("Bad Request");
            }
        });
        return;
    }

    if (request.method == 'GET' && request.url === "/login") {
        fs.readFile('./login.html', function (err, data) {
            if (err) {
                response.writeHead(500);
                response.end("Error loading login.html");
                return;
            }
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end(data);
        });
        return;
    }

    // 3. Protected Viewer Endpoints
    if (!isAuthorized(request)) {
        // Redirect to login for HTML requests, 401 for others
        if (request.url === '/' || request.url === '/index.html') {
            response.writeHead(302, { 'Location': '/login' });
            response.end();
        } else {
            response.writeHead(401);
            response.end("Unauthorized");
        }
        return;
    }

    // --- PROTECTED ROUTES BELOW ---

    if (request.method == 'GET' && request.url == '/') {
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
    } else if (request.method == 'GET' && request.url === "/labels") {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(currentLabels));
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
