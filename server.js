// P3D Remote Cloud Relay - Enhanced Edition
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

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
  console.log('New connection');
  
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
            guestPassword: guestPassword
          });
        } else {
          const session = sessions.get(uniqueId);
          session.pcClient = ws;
          session.password = password;
          session.guestPassword = guestPassword;
        }
        
        ws.send(JSON.stringify({ type: 'registered', uniqueId }));
        console.log(`PC registered: ${uniqueId}`);
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
              data.type === 'toggle_spoilers' ||
              data.type === 'toggle_parking_brake' ||
              data.type === 'change_flaps' ||
              data.type === 'throttle_control') {
            if (!ws.hasControlAccess) {
              ws.send(JSON.stringify({ 
                type: 'control_required',
                message: 'Enter password to access controls'
              }));
              return;
            }
          }
          
          // Forward to PC
          if (session.pcClient.readyState === WebSocket.OPEN) {
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
      console.error('Error:', error);
    }
  });

  ws.on('close', () => {
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
            background: #000000;
            color: white;
        }
        .header {
            background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
            padding: 15px 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.5);
            border-bottom: 2px solid #00c853;
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
        .status.connected { background: #00c853; color: #000; }
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
        .login-card h2 { margin-bottom: 20px; color: #00c853; }
        
        input {
            width: 100%;
            padding: 14px;
            background: #0d0d0d;
            border: 2px solid #333;
            border-radius: 8px;
            color: white;
            font-size: 15px;
            margin: 10px 0;
        }
        input::placeholder { color: #666; }
        input:focus { outline: none; border-color: #00c853; }
        
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
        }
        .btn-primary { background: #00c853; color: #000; }
        .btn-primary:active { background: #00e676; }
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
        }
        .tab.active {
            color: #00c853;
            background: #1a1a1a;
            border-bottom: 3px solid #00c853;
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
            color: #00c853;
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
        }
        .toggle-btn.on { background: #00c853; color: #000; }
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
        
        .throttle-controls {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-top: 10px;
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
            color: #00c853;
            margin-bottom: 15px;
        }
    </style>
</head>
<body>
    <div class='header'>
        <h1>Prepar3D Remote</h1>
        <div id='statusBadge' class='status offline'>Offline</div>
    </div>

    <div id='loginScreen' class='login-screen'>
        <div class='login-card'>
            <h2>Connect to Simulator</h2>
            <div class='info-box'>
                Enter your Unique ID from the PC Server
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
                <div class='data-value'><span id='distance'>--</span> nm</div>
                <div style='margin-top: 8px; color: #888; font-size: 13px;' id='ete'>Total ETE: --</div>
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
            
            localStorage.setItem('p3d_unique_id', uniqueId);
            
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + window.location.host);
            
            ws.onopen = () => {
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
                updateStatus('offline');
                setTimeout(connectToSim, 3000);
            };
        }

        function handleMessage(data) {
            switch(data.type) {
                case 'connected':
                    document.getElementById('loginScreen').classList.add('hidden');
                    document.getElementById('mainApp').classList.remove('hidden');
                    updateStatus(data.pcOnline ? 'connected' : 'offline');
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
                document.getElementById('distance').textContent = data.totalDistance.toFixed(1);
            } else {
                document.getElementById('distance').textContent = '--';
            }
            
            // Total ETE
            if (data.ete && data.ete > 0) {
                const hours = Math.floor(data.ete / 3600);
                const minutes = Math.floor((data.ete % 3600) / 60);
                document.getElementById('ete').textContent = 'Total ETE: ' + (hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'm');
            } else {
                document.getElementById('ete').textContent = 'Total ETE: --';
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
            
            // NAV/GPS toggle - FIXED: inverted the logic
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
            ws.send(JSON.stringify({ type: 'autopilot_toggle', system }));
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
            ws.send(JSON.stringify({ type: 'toggle_spoilers' }));
        }

        function toggleParkingBrake() {
            ws.send(JSON.stringify({ type: 'toggle_parking_brake' }));
        }

        function changeFlaps(direction) {
            ws.send(JSON.stringify({ type: 'change_flaps', direction }));
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
