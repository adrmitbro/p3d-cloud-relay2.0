const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Simple session storage: uniqueId -> { pcClient, mobileClients: Set(), password, guestPassword }
const sessions = new Map();

app.use(express.static('public'));

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    activeSessions: sessions.size
  });
});

app.get('/', (req, res) => {
  res.send(getMobileAppHTML());
});

wss.on('connection', (ws, req) => {
  console.log('New connection established');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received message type:', data.type, 'from', ws.clientType || 'unknown');
      
      if (data.type === 'register_pc') {
        // PC registering with unique ID
        const uniqueId = data.uniqueId;
        const password = data.password;
        const guestPassword = data.guestPassword;
        
        console.log(`PC registration attempt for ID: ${uniqueId}`);
        
        // Check if uniqueId is already taken by another PC client
        if (sessions.has(uniqueId)) {
          const session = sessions.get(uniqueId);
          if (session.pcClient && session.pcClient !== ws && session.pcClient.readyState === WebSocket.OPEN) {
            console.log(`ID ${uniqueId} already in use by another client`);
            ws.send(JSON.stringify({ type: 'error', message: 'ID already in use by another client' }));
            return;
          }
        }
        
        // Store client info
        ws.uniqueId = uniqueId;
        ws.clientType = 'pc';
        
        // Create or update session
        if (!sessions.has(uniqueId)) {
          sessions.set(uniqueId, {
            pcClient: ws,
            mobileClients: new Set(),
            password: password,
            guestPassword: guestPassword
          });
          console.log(`Created new session for ${uniqueId}`);
        } else {
          const session = sessions.get(uniqueId);
          session.pcClient = ws;
          session.password = password;
          session.guestPassword = guestPassword;
          console.log(`Updated existing session for ${uniqueId}`);
        }
        
        // Send confirmation to PC
        ws.send(JSON.stringify({ 
          type: 'registered', 
          uniqueId: uniqueId,
          message: 'Successfully registered'
        }));
        
        console.log(`PC registered successfully: ${uniqueId}`);
        
        // Notify mobile clients that PC is online
        const session = sessions.get(uniqueId);
        session.mobileClients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'pc_online' }));
          }
        });
      }
      
      else if (data.type === 'connect_mobile') {
        // Mobile connecting with unique ID
        const uniqueId = data.uniqueId;
        
        console.log(`Mobile connection attempt for ID: ${uniqueId}`);
        
        if (!sessions.has(uniqueId)) {
          console.log(`No session found for ID: ${uniqueId}`);
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
          pcOnline: !!session.pcClient && session.pcClient.readyState === WebSocket.OPEN
        }));
        
        console.log(`Mobile connected to: ${uniqueId}`);
      }
      
      else if (data.type === 'request_control') {
        // Mobile requesting control access
        const password = data.password;
        const session = sessions.get(ws.uniqueId);
        
        if (!session) {
          ws.send(JSON.stringify({ type: 'auth_failed', message: 'Session not found' }));
          return;
        }
        
        if (password === session.password || password === session.guestPassword) {
          ws.hasControlAccess = true;
          ws.send(JSON.stringify({ type: 'control_granted', message: 'Access granted' }));
          console.log(`Control granted to mobile client for ${ws.uniqueId}`);
        } else {
          ws.send(JSON.stringify({ type: 'auth_failed', message: 'Invalid password' }));
          console.log(`Auth failed for mobile client for ${ws.uniqueId}`);
        }
      }
      
      else {
        // Route all other messages
        const session = sessions.get(ws.uniqueId);
        if (!session) {
          console.log(`No session found for message routing from ${ws.uniqueId}`);
          return;
        }
        
        if (ws.clientType === 'mobile' && session.pcClient) {
          // Check if command requires control access
          const requiresControl = data.type.includes('autopilot') || 
                                 data.type === 'pause_toggle' || 
                                 data.type === 'save_game' ||
                                 data.type.includes('throttle') ||
                                 data.type.includes('engine') ||
                                 data.type === 'toggle_parking_brake' ||
                                 data.type === 'toggle_speedbrake' ||
                                 data.type === 'set_speedbrake' ||
                                 data.type === 'toggle_gear' ||
                                 data.type === 'change_flaps';
          
          if (requiresControl && !ws.hasControlAccess) {
            ws.send(JSON.stringify({ 
              type: 'control_required',
              message: 'Enter password to access controls'
            }));
            return;
          }
          
          // Forward to PC
          if (session.pcClient.readyState === WebSocket.OPEN) {
            session.pcClient.send(JSON.stringify(data));
            console.log(`Forwarded message from mobile to PC for ${ws.uniqueId}`);
          } else {
            console.log(`PC client not available for ${ws.uniqueId}`);
            ws.send(JSON.stringify({ type: 'error', message: 'PC client not available' }));
          }
        }
        else if (ws.clientType === 'pc') {
          // Broadcast to all mobile clients
          let mobileCount = 0;
          session.mobileClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(data));
              mobileCount++;
            }
          });
          console.log(`Broadcasted message from PC to ${mobileCount} mobile clients for ${ws.uniqueId}`);
        }
      }
      
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log(`Connection closed for ${ws.clientType} client with ID: ${ws.uniqueId || 'unknown'}`);
    
    if (ws.uniqueId && sessions.has(ws.uniqueId)) {
      const session = sessions.get(ws.uniqueId);
      
      if (ws.clientType === 'pc') {
        console.log(`PC disconnected: ${ws.uniqueId}`);
        session.pcClient = null;
        
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
    console.error(`WebSocket error for ${ws.clientType} client:`, error);
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
            font-family: 'Segoe UI', Arial, sans-serif;
            background: #003057;
            color: white;
        }
        .header {
            background: linear-gradient(135deg, #003057 0%, #005a9c 100%);
            padding: 15px 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        }
        .header h1 { 
            font-size: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .logo { font-size: 24px; }
        .status {
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: bold;
            margin-top: 5px;
            display: inline-block;
        }
        .status.connected { background: #00c853; }
        .status.offline { background: #f44336; }
        
        .login-screen {
            padding: 20px;
            max-width: 500px;
            margin: 40px auto;
        }
        .login-card {
            background: #004d7a;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        }
        .login-card h2 { margin-bottom: 20px; color: #fff; }
        
        input {
            width: 100%;
            padding: 14px;
            background: #003057;
            border: 2px solid #005a9c;
            border-radius: 8px;
            color: white;
            font-size: 15px;
            margin: 10px 0;
        }
        input::placeholder { color: #7ab8e8; }
        
        .btn {
            width: 100%;
            padding: 14px;
            border: none;
            border-radius: 10px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
            margin: 8px 0;
        }
        .btn-primary { background: #00c853; color: white; }
        .btn-secondary { background: #005a9c; color: white; }
        .btn-danger { background: #f44336; color: white; }
        .btn:disabled { background: #555; opacity: 0.5; }
        .btn.paused { background: #ff9800; }
        
        .tabs {
            display: flex;
            background: #003057;
            border-bottom: 2px solid #005a9c;
        }
        .tab {
            flex: 1;
            padding: 15px;
            text-align: center;
            cursor: pointer;
            border: none;
            background: transparent;
            color: #7ab8e8;
            font-size: 14px;
            font-weight: bold;
        }
        .tab.active {
            color: white;
            background: #004d7a;
            border-bottom: 3px solid #00c853;
        }
        
        .tab-content {
            display: none;
            padding: 15px;
        }
        .tab-content.active { display: block; }
        
        .card {
            background: #004d7a;
            border-radius: 12px;
            padding: 15px;
            margin-bottom: 15px;
        }
        
        .data-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        .data-item {
            background: #003057;
            padding: 12px;
            border-radius: 8px;
            text-align: center;
        }
        .data-label {
            font-size: 11px;
            color: #7ab8e8;
            text-transform: uppercase;
            margin-bottom: 5px;
        }
        .data-value {
            font-size: 24px;
            font-weight: bold;
            color: #00c853;
        }
        
        #map {
            height: 400px;
            border-radius: 12px;
            overflow: hidden;
        }
        
        .control-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px;
            background: #003057;
            border-radius: 8px;
            margin-bottom: 8px;
        }
        .control-label { font-size: 14px; }
        .toggle-btn {
            padding: 6px 16px;
            border-radius: 20px;
            border: none;
            font-weight: bold;
            cursor: pointer;
            font-size: 12px;
        }
        .toggle-btn.on { background: #00c853; color: white; }
        .toggle-btn.off { background: #555; color: #999; }
        
        .hidden { display: none !important; }
        
        .info-box {
            background: #005a9c;
            padding: 12px;
            border-radius: 8px;
            margin: 10px 0;
            font-size: 13px;
        }
        
        .waypoint-info {
            background: #003057;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 10px;
        }
        
        .waypoint-name {
            font-size: 16px;
            font-weight: bold;
            color: #00c853;
            margin-bottom: 5px;
        }
        
        .waypoint-details {
            display: flex;
            justify-content: space-between;
            font-size: 13px;
            color: #7ab8e8;
        }
        
        .slider-container {
            margin: 10px 0;
        }
        
        .slider {
            width: 100%;
            height: 6px;
            border-radius: 3px;
            background: #003057;
            outline: none;
            -webkit-appearance: none;
        }
        
        .slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            background: #00c853;
            cursor: pointer;
        }
        
        .slider::-moz-range-thumb {
            width: 20px;
            height: 20px;
            border-radius: 50%;
            background: #00c853;
            cursor: pointer;
        }
        
        .engine-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        
        .engine-control {
            background: #003057;
            padding: 10px;
            border-radius: 8px;
            text-align: center;
        }
        
        .engine-label {
            font-size: 12px;
            color: #7ab8e8;
            margin-bottom: 5px;
        }
        
        .engine-status {
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 5px;
        }
        
        .engine-status.on {
            color: #00c853;
        }
        
        .engine-status.off {
            color: #f44336;
        }
    </style>
</head>
<body>
    <div class='header'>
        <h1><span class='logo'>✈️</span> Prepar3D Remote</h1>
        <div id='statusBadge' class='status offline'>Offline</div>
    </div>

    <div id='loginScreen' class='login-screen'>
        <div class='login-card'>
            <h2>Connect to Simulator</h2>
            <div class='info-box'>
                Enter your Unique ID from PC Server
            </div>
            <input type='text' id='uniqueId' placeholder='Unique ID' autocapitalize='off'>
            <button class='btn btn-primary' onclick='connectToSim()'>Connect</button>
        </div>
    </div>

    <div id='mainApp' class='hidden'>
        <div class='tabs'>
            <button class='tab active' onclick='switchTab(0)'>Flight</button>
            <button class='tab' onclick='switchTab(1)'>Map</button>
            <button class='tab' onclick='switchTab(2)'>Autopilot</button>
            <button class='tab' onclick='switchTab(3)'>Aircraft</button>
        </div>

        <div class='tab-content active'>
            <div class='waypoint-info'>
                <div class='waypoint-name' id='nextWaypoint'>--</div>
                <div class='waypoint-details'>
                    <span>Distance: <span id='waypointDistance'>--</span> nm</span>
                    <span>Bearing: <span id='waypointBearing'>--</span>°</span>
                </div>
            </div>
            
            <div class='card'>
                <div class='data-label'>Distance to Destination</div>
                <div class='data-value'><span id='distance'>--</span> nm</div>
                <div style='margin-top: 8px; color: #7ab8e8; font-size: 13px;' id='ete'>ETE: --</div>
            </div>

            <div class='card'>
                <div class='data-grid'>
                    <div class='data-item'>
                        <div class='data-label'>Speed</div>
                        <div class='data-value' id='speed'>--</div>
                        <div style='font-size: 11px; color: #7ab8e8;'>knots</div>
                    </div>
                    <div class='data-item'>
                        <div class='data-label'>Altitude</div>
                        <div class='data-value' id='altitude'>--</div>
                        <div style='font-size: 11px; color: #7ab8e8;'>feet</div>
                    </div>
                    <div class='data-item'>
                        <div class='data-label'>Heading</div>
                        <div class='data-value' id='heading'>--</div>
                        <div style='font-size: 11px; color: #7ab8e8;'>degrees</div>
                    </div>
                    <div class='data-item'>
                        <div class='data-label'>V/S</div>
                        <div class='data-value' id='vs'>--</div>
                        <div style='font-size: 11px; color: #7ab8e8;'>fpm</div>
                    </div>
                </div>
            </div>
        </div>

        <div class='tab-content'>
            <div class='card'>
                <button class='btn btn-secondary' onclick='toggleRoute()' id='btnRoute'>Show Route</button>
                <div id='map'></div>
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
                    <button class='btn btn-secondary' id='btnPause' onclick='togglePause()'>⏸️ Pause</button>
                    <button class='btn btn-primary' onclick='saveGame()'>💾 Save</button>
                </div>
                
                <div class='card'>
                    <h3 style='margin-bottom: 15px;'>Autopilot</h3>
                    
                    <div class='control-row'>
                        <span class='control-label'>Master</span>
                        <button class='toggle-btn off' id='apMaster' onclick='toggleAP("master")'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Altitude</span>
                        <button class='toggle-btn off' id='apAlt' onclick='toggleAP("altitude")'>OFF</button>
                    </div>
                    <input type='number' id='targetAlt' placeholder='Target Altitude' oninput='setAltitude()'>
                    <button class='btn btn-primary' onclick='setAltitude()'>Set</button>
                    
                    <div class='control-row'>
                        <span class='control-label'>V/S</span>
                        <button class='toggle-btn off' id='apVS' onclick='toggleAP("vs")'>OFF</button>
                    </div>
                    <input type='number' id='targetVS' placeholder='Vertical Speed (fpm)' oninput='setVS()'>
                    <button class='btn btn-primary' onclick='setVS()'>Set</button>
                    
                    <div class='control-row'>
                        <span class='control-label'>Speed</span>
                        <button class='toggle-btn off' id='apSpeed' onclick='toggleAP("speed")'>OFF</button>
                    </div>
                    <input type='number' id='targetSpeed' placeholder='Target Speed (kts)' oninput='setSpeed()'>
                    <button class='btn btn-primary' onclick='setSpeed()'>Set</button>
                    
                    <div class='control-row'>
                        <span class='control-label'>Heading</span>
                        <button class='toggle-btn off' id='apHdg' onclick='toggleAP("heading")'>OFF</button>
                    </div>
                    <input type='number' id='targetHdg' placeholder='Heading' oninput='setHeading()'>
                    <button class='btn btn-primary' onclick='setHeading()'>Set</button>
                    
                    <div class='control-row'>
                        <span class='control-label'>NAV/GPS</span>
                        <button class='toggle-btn off' id='navMode' onclick='toggleNavMode()'>GPS</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>NAV1</span>
                        <button class='toggle-btn off' id='nav1Mode' onclick='toggleAP("nav1")'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Approach</span>
                        <button class='toggle-btn off' id='apApp' onclick='toggleAP("approach")'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Auto Throttle</span>
                        <button class='toggle-btn off' id='autoThrottle' onclick='toggleAP("throttle")'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>ILS</span>
                        <button class='toggle-btn off' id='ilsMode' onclick='toggleILS()'>OFF</button>
                    </div>
                </div>
            </div>
        </div>
        
        <div class='tab-content'>
            <div id='aircraftLock' class='card'>
                <div class='info-box'>🔒 Enter password to access aircraft controls</div>
                <input type='password' id='aircraftPassword' placeholder='Password'>
                <button class='btn btn-primary' onclick='unlockAircraftControls()'>Unlock Controls</button>
            </div>
            
            <div id='aircraftPanel' class='hidden'>
                <div class='card'>
                    <h3 style='margin-bottom: 15px;'>Landing Gear & Brakes</h3>
                    
                    <div class='control-row'>
                        <span class='control-label'>Landing Gear</span>
                        <button class='toggle-btn off' id='gear' onclick='toggleGear()'>UP</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Parking Brake</span>
                        <button class='toggle-btn off' id='parkingBrake' onclick='toggleParkingBrake()'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Speed Brake</span>
                        <button class='toggle-btn off' id='speedBrake' onclick='toggleSpeedBrake()'>OFF</button>
                    </div>
                    <div class='slider-container'>
                        <input type='range' min='0' max='100' value='0' class='slider' id='speedBrakeSlider' oninput='setSpeedBrake(this.value)'>
                        <div style='display: flex; justify-content: space-between; font-size: 12px; color: #7ab8e8;'>
                            <span>0%</span>
                            <span id='speedBrakeValue'>0%</span>
                            <span>100%</span>
                        </div>
                    </div>
                </div>
                
                <div class='card'>
                    <h3 style='margin-bottom: 15px;'>Flaps</h3>
                    
                    <div class='control-row'>
                        <span class='control-label'>Flaps</span>
                        <div>
                            <button class='btn btn-secondary' style='width:auto; padding:8px 12px; margin:0 5px;' onclick='changeFlaps(-1)'>-</button>
                            <span id='flapsPos'>0%</span>
                            <button class='btn btn-secondary' style='width:auto; padding:8px 12px; margin:0 5px;' onclick='changeFlaps(1)'>+</button>
                        </div>
                    </div>
                </div>
                
                <div class='card'>
                    <h3 style='margin-bottom: 15px;'>Engines</h3>
                    
                    <div class='engine-grid'>
                        <div class='engine-control'>
                            <div class='engine-label'>Engine 1</div>
                            <div class='engine-status' id='engine1Status'>OFF</div>
                            <button class='btn btn-secondary' style='width:100%;' onclick='toggleEngine(1)'>Toggle</button>
                            <div class='slider-container'>
                                <input type='range' min='0' max='100' value='0' class='slider' id='throttle1' oninput='setThrottle(1, this.value)'>
                                <div style='font-size: 12px; color: #7ab8e8;'>Throttle: <span id='throttle1Value'>0%</span></div>
                            </div>
                        </div>
                        
                        <div class='engine-control'>
                            <div class='engine-label'>Engine 2</div>
                            <div class='engine-status' id='engine2Status'>OFF</div>
                            <button class='btn btn-secondary' style='width:100%;' onclick='toggleEngine(2)'>Toggle</button>
                            <div class='slider-container'>
                                <input type='range' min='0' max='100' value='0' class='slider' id='throttle2' oninput='setThrottle(2, this.value)'>
                                <div style='font-size: 12px; color: #7ab8e8;'>Throttle: <span id='throttle2Value'>0%</span></div>
                            </div>
                        </div>
                        
                        <div class='engine-control'>
                            <div class='engine-label'>Engine 3</div>
                            <div class='engine-status' id='engine3Status'>OFF</div>
                            <button class='btn btn-secondary' style='width:100%;' onclick='toggleEngine(3)'>Toggle</button>
                            <div class='slider-container'>
                                <input type='range' min='0' max='100' value='0' class='slider' id='throttle3' oninput='setThrottle(3, this.value)'>
                                <div style='font-size: 12px; color: #7ab8e8;'>Throttle: <span id='throttle3Value'>0%</span></div>
                            </div>
                        </div>
                        
                        <div class='engine-control'>
                            <div class='engine-label'>Engine 4</div>
                            <div class='engine-status' id='engine4Status'>OFF</div>
                            <button class='btn btn-secondary' style='width:100%;' onclick='toggleEngine(4)'>Toggle</button>
                            <div class='slider-container'>
                                <input type='range' min='0' max='100' value='0' class='slider' id='throttle4' oninput='setThrottle(4, this.value)'>
                                <div style='font-size: 12px; color: #7ab8e8;'>Throttle: <span id='throttle4Value'>0%</span></div>
                            </div>
                        </div>
                    </div>
                    
                    <div style='margin-top: 15px; text-align: center;'>
                        <button class='btn btn-primary' onclick='setAllThrottles(100)'>Full Throttle (100%)</button>
                        <button class='btn btn-secondary' onclick='setAllThrottles(0)'>Idle (0%)</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let ws = null;
        let map = null;
        let aircraftMarker = null;
        let aiMarkers = [];
        let routePolyline = null;
        let showingRoute = false;
        let uniqueId = null;
        let hasControl = false;
        let hasAircraftControl = false;
        let isPaused = false;

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
        }

        function connectToSim() {
            uniqueId = document.getElementById('uniqueId').value.trim();
            if (!uniqueId) {
                alert('Please enter your Unique ID');
                return;
            }
            
            // Save to localStorage
            localStorage.setItem('p3d_unique_id', uniqueId);
            
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + window.location.host);
            
            ws.onopen = () => {
                console.log('WebSocket connected');
                ws.send(JSON.stringify({ 
                    type: 'connect_mobile',
                    uniqueId: uniqueId
                }));
            };

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                console.log('Received message:', data.type);
                handleMessage(data);
            };

            ws.onclose = () => {
                console.log('WebSocket disconnected');
                updateStatus('offline');
                setTimeout(connectToSim, 3000);
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
                    break;
                    
                case 'pc_online':
                    updateStatus('connected');
                    break;
                    
                case 'pc_offline':
                    updateStatus('offline');
                    break;
                    
                case 'error':
                    alert(data.message || 'An error occurred');
                    break;
                    
                case 'control_granted':
                    hasControl = true;
                    hasAircraftControl = true;
                    document.getElementById('controlLock').classList.add('hidden');
                    document.getElementById('controlPanel').classList.remove('hidden');
                    document.getElementById('aircraftLock').classList.add('hidden');
                    document.getElementById('aircraftPanel').classList.remove('hidden');
                    break;
                    
                case 'auth_failed':
                    alert(data.message || 'Authentication failed');
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
                    
                case 'ai_traffic':
                    updateAITraffic(data.aircraft);
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
            document.getElementById('distance').textContent = data.totalDistance.toFixed(1);
            
            const hours = Math.floor(data.ete / 3600);
            const minutes = Math.floor((data.ete % 3600) / 60);
            document.getElementById('ete').textContent = 'ETE: ' + (hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'm');

            // Update pause button state
            isPaused = data.isPaused;
            const btnPause = document.getElementById('btnPause');
            if (isPaused) {
                btnPause.textContent = '▶️ Resume';
                btnPause.classList.add('paused');
            } else {
                btnPause.textContent = '⏸️ Pause';
                btnPause.classList.remove('paused');
            }

            // Update waypoint info
            if (data.nextWaypoint) {
                document.getElementById('nextWaypoint').textContent = data.nextWaypoint;
                document.getElementById('waypointDistance').textContent = data.distanceToWaypoint.toFixed(1);
                document.getElementById('waypointBearing').textContent = Math.round(data.bearingToWaypoint);
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
            updateToggle('apNav1', data.nav1);
            updateToggle('autoThrottle', data.throttle);
            updateToggle('gear', data.gear, data.gear ? 'DOWN' : 'UP');
            updateToggle('parkingBrake', data.parkingBrake);
            updateToggle('speedBrake', data.speedBrake > 0);
            updateToggle('ilsMode', data.ilsMode);
            
            document.getElementById('flapsPos').textContent = Math.round(data.flaps) + '%';
            
            // Update speed brake slider
            document.getElementById('speedBrakeSlider').value = data.speedBrake;
            document.getElementById('speedBrakeValue').textContent = Math.round(data.speedBrake) + '%';
            
            // Update engine status and throttles
            for (let i = 1; i <= 4; i++) {
                const engineStatus = document.getElementById('engine' + i + 'Status');
                const throttleSlider = document.getElementById('throttle' + i);
                const throttleValue = document.getElementById('throttle' + i + 'Value');
                
                if (data['engine' + i]) {
                    engineStatus.textContent = 'ON';
                    engineStatus.className = 'engine-status on';
                } else {
                    engineStatus.textContent = 'OFF';
                    engineStatus.className = 'engine-status off';
                }
                
                if (data['throttle' + i] !== undefined) {
                    throttleSlider.value = data['throttle' + i];
                    throttleValue.textContent = Math.round(data['throttle' + i]) + '%';
                }
            }
            
            // Update target values - always update to sync with sim
            document.getElementById('targetAlt').value = data.targetAltitude || '';
            document.getElementById('targetHdg').value = data.targetHeading || '';
            document.getElementById('targetVS').value = data.targetVS || '';
            document.getElementById('targetSpeed').value = data.targetSpeed || '';
            
            // NAV/GPS toggle - Fixed inversion
            const navBtn = document.getElementById('navMode');
            navBtn.textContent = data.navMode ? 'NAV' : 'GPS';
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
                icon: createPlaneIcon('#FFD700', 32)
            }).addTo(map);
        }

        function createPlaneIcon(color, size) {
            return L.divIcon({
                html: '<div style="font-size:' + size + 'px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));">✈️</div>',
                className: '',
                iconSize: [size, size],
                iconAnchor: [size/2, size/2]
            });
        }

        function updateMap(lat, lon, heading) {
            if (!map) return;
            
            const icon = L.divIcon({
                html: '<div style="font-size:32px;transform:rotate(' + heading + 'deg);filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));">✈️</div>',
                className: '',
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            });
            
            aircraftMarker.setLatLng([lat, lon]);
            aircraftMarker.setIcon(icon);
            map.setView([lat, lon], map.getZoom());
        }

        function updateAITraffic(aircraft) {
            // Clear old markers
            aiMarkers.forEach(m => map.removeLayer(m));
            aiMarkers = [];
            
            if (!map) return;
            
            aircraft.forEach(ac => {
                const marker = L.marker([ac.latitude, ac.longitude], {
                    icon: createPlaneIcon('#FFFFFF', 20)
                }).addTo(map);
                
                marker.bindPopup('<strong>' + ac.callsign + '</strong><br>' +
                    'Alt: ' + Math.round(ac.altitude) + ' ft<br>' +
                    'Speed: ' + Math.round(ac.speed) + ' kts');
                
                aiMarkers.push(marker);
            });
        }

        function toggleRoute() {
            // Implement route toggle
        }

        function unlockControls() {
            const password = document.getElementById('controlPassword').value;
            ws.send(JSON.stringify({ type: 'request_control', password }));
        }

        function unlockAircraftControls() {
            const password = document.getElementById('aircraftPassword').value;
            ws.send(JSON.stringify({ type: 'request_control', password }));
        }

        function togglePause() {
            isPaused = !isPaused;
            const btnPause = document.getElementById('btnPause');
            
            if (isPaused) {
                btnPause.textContent = '▶️ Resume';
                btnPause.classList.add('paused');
            } else {
                btnPause.textContent = '⏸️ Pause';
                btnPause.classList.remove('paused');
            }
            
            ws.send(JSON.stringify({ type: 'pause_toggle' }));
        }

        function saveGame() {
            const saveName = prompt('Enter a name for your save:');
            if (saveName) {
                ws.send(JSON.stringify({ type: 'save_game', name: saveName }));
                alert('Flight saved as: ' + saveName);
            }
        }

        function toggleAP(system) {
            ws.send(JSON.stringify({ type: 'autopilot_toggle', system }));
        }

        function setAltitude() {
            const alt = parseInt(document.getElementById('targetAlt').value);
            if (!isNaN(alt)) {
                ws.send(JSON.stringify({ type: 'autopilot_set', param: 'altitude', value: alt }));
            }
        }

        function setHeading() {
            const hdg = parseInt(document.getElementById('targetHdg').value);
            if (!isNaN(hdg)) {
                ws.send(JSON.stringify({ type: 'autopilot_set', param: 'heading', value: hdg }));
            }
        }

        function setVS() {
            const vs = parseInt(document.getElementById('targetVS').value);
            if (!isNaN(vs)) {
                ws.send(JSON.stringify({ type: 'autopilot_set', param: 'vs', value: vs }));
            }
        }

        function setSpeed() {
            const speed = parseInt(document.getElementById('targetSpeed').value);
            if (!isNaN(speed)) {
                ws.send(JSON.stringify({ type: 'autopilot_set', param: 'speed', value: speed }));
            }
        }

        function toggleNavMode() {
            ws.send(JSON.stringify({ type: 'toggle_nav_mode' }));
        }

        function toggleILS() {
            ws.send(JSON.stringify({ type: 'toggle_ils' }));
        }

        function toggleGear() {
            ws.send(JSON.stringify({ type: 'toggle_gear' }));
        }

        function toggleParkingBrake() {
            ws.send(JSON.stringify({ type: 'toggle_parking_brake' }));
        }

        function toggleSpeedBrake() {
            ws.send(JSON.stringify({ type: 'toggle_speedbrake' }));
        }

        function setSpeedBrake(value) {
            document.getElementById('speedBrakeValue').textContent = value + '%';
            ws.send(JSON.stringify({ type: 'set_speedbrake', value: parseInt(value) }));
        }

        function changeFlaps(direction) {
            ws.send(JSON.stringify({ type: 'change_flaps', direction }));
        }

        function toggleEngine(engine) {
            ws.send(JSON.stringify({ type: 'toggle_engine', engine }));
        }

        function setThrottle(engine, value) {
            document.getElementById('throttle' + engine + 'Value').textContent = value + '%';
            ws.send(JSON.stringify({ type: 'set_throttle', engine, value: parseInt(value) }));
        }
        
        function setAllThrottles(value) {
            for (let i = 1; i <= 4; i++) {
                document.getElementById('throttle' + i).value = value;
                document.getElementById('throttle' + i + 'Value').textContent = value + '%';
                ws.send(JSON.stringify({ type: 'set_throttle', engine: i, value: value }));
            }
        }

        // Load saved ID
        window.onload = () => {
            const savedId = localStorage.getItem('p3d_unique_id');
            if (savedId) {
                document.getElementById('uniqueId').value = savedId;
            }
        };
    </script>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`P3D Remote Cloud Relay running on port ${PORT}`);
});
