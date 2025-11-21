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
              data.type === 'change_flaps' ||
              data.type === 'toggle_nav_mode' ||
              data.type === 'toggle_speedbrake' ||
              data.type === 'toggle_parking_brake' ||
              data.type === 'set_throttle' ||
              data.type === 'engine_start' ||
              data.type === 'engine_stop') {
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
            transition: all 0.2s;
        }
        .btn-primary { background: #00c853; color: white; }
        .btn-secondary { background: #005a9c; color: white; }
        .btn-danger { background: #f44336; color: white; }
        .btn-paused { background: #ff9800; color: white; }
        .btn:disabled { background: #555; opacity: 0.5; }
        
        .tabs {
            display: flex;
            background: #003057;
            border-bottom: 2px solid #005a9c;
            overflow-x: auto;
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
            white-space: nowrap;
            min-width: 80px;
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
            min-width: 60px;
        }
        .toggle-btn.on { background: #00c853; color: white; }
        .toggle-btn.off { background: #555; color: #999; }
        
        .throttle-slider {
            width: 100%;
            height: 40px;
            margin: 10px 0;
        }
        
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
            padding: 10px;
            border-radius: 8px;
            margin-top: 10px;
            font-size: 13px;
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
            <button class='tab' onclick='switchTab(3)'>Aircraft</button>
        </div>

        <div class='tab-content active'>
            <div class='card'>
                <div class='data-label'>Total Distance to Destination</div>
                <div class='data-value'><span id='totalDistance'>--</span> nm</div>
                <div style='margin-top: 8px; color: #7ab8e8; font-size: 13px;' id='totalEte'>Total ETE: --</div>
                
                <div class='waypoint-info'>
                    <div style='font-weight: bold; margin-bottom: 5px;'>Next Waypoint: <span id='nextWaypoint'>--</span></div>
                    <div>Distance: <span id='waypointDistance'>--</span> nm</div>
                    <div>ETE: <span id='waypointEte'>--</span></div>
                </div>
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
                    <button class='btn btn-primary' onclick='saveGame()'>💾 Quick Save</button>
                </div>
                
                <div class='card'>
                    <h3 style='margin-bottom: 15px;'>Autopilot</h3>
                    
                    <div class='control-row'>
                        <span class='control-label'>Master</span>
                        <button class='toggle-btn off' id='apMaster' onclick='toggleAP("master")'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Altitude Hold</span>
                        <button class='toggle-btn off' id='apAlt' onclick='toggleAP("altitude")'>OFF</button>
                    </div>
                    <input type='number' id='targetAlt' placeholder='Target Altitude (ft)'>
                    <button class='btn btn-primary' onclick='setAltitude()'>Set Altitude</button>
                    
                    <div class='control-row'>
                        <span class='control-label'>V/S</span>
                        <button class='toggle-btn off' id='apVS' onclick='toggleAP("vs")'>OFF</button>
                    </div>
                    <input type='number' id='targetVS' placeholder='Vertical Speed (fpm)'>
                    <button class='btn btn-primary' onclick='setVS()'>Set V/S</button>
                    
                    <div class='control-row'>
                        <span class='control-label'>Speed</span>
                        <button class='toggle-btn off' id='apSpeed' onclick='toggleAP("speed")'>OFF</button>
                    </div>
                    <input type='number' id='targetSpeed' placeholder='Target Speed (kts)'>
                    <button class='btn btn-primary' onclick='setSpeed()'>Set Speed</button>
                    
                    <div class='control-row'>
                        <span class='control-label'>Heading</span>
                        <button class='toggle-btn off' id='apHdg' onclick='toggleAP("heading")'>OFF</button>
                    </div>
                    <input type='number' id='targetHdg' placeholder='Heading (degrees)'>
                    <button class='btn btn-primary' onclick='setHeading()'>Set Heading</button>
                    
                    <div class='control-row'>
                        <span class='control-label'>NAV/GPS Mode</span>
                        <button class='toggle-btn off' id='navMode' onclick='toggleNavMode()'>GPS</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>LOC (NAV1)</span>
                        <button class='toggle-btn off' id='apLoc' onclick='toggleAP("loc")'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>ILS Mode</span>
                        <button class='toggle-btn off' id='ilsMode' onclick='toggleAP("ils")'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Approach</span>
                        <button class='toggle-btn off' id='apApp' onclick='toggleAP("approach")'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Auto Throttle</span>
                        <button class='toggle-btn off' id='autoThrottle' onclick='toggleAP("throttle")'>OFF</button>
                    </div>
                </div>
            </div>
        </div>
        
        <div class='tab-content'>
            <div id='controlLock2' class='card'>
                <div class='info-box'>🔒 Enter password to access controls</div>
                <input type='password' id='controlPassword2' placeholder='Password'>
                <button class='btn btn-primary' onclick='unlockControls2()'>Unlock Controls</button>
            </div>
            
            <div id='aircraftPanel' class='hidden'>
                <div class='card'>
                    <h3 style='margin-bottom: 15px;'>Flight Controls</h3>
                    
                    <div class='control-row'>
                        <span class='control-label'>Landing Gear</span>
                        <button class='toggle-btn off' id='gear' onclick='toggleGear()'>UP</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Flaps</span>
                        <div>
                            <button class='btn btn-secondary' style='width:auto; padding:8px 12px; margin:0 5px;' onclick='changeFlaps(-1)'>-</button>
                            <span id='flapsPos'>0%</span>
                            <button class='btn btn-secondary' style='width:auto; padding:8px 12px; margin:0 5px;' onclick='changeFlaps(1)'>+</button>
                        </div>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Speedbrakes</span>
                        <button class='toggle-btn off' id='speedbrake' onclick='toggleSpeedbrake()'>OFF</button>
                    </div>
                    
                    <div class='control-row'>
                        <span class='control-label'>Parking Brake</span>
                        <button class='toggle-btn off' id='parkingBrake' onclick='toggleParkingBrake()'>OFF</button>
                    </div>
                </div>
                
                <div class='card'>
                    <h3 style='margin-bottom: 15px;'>Engine Controls</h3>
                    
                    <div class='control-row'>
                        <span class='control-label'>Engines</span>
                        <div>
                            <button class='btn btn-primary' style='width:auto; padding:8px 16px; margin:0 5px;' onclick='startEngines()'>Start</button>
                            <button class='btn btn-danger' style='width:auto; padding:8px 16px; margin:0 5px;' onclick='stopEngines()'>Stop</button>
                        </div>
                    </div>
                    
                    <div style='margin: 15px 0;'>
                        <div class='data-label'>Throttle Position</div>
                        <div class='data-value' id='throttleDisplay'>0%</div>
                        <input type='range' min='0' max='100' value='0' class='throttle-slider' id='throttleSlider' oninput='updateThrottle(this.value)'>
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
                    document.getElementById('controlLock2').classList.add('hidden');
                    document.getElementById('aircraftPanel').classList.remove('hidden');
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
                    
                case 'ai_traffic':
                    updateAITraffic(data.aircraft);
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
            
            // Total distance to destination
            document.getElementById('totalDistance').textContent = data.totalDistance ? data.totalDistance.toFixed(1) : '--';
            
            // Total ETE
            if (data.totalEte && data.totalEte > 0) {
                const hours = Math.floor(data.totalEte / 3600);
                const minutes = Math.floor((data.totalEte % 3600) / 60);
                document.getElementById('totalEte').textContent = 'Total ETE: ' + (hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'm');
            } else {
                document.getElementById('totalEte').textContent = 'Total ETE: --';
            }
            
            // Next waypoint info
            document.getElementById('nextWaypoint').textContent = data.nextWaypoint || '--';
            document.getElementById('waypointDistance').textContent = data.waypointDistance ? data.waypointDistance.toFixed(1) : '--';
            
            if (data.waypointEte && data.waypointEte > 0) {
                const hours = Math.floor(data.waypointEte / 3600);
                const minutes = Math.floor((data.waypointEte % 3600) / 60);
                document.getElementById('waypointEte').textContent = (hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'm');
            } else {
                document.getElementById('waypointEte').textContent = '--';
            }

            // Update pause button style
            const btnPause = document.getElementById('btnPause');
            if (data.isPaused) {
                btnPause.textContent = '▶️ Resume';
                btnPause.className = 'btn btn-paused';
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
            updateToggle('apLoc', data.loc);
            updateToggle('ilsMode', data.ils);
            updateToggle('autoThrottle', data.throttle);
            updateToggle('gear', data.gear, data.gear ? 'DOWN' : 'UP');
            updateToggle('speedbrake', data.speedbrake);
            updateToggle('parkingBrake', data.parkingBrake);
            
            document.getElementById('flapsPos').textContent = Math.round(data.flaps) + '%';
            
            // NAV/GPS toggle - FIXED: Show GPS when GPS is active
            const navBtn = document.getElementById('navMode');
            navBtn.textContent = data.navMode ? 'NAV' : 'GPS';
            navBtn.className = 'toggle-btn ' + (data.navMode || data.gpsActive ? 'on' : 'off');
            
            // Update throttle display if available
            if (data.throttle !== undefined) {
                const throttlePercent = Math.round(data.throttle * 100);
                document.getElementById('throttleDisplay').textContent = throttlePercent + '%';
                document.getElementById('throttleSlider').value = throttlePercent;
            }
        }

        function updateToggle(id, state, customText) {
            const btn = document.getElementById(id);
            if (!btn) return;
            
            btn.className = 'toggle-btn ' + (state ? 'on' : 'off');
            btn.textContent = customText || (state ? 'ON' : 'OFF');
        }

        function initMap() {
            map = L.map('map').setView([0, 0], 2);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors'
            }).addTo(map);
        }

        function updateMap(lat, lon, heading) {
            if (!map || !aircraftMarker) {
                const planeIcon = L.divIcon({
                    html: '<div style="transform: rotate(' + heading + 'deg); font-size: 20px;">✈️</div>',
                    iconSize: [20, 20],
                    className: 'aircraft-icon'
                });
                
                aircraftMarker = L.marker([lat, lon], { icon: planeIcon }).addTo(map);
                map.setView([lat, lon], 10);
            } else {
                aircraftMarker.setLatLng([lat, lon]);
                aircraftMarker.setIcon(L.divIcon({
                    html: '<div style="transform: rotate(' + heading + 'deg); font-size: 20px;">✈️</div>',
                    iconSize: [20, 20],
                    className: 'aircraft-icon'
                }));
            }
        }

        function updateAITraffic(aircraft) {
            // Clear existing markers
            aiMarkers.forEach(marker => map.removeLayer(marker));
            aiMarkers = [];
            
            // Add new markers
            aircraft.forEach(ac => {
                const marker = L.marker([ac.lat, ac.lon]).addTo(map);
                marker.bindPopup(ac.type + ' (' + ac.tailNumber + ')');
                aiMarkers.push(marker);
            });
        }

        function toggleRoute() {
            const btn = document.getElementById('btnRoute');
            showingRoute = !showingRoute;
            
            if (showingRoute) {
                btn.textContent = 'Hide Route';
                // Request route data from PC
                if (ws) {
                    ws.send(JSON.stringify({ type: 'get_route' }));
                }
            } else {
                btn.textContent = 'Show Route';
                if (routePolyline) {
                    map.removeLayer(routePolyline);
                    routePolyline = null;
                }
            }
        }

        function unlockControls() {
            const password = document.getElementById('controlPassword').value;
            if (!password) {
                alert('Please enter a password');
                return;
            }
            
            if (ws) {
                ws.send(JSON.stringify({
                    type: 'request_control',
                    password: password
                }));
            }
        }

        function unlockControls2() {
            const password = document.getElementById('controlPassword2').value;
            if (!password) {
                alert('Please enter a password');
                return;
            }
            
            if (ws) {
                ws.send(JSON.stringify({
                    type: 'request_control',
                    password: password
                }));
            }
        }

        function togglePause() {
            if (ws) {
                ws.send(JSON.stringify({ type: 'pause_toggle' }));
            }
        }

        function saveGame() {
            if (ws) {
                ws.send(JSON.stringify({ type: 'save_game' }));
            }
        }

        function toggleAP(mode) {
            if (ws) {
                ws.send(JSON.stringify({ type: 'autopilot_toggle', mode: mode }));
            }
        }

        function setAltitude() {
            const altitude = document.getElementById('targetAlt').value;
            if (!altitude) return;
            
            if (ws) {
                ws.send(JSON.stringify({ 
                    type: 'autopilot_set_altitude', 
                    value: parseInt(altitude) 
                }));
            }
        }

        function setVS() {
            const vs = document.getElementById('targetVS').value;
            if (!vs) return;
            
            if (ws) {
                ws.send(JSON.stringify({ 
                    type: 'autopilot_set_vs', 
                    value: parseInt(vs) 
                }));
            }
        }

        function setSpeed() {
            const speed = document.getElementById('targetSpeed').value;
            if (!speed) return;
            
            if (ws) {
                ws.send(JSON.stringify({ 
                    type: 'autopilot_set_speed', 
                    value: parseInt(speed) 
                }));
            }
        }

        function setHeading() {
            const heading = document.getElementById('targetHdg').value;
            if (!heading) return;
            
            if (ws) {
                ws.send(JSON.stringify({ 
                    type: 'autopilot_set_heading', 
                    value: parseInt(heading) 
                }));
            }
        }

        function toggleNavMode() {
            if (ws) {
                ws.send(JSON.stringify({ type: 'toggle_nav_mode' }));
            }
        }

        function toggleGear() {
            if (ws) {
                ws.send(JSON.stringify({ type: 'toggle_gear' }));
            }
        }

        function changeFlaps(direction) {
            if (ws) {
                ws.send(JSON.stringify({ 
                    type: 'change_flaps', 
                    direction: direction 
                }));
            }
        }

        function toggleSpeedbrake() {
            if (ws) {
                ws.send(JSON.stringify({ type: 'toggle_speedbrake' }));
            }
        }

        function toggleParkingBrake() {
            if (ws) {
                ws.send(JSON.stringify({ type: 'toggle_parking_brake' }));
            }
        }

        function updateThrottle(value) {
            document.getElementById('throttleDisplay').textContent = value + '%';
            
            if (ws) {
                ws.send(JSON.stringify({ 
                    type: 'set_throttle', 
                    value: parseInt(value) / 100 
                }));
            }
        }

        function startEngines() {
            if (ws) {
                ws.send(JSON.stringify({ type: 'engine_start' }));
            }
        }

        function stopEngines() {
            if (ws) {
                ws.send(JSON.stringify({ type: 'engine_stop' }));
            }
        }

        // Check for saved unique ID
        document.addEventListener('DOMContentLoaded', () => {
            const savedId = localStorage.getItem('p3d_unique_id');
            if (savedId) {
                document.getElementById('uniqueId').value = savedId;
            }
        });
    </script>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
