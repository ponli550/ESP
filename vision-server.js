
// Run this cmd before running
// export GOOGLE_APPLICATION_CREDENTIALS="esp32-484513-e5aae62b1117.json"

require('dotenv').config();

let fs = require('fs');
const http = require('http');
const WebSocket = require('ws'); // Import WebSocket
const crypto = require('crypto'); // Import Crypto for random tokens

const server = http.createServer();
const wss = new WebSocket.Server({ server }); // Attach WebSocket to HTTP server

// Store image in memory instead of file
let currentImageBuffer = null;
let currentLabels = [];

// Auth Config
const SERVER_PASSWORD = process.env.PASSWORD || "admin";
const COOKIE_NAME = "cameraview_auth";
// const SESSION_VAL = "authenticated_session"; // OLD Static Cookie (Removed)

// Dynamic Session Storage
// Map<sessionId, { expiresAt: number }>
const sessions = new Map();
const SESSION_DURATION = 60 * 60 * 1000; // 1 Hour

// API Key Config
const ESP32_API_KEY = process.env.ESP32_API_KEY || "esp_key";

// Rate Limiting Config
const LOGIN_LIMIT_WINDOW = 60 * 1000; // 1 minute
const LOGIN_LIMIT_MAX = 5; // 5 attempts per window
const UPLOAD_LIMIT_WINDOW = 1000; // 1 second
const UPLOAD_LIMIT_MAX = 1; // 1 upload per window

// In-memory request trackers
const loginAttempts = new Map();
const uploadAttempts = new Map();

function isRateLimited(map, ip, windowMs, maxRequests) {
    const now = Date.now();
    let record = map.get(ip);

    // Create new record if none exists or window expired
    if (!record || (now - record.startTime > windowMs)) {
        record = { count: 0, startTime: now };
    }

    // Check limit
    if (record.count >= maxRequests) {
        return true;
    }

    // Increment and update
    record.count++;
    map.set(ip, record);
    return false;
}

function isAuthorized(request) {
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) return false;

    // Parse cookies
    const cookies = {};
    cookieHeader.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        cookies[parts[0].trim()] = parts[1];
    });

    const sessionId = cookies[COOKIE_NAME];
    if (!sessionId) return false;

    // Check if session exists and is valid
    const session = sessions.get(sessionId);
    if (session) {
        if (Date.now() < session.expiresAt) {
            return true;
        } else {
            // Expired, remove it
            sessions.delete(sessionId);
        }
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

function getClientIp(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress;
}

server.on('request', (request, response) => {
    const ip = getClientIp(request);

    // 1. ESP32 Upload Endpoint (Protected by API Key + Rate Limit)
    if (request.method == 'POST' && request.url === "/imageUpdate") {

        // Rate Limit Check
        if (isRateLimited(uploadAttempts, ip, UPLOAD_LIMIT_WINDOW, UPLOAD_LIMIT_MAX)) {
            console.log(`Upload rate limit exceeded for ${ip}`);
            response.writeHead(429, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: "Too Many Requests" }));
            return;
        }

        // Check for API Key
        const apiKey = request.headers['x-api-key'];
        if (apiKey !== ESP32_API_KEY) {
            console.log("Unauthorized upload attempt blocked.");
            response.writeHead(401, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: "Unauthorized: Invalid API Key" }));
            return;
        }

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

    // 2. Login Endpoint (Protected by Rate Limit)
    if (request.method == 'POST' && request.url === "/login") {
        // Rate Limit Check
        if (isRateLimited(loginAttempts, ip, LOGIN_LIMIT_WINDOW, LOGIN_LIMIT_MAX)) {
            console.log(`Login rate limit exceeded for ${ip}`);
            response.writeHead(429, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: "Too many login attempts. Please wait." }));
            return;
        }

        let body = '';
        request.on('data', chunk => body += chunk.toString());
        request.on('end', () => {
            try {
                const { password } = JSON.parse(body);
                if (password === SERVER_PASSWORD) {

                    // Generate Session ID
                    const sessionId = crypto.randomUUID();
                    sessions.set(sessionId, { expiresAt: Date.now() + SESSION_DURATION });

                    // Cleanup old sessions occasionally (simple optimization)
                    if (sessions.size > 1000) {
                        for (const [id, s] of sessions) {
                            if (Date.now() > s.expiresAt) sessions.delete(id);
                        }
                    }

                    response.writeHead(200, {
                        'Set-Cookie': `${COOKIE_NAME}=${sessionId}; HttpOnly; Path=/; Max-Age=3600`,
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
