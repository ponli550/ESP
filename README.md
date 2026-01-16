# ESP32 Vision Server

A Node.js server that receives images from an ESP32-CAM and performs label detection using Google Cloud Vision API.

## Features
- **Image Receiving**: Accepts POST requests with distinct image chunks or streams.
- **Web Interface**: Real-time view of the camera feed at `http://<IP>:8888`.
- **Cloud Vision Integration**: analyzes images and logs label detections.
- **Cloud Ready**: Designed for deployment on Render, Railway, etc.

## Setup

1.  **Install Dependencies:**
    ```bash
    npm install
    ```

2.  **Environment Variables:**
    Create a `.env` file or set environment variables:
    ```bash
    GOOGLE_APPLICATION_CREDENTIALS="path/to/key.json"
    # OR for cloud deployment (secure):
    GOOGLE_CREDENTIALS_JSON="{ ... content of json key ... }"
    ```

3.  **Run:**
    ```bash
    npm start
    ```

## Endpoints
- `POST /imageUpdate`: ESP32 sends image data here.
- `GET /`: View the live camera feed.
- `GET /saveImage.jpg`: Get the latest image.

## Deployment
This project is ready for cloud deployment.
- It uses in-memory storage for images.
- It listens on `process.env.PORT`.
