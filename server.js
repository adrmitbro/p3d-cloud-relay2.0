// P3D Remote Cloud Relay - All-in-One Edition
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Simple session storage: uniqueId -> { pcClient, mobileClients: Set(), password, guestPassword }
const sessions = new Map();

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    activeSessions: sessions.size
  });
});

app.get('/', (req, res) => {
  res.send(getMobileAppHTML());
});

// Screenshot capture function
function captureScreenshot() {
    return new Promise((resolve, reject) => {
        // Method 1: PowerShell for Windows (built-in)
        const tempPath = path.join(__dirname, 'temp_screenshot.png');
        
        // PowerShell script to capture screen
        const psScript = `
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $bmp = New-Object System.Drawing.Bitmap $bounds.width, $bounds.height
            $graphics = [System.Drawing.Graphics]::FromImage($bmp)
            $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.size)
            $bmp.Save('${tempPath.replace(/\\/g, '\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
            $graphics.Dispose()
            $bmp.Dispose()
        `;
        
        exec(`powershell -Command "${psScript.replace(/"/g, '\\"')}"`, (error, stdout, stderr) => {
            if (error) {
                console.error('Screenshot failed:', error);
                reject(error);
                return;
            }
            
            try {
                // Read the captured image
                const imageBuffer = fs.readFileSync(tempPath);
                const base64Image = imageBuffer.toString('base64');
                
                // Clean up temp file
                fs.unlinkSync(tempPath);
                
                resolve(base64Image);
            } catch (err) {
                console.error('Error reading screenshot:', err);
                reject(err);
            }
        });
    });
}

// Simulate flight data (replace with actual SimConnect data)
function getMockFlightData() {
    return {
        groundSpeed: 250 + Math.random() * 50,
        altitude: 30000 + Math.random() * 5000,
        heading: Math.random() * 360,
        verticalSpeed: (Math.random() - 0.5) * 1000,
        nextWaypoint: 'KORD',
        distanceToWaypoint: 50 + Math.random() * 100,
        waypointEte: 1800 + Math.random() * 600,
        totalDistance: 500 + Math.random() * 200,
        totalEte: 7200 + Math.random() * 1800,
        isPaused: false,
        latitude: 41.9742 + (Math.random() - 0.5) * 0.1,
        longitude: -87.9073 + (Math.random() - 0.5) * 0.1
    };
}

// Simulate autopilot data
function getMockAutopilotData() {
    return {
        master: Math.random() > 0.5,
        altitude: Math.random() > 0.5,
        heading: Math.random() > 0.5,
        vs: Math.random() > 0.5,
        speed: Math.random() > 0.5,
        approach: Math.random() > 0.5,
        nav: Math.random() > 0.5,
        backcourse: Math.random() > 0.5,
        throttle: Math.random() > 0.5,
        gear: Math.random() > 0.5,
        parkingBrake: Math.random() > 0.3,
        flaps: Math.random() * 100,
        spoilers: Math.random() * 100,
        navMode: Math.random() > 0.5
    };
}

