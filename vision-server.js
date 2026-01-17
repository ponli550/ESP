
// Run this cmd before running
// export GOOGLE_APPLICATION_CREDENTIALS="esp32-484513-e5aae62b1117.json"

require('dotenv').config();

let fs = require('fs');
const http = require('http');
const WebSocket = require('ws'); // Import WebSocket
const crypto = require('crypto'); // Import Crypto for random tokens
const TelegramBot = require('node-telegram-bot-api'); // Import Telegram Bot

const server = http.createServer();
const wss = new WebSocket.Server({ server }); // Attach WebSocket to HTTP server
const sharp = require('sharp'); // Image processing

// Rotation Config
const ROTATE_IMAGE = process.env.ROTATE_IMAGE ? parseInt(process.env.ROTATE_IMAGE) : 0;

// Store image in memory instead of file
let currentImageBuffer = null;
let currentLabels = [];
let isAiEnabled = true; // DEFAULT: AI IS ON

// Snapshot Gallery (Detection Reel)
let snapshotGallery = []; // Max 10 items
const MAX_GALLERY_SIZE = 10;

// Auth Config
const SERVER_PASSWORD = process.env.PASSWORD || "admin";
const COOKIE_NAME = "cameraview_auth";

// Dynamic Session Storage
const sessions = new Map();
const SESSION_DURATION = 60 * 60 * 1000; // 1 Hour

// API Key Config
const ESP32_API_KEY = process.env.ESP32_API_KEY || "esp_key";

// Rate Limiting Config
const LOGIN_LIMIT_WINDOW = 60 * 1000; // 1 minute   
const LOGIN_LIMIT_MAX = 5; // 5 attempts per window
const UPLOAD_LIMIT_WINDOW = 1000; // 1 second
const UPLOAD_LIMIT_MAX = 1; // 1 upload per window

// Telegram Alert Config
// Debug Env Vars
console.log("Loading Environment Variables...");
console.log("PWD:", process.cwd());
console.log("ESP32_API_KEY:", process.env.ESP32_API_KEY ? "Loaded" : "Missing");
console.log("TELEGRAM_BOT_TOKEN:", process.env.TELEGRAM_BOT_TOKEN ? "Loaded" : "Missing");
console.log("TELEGRAM_CHAT_ID:", process.env.TELEGRAM_CHAT_ID ? "Loaded" : "Missing");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALERT_TARGET = process.env.ALERT_TARGET
    ? process.env.ALERT_TARGET.split(',').map(s => s.trim())
    : ["Skin", "Eyelash", "Jaw", "Head", "Forehead"];
// Default targets
const ALERT_COOLDOWN = 60 * 1000; // 1 minute cooldown

let lastAlertTime = 0;
let bot = null;