wss.on('connection', (ws, req) => {
  console.log('New connection from:', req.socket.remoteAddress);
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'register_pc') {
        // PC registering with unique ID
        const uniqueId = data.uniqueId;
        const password = data.password;
        const guestPassword = data.guestPassword;
        
        ws.uniqueId = uniqueId;
        ws.clientType = 'pc';
        
        if (!sessions.has(uniqueId)) {
          sessions.set(uniqueId, {
            pcClient: ws,
            mobileClients: new Set(),
            password: password,
            guestPassword: guestPassword,
            flightDataInterval: null,
            autopilotInterval: null
          });
        } else {
          const session = sessions.get(uniqueId);
          session.pcClient = ws;
          session.password = password;
          session.guestPassword = guestPassword;
        }
        
        ws.send(JSON.stringify({ type: 'registered', uniqueId }));
        console.log(`PC registered: ${uniqueId}`);
        
        // Start sending mock data
        const session = sessions.get(uniqueId);
        
        // Send flight data every second
        session.flightDataInterval = setInterval(() => {
          if (session.pcClient && session.pcClient.readyState === WebSocket.OPEN) {
            session.mobileClients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: 'flight_data',
                  data: getMockFlightData()
                }));
              }
            });
          }
        }, 1000);
        
        // Send autopilot data every 2 seconds
        session.autopilotInterval = setInterval(() => {
          if (session.pcClient && session.pcClient.readyState === WebSocket.OPEN) {
            session.mobileClients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: 'autopilot_state',
                  data: getMockAutopilotData()
                }));
              }
            });
          }
        }, 2000);
      }
      
      else if (data.type === 'connect_mobile') {
        // Mobile connecting with unique ID
        const uniqueId = data.uniqueId;
        
        if (!sessions.has(uniqueId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid ID' }));
          return;
        }
        
        const session = sessions.get(uniqueId);
        ws.uniqueId = uniqueId;
        ws.clientType = 'mobile';
        ws.hasControlAccess = false;
        
        session.mobileClients.add(ws);
        
        ws.send(JSON.stringify({ 
          type: 'connected',
          pcOnline: !!session.pcClient
        }));
        
        console.log(`Mobile connected to: ${uniqueId}`);
      }
      
      else if (data.type === 'request_control') {
        // Mobile requesting control access
        const password = data.password;
        const session = sessions.get(ws.uniqueId);
        
        if (!session) {
          ws.send(JSON.stringify({ type: 'auth_failed' }));
          return;
        }
        
        if (password === session.password || password === session.guestPassword) {
          ws.hasControlAccess = true;
          ws.send(JSON.stringify({ type: 'control_granted' }));
        } else {
          ws.send(JSON.stringify({ type: 'auth_failed' }));
        }
      }
      
      else if (data.type === 'request_screenshot') {
        // Handle screenshot request
        const session = sessions.get(ws.uniqueId);
        if (!session || !ws.hasControlAccess) {
          ws.send(JSON.stringify({ 
            type: 'control_required',
            message: 'Enter password to access controls'
          }));
          return;
        }
        
        captureScreenshot()
          .then(base64Image => {
            // Send screenshot to the requesting mobile client
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'screenshot',
                image: base64Image
              }));
            }
          })
          .catch(error => {
            console.error('Screenshot capture failed:', error);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'screenshot_error',
                message: 'Failed to capture screenshot'
              }));
            }
          });
      }
      
      else {
        // Route all other messages
        const session = sessions.get(ws.uniqueId);
        if (!session) return;
        
        if (ws.clientType === 'mobile' && session.pcClient) {
          // Check if command requires control access
          if (data.type.includes('autopilot') || 
              data.type === 'pause_toggle' || 
              data.type === 'save_game' ||
              data.type === 'toggle_gear' ||
              data.type === 'toggle_speedbrake' ||
              data.type === 'toggle_parking_brake' ||
              data.type === 'change_flaps' ||
              data.type === 'throttle_control' ||
              data.type === 'view_change' ||
              data.type === 'camera_control') {
            if (!ws.hasControlAccess) {
              ws.send(JSON.stringify({ 
                type: 'control_required',
                message: 'Enter password to access controls'
              }));
              return;
            }
          }
          
          // Handle view changes and camera controls
          if (data.type === 'view_change') {
            console.log('📷 View change requested:', data.view);
            // Here you would integrate with SimConnect to change views
          } else if (data.type === 'camera_control') {
            console.log('🎥 Camera control:', data);
            // Here you would integrate with SimConnect for camera controls
          }
          
          // Forward to PC if it exists
          if (session.pcClient && session.pcClient.readyState === WebSocket.OPEN) {
            session.pcClient.send(JSON.stringify(data));
          }
        }
        else if (ws.clientType === 'pc') {
          // Broadcast to all mobile clients
          session.mobileClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(data));
            }
          });
        }
      }
      
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    if (ws.uniqueId && sessions.has(ws.uniqueId)) {
      const session = sessions.get(ws.uniqueId);
      
      if (ws.clientType === 'pc') {
        console.log(`PC disconnected: ${ws.uniqueId}`);
        session.pcClient = null;
        
        // Clear intervals
        if (session.flightDataInterval) {
          clearInterval(session.flightDataInterval);
        }
        if (session.autopilotInterval) {
          clearInterval(session.autopilotInterval);
        }
        
        // Notify mobile clients
        session.mobileClients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'pc_offline' }));
          }
        });
      }
      else if (ws.clientType === 'mobile') {
        session.mobileClients.delete(ws);
        console.log(`Mobile disconnected from: ${ws.uniqueId}`);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function getMobileAppHTML() {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset='UTF-8'>
    <meta name='viewport' content='width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'>
    <meta name="apple-mobile-web-app-capable" content="yes">
    <title>P3D Remote</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            background: #000000;
            color: white;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }
        .header {
            background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
            padding: 15px 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.5);
            border-bottom: 2px solid #167fac;
        }
        .header h1 { 
            font-size: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .status {
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: bold;
            margin-top: 5px;
            display: inline-block;
        }
        .status.connected { background: #167fac; color: #fff; }
        .status.offline { background: #f44336; color: white; }
        
        .login-screen {
            padding: 20px;
            max-width: 500px;
            margin: 40px auto;
        }
        .login-card {
            background: #1a1a1a;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            border: 1px solid #333;
        }
        .login-card h2 { margin-bottom: 20px; color: #167fac; }
        
        input {
            width: 100%;
            padding: 14px;
            background: #0d0d0d;
            border: 2px solid #333;
            border-radius: 8px;
            color: white;
            font-size: 15px;
            margin: 10px 0;
            -webkit-appearance: none;
        }
        input::placeholder { color: #666; }
        input:focus { outline: none; border-color: #167fac; }
        
        .btn {
            width: 100%;
            padding: 14px;
            border: none;
            border-radius: 10px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
            margin: 8px 0;
            transition: all 0.3s;
            -webkit-tap-highlight-color: transparent;
        }
        .btn-primary { background: #167fac; color: #fff; }
        .btn-primary:active { background: #1a8fc4; }
        .btn-secondary { background: #2d2d2d; color: white; border: 1px solid #444; }
        .btn-secondary:active { background: #3d3d3d; }
        .btn-warning { background: #ff9800; color: #000; }
        .btn-danger { background: #f44336; color: white; }
        .btn:disabled { background: #333; opacity: 0.5; }
        .btn.paused { 
            background: #ff9800; 
            color: #000;
            animation: pulse 1.5s infinite; 
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.8; transform: scale(0.98); }
        }
        
        .tabs {
            display: flex;
            background: #0d0d0d;
            border-bottom: 2px solid #333;
        }
        .tab {
            flex: 1;
            padding: 15px;
            text-align: center;
            cursor: pointer;
            border: none;
            background: transparent;
            color: #666;
            font-size: 13px;
            font-weight: bold;
            transition: all 0.3s;
            -webkit-tap-highlight-color: transparent;
        }
        .tab.active {
            color: #167fac;
            background: #1a1a1a;
            border-bottom: 3px solid #167fac;
        }
        
        .tab-content {
            display: none;
            padding: 15px;
        }
        .tab-content.active { display: block; }
        
        .card {
            background: #1a1a1a;
            border-radius: 12px;
            padding: 15px;
            margin-bottom: 15px;
            border: 1px solid #333;
        }
        
        .data-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        .data-item {
            background: #0d0d0d;
            padding: 12px;
            border-radius: 8px;
            text-align: center;
            border: 1px solid #222;
        }
        .data-label {
            font-size: 11px;
            color: #888;
            text-transform: uppercase;
            margin-bottom: 5px;
        }
        .data-value {
            font-size: 24px;
            font-weight: bold;
            color: #167fac;
        }
        
        #map {
            height: 400px;
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid #333;
        }
        
        .control-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px;
            background: #0d0d0d;
            border-radius: 8px;
            margin-bottom: 8px;
            border: 1px solid #222;
        }
        .control-label { font-size: 14px; color: #ccc; }
        .toggle-btn {
            padding: 6px 16px;
            border-radius: 20px;
            border: none;
            font-weight: bold;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.3s;
            -webkit-tap-highlight-color: transparent;
        }
        .toggle-btn.on { background: #167fac; color: #fff; }
        .toggle-btn.off { background: #333; color: #888; }
        
        .input-group {
            display: flex;
            gap: 8px;
            align-items: center;
            margin: 10px 0;
        }
        .input-group input {
            flex: 1;
            margin: 0;
        }
        .input-group .btn {
            width: auto;
            padding: 10px 20px;
            margin: 0;
        }
        
        .btn-group {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        
        .hidden { display: none !important; }
        
        .info-box {
            background: #2d2d2d;
            padding: 12px;
            border-radius: 8px;
            margin: 10px 0;
            font-size: 13px;
            color: #ccc;
            border: 1px solid #444;
        }
        
        h3 {
            color: #167fac;
            margin-bottom: 15px;
        }
        
        /* View Tab Styles */
        #simulatorView {
            width: 100%;
            height: 300px;
            background: #000;
            border-radius: 12px;
            border: 1px solid #333;
            position: relative;
            overflow: hidden;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        #simulatorImage {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            image-rendering: pixelated;
            image-rendering: -moz-crisp-edges;
            image-rendering: crisp-edges;
        }
        
        .view-placeholder {
            color: #666;
            font-size: 14px;
            text-align: center;
        }
        
        .view-controls {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
            margin-bottom: 15px;
        }
        
        .view-btn {
            padding: 12px;
            background: #2d2d2d;
            border: 1px solid #444;
            border-radius: 8px;
            color: #ccc;
            font-size: 12px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.3s;
            text-align: center;
            -webkit-tap-highlight-color: transparent;
        }
        
        .view-btn:hover {
            background: #3d3d3d;
            border-color: #167fac;
        }
        
        .view-btn.active {
            background: #167fac;
            color: #fff;
            border-color: #167fac;
        }
        
        .camera-controls {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
            margin-top: 10px;
        }
        
        .camera-btn {
            padding: 15px;
            background: #2d2d2d;
            border: 1px solid #444;
            border-radius: 8px;
            color: #ccc;
            font-size: 18px;
            cursor: pointer;
            transition: all 0.3s;
            display: flex;
            align-items: center;
            justify-content: center;
            -webkit-tap-highlight-color: transparent;
        }
        
        .camera-btn:hover {
            background: #3d3d3d;
            border-color: #167fac;
        }
        
        .camera-btn:active {
            background: #167fac;
            color: #fff;
        }
        
        .camera-btn.center {
            grid-column: 2;
        }
        
        .view-info {
            text-align: center;
            padding: 8px;
            background: #0d0d0d;
            border-radius: 8px;
            margin-bottom: 10px;
            font-size: 12px;
            color: #888;
        }
        
        @media (max-width: 480px) {
            .header h1 { font-size: 18px; }
            .tabs { font-size: 12px; }
            .data-value { font-size: 20px; }
        }
    </style>
</head>
<body>
    <div class='header'>
        <h1>✈️ Prepar3D Remote</h1>
        <div id='statusBadge' class='status offline'>Offline</div>
    </div>

    <div id='loginScreen' class='login-screen'>
        <div class='login-card'>
            <h2>Connect to Simulator</h2>
            <div class='info-box'>
                Enter your Unique ID from the PC Server
            </div>
            <input type='text' id='uniqueId' placeholder='Unique ID' autocapitalize='off' autocomplete='off'>
            <button class='btn btn-primary' onclick='connectToSim()'>Connect</button>
        </div>
    </div>

    <div id='mainApp' class='hidden'>
        <div class='tabs'>
            <button class='tab active' onclick='switchTab(0)'>Flight</button>
            <button class='tab' onclick='switchTab(1)'>Map</button>
            <button class='tab' onclick='switchTab(2)'>View</button>
            <button class='tab' onclick='switchTab(3)'>Autopilot</button>
        </div>

        <div class='tab-content active'>
            <div class='card'>
                <div class='data-label'>Next Waypoint</div>
                <div class='data-value' style='font-size: 18px;' id='nextWaypoint'>--</div>
                <div style='margin-top: 8px; color: #888; font-size: 13px;' id='wpDistance'>Distance: --</div>
                <div style='color: #888; font-size: 13px;' id='wpEte'>ETE: --</div>
            </div>

            <div class='card'>
                <div class='data-label'>Total Distance to Destination</div>
                <div class='data-value'><span id='totalDistance'>--</span> nm</div>
                <div style='margin-top: 8px; color: #888; font-size: 13px;' id='totalEte'>Total ETE: --</div>
            </div>

            <div class='card'>
                <div class='data-grid'>
                    <div class='data-item'>
                        <div class='data-label'>Speed</div>
                        <div class='data-value' id='speed'>--</div>
                        <div style='font-size: 11px; color: #888;'>knots</div>
                    </div>
                    <div class='data-item'>
                        <div class='data-label'>Altitude</div>
                        <div class='data-value' id='altitude'>--</div>
                        <div style='font-size: 11px; color: #888;'>feet</div>
                    </div>
                    <div class='data-item'>
                        <div class='data-label'>Heading</div>
                        <div class='data-value' id='heading'>--</div>
                        <div style='font-size: 11px; color: #888;'>degrees</div>
                    </div>
                    <div class='data-item'>
                        <div class='data-label'>V/S</div>
                        <div class='data-value' id='vs'>--</div>
                        <div style='font-size: 11px; color: #888;'>fpm</div>
                    </div>
                </div>
            </div>
        </div>

        <div class='tab-content'>
            <div class='card'>
                <div id='map'></div>
            </div>
        </div>

        <div class='tab-content'>
            <div class='card'>
                <div class='view-info' id='viewInfo'>Current View: Cockpit</div>
                <div id='simulatorView'>
                    <div id='simulatorImageContainer'>
                        <div class='view-placeholder'>📸 Waiting for simulator view...</div>
                    </div>
                    <img id='simulatorImage' style='display:none;' alt='Simulator View'>
                </div>
                <button class='btn btn-secondary' onclick='requestScreenshot()' style='margin-top: 10px;'>🔄 Refresh View</button>
            </div>
            
            <div class='card'>
                <h3>View Selection</h3>
                <div class='view-controls'>
                    <button class='view-btn active' onclick='changeView("cockpit")'>Cockpit</button>
                    <button class='view-btn' onclick='changeView("virtual_cockpit")'>Virtual Cockpit</button>
                    <button class='view-btn' onclick='changeView("spot")'>Spot</button>
                    <button class='view-btn' onclick='changeView("external")'>External</button>
                    <button class='view-btn' onclick='changeView("tower")'>Tower</button>
                    <button class='view-btn' onclick='changeView("follow")'>Follow</button>
                </div>
            </div>
            
            <div class='card'>
                <h3>Camera Movement</h3>
                <div class='camera-controls'>
                    <button class='camera-btn' ontouchstart='cameraMove("up")' ontouchend='stopCameraMove()' onmousedown='cameraMove("up")' onmouseup='stopCameraMove()' onmouseleave='stopCameraMove()'>↑</button>
                    <button class='camera-btn center' ontouchstart='cameraMove("forward")' ontouchend='stopCameraMove()' onmousedown='cameraMove("forward")' onmouseup='stopCameraMove()' onmouseleave='stopCameraMove()'>⬆</button>
                    <button class='camera-btn' ontouchstart='cameraMove("down")' ontouchend='stopCameraMove()' onmousedown='cameraMove("down")' onmouseup='stopCameraMove()' onmouseleave='stopCameraMove()'>↓</button>
                    <button class='camera-btn' ontouchstart='cameraMove("left")' ontouchend='stopCameraMove()' onmousedown='cameraMove("left")' onmouseup='stopCameraMove()' onmouseleave='stopCameraMove()'>←</button>
                    <button class='camera-btn center' ontouchstart='cameraMove("reset")' ontouchend='stopCameraMove()' onmousedown='cameraMove("reset")' onmouseup='stopCameraMove()' onmouseleave='stopCameraMove()'>⟲</button>
                    <button class='camera-btn' ontouchstart='cameraMove("right")' ontouchend='stopCameraMove()' onmousedown='cameraMove("right")' onmouseup='stopCameraMove()' onmouseleave='stopCameraMove()'>→</button>
                    <button class='camera-btn' ontouchstart='cameraMove("zoom_in")' ontouchend='stopCameraMove()' onmousedown='cameraMove("zoom_in")' onmouseup='stopCameraMove()' onmouseleave='stopCameraMove()'>+</button>
                    <button class='camera-btn center' ontouchstart='cameraMove("backward")' ontouchend='stopCameraMove()' onmousedown='cameraMove("backward")' onmouseup='stopCameraMove()' onmouseleave='stopCameraMove()'>⬇</button>
                    <button class='camera-btn' ontouchstart='cameraMove("zoom_out")' ontouchend='stopCameraMove()' onmousedown='cameraMove("zoom_out")' onmouseup='stopCameraMove()' onmouseleave='stopCameraMove()'>-</button>
                </div>
            </div>
        </div>

        <div class='tab-content'>
            <div id='controlLock' class='card'>
                <div class='info-box'>🔒 Enter password to access controls</div>
                <input type='password' id='controlPassword' placeholder='Password'>
                <button class='btn btn-primary' onclick='unlockControls()'>Unlock Controls</button>
            </div>
            
            <div id='controlPanel' class='hidden'>
                <div class='card'>
                    <div class='btn-group'>
                        <button class='btn btn-secondary' id='btnPause' onclick='togglePause()'>⏸️ Pause</button>
                        <button class='btn btn-primary' onclick='saveGame()'>💾 Save Flight</button>
                    </div>
                </div>
                
                <div class='card'>
                    <h3>Autopilot</h3>
                    
                    <div class='control-row'>
                        <span class='control-label'>Master</span>
                        <button class='toggle-btn off' id='apMaster' onclick='toggleAP("master")'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Altitude Hold</span>
                        <button class='toggle-btn off' id='apAlt' onclick='toggleAP("altitude")'>OFF</button>
                    </div>
                    <div class='input-group'>
                        <input type='number' id='targetAlt' placeholder='Target Altitude (ft)'>
                        <button class='btn btn-primary' onclick='setAltitude()'>Set</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>V/S Hold</span>
                        <button class='toggle-btn off' id='apVS' onclick='toggleAP("vs")'>OFF</button>
                    </div>
                    <div class='input-group'>
                        <input type='number' id='targetVS' placeholder='Vertical Speed (fpm)'>
                        <button class='btn btn-primary' onclick='setVS()'>Set</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Airspeed Hold</span>
                        <button class='toggle-btn off' id='apSpeed' onclick='toggleAP("speed")'>OFF</button>
                    </div>
                    <div class='input-group'>
                        <input type='number' id='targetSpeed' placeholder='Target Speed (kts)'>
                        <button class='btn btn-primary' onclick='setSpeed()'>Set</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Heading Hold</span>
                        <button class='toggle-btn off' id='apHdg' onclick='toggleAP("heading")'>OFF</button>
                    </div>
                    <div class='input-group'>
                        <input type='number' id='targetHdg' placeholder='Heading (deg)'>
                        <button class='btn btn-primary' onclick='setHeading()'>Set</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>NAV/GPS Mode</span>
                        <button class='toggle-btn off' id='navMode' onclick='toggleNavMode()'>GPS</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>LOC Hold</span>
                        <button class='toggle-btn off' id='apNav' onclick='toggleAP("nav")'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Approach</span>
                        <button class='toggle-btn off' id='apApp' onclick='toggleAP("approach")'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>ILS/Backcourse</span>
                        <button class='toggle-btn off' id='apBackcourse' onclick='toggleAP("backcourse")'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Auto Throttle</span>
                        <button class='toggle-btn off' id='autoThrottle' onclick='toggleAP("throttle")'>OFF</button>
                    </div>
                </div>
                
                <div class='card'>
                    <h3>Aircraft</h3>
                    
                    <div class='control-row'>
                        <span class='control-label'>Landing Gear</span>
                        <button class='toggle-btn off' id='gear' onclick='toggleGear()'>UP</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Flaps</span>
                        <div>
                            <button class='btn btn-secondary' style='width:auto; padding:8px 16px; margin:0 5px;' onclick='changeFlaps(-1)'>-</button>
                            <span id='flapsPos' style='display:inline-block; width:60px; text-align:center;'>0%</span>
                            <button class='btn btn-secondary' style='width:auto; padding:8px 16px; margin:0 5px;' onclick='changeFlaps(1)'>+</button>
                        </div>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Speedbrakes</span>
                        <button class='toggle-btn off' id='spoilers' onclick='toggleSpoilers()'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Parking Brake</span>
                        <button class='toggle-btn off' id='parkingBrake' onclick='toggleParkingBrake()'>OFF</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let ws = null;
        let map = null;
        let aircraftMarker = null;
        let uniqueId = null;
        let hasControl = false;
        let isPaused = false;
        let currentView = 'cockpit';
        let cameraInterval = null;
        let lastScreenshotTime = 0;
        let reconnectInterval = null;

        function switchTab(index) {
            document.querySelectorAll('.tab').forEach((tab, i) => {
                tab.classList.toggle('active', i === index);
            });
            document.querySelectorAll('.tab-content').forEach((content, i) => {
                content.classList.toggle('active', i === index);
            });
            
            if (index === 1 && !map) {
                setTimeout(initMap, 100);
            }
            
            // Request screenshot when switching to view tab
            if (index === 2 && ws && ws.readyState === WebSocket.OPEN) {
                requestScreenshot();
            }
        }

        function connectToSim() {
            uniqueId = document.getElementById('uniqueId').value.trim();
            if (!uniqueId) {
                alert('Please enter your Unique ID');
                return;
            }
            
            localStorage.setItem('p3d_unique_id', uniqueId);
            
            // Clear any existing reconnect interval
            if (reconnectInterval) {
                clearInterval(reconnectInterval);
                reconnectInterval = null;
            }
            
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + window.location.host);
            
            ws.onopen = () => {
                console.log('Connected to server');
                ws.send(JSON.stringify({ 
                    type: 'connect_mobile',
                    uniqueId: uniqueId
                }));
            };

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                handleMessage(data);
            };

            ws.onclose = () => {
                console.log('Disconnected from server');
                updateStatus('offline');
                
                // Try to reconnect every 3 seconds
                reconnectInterval = setInterval(() => {
                    if (ws && ws.readyState === WebSocket.CLOSED) {
                        console.log('Attempting to reconnect...');
                        connectToSim();
                    }
                }, 3000);
            };

            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
        }

        function handleMessage(data) {
            switch(data.type) {
                case 'connected':
                    document.getElementById('loginScreen').classList.add('hidden');
                    document.getElementById('mainApp').classList.remove('hidden');
                    updateStatus(data.pcOnline ? 'connected' : 'offline');
                    
                    // Clear reconnect interval on successful connection
                    if (reconnectInterval) {
                        clearInterval(reconnectInterval);
                        reconnectInterval = null;
                    }
                    break;
                    
                case 'error':
                    alert(data.message);
                    break;
                    
                case 'control_granted':
                    hasControl = true;
                    document.getElementById('controlLock').classList.add('hidden');
                    document.getElementById('controlPanel').classList.remove('hidden');
                    break;
                    
                case 'auth_failed':
                    alert('Wrong password!');
                    break;
                    
                case 'control_required':
                    if (document.getElementById('controlLock').classList.contains('hidden')) {
                        alert(data.message);
                    }
                    break;
                    
                case 'flight_data':
                    updateFlightData(data.data);
                    break;
                    
                case 'autopilot_state':
                    updateAutopilotUI(data.data);
                    break;
                    
                case 'screenshot':
                    updateSimulatorView(data.image);
                    break;
                    
                case 'screenshot_error':
                    updateSimulatorView(null);
                    document.getElementById('simulatorImageContainer').innerHTML = '<div class="view-placeholder">❌ Failed to capture screenshot</div>';
                    break;
                    
                case 'pc_offline':
                    updateStatus('offline');
                    break;
            }
        }

        function updateStatus(status) {
            const badge = document.getElementById('statusBadge');
            badge.className = 'status ' + status;
            badge.textContent = status === 'connected' ? 'Connected' : 'Offline';
        }

        function updateFlightData(data) {
            document.getElementById('speed').textContent = Math.round(data.groundSpeed);
            document.getElementById('altitude').textContent = Math.round(data.altitude).toLocaleString();
            document.getElementById('heading').textContent = Math.round(data.heading) + '°';
            document.getElementById('vs').textContent = Math.round(data.verticalSpeed);
            
            // Next waypoint info
            document.getElementById('nextWaypoint').textContent = data.nextWaypoint || 'No Active Waypoint';
            document.getElementById('wpDistance').textContent = 'Distance: ' + (data.distanceToWaypoint ? data.distanceToWaypoint.toFixed(1) + ' nm' : '--');
            
            if (data.waypointEte && data.waypointEte > 0) {
                const wpMinutes = Math.floor(data.waypointEte / 60);
                const wpSeconds = Math.floor(data.waypointEte % 60);
                document.getElementById('wpEte').textContent = 'ETE: ' + wpMinutes + 'm ' + wpSeconds + 's';
            } else {
                document.getElementById('wpEte').textContent = 'ETE: --';
            }
            
            // Total distance to destination
            if (data.totalDistance && data.totalDistance > 0) {
                document.getElementById('totalDistance').textContent = data.totalDistance.toFixed(1);
            } else {
                document.getElementById('totalDistance').textContent = '--';
            }
            
            // Total ETE
            if (data.totalEte && data.totalEte > 0) {
                const hours = Math.floor(data.totalEte / 3600);
                const minutes = Math.floor((data.totalEte % 3600) / 60);
                document.getElementById('totalEte').textContent = 'Total ETE: ' + (hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'm');
            } else {
                document.getElementById('totalEte').textContent = 'Total ETE: --';
            }

            isPaused = data.isPaused;
            const btnPause = document.getElementById('btnPause');
            if (data.isPaused) {
                btnPause.textContent = '▶️ PAUSED - Resume';
                btnPause.className = 'btn btn-warning paused';
            } else {
                btnPause.textContent = '⏸️ Pause';
                btnPause.className = 'btn btn-secondary';
            }

            if (map && data.latitude && data.longitude) {
                updateMap(data.latitude, data.longitude, data.heading);
            }
        }

        function updateAutopilotUI(data) {
            updateToggle('apMaster', data.master);
            updateToggle('apAlt', data.altitude);
            updateToggle('apHdg', data.heading);
            updateToggle('apVS', data.vs);
            updateToggle('apSpeed', data.speed);
            updateToggle('apApp', data.approach);
            updateToggle('apNav', data.nav);
            updateToggle('apBackcourse', data.backcourse);
            updateToggle('autoThrottle', data.throttle);
            updateToggle('gear', data.gear, data.gear ? 'DOWN' : 'UP');
            updateToggle('parkingBrake', data.parkingBrake, data.parkingBrake ? 'SET' : 'OFF');
            
            document.getElementById('flapsPos').textContent = Math.round(data.flaps) + '%';
            
            // Spoilers
            const spoilersBtn = document.getElementById('spoilers');
            const spoilersActive = data.spoilers > 10;
            spoilersBtn.className = 'toggle-btn ' + (spoilersActive ? 'on' : 'off');
            spoilersBtn.textContent = spoilersActive ? 'DEPLOYED' : 'RETRACTED';
            
            // NAV/GPS toggle
            const navBtn = document.getElementById('navMode');
            navBtn.textContent = data.navMode ? 'GPS' : 'NAV';
            navBtn.className = 'toggle-btn ' + (data.navMode ? 'on' : 'off');
        }

        function updateToggle(id, state, text) {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.className = 'toggle-btn ' + (state ? 'on' : 'off');
            btn.textContent = text || (state ? 'ON' : 'OFF');
        }

        function initMap() {
            map = L.map('map').setView([0, 0], 8);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap'
            }).addTo(map);
            
            aircraftMarker = L.marker([0, 0], {
                icon: createPlaneIcon(0)
            }).addTo(map);
        }

        function createPlaneIcon(heading) {
            return L.divIcon({
                html: '<div style="font-size:32px;transform:rotate(' + heading + 'deg);filter:drop-shadow(0 2px 4px rgba(0,0,0,0.8));">✈️</div>',
                className: '',
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            });
        }

        function updateMap(lat, lon, heading) {
            if (!map) return;
            
            const icon = L.divIcon({
                html: '<div style="font-size:32px;transform:rotate(' + heading + 'deg);filter:drop-shadow(0 2px 4px rgba(0,0,0,0.8));">✈️</div>',
                className: '',
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            });
            
            aircraftMarker.setLatLng([lat, lon]);
            aircraftMarker.setIcon(icon);
            map.setView([lat, lon], map.getZoom());
        }

        // View Tab Functions
        function requestScreenshot() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                document.getElementById('simulatorImageContainer').innerHTML = '<div class="view-placeholder">📸 Capturing screenshot...</div>';
                ws.send(JSON.stringify({ type: 'request_screenshot' }));
            }
        }

        function updateSimulatorView(imageData) {
            const img = document.getElementById('simulatorImage');
            const container = document.getElementById('simulatorImageContainer');
            
            if (imageData) {
                img.src = 'data:image/png;base64,' + imageData;
                img.style.display = 'block';
                container.style.display = 'none';
                lastScreenshotTime = Date.now();
                
                // Add loading indicator
                img.onload = () => {
                    console.log('✅ Screenshot loaded');
                };
                img.onerror = () => {
                    console.log('❌ Failed to load screenshot');
                    container.style.display = 'block';
                    container.innerHTML = '<div class="view-placeholder">❌ Failed to load image</div>';
                };
            } else {
                img.style.display = 'none';
                container.style.display = 'block';
                container.innerHTML = '<div class="view-placeholder">📸 No screenshot available</div>';
            }
        }

        function changeView(viewType) {
            currentView = viewType;
            
            // Update active button
            document.querySelectorAll('.view-btn').forEach(btn => {
                btn.classList.remove('active');
            });
            event.target.classList.add('active');
            
            // Update view info
            const viewNames = {
                'cockpit': 'Cockpit',
                'virtual_cockpit': 'Virtual Cockpit',
                'spot': 'Spot',
                'external': 'External',
                'tower': 'Tower',
                'follow': 'Follow'
            };
            document.getElementById('viewInfo').textContent = 'Current View: ' + viewNames[viewType];
            
            // Send view change command
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                    type: 'view_change',
                    view: viewType
                }));
            }
            
            // Request screenshot after view change
            setTimeout(requestScreenshot, 500);
        }

        function cameraMove(direction) {
            if (cameraInterval) return;
            
            // Send initial camera movement
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                    type: 'camera_control',
                    action: 'start',
                    direction: direction
                }));
            }
            
            // Continue sending camera movement while held
            cameraInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ 
                        type: 'camera_control',
                        action: 'continue',
                        direction: direction
                    }));
                }
            }, 100);
        }

        function stopCameraMove() {
            if (cameraInterval) {
                clearInterval(cameraInterval);
                cameraInterval = null;
                
                // Send stop camera movement
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ 
                        type: 'camera_control',
                        action: 'stop'
                    }));
                }
                
                // Request screenshot after camera movement
                setTimeout(requestScreenshot, 300);
            }
        }

        function unlockControls() {
            const password = document.getElementById('controlPassword').value;
            ws.send(JSON.stringify({ type: 'request_control', password }));
        }

        function togglePause() {
            ws.send(JSON.stringify({ type: 'pause_toggle' }));
        }

        function saveGame() {
            ws.send(JSON.stringify({ type: 'save_game' }));
            alert('Flight saved!');
        }

        function toggleAP(system) {
            if (system === 'nav') {
                ws.send(JSON.stringify({ type: 'autopilot_toggle_loc' }));
            } else if (system === 'approach') {
                ws.send(JSON.stringify({ type: 'autopilot_toggle_ils' }));
            } else {
                ws.send(JSON.stringify({ type: 'autopilot_toggle', system }));
            }
        }

        function setAltitude() {
            const alt = parseInt(document.getElementById('targetAlt').value);
            if (!isNaN(alt)) {
                ws.send(JSON.stringify({ type: 'autopilot_set', param: 'altitude', value: alt }));
                document.getElementById('targetAlt').value = '';
            }
        }

        function setHeading() {
            const hdg = parseInt(document.getElementById('targetHdg').value);
            if (!isNaN(hdg)) {
                ws.send(JSON.stringify({ type: 'autopilot_set', param: 'heading', value: hdg }));
                document.getElementById('targetHdg').value = '';
            }
        }

        function setVS() {
            const vs = parseInt(document.getElementById('targetVS').value);
            if (!isNaN(vs)) {
                ws.send(JSON.stringify({ type: 'autopilot_set', param: 'vs', value: vs }));
                document.getElementById('targetVS').value = '';
            }
        }

        function setSpeed() {
            const speed = parseInt(document.getElementById('targetSpeed').value);
            if (!isNaN(speed)) {
                ws.send(JSON.stringify({ type: 'autopilot_set', param: 'speed', value: speed }));
                document.getElementById('targetSpeed').value = '';
            }
        }

        function toggleNavMode() {
            ws.send(JSON.stringify({ type: 'toggle_nav_mode' }));
        }

        function toggleGear() {
            ws.send(JSON.stringify({ type: 'toggle_gear' }));
        }

        function toggleSpoilers() {
            ws.send(JSON.stringify({ type: 'toggle_speedbrake' }));
        }

        function toggleParkingBrake() {
            ws.send(JSON.stringify({ type: 'toggle_parking_brake' }));
        }

        function changeFlaps(direction) {
            ws.send(JSON.stringify({ type: 'change_flaps', direction }));
        }

        // Auto-refresh screenshot when on view tab
        setInterval(() => {
            if (document.querySelector('.tab:nth-child(3)').classList.contains('active') && 
                ws && ws.readyState === WebSocket.OPEN &&
                Date.now() - lastScreenshotTime > 5000) {
                requestScreenshot();
            }
        }, 5000);

        // Load saved ID and auto-connect
        window.onload = () => {
            const savedId = localStorage.getItem('p3d_unique_id');
            if (savedId) {
                document.getElementById('uniqueId').value = savedId;
                // Auto-connect if ID is saved
                setTimeout(() => connectToSim(), 500);
            }
        };

        // Handle page visibility change
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && ws && ws.readyState === WebSocket.OPEN) {
                // Request data when page becomes visible
                if (document.querySelector('.tab:nth-child(3)').classList.contains('active')) {
                    requestScreenshot();
                }
            }
        });
    </script>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`🚀 P3D Remote Cloud Relay running on port ${PORT}`);
  console.log(`📱 Access at: http://localhost:${PORT}`);
  console.log(`💡 Use any ID to connect - the server will simulate flight data`);
  console.log(`📸 Screenshot capture is built-in - just unlock controls to use it`);
});