// Initialize Bot if token exists
if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    console.log("Telegram Bot Initialized with Polling");

    // Helper for Status Keyboard
    const getStatusMarkup = () => ({
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "Refresh 🔄", callback_data: "status" },
                    { text: "Take Photo 📸", callback_data: "photo" }
                ],
                [
                    { text: isAiEnabled ? "Disable AI 🤖" : "Enable AI 🤖", callback_data: "toggle" },
                    { text: "Gallery 🎞️", callback_data: "gallery" }
                ]
            ]
        },
        parse_mode: 'Markdown'
    });

    // Command Handlers
    bot.onText(/\/status/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== TELEGRAM_CHAT_ID.toString()) return;

        const status = isAiEnabled ? "✅ ON" : "❌ OFF";
        const labels = currentLabels.length > 0
            ? currentLabels.map(l => `${l.description} (${Math.round(l.score * 100)}%)`).join(", ")
            : "No objects detected yet.";

        bot.sendMessage(chatId, `📊 *System Status*\n- AI Detection: ${status}\n- Last Seen: ${labels}`, getStatusMarkup());
    });

    bot.onText(/\/photo/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== TELEGRAM_CHAT_ID.toString()) return;

        if (currentImageBuffer) {
            bot.sendPhoto(chatId, currentImageBuffer, { caption: "📸 Fresh snapshot from camera." });
        } else {
            bot.sendMessage(chatId, "⚠️ No image buffer available yet.");
        }
    });

    bot.onText(/\/gallery/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== TELEGRAM_CHAT_ID.toString()) return;

        if (snapshotGallery.length === 0) {
            bot.sendMessage(chatId, "📭 The Detection Reel is empty.");
            return;
        }

        bot.sendMessage(chatId, `🎞️ *Latest Detections* (Last ${snapshotGallery.length})`, { parse_mode: 'Markdown' });

        // Send the last 3 snapshots to avoid spamming
        snapshotGallery.slice(0, 3).forEach((snap, index) => {
            const buffer = Buffer.from(snap.image, 'base64');
            bot.sendPhoto(chatId, buffer, {
                caption: `🕒 ${snap.time}\n🏷️ ${snap.labels}`
            });
        });
    });

    bot.onText(/\/targets/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== TELEGRAM_CHAT_ID.toString()) return;

        const targets = Array.isArray(ALERT_TARGET) ? ALERT_TARGET.join(", ") : ALERT_TARGET;
        bot.sendMessage(chatId, `🎯 *Current Alert Targets:*\n\`${targets}\``, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/toggle/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== TELEGRAM_CHAT_ID.toString()) return;

        isAiEnabled = !isAiEnabled;
        const status = isAiEnabled ? "Activated" : "Deactivated";

        bot.sendMessage(chatId, `🤖 AI Detection has been *${status}*.`, getStatusMarkup());
        broadcastUpdate();
    });

    // Callback Query Handler (Buttons)
    bot.on('callback_query', (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;

        if (chatId.toString() !== TELEGRAM_CHAT_ID.toString()) return;

        if (data === 'status') {
            const status = isAiEnabled ? "✅ ON" : "❌ OFF";
            const labels = currentLabels.length > 0
                ? currentLabels.map(l => `${l.description} (${Math.round(l.score * 100)}%)`).join(", ")
                : "No objects detected yet.";

            bot.editMessageText(`📊 *System Status* (Refreshed)\n- AI Detection: ${status}\n- Last Seen: ${labels}`, {
                chat_id: chatId,
                message_id: query.message.message_id,
                ...getStatusMarkup()
            });
        } else if (data === 'photo') {
            if (currentImageBuffer) {
                bot.sendPhoto(chatId, currentImageBuffer, { caption: "📸 Fresh snapshot from camera." });
            } else {
                bot.answerCallbackQuery(query.id, { text: "⚠️ No image buffer available.", show_alert: true });
            }
        } else if (data === 'toggle') {
            isAiEnabled = !isAiEnabled;
            const status = isAiEnabled ? "✅ ON" : "❌ OFF";
            const labels = currentLabels.length > 0
                ? currentLabels.map(l => `${l.description} (${Math.round(l.score * 100)}%)`).join(", ")
                : "No objects detected yet.";

            bot.editMessageText(`🤖 AI Detection toggled to *${isAiEnabled ? "ON" : "OFF"}*.\n\n📊 *System Status*\n- AI Detection: ${status}\n- Last Seen: ${labels}`, {
                chat_id: chatId,
                message_id: query.message.message_id,
                ...getStatusMarkup()
            });
            broadcastUpdate();
        } else if (data === 'gallery') {
            if (snapshotGallery.length === 0) {
                bot.answerCallbackQuery(query.id, { text: "📭 Reel is empty.", show_alert: true });
            } else {
                bot.sendMessage(chatId, `🎞️ *Latest Detections*`, { parse_mode: 'Markdown' });
                snapshotGallery.slice(0, 3).forEach((snap) => {
                    bot.sendPhoto(chatId, Buffer.from(snap.image, 'base64'), {
                        caption: `🕒 ${snap.time}\n🏷️ ${snap.labels}`
                    });
                });
            }
        }

        bot.answerCallbackQuery(query.id);
    });

    bot.onText(/\/start|\/help/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== TELEGRAM_CHAT_ID.toString()) return;

        const helpText = `👋 *ESP32 Camera Bot*\n\nYou can use the buttons below for quick access or use the commands.`;
        bot.sendMessage(chatId, helpText, getStatusMarkup());
    });

} else {
    console.log("Telegram Bot Config Missing (Optional)");
}

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
function broadcastUpdate(isEdgeDetected = false) {
    const data = JSON.stringify({
        type: 'frame',
        image: currentImageBuffer ? currentImageBuffer.toString('base64') : null,
        labels: currentLabels,
        aiEnabled: isAiEnabled,
        edgeDetected: isEdgeDetected,
        gallery: snapshotGallery // Send the latest 10 snapshots
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

async function sendTelegramAlert(imageBuffer, labels) {
    if (!bot || !TELEGRAM_CHAT_ID) return;

    const now = Date.now();
    if (now - lastAlertTime < ALERT_COOLDOWN) return; // Cooldown

    // Check if any of the target labels exist in detections
    const targets = Array.isArray(ALERT_TARGET) ? ALERT_TARGET : [ALERT_TARGET];
    const detected = labels.find(label => {
        const desc = label.description.toLowerCase();
        return targets.some(target => typeof target === 'string' && desc.includes(target.toLowerCase()));
    });

    if (detected) {
        console.log(`🚨 ALERT! Detected ${detected.description}. Sending to Telegram...`);
        lastAlertTime = now;

        try {
            await bot.sendPhoto(TELEGRAM_CHAT_ID, imageBuffer, {
                caption: `🚨 Security Alert: ${detected.description} detected! (${Math.round(detected.score * 100)}%)`
            });
            console.log("Telegram alert sent successfully.");
        } catch (e) {
            console.error("Failed to send Telegram alert:", e.message);
        }
    }
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
            let buffer = Buffer.concat(chunks);
            console.log(`Received image. Size: ${buffer.length} bytes`);

            // Rotate if configured
            if (ROTATE_IMAGE !== 0) {
                try {
                    buffer = await sharp(buffer).rotate(ROTATE_IMAGE).toBuffer();
                } catch (e) {
                    console.error("Image rotation failed:", e);
                }
            }
            currentImageBuffer = buffer;

            try {
                // Only perform AI detection if enabled!
                if (isAiEnabled) {
                    const labels = await labelAPI(currentImageBuffer);
                    currentLabels = labels;

                    // Check for Alerts
                    sendTelegramAlert(currentImageBuffer, currentLabels);

                } else {
                    currentLabels = []; // Clear labels if AI is off
                }

                const isEdgeDetected = request.headers['x-face-detected'] === '1';
                if (isEdgeDetected) {
                    console.log("⚡ [Edge AI] Face detected locally on ESP32!");
                }

                // Add to Snapshot Gallery if target detected or edge alert
                const targets = Array.isArray(ALERT_TARGET) ? ALERT_TARGET : [ALERT_TARGET];
                const hasTarget = currentLabels.some(label => {
                    const desc = label.description.toLowerCase();
                    return targets.some(target => typeof target === 'string' && desc.includes(target.toLowerCase()));
                });

                if (hasTarget || isEdgeDetected) {
                    const snapshot = {
                        id: Date.now(),
                        time: new Date().toLocaleTimeString(),
                        image: currentImageBuffer.toString('base64'),
                        labels: currentLabels.slice(0, 3).map(l => l.description).join(", ") || (isEdgeDetected ? "Edge Detection" : "Detection")
                    };

                    snapshotGallery.unshift(snapshot); // Add to beginning
                    if (snapshotGallery.length > MAX_GALLERY_SIZE) {
                        snapshotGallery.pop(); // Remove oldest
                    }
                }

                // Broadcast update to WebSockets immediately
                broadcastUpdate(isEdgeDetected);

                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(currentLabels));
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

    // Toggle AI Endpoint
    if (request.method == 'POST' && request.url === "/toggleAI") {
        let body = '';
        request.on('data', chunk => body += chunk.toString());
        request.on('end', () => {
            try {
                const { enabled } = JSON.parse(body);
                isAiEnabled = !!enabled; // Force boolean
                console.log(`AI Detection toggled: ${isAiEnabled}`);

                broadcastUpdate(); // Notify clients of state change

                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ success: true, enabled: isAiEnabled }));
            } catch (e) {
                response.writeHead(400);
                response.end("Bad Request");
            }
        });
        return;
    }
    // 6. Video Upload Endpoint (Manual Recording)
    if (request.method == 'POST' && request.url === "/uploadVideo") {
        if (!isAuthorized(request)) {
            response.writeHead(401);
            response.end("Unauthorized");
            return;
        }

        let chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', async () => {
            const videoBuffer = Buffer.concat(chunks);
            console.log(`Received video file for Telegram. Size: ${videoBuffer.length} bytes`);

            if (bot && TELEGRAM_CHAT_ID) {
                try {
                    await bot.sendVideo(TELEGRAM_CHAT_ID, videoBuffer, {
                        caption: `🎞️ Manual Recording Uploaded at ${new Date().toLocaleTimeString()}`
                    });
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ success: true }));
                } catch (e) {
                    console.error("Telegram sendVideo error:", e.message);
                    response.writeHead(500);
                    response.end("Failed to send to Telegram");
                }
            } else {
                response.writeHead(503);
                response.end("Telegram Bot not configured");
            }
        });
        return;
    }


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
        // Return object with status to sync UI
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ labels: currentLabels, aiEnabled: isAiEnabled }));
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
