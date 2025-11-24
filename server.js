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
              data.type === 'toggle_speedbrake' ||
              data.type === 'toggle_parking_brake' ||
              data.type === 'change_flaps' ||
              data.type === 'throttle_control' ||
              data.type.includes('toggle_light') || 
              data.type.includes('toggle_cabin')) {
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
    <link href="https://fonts.cdnfonts.com/css/good-times-2" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Arial, sans-serif;
            background: #000000;
            color: white;
            overflow-x: hidden;
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
            font-family: 'Good Times', sans-serif;
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
.status.paused { 
    background: #800000; 
    color: #fff;
    display: none;
}
        .status.paused.visible { display: inline-block; }
        
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
        }
        .btn-primary { background: #167fac; color: #fff; }
        .btn-primary:active { background: #1a8fd4; }
        .btn-secondary { background: #2d2d2d; color: white; border: 1px solid #444; }
        .btn-secondary:active { background: #3d3d3d; }
        .btn-warning { background: #800000; color: #fff; }
        .btn-danger { background: #f44336; color: white; }
        .btn:disabled { background: #333; opacity: 0.5; }

        
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
            color: #167fac;
            background: #1a1a1a;
            border-bottom: 3px solid #167fac;
        }
        
        .tab-content {
            display: none;
            padding: 15px;
            height: calc(100vh - 180px);
            overflow-y: auto;
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
        
        .map-controls {
            display: flex;
            flex-direction: column;
            background: #0d0d0d;
            border-bottom: 1px solid #333;
            margin-bottom: 10px;
            border-radius: 8px;
            padding: 10px;
        }
        
        .map-controls-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        
        .map-controls-row:last-child {
            margin-bottom: 0;
        }
        
        .map-buttons {
            display: flex;
            gap: 8px;
        }
        
        .map-buttons .btn {
            width: auto;
            padding: 8px 12px;
            font-size: 12px;
            margin: 0;
            flex: 1;
            min-width: 100px;
        }
        
        .zoom-indicator {
            color: #888;
            font-size: 13px;
            background: #1a1a1a;
            padding: 6px 10px;
            border-radius: 6px;
            border: 1px solid #333;
        }
        
.map-container {
            height: 400px;
            position: relative;
            margin-bottom: 15px;
        }
        
        #map {
            height: 100%;
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid #333;
        }
        
        .instrument-panel {
            display: flex;
            flex-direction: column;
            gap: 15px;
            padding-bottom: 20px;
        }
        
        .instrument-row {
            display: flex;
            gap: 15px;
            justify-content: center;
        }
        
        .instrument-container {
            background: #000;
            border: 2px solid #333;
            border-radius: 12px;
            padding: 10px;
            position: relative;
        }
        
        .instrument-label {
            position: absolute;
            top: 5px;
            left: 10px;
            font-size: 10px;
            color: #888;
            text-transform: uppercase;
            font-weight: bold;
        }
        
        canvas.instrument {
            display: block;
            background: #000;
        }
        
        .aircraft-panel {
            display: flex;
            flex-direction: column;
            height: 400px;
            overflow: hidden;
        }
        
        .panel-section {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
        }
        
        .panel-header {
            background: #1a1a1a;
            padding: 8px 15px;
            border-bottom: 1px solid #333;
            flex-shrink: 0;
        }
        
        .panel-header h3 {
            margin: 0;
            font-size: 14px;
            color: #167fac;
        }
        
        .aircraft-list {
            flex: 1;
            overflow-y: auto;
            background: #0d0d0d;
        }
        
        .aircraft-list-item {
            display: flex;
            justify-content: space-between;
            padding: 8px 15px;
            border-bottom: 1px solid #222;
            cursor: pointer;
        }
        
        .aircraft-list-item:hover {
            background: #1a1a1a;
        }
        
        .aircraft-list-item.selected {
            background: rgba(255, 0, 0, 0.2);
            border-left: 3px solid #ff0000;
        }
        
        .aircraft-callsign {
            font-weight: bold;
            color: #ccc;
        }
        
        .aircraft-distance {
            color: #888;
        }
        
        .aircraft-details {
            flex: 1;
            overflow-y: auto;
            background: #0d0d0d;
            padding: 15px;
            border-top: 1px solid #333;
        }
        
        .no-aircraft {
            padding: 15px;
            text-align: center;
            color: #666;
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
            color: #167fac;
            margin-bottom: 15px;
        }
        
        .route-badge {
            display: inline-block;
            background: #2d2d2d;
            padding: 3px 8px;
            border-radius: 12px;
            font-size: 11px;
            margin-top: 5px;
        }

.status-badge {
    display: inline-block;
    padding: 3px 5px;
    border-radius: 6px;
    font-size: 9px;
    font-weight: bold;
    background: #333;
    color: #888;
    margin: 1px;
}

.status-badge.active {
    background: #167fac;
    color: #fff;
}

.summary-container {
    background: #0d0d0d;
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 10px;
}

.summary-main {
    display: flex;
    justify-content: space-between;
    margin-bottom: 8px;
    gap: 4px;
}

.summary-item {
    text-align: center;
    flex: 1;
    min-width: 0;
}

.summary-label {
    font-size: 9px;
    color: #888;
    text-transform: uppercase;
    margin-bottom: 2px;
}

.summary-value {
    font-size: 14px;
    font-weight: bold;
    color: #167fac;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.summary-secondary {
    display: flex;
    justify-content: space-around;
    align-items: center;
    padding: 5px 0;
    border-top: 1px solid #222;
}

.summary-secondary-item {
    display: flex;
    align-items: center;
    gap: 5px;
}

.arrow-up {
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-bottom: 10px solid #167fac;
}

.arrow-down {
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 10px solid #167fac;
}

.status-badges-row {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    justify-content: center;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #222;
}
        
        .detail-row {
            display: flex;
            justify-content: space-between;
            padding: 4px 0;
            border-bottom: 1px solid #222;
        }
        
        .detail-row:last-child {
            border-bottom: none;
        }
        
        .detail-label {
            color: #888;
            font-size: 12px;
        }
        
        .detail-value {
            color: #ccc;
            font-size: 12px;
            font-weight: bold;
        }
        
        .user-aircraft {
            filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));
            z-index: 1000;
        }

        .ai-aircraft {
            filter: drop-shadow(0 1px 2px rgba(0,0,0,0.8));
            z-index: 900;
        }

        .ai-aircraft.selected, .user-aircraft.selected {
            animation: pulse 1.5s infinite;
        }

        .waypoint-info-row {
            display: flex;
            justify-content: space-between;
            margin-top: 8px;
        }
        
        .waypoint-info-item {
            color: #888;
            font-size: 13px;
        }
    </style>
</head>
<body>
    <div class='header'>
        <h1>Prepar3D Remote</h1>
        <div id='statusBadge' class='status offline'>Offline</div>
        <div id='pauseBadge' class='status paused'>Paused</div>
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
    <button class='tab' onclick='switchTab(2)'>Instruments</button>
    <button class='tab' onclick='switchTab(3)'>Autopilot</button>
</div>

<!-- Flight Tab -->
<div class='tab-content active'>
    <div class='card'>
        <div class='data-label'>Next Waypoint</div>
        <div class='data-value' style='font-size: 18px;' id='nextWaypoint'>--</div>
        <div class='waypoint-info-row'>
            <div class='waypoint-info-item' id='wpDistance'>Distance: --</div>
            <div class='waypoint-info-item' id='wpBearing'>Bearing: --°</div>
        </div>
        <div class='waypoint-info-item' id='wpEte'>ETE: --</div>
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

<!-- Map Tab -->
<div class='tab-content'>
    <div class='map-controls'>
        <div class='map-controls-row'>
            <div class='map-buttons'>
                <button id='followUserBtn' class='btn btn-secondary' onclick='toggleFollowUser()'>Follow Aircraft</button>
                <button id='toggleLabelsBtn' class='btn btn-secondary' onclick='toggleAircraftLabels()'>Hide Labels</button>
            </div>
            <span id='zoomLevel' class='zoom-indicator'>Zoom: 7</span>
        </div>
    </div>
    
    <div class='map-container'>
        <div id='map'></div>
    </div>
    
    <div class='aircraft-panel'>
        <div class='panel-section'>
            <div class='panel-header'>
                <h3>Nearby Aircraft</h3>
            </div>
            <div id='nearbyAircraftList' class='aircraft-list'>
                <div class='no-aircraft'>No nearby aircraft</div>
            </div>
        </div>
        
        <div class='panel-section'>
            <div class='panel-header'>
                <h3>Aircraft Details</h3>
            </div>
            <div id='aircraftDetails' class='aircraft-details'>
                <p>Click on an aircraft to view details</p>
            </div>
        </div>
    </div>
</div>

<!-- Instruments Tab -->
<div class='tab-content'>
    <div class='instrument-panel'>
        <div class='instrument-row'>
            <div class='instrument-container'>
                <span class='instrument-label'>Primary Flight Display</span>
                <canvas id='pfdCanvas' class='instrument' width='300' height='300'></canvas>
            </div>
        </div>
        <div class='instrument-row'>
            <div class='instrument-container'>
                <span class='instrument-label'>Multi-Function Display</span>
                <canvas id='mfdCanvas' class='instrument' width='300' height='300'></canvas>
            </div>
        </div>
    </div>
</div>

<!-- Autopilot Tab -->
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
            <h3 style='margin-bottom: 10px;'>Summary</h3>
            <div class='summary-container'>
                <div class='summary-main'>
                    <div class='summary-item'>
                        <div class='summary-label'>SPD</div>
                        <div class='summary-value' id='summarySpeed'>--</div>
                    </div>
                    <div class='summary-item'>
                        <div class='summary-label'>HDG</div>
                        <div class='summary-value' id='summaryHeading'>--</div>
                    </div>
                    <div class='summary-item'>
                        <div class='summary-label'>ALT</div>
                        <div class='summary-value' id='summaryAltitude'>--</div>
                    </div>
                    <div class='summary-item'>
                        <div class='summary-label'>V/S</div>
                        <div class='summary-value' id='summaryVS'>--</div>
                    </div>
                </div>
                
                <div class='summary-secondary'>
                    <div class='summary-secondary-item'>
                        <span style='font-size: 10px; color: #888;'>FLAPS</span>
                        <span style='font-size: 12px; font-weight: bold; color: #167fac;' id='summaryFlaps'>--%</span>
                    </div>
                    <div class='summary-secondary-item'>
                        <span style='font-size: 10px; color: #888;'>GEAR</span>
                        <div id='summaryGear' class='arrow-up'></div>
                    </div>
                </div>
                
<div class='status-badges-row'>
    <span class='status-badge' id='apMasterStatus'>AP</span>
    <span class='status-badge' id='apAltStatus'>ALT</span>
    <span class='status-badge' id='apHdgStatus'>HDG</span>
    <span class='status-badge' id='apVSStatus'>V/S</span>
    <span class='status-badge' id='apSpeedStatus'>SPD</span>
    <span class='status-badge' id='apLocStatus'>LOC</span>
    <span class='status-badge active' id='apNavGpsStatus'>GPS</span>
    <span class='status-badge' id='apAppStatus'>APP</span>
    <span class='status-badge' id='autoThrottleStatus'>A/T</span>
</div>
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
                <button class='toggle-btn off' id='navMode' onclick='toggleNavMode()'>NAV</button>
            </div>
            
            <div class='control-row'>
                <span class='control-label'>LOC Hold</span>
                <button class='toggle-btn off' id='apNav' onclick='toggleAP("loc")'>OFF</button>
            </div>
            
            <div class='control-row'>
                <span class='control-label'>Approach</span>
                <button class='toggle-btn off' id='apApp' onclick='toggleAP("ils")'>OFF</button>
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
                <span class='control-label'>Speedbrake</span>
                <button class='toggle-btn off' id='spoilers' onclick='toggleSpeedbrake()'>RETRACTED</button>
            </div>
            
            <div class='control-row'>
                <span class='control-label'>Parking Brake</span>
                <button class='toggle-btn off' id='parkingBrake' onclick='toggleParkingBrake()'>OFF</button>
            </div>
        </div>
        
        <div class='card'>
            <h3>Exterior Lights</h3>
            
            <div class='control-row'>
                <span class='control-label'>Strobe Lights</span>
                <button class='toggle-btn off' id='lightStrobe' onclick='toggleLight("strobe")'>OFF</button>
            </div>
            
            <div class='control-row'>
                <span class='control-label'>Landing Lights</span>
                <button class='toggle-btn off' id='lightLanding' onclick='toggleLight("landing")'>OFF</button>
            </div>
            
            <div class='control-row'>
                <span class='control-label'>Taxi Lights</span>
                <button class='toggle-btn off' id='lightTaxi' onclick='toggleLight("taxi")'>OFF</button>
            </div>
            
            <div class='control-row'>
                <span class='control-label'>Beacon Lights</span>
                <button class='toggle-btn off' id='lightBeacon' onclick='toggleLight("beacon")'>OFF</button>
            </div>
            
            <div class='control-row'>
                <span class='control-label'>Nav Lights</span>
                <button class='toggle-btn off' id='lightNav' onclick='toggleLight("nav")'>OFF</button>
            </div>
            
            <div class='control-row'>
                <span class='control-label'>Logo Lights</span>
                <button class='toggle-btn off' id='lightLogo' onclick='toggleLight("logo")'>OFF</button>
            </div>
            
            <div class='control-row'>
                <span class='control-label'>Wing Lights</span>
                <button class='toggle-btn off' id='lightWing' onclick='toggleLight("wing")'>OFF</button>
            </div>
            
            <div class='control-row'>
                <span class='control-label'>Recognition Lights</span>
                <button class='toggle-btn off' id='lightRecognition' onclick='toggleLight("recognition")'>OFF</button>
            </div>
        </div>
        
        <div class='card'>
            <h3>Cabin & Interior</h3>
            
            <div class='control-row'>
                <span class='control-label'>Panel Lights</span>
                <button class='toggle-btn off' id='lightPanel' onclick='toggleLight("panel")'>OFF</button>
            </div>
            
            <div class='control-row'>
                <span class='control-label'>No Smoking Sign</span>
                <button class='toggle-btn off' id='noSmokingSwitch' onclick='toggleCabin("nosmoking")'>OFF</button>
            </div>
            
            <div class='control-row'>
                <span class='control-label'>Seatbelts Sign</span>
                <button class='toggle-btn off' id='seatbeltsSwitch' onclick='toggleCabin("seatbelts")'>OFF</button>
            </div>
        </div>
    </div>
</div>
    </div>

    <script>
        let ws = null;
        let map = null;
        let aircraftMarkers = [];
        let aiAircraft = [];
        let selectedAircraft = null;
        let mapCenterLat = 0;
        let mapCenterLon = 0;
        let mapZoom = 7;
        let followUser = false;
        let mapDragStart = null;
        let isDragging = false;
        let showAircraftLabels = true;
        let uniqueId = null;
        let hasControl = false;
        let isPaused = false;
        let userLat = 0;
        let userLon = 0;
        let userHeading = 0;
        let currentFlightData = {};
        let mapInitialized = false;
        let pfdCanvas = null;
        let pfdCtx = null;
        let mfdCanvas = null;
        let mfdCtx = null;

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
            
            if (index === 2 && !pfdCanvas) {
                setTimeout(initInstruments, 100);
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

                case 'save_complete':
                    closeSaveProgress(true, data.filename);
                    break;
                
                case 'save_error':
                    closeSaveProgress(false, '');
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
                        document.getElementById('controlLock').classList.remove('hidden');
                        document.getElementById('controlPanel').classList.add('hidden');
                        document.getElementById('controlPassword').value = '';
                        alert(data.message);
                    }
                    break;
                    
                case 'flight_data':
                    currentFlightData = data.data;
                    updateFlightData(data.data);
                    break;
                    
                case 'autopilot_state':
                    updateAutopilotUI(data.data);
                    break;
                    
                case 'ai_traffic':
                    aiAircraft = data.data;
                    updateNearbyAircraftList();
                    if (map) {
                        updateMap(userLat, userLon, userHeading);
                    }
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
            
            document.getElementById('nextWaypoint').textContent = data.nextWaypoint || 'No Active Waypoint';
            document.getElementById('wpDistance').textContent = 'Distance: ' + (data.distanceToWaypoint ? data.distanceToWaypoint.toFixed(1) + ' nm' : '--');
            document.getElementById('wpBearing').textContent = 'Bearing: ' + (data.bearingToWaypoint ? Math.round(data.bearingToWaypoint) + '°' : '--°');
            
            if (data.waypointEte && data.waypointEte > 0) {
                const wpHours = Math.floor(data.waypointEte / 3600);
                const wpMinutes = Math.floor((data.waypointEte % 3600) / 60);
                document.getElementById('wpEte').textContent = 'ETE: ' + (wpHours > 0 ? wpHours + 'h ' + wpMinutes + 'm' : wpMinutes + 'min');
            } else {
                document.getElementById('wpEte').textContent = 'ETE: --';
            }
            
            if (data.totalDistance && data.totalDistance > 0) {
                document.getElementById('distance').textContent = data.totalDistance.toFixed(1);
            } else {
                document.getElementById('distance').textContent = '--';
            }
            
            if (data.ete && data.ete > 0) {
                const hours = Math.floor(data.ete / 3600);
                const minutes = Math.floor((data.ete % 3600) / 60);
                document.getElementById('ete').textContent = 'Total ETE: ' + (hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'min');
            } else {
                document.getElementById('ete').textContent = 'Total ETE: --';
            }

            const pauseBadge = document.getElementById('pauseBadge');
            if (data.isPaused) {
                pauseBadge.classList.add('visible');
            } else {
                pauseBadge.classList.remove('visible');
            }

            const btnPause = document.getElementById('btnPause');
            if (data.isPaused) {
                btnPause.textContent = '▶️ Resume';
                btnPause.className = 'btn btn-warning';
            } else {
                btnPause.textContent = '⏸️ Pause';
                btnPause.className = 'btn btn-secondary';
            }

            if (map && data.latitude && data.longitude) {
                updateMap(data.latitude, data.longitude, data.heading);
            }
        }

function updateAutopilotUI(data) {
    // Store autopilot state globally for PFD access
    window.lastAutopilotState = data;
    
    updateToggle('apMaster', data.master);
            updateToggle('apAlt', data.altitude);
            updateToggle('apHdg', data.heading);
            updateToggle('apVS', data.vs);
            updateToggle('apSpeed', data.speed);
            updateToggle('apApp', data.approach);
            updateToggle('apNav', data.nav);
            updateToggle('autoThrottle', data.throttle);
            updateToggle('gear', data.gear, data.gear ? 'DOWN' : 'UP');
            updateToggle('parkingBrake', data.parkingBrake, data.parkingBrake ? 'ON' : 'OFF');
            
            document.getElementById('flapsPos').textContent = Math.round(data.flaps) + '%';
            
            const spoilersBtn = document.getElementById('spoilers');
            const spoilersActive = data.spoilers > 10;
            spoilersBtn.className = 'toggle-btn ' + (spoilersActive ? 'on' : 'off');
            spoilersBtn.textContent = spoilersActive ? 'EXTENDED' : 'RETRACTED';
            
            const navBtn = document.getElementById('navMode');
            navBtn.textContent = data.navMode ? 'GPS' : 'NAV';
            navBtn.className = 'toggle-btn ' + (data.navMode ? 'on' : 'off');
            
            updateToggle('lightStrobe', data.lightStrobe);
            updateToggle('lightPanel', data.lightPanel);
            updateToggle('lightLanding', data.lightLanding);
            updateToggle('lightTaxi', data.lightTaxi);
            updateToggle('lightBeacon', data.lightBeacon);
            updateToggle('lightNav', data.lightNav);
            updateToggle('lightLogo', data.lightLogo);
            updateToggle('lightWing', data.lightWing);
            updateToggle('lightRecognition', data.lightRecognition);
            updateToggle('noSmokingSwitch', data.noSmokingSwitch);
            updateToggle('seatbeltsSwitch', data.seatbeltsSwitch);
            
            updateFlightSummary(data);
            updateAutopilotStatus(data);
        }

        function updateFlightSummary(data) {
            const speedValue = data.apSpeed !== undefined ? Math.round(data.apSpeed) : '--';
            document.getElementById('summarySpeed').textContent = speedValue;
            
            const headingValue = data.apHeading !== undefined ? Math.round(data.apHeading) : '--';
            document.getElementById('summaryHeading').textContent = headingValue + '°';
            
            const altValue = data.apAltitude !== undefined ? Math.round(data.apAltitude).toLocaleString() : '--';
            document.getElementById('summaryAltitude').textContent = altValue;
            
            const vsValue = data.apVerticalSpeed !== undefined ? Math.round(data.apVerticalSpeed) : '--';
            document.getElementById('summaryVS').textContent = vsValue;
            
            document.getElementById('summaryFlaps').textContent = Math.round(data.flaps) + '%';
            
            const gearElement = document.getElementById('summaryGear');
            if (data.gear) {
                gearElement.className = 'arrow-down';
            } else {
                gearElement.className = 'arrow-up';
            }
        }

function updateAutopilotStatus(data) {
    updateStatusBadge('apMasterStatus', data.master);
    updateStatusBadge('apAltStatus', data.altitude);
    updateStatusBadge('apHdgStatus', data.heading);
    updateStatusBadge('apVSStatus', data.vs);
    updateStatusBadge('apSpeedStatus', data.speed);
    updateStatusBadge('apLocStatus', data.nav);
    updateStatusBadge('apAppStatus', data.approach);
    updateStatusBadge('autoThrottleStatus', data.throttle);
    
    // Update NAV/GPS status - always active, just shows which mode
    const navGpsStatus = document.getElementById('apNavGpsStatus');
    navGpsStatus.classList.add('active');
    navGpsStatus.textContent = data.navMode ? 'GPS' : 'NAV';
}

        function updateStatusBadge(id, isActive) {
            const badge = document.getElementById(id);
            if (isActive) {
                badge.classList.add('active');
            } else {
                badge.classList.remove('active');
            }
        }

        function updateToggle(id, state, text) {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.className = 'toggle-btn ' + (state ? 'on' : 'off');
            btn.textContent = text || (state ? 'ON' : 'OFF');
        }

        function createUserAircraftIcon(heading, isSelected) {
            const color = isSelected ? "#FF0000" : "#FFD700";
            const size = isSelected ? 26 : 24;
            
            return L.divIcon({
                html: \`<div class="user-aircraft \${isSelected ? 'selected' : ''}" style="transform: rotate(\${heading}deg);"><svg width="\${size}" height="\${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="\${color}" stroke="#000" stroke-width="0.5"/></svg></div>\`,
                className: '',
                iconSize: [size, size],
                iconAnchor: [size/2, size/2]
            });
        }

        function createAIAircraftIcon(heading, isSelected) {
            const color = isSelected ? "#FF0000" : "#FFFFFF";
            const size = isSelected ? 18 : 16;
            
            return L.divIcon({
                html: \`<div class="ai-aircraft \${isSelected ? 'selected' : ''}" style="transform: rotate(\${heading}deg);"><svg width="\${size}" height="\${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="\${color}" stroke="#000" stroke-width="0.5"/></svg></div>\`,
                className: '',
                iconSize: [size, size],
                iconAnchor: [size/2, size/2]
            });
        }

        function initMap() {
            map = L.map('map', {
                center: [0, 0],
                zoom: mapZoom,
                zoomControl: false
            });
            
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors',
                maxZoom: 18
            }).addTo(map);
            
            L.control.zoom({
                position: 'bottomright'
            }).addTo(map);

            document.getElementById('followUserBtn').textContent = followUser ? 'Following' : 'Follow Aircraft';
            
            map.on('mousedown', function(e) {
                if (e.originalEvent.button === 0) {
                    isDragging = true;
                    mapDragStart = e.latlng;
                }
            });
            
            map.on('mousemove', function(e) {
                if (isDragging && mapDragStart) {
                    map.panBy([mapDragStart.lat - e.latlng.lat, mapDragStart.lng - e.latlng.lng]);
                    mapDragStart = e.latlng;
                }
            });
            
            map.on('mouseup', function() {
                isDragging = false;
                mapDragStart = null;
            });
            
            map.on('click', function(e) {
                if (e.originalEvent.target.closest('.leaflet-marker-icon')) {
                    return;
                }
                
                selectedAircraft = null;
                updateMap(userLat, userLon, userHeading);
                updateNearbyAircraftList();
                
                const detailsPanel = document.getElementById('aircraftDetails');
                detailsPanel.innerHTML = '<p>Click on an aircraft to view details</p>';
            });
            
            map.on('moveend', function() {
                const center = map.getCenter();
                mapCenterLat = center.lat;
                mapCenterLon = center.lng;
                mapZoom = map.getZoom();
                document.getElementById('zoomLevel').textContent = 'Zoom: ' + mapZoom;
            });
        }

        function updateMap(lat, lon, heading) {
            if (!map) return;
            
            userLat = lat;
            userLon = lon;
            userHeading = heading;

            if (!mapInitialized) {
                map.setView([lat, lon], mapZoom);
                mapInitialized = true;
            }
            
            if (followUser) {
                map.setView([lat, lon], mapZoom);
            }
            
            if (aircraftMarkers) {
                aircraftMarkers.forEach(marker => map.removeLayer(marker));
                aircraftMarkers = [];
            } else {
                aircraftMarkers = [];
            }
            
            const userIsSelected = selectedAircraft && selectedAircraft.isUser;
            const userMarker = L.marker([lat, lon], { 
                icon: createUserAircraftIcon(heading, userIsSelected) 
            }).addTo(map);

            const userCallsign = currentFlightData.atcId || "Your Aircraft";
            const userFlightInfo = (currentFlightData.atcAirline && currentFlightData.atcFlightNumber) 
                ? currentFlightData.atcAirline + " " + currentFlightData.atcFlightNumber 
                : "";
            const userAircraftModel = currentFlightData.atcModel || currentFlightData.atcType || "User Aircraft";

            const userPopupContent = \`<div style="min-width:200px"><h4 style="margin:0 0 5px 0">\${userCallsign}</h4>\${userFlightInfo ? \`<p style="margin:0 0 5px 0">\${userFlightInfo}</p>\` : ""}<p style="margin:0 0 5px 0">Aircraft: \${userAircraftModel}</p><p style="margin:0 0 5px 0">Speed: \${Math.round(currentFlightData.groundSpeed || 0)} kts</p><p style="margin:0 0 5px 0">Altitude: \${Math.round(currentFlightData.altitude || 0)} ft</p><p style="margin:0">Heading: \${Math.round(currentFlightData.heading || 0)}°</p></div>\`;

            userMarker.bindPopup(userPopupContent);

userMarker.on('click', function(e) {
    L.DomEvent.stopPropagation(e);
    selectedAircraft = { isUser: true };
    updateUserAircraftDetails();
    updateMap(lat, lon, heading);
    updateNearbyAircraftList();
});
            
            aircraftMarkers.push(userMarker);
            
            aiAircraft.forEach(aircraft => {
                const isSelected = selectedAircraft && 
                                ((selectedAircraft.atcId && selectedAircraft.atcId === aircraft.atcId) || 
                                 (!selectedAircraft.atcId && selectedAircraft.title === aircraft.title));
                
                const marker = L.marker([aircraft.latitude, aircraft.longitude], { 
                    icon: createAIAircraftIcon(aircraft.heading, isSelected)
                }).addTo(map);
                
                let callsign = aircraft.atcId || "N/A";
                let flightInfo = "";
                if (aircraft.atcAirline && aircraft.atcFlightNumber) {
                    flightInfo = aircraft.atcAirline + " " + aircraft.atcFlightNumber;
                } else if (aircraft.atcAirline) {
                    flightInfo = aircraft.atcAirline;
                }
                
                let routeInfo = "";
                if (aircraft.departureAirport && aircraft.destinationAirport) {
                    routeInfo = aircraft.departureAirport + " → " + aircraft.destinationAirport;
                } else if (aircraft.destinationAirport) {
                    routeInfo = "To " + aircraft.destinationAirport;
                }
                
                const popupContent = \`<div style="min-width:200px"><h4 style="margin:0 0 5px 0">\${callsign}</h4>\${flightInfo ? \`<p style="margin:0 0 5px 0">\${flightInfo}</p>\` : ""}<p style="margin:0 0 5px 0">Aircraft: \${aircraft.atcModel || aircraft.atcType || aircraft.title}</p>\${routeInfo ? \`<p style="margin:0 0 5px 0">Route: \${routeInfo}</p>\` : ""}<p style="margin:0 0 5px 0">Speed: \${Math.round(aircraft.groundSpeed)} kts</p><p style="margin:0 0 5px 0">Altitude: \${Math.round(aircraft.altitude)} ft</p><p style="margin:0">Distance: \${aircraft.distanceFromUser.toFixed(1)} nm</p></div>\`;
                
                marker.bindPopup(popupContent);
                
                marker.on('click', function(e) {
                    L.DomEvent.stopPropagation(e);
                    selectedAircraft = aircraft;
                    updateAircraftDetails(aircraft);
                    updateMap(lat, lon, heading);
                    updateNearbyAircraftList();
                });
                
                aircraftMarkers.push(marker);
                
                if (showAircraftLabels) {
                    const label = L.divIcon({
                        html: \`<div style="background:rgba(0,0,0,0.7);color:white;padding:2px 5px;border-radius:3px;font-size:11px;white-space:nowrap">\${aircraft.atcId || aircraft.title.substring(0, 10)}</div>\`,
                        className: '',
                        iconSize: [100, 20],
                        iconAnchor: [50, -10]
                    });
                    
                    const labelMarker = L.marker([aircraft.latitude, aircraft.longitude], { icon: label }).addTo(map);
                    aircraftMarkers.push(labelMarker);
                }
            });
        }

function updateUserAircraftDetails() {
    const detailsPanel = document.getElementById('aircraftDetails');
    if (!detailsPanel) return;
    
    const callsign = currentFlightData.atcId || "Your Aircraft";
    
    let flightInfo = "";
    if (currentFlightData.atcAirline && currentFlightData.atcFlightNumber) {
        flightInfo = currentFlightData.atcAirline + " " + currentFlightData.atcFlightNumber;
    } else if (currentFlightData.atcAirline) {
        flightInfo = currentFlightData.atcAirline;
    }
    
    const aircraftModel = currentFlightData.atcModel || currentFlightData.atcType || "User Aircraft";
    
    const routeInfo = (currentFlightData.flightPlanOrigin && currentFlightData.flightPlanDestination) 
        ? currentFlightData.flightPlanOrigin + " → " + currentFlightData.flightPlanDestination 
        : "";
    
    let html = '<h4 style="margin-top:0">' + callsign + '</h4>';
    
    if (flightInfo) {
        html += '<p><strong>Flight:</strong> ' + flightInfo + '</p>';
    }
    
    html += '<p><strong>Aircraft:</strong> ' + aircraftModel + '</p>';
    
    if (routeInfo) {
        html += '<p><strong>Route:</strong> ' + routeInfo + '</p>';
    }
    
    html += '<div class="detail-row">' +
            '<span class="detail-label">Departure:</span>' +
            '<span class="detail-value">' + (currentFlightData.flightPlanOrigin || 'N/A') + '</span>' +
            '</div>' +
            '<div class="detail-row">' +
            '<span class="detail-label">Destination:</span>' +
            '<span class="detail-value">' + (currentFlightData.flightPlanDestination || 'N/A') + '</span>' +
            '</div>' +
            '<div class="detail-row">' +
            '<span class="detail-label">Speed:</span>' +
            '<span class="detail-value">' + Math.round(currentFlightData.groundSpeed || 0) + ' kts</span>' +
            '</div>' +
            '<div class="detail-row">' +
            '<span class="detail-label">Altitude:</span>' +
            '<span class="detail-value">' + Math.round(currentFlightData.altitude || 0) + ' ft</span>' +
            '</div>';
    
    detailsPanel.innerHTML = html;
}

        function updateAircraftDetails(aircraft) {
            const detailsPanel = document.getElementById('aircraftDetails');
            if (!detailsPanel) return;
            
            let callsign = aircraft.atcId || "N/A";
            let flightInfo = "";
            if (aircraft.atcAirline && aircraft.atcFlightNumber) {
                flightInfo = aircraft.atcAirline + " " + aircraft.atcFlightNumber;
            } else if (aircraft.atcAirline) {
                flightInfo = aircraft.atcAirline;
            }
            
            let routeInfo = "";
            if (aircraft
            .departureAirport && aircraft.destinationAirport) {
                routeInfo = aircraft.departureAirport + " → " + aircraft.destinationAirport;
            } else if (aircraft.destinationAirport) {
                routeInfo = "To " + aircraft.destinationAirport;
            }
            
            detailsPanel.innerHTML = \`<h4 style="margin-top:0">\${callsign}</h4>\${flightInfo ? \`<p><strong>Flight:</strong> \${flightInfo}</p>\` : ""}<p><strong>Aircraft:</strong> \${aircraft.atcModel || aircraft.atcType || aircraft.title}</p>\${routeInfo ? \`<p><strong>Route:</strong> \${routeInfo}</p>\` : ""}<div class="detail-row"><span class="detail-label">Departure:</span><span class="detail-value">\${aircraft.departureAirport || 'N/A'}</span></div><div class="detail-row"><span class="detail-label">Destination:</span><span class="detail-value">\${aircraft.destinationAirport || 'N/A'}</span></div><div class="detail-row"><span class="detail-label">Speed:</span><span class="detail-value">\${Math.round(aircraft.groundSpeed)} kts</span></div><div class="detail-row"><span class="detail-label">Altitude:</span><span class="detail-value">\${Math.round(aircraft.altitude)} ft</span></div><div class="detail-row"><span class="detail-label">Distance:</span><span class="detail-value">\${aircraft.distanceFromUser.toFixed(1)} nm</span></div>\`;
        }

        function updateNearbyAircraftList() {
            const list = document.getElementById('nearbyAircraftList');
            if (!list) return;
            
            list.innerHTML = '';
            
            const userItem = document.createElement('div');
            userItem.className = 'aircraft-list-item';
            if (selectedAircraft && selectedAircraft.isUser) {
                userItem.classList.add('selected');
            }
            
            userItem.innerHTML = \`<div class="aircraft-callsign">Your Aircraft</div><div class="aircraft-distance">0 nm</div>\`;
            
            userItem.addEventListener('click', function() {
                selectedAircraft = { isUser: true };
                map.setView([userLat, userLon], mapZoom);
                followUser = true;
                document.getElementById('followUserBtn').textContent = 'Following';
                updateUserAircraftDetails();
                updateMap(userLat, userLon, userHeading);
                updateNearbyAircraftList();
            });
            
            list.appendChild(userItem);
            
            const separator = document.createElement('div');
            separator.style.cssText = 'height: 1px; background: #333; margin: 5px 0;';
            list.appendChild(separator);
            
            if (aiAircraft.length === 0) {
                list.innerHTML += '<div class="no-aircraft">No nearby aircraft</div>';
                return;
            }
            
            aiAircraft.slice(0, 10).forEach(aircraft => {
                const callsign = aircraft.atcId || aircraft.title.substring(0, 15);
                const item = document.createElement('div');
                item.className = 'aircraft-list-item';
                if (selectedAircraft && 
                    ((selectedAircraft.atcId && selectedAircraft.atcId === aircraft.atcId) || 
                     (!selectedAircraft.atcId && selectedAircraft.title === aircraft.title))) {
                    item.classList.add('selected');
                }
                
                item.innerHTML = \`<div class="aircraft-callsign">\${callsign}</div><div class="aircraft-distance">\${aircraft.distanceFromUser.toFixed(1)} nm</div>\`;
                
                item.addEventListener('click', function() {
                    selectedAircraft = aircraft;
                    map.setView([aircraft.latitude, aircraft.longitude], 10);
                    followUser = false;
                    document.getElementById('followUserBtn').textContent = 'Follow Aircraft';
                    updateAircraftDetails(aircraft);
                    updateMap(userLat, userLon, userHeading);
                    updateNearbyAircraftList();
                });
                
                list.appendChild(item);
            });
        }

        function toggleAircraftLabels() {
            showAircraftLabels = !showAircraftLabels;
            document.getElementById('toggleLabelsBtn').textContent = showAircraftLabels ? 'Hide Labels' : 'Show Labels';
            updateMap(userLat, userLon, userHeading);
        }

        function toggleFollowUser() {
            followUser = !followUser;
            const btn = document.getElementById('followUserBtn');
            
            if (followUser) {
                btn.textContent = 'Following';
                map.setView([userLat, userLon], mapZoom);
            } else {
                btn.textContent = 'Follow Aircraft';
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
            const saveBtn = document.querySelector('button[onclick="saveGame()"]');
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.textContent = '💾 Saving...';
            }
            
            ws.send(JSON.stringify({ type: 'save_game' }));
            
            showSaveProgress();
            
            let countdown = 60;
            const disableInterval = setInterval(() => {
                countdown--;
                if (saveBtn) {
                    saveBtn.textContent = '💾 Wait ' + countdown + 's';
                }
                
                if (countdown <= 0) {
                    clearInterval(disableInterval);
                    if (saveBtn) {
                        saveBtn.disabled = false;
                        saveBtn.textContent = '💾 Save Flight';
                    }
                }
            }, 1000);
        }

        function showSaveProgress() {
            const overlay = document.createElement('div');
            overlay.id = 'saveProgressOverlay';
            overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';
            
            overlay.innerHTML = \`<div style="background: #1a1a1a; padding: 30px; border-radius: 15px; text-align: center; border: 2px solid #167fac;"><div style="font-size: 40px; margin-bottom: 15px;">💾</div><h3 style="margin: 0 0 10px 0; color: #167fac;">Saving Flight...</h3><div style="color: #888; font-size: 14px;">Please wait</div><div style="margin-top: 20px;"><div style="width: 200px; height: 4px; background: #333; border-radius: 2px; overflow: hidden;"><div id="saveProgressBar" style="width: 0%; height: 100%; background: #167fac; transition: width 0.3s;"></div></div></div></div>\`;
            
            document.body.appendChild(overlay);
            
            let progress = 0;
            const progressBar = document.getElementById('saveProgressBar');
            const interval = setInterval(() => {
                progress += 10;
                if (progress <= 90) {
                    progressBar.style.width = progress + '%';
                }
            }, 200);
            
            overlay.dataset.intervalId = interval;
        }

        function closeSaveProgress(success, filename) {
            const overlay = document.getElementById('saveProgressOverlay');
            if (!overlay) return;
            
            const intervalId = overlay.dataset.intervalId;
            if (intervalId) {
                clearInterval(parseInt(intervalId));
            }
            
            const progressBar = document.getElementById('saveProgressBar');
            if (progressBar) {
                progressBar.style.width = '100%';
            }
            
            const content = overlay.querySelector('div > div');
            if (success) {
                content.innerHTML = '<div style="font-size: 40px; margin-bottom: 15px;">✅</div><h3 style="margin: 0 0 10px 0; color: #4CAF50;">Flight Saved!</h3><div style="color: #ccc; font-size: 14px;">' + filename + '</div>';
            } else {
                content.innerHTML = '<div style="font-size: 40px; margin-bottom: 15px;">❌</div><h3 style="margin: 0 0 10px 0; color: #f44336;">Save Failed</h3><div style="color: #ccc; font-size: 14px;">Please try again</div>';
            }
            
            setTimeout(() => {
                overlay.remove();
            }, 2000);
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

        function toggleSpeedbrake() {
            ws.send(JSON.stringify({ type: 'toggle_speedbrake' }));
        }

        function toggleParkingBrake() {
            ws.send(JSON.stringify({ type: 'toggle_parking_brake' }));
        }

        function changeFlaps(direction) {
            ws.send(JSON.stringify({ type: 'change_flaps', direction }));
        }
        
        function toggleLight(lightType) {
            ws.send(JSON.stringify({ type: 'toggle_light', lightType: lightType }));
        }

        function toggleCabin(cabinType) {
            ws.send(JSON.stringify({ type: 'toggle_cabin', cabinType: cabinType }));
        }
function initInstruments() {
            pfdCanvas = document.getElementById('pfdCanvas');
            pfdCtx = pfdCanvas.getContext('2d');
            mfdCanvas = document.getElementById('mfdCanvas');
            mfdCtx = mfdCanvas.getContext('2d');
            
            // Start drawing loop
            requestAnimationFrame(drawInstruments);
        }
        
        function drawInstruments() {
            if (pfdCtx && currentFlightData) {
                drawPFD();
            }
            if (mfdCtx && currentFlightData) {
                drawMFD();
            }
            requestAnimationFrame(drawInstruments);
        }
        
function drawPFD() {
    const ctx = pfdCtx;
    const width = pfdCanvas.width;
    const height = pfdCanvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    
    // Clear canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    
    // Get flight data
    const pitch = currentFlightData.pitch || 0;
    const roll = currentFlightData.roll || 0;
    const altitude = currentFlightData.altitude || 0;
    const speed = currentFlightData.groundSpeed || 0;
    const heading = currentFlightData.heading || 0;
    const vs = currentFlightData.verticalSpeed || 0;
    
    // Get autopilot status from autopilot state
    const apData = window.lastAutopilotState || {};
    const apMaster = apData.master || false;
    const autoThrottle = apData.throttle || false;
    
    // Define the horizon display area (clipped to avoid tapes)
    const horizonLeft = 75;
    const horizonRight = width - 95;
    const horizonTop = 35;
    const horizonBottom = height - 50;
    const horizonWidth = horizonRight - horizonLeft;
    const horizonHeight = horizonBottom - horizonTop;
    const horizonCenterX = horizonLeft + horizonWidth / 2;
    const horizonCenterY = horizonTop + horizonHeight / 2;
    
    // Draw artificial horizon (clipped with rounded edges effect)
    ctx.save();
    
    // Create rounded rectangle clip path
    ctx.beginPath();
    const cornerRadius = 15;
    ctx.moveTo(horizonLeft + cornerRadius, horizonTop);
    ctx.lineTo(horizonRight - cornerRadius, horizonTop);
    ctx.arcTo(horizonRight, horizonTop, horizonRight, horizonTop + cornerRadius, cornerRadius);
    ctx.lineTo(horizonRight, horizonBottom - cornerRadius);
    ctx.arcTo(horizonRight, horizonBottom, horizonRight - cornerRadius, horizonBottom, cornerRadius);
    ctx.lineTo(horizonLeft + cornerRadius, horizonBottom);
    ctx.arcTo(horizonLeft, horizonBottom, horizonLeft, horizonBottom - cornerRadius, cornerRadius);
    ctx.lineTo(horizonLeft, horizonTop + cornerRadius);
    ctx.arcTo(horizonLeft, horizonTop, horizonLeft + cornerRadius, horizonTop, cornerRadius);
    ctx.closePath();
    ctx.clip();
    
    ctx.translate(horizonCenterX, horizonCenterY);
    ctx.rotate(roll * Math.PI / 180);
    
    // Sky with gradient
    const skyGrad = ctx.createLinearGradient(0, -height, 0, 0);
    skyGrad.addColorStop(0, '#0066cc');
    skyGrad.addColorStop(1, '#0099ff');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(-width, -height - pitch * 2.5, width * 2, height * 2);
    
    // Ground with gradient
    const groundGrad = ctx.createLinearGradient(0, 0, 0, height);
    groundGrad.addColorStop(0, '#8B4513');
    groundGrad.addColorStop(1, '#654321');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(-width, -pitch * 2.5, width * 2, height * 2);
    
    // Horizon line - thicker and white
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-width, -pitch * 2.5);
    ctx.lineTo(width, -pitch * 2.5);
    ctx.stroke();
    
    // Pitch ladder
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.font = 'bold 12px Arial';
    
    for (let p = -90; p <= 90; p += 10) {
        if (p === 0) continue;
        const y = (pitch - p) * 2.5;
        const lineWidth = p % 20 === 0 ? 50 : 25;
        
        // Pitch lines
        ctx.beginPath();
        ctx.moveTo(-lineWidth / 2, y);
        ctx.lineTo(lineWidth / 2, y);
        ctx.stroke();
        
        // Pitch numbers for major marks
        if (p % 20 === 0) {
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'right';
            ctx.fillText(Math.abs(p), -lineWidth / 2 - 8, y + 5);
            ctx.textAlign = 'left';
            ctx.fillText(Math.abs(p), lineWidth / 2 + 8, y + 5);
        }
    }
    
    ctx.restore();
    
    // Fixed aircraft symbol - yellow with black outline
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(horizonCenterX - 40, horizonCenterY);
    ctx.lineTo(horizonCenterX - 12, horizonCenterY);
    ctx.moveTo(horizonCenterX + 12, horizonCenterY);
    ctx.lineTo(horizonCenterX + 40, horizonCenterY);
    ctx.moveTo(horizonCenterX, horizonCenterY);
    ctx.lineTo(horizonCenterX, horizonCenterY + 10);
    ctx.stroke();
    
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(horizonCenterX - 40, horizonCenterY);
    ctx.lineTo(horizonCenterX - 12, horizonCenterY);
    ctx.moveTo(horizonCenterX + 12, horizonCenterY);
    ctx.lineTo(horizonCenterX + 40, horizonCenterY);
    ctx.moveTo(horizonCenterX, horizonCenterY);
    ctx.lineTo(horizonCenterX, horizonCenterY + 10);
    ctx.stroke();
    
    // Center dot
    ctx.fillStyle = '#ffff00';
    ctx.beginPath();
    ctx.arc(horizonCenterX, horizonCenterY, 3, 0, Math.PI * 2);
    ctx.fill();
    
    // Roll indicator at top
    ctx.save();
    ctx.translate(horizonCenterX, 55);
    
    // Roll arc
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 70, -Math.PI * 0.65, -Math.PI * 0.35, false);
    ctx.stroke();
    
    // Roll markers
    [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].forEach(angle => {
        const rad = angle * Math.PI / 180 - Math.PI / 2;
        const isLarge = [0, -30, -45, 30, 45].includes(angle);
        const length = isLarge ? 12 : 8;
        const x1 = Math.cos(rad) * 70;
        const y1 = Math.sin(rad) * 70;
        const x2 = Math.cos(rad) * (70 - length);
        const y2 = Math.sin(rad) * (70 - length);
        
        ctx.lineWidth = isLarge ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    });
    
    // Roll pointer (yellow triangle)
    ctx.rotate(-roll * Math.PI / 180);
    ctx.fillStyle = '#ffff00';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -70);
    ctx.lineTo(-6, -58);
    ctx.lineTo(6, -58);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Bank angle indicator (white triangle at top)
    ctx.rotate(roll * Math.PI / 180);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, -72);
    ctx.lineTo(-5, -62);
    ctx.lineTo(5, -62);
    ctx.closePath();
    ctx.fill();
    
    ctx.restore();
    
    // Speed tape (left side) - more realistic
    const tapeX = 15;
    const tapeY = horizonTop;
    const tapeWidth = 50;
    const tapeHeight = horizonHeight;
    
    // Speed tape background
    ctx.fillStyle = 'rgba(50, 50, 50, 0.8)';
    ctx.fillRect(tapeX, tapeY, tapeWidth, tapeHeight);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(tapeX, tapeY, tapeWidth, tapeHeight);
    
    // Speed markings
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'right';
    
    for (let s = Math.floor(speed / 20) * 20 - 80; s <= speed + 80; s += 20) {
        if (s < 0) continue;
        const y = horizonCenterY - (s - speed) * 1.5;
        if (y >= tapeY + 10 && y <= tapeY + tapeHeight - 10) {
            ctx.fillStyle = '#fff';
            ctx.fillText(s, tapeX + tapeWidth - 5, y + 5);
            
            // Tick marks
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(tapeX, y);
            ctx.lineTo(tapeX + 10, y);
            ctx.stroke();
        }
    }
    
    // Speed readout box
    ctx.fillStyle = '#000';
    ctx.fillRect(tapeX, horizonCenterY - 18, tapeWidth, 36);
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth = 2;
    ctx.strokeRect(tapeX, horizonCenterY - 18, tapeWidth, 36);
    
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(speed), tapeX + tapeWidth / 2, horizonCenterY + 7);
    
    // Altitude tape (right side)
    const altTapeX = width - tapeX - tapeWidth - 20;
    
    ctx.fillStyle = 'rgba(50, 50, 50, 0.8)';
    ctx.fillRect(altTapeX, tapeY, tapeWidth, tapeHeight);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(altTapeX, tapeY, tapeWidth, tapeHeight);
    
    // Altitude markings
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'left';
    
    const altStep = 100;
    for (let a = Math.floor(altitude / altStep) * altStep - 500; a <= altitude + 500; a += altStep) {
        const y = horizonCenterY - (a - altitude) * 0.4;
        if (y >= tapeY + 10 && y <= tapeY + tapeHeight - 10) {
            if (a % 200 === 0) {
                ctx.fillStyle = '#fff';
                ctx.fillText(a, altTapeX + 8, y + 5);
                
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(altTapeX + tapeWidth - 10, y);
                ctx.lineTo(altTapeX + tapeWidth, y);
                ctx.stroke();
            }
        }
    }
    
    // Altitude readout box
    ctx.fillStyle = '#000';
    ctx.fillRect(altTapeX, horizonCenterY - 18, tapeWidth, 36);
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    ctx.strokeRect(altTapeX, horizonCenterY - 18, tapeWidth, 36);
    
    ctx.fillStyle = '#00ff00';
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(altitude), altTapeX + tapeWidth / 2, horizonCenterY + 7);
    
    // Vertical speed indicator (right side)
    const vsiX = width - 15;
    const vsiY = horizonCenterY - 80;
    const vsiHeight = 160;
    
    // VSI scale
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(vsiX, vsiY);
    ctx.lineTo(vsiX, vsiY + vsiHeight);
    ctx.stroke();
    
    // VSI marks
    [6, 4, 2, 1, 0, -1, -2, -4, -6].forEach(n => {
        const y = horizonCenterY - n * 13;
        ctx.strokeStyle = '#888';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(vsiX - 5, y);
        ctx.lineTo(vsiX, y);
        ctx.stroke();
    });
    
    // VSI pointer
    const vsIndicator = Math.max(-6, Math.min(6, vs / 500));
    const vsY = horizonCenterY - vsIndicator * 13;
    
    ctx.fillStyle = '#00ff00';
    ctx.beginPath();
    ctx.moveTo(vsiX - 12, horizonCenterY);
    ctx.lineTo(vsiX - 3, vsY);
    ctx.lineTo(vsiX, vsY);
    ctx.lineTo(vsiX, horizonCenterY);
    ctx.closePath();
    ctx.fill();
    
    // Heading tape (bottom) - 15px gap from bottom
    const hdgTapeY = height - 45;
    const hdgTapeHeight = 30;
    
    ctx.fillStyle = 'rgba(50, 50, 50, 0.8)';
    ctx.fillRect(horizonCenterX - 100, hdgTapeY, 200, hdgTapeHeight);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(horizonCenterX - 100, hdgTapeY, 200, hdgTapeHeight);
    
    // Heading marks
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'center';
    
    for (let h = Math.floor(heading / 10) * 10 - 30; h <= heading + 30; h += 10) {
        const hdg = ((h % 360) + 360) % 360;
        const x = horizonCenterX + (hdg - heading) * 3;
        
        if (hdg % 30 === 0) {
            const hdgText = hdg === 0 ? '36' : (hdg / 10).toString().padStart(2, '0');
            ctx.fillText(hdgText, x, hdgTapeY + 20);
        }
        
        // Tick
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, hdgTapeY);
        ctx.lineTo(x, hdgTapeY + 8);
        ctx.stroke();
    }
    
    // Heading bug (center triangle)
    ctx.fillStyle = '#ffff00';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(horizonCenterX, hdgTapeY);
    ctx.lineTo(horizonCenterX - 8, hdgTapeY - 8);
    ctx.lineTo(horizonCenterX + 8, hdgTapeY - 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Top status bar with real-time autopilot status
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, width, 30);
    
    // Get current autopilot values
    const apSpeed = apData.apSpeed || speed;
    const apHeading = apData.apHeading || heading;
    const apAltitude = apData.apAltitude || altitude;
    
    // Left side - Speed status
    ctx.fillStyle = apData.speed ? '#00ff00' : '#888';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('SPEED', 10, 12);
    ctx.font = 'bold 14px Arial';
    ctx.fillText(Math.round(apSpeed), 10, 26);
    
    // Center left - G/S indicator
    ctx.fillStyle = '#00ff00';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('G/S', width / 4, 20);
    
    // Center - LOC status
    ctx.fillStyle = apData.nav ? '#00ff00' : '#888';
    ctx.fillText('LOC', width / 2, 20);
    
    // Center right - Heading status
    ctx.fillStyle = apData.heading ? '#00ff00' : '#888';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('HDG', width * 0.65, 12);
    ctx.font = 'bold 14px Arial';
    ctx.fillText(Math.round(apHeading) + '°', width * 0.65, 26);
    
    // Right center - Altitude status
    ctx.fillStyle = apData.altitude ? '#00ff00' : '#888';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'right';
    ctx.fillText('ALT', width - 60, 12);
    ctx.font = 'bold 14px Arial';
    ctx.fillText(Math.round(apAltitude), width - 60, 26);
    
    // Far right - AP1 and A/THR status stacked (only if active)
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px Arial';
    
    if (apMaster) {
        ctx.fillText('AP1', width - 10, 12);
    }
    if (autoThrottle) {
        ctx.fillText('A/THR', width - 10, 24);
    }
}
        
        function drawMFD() {
            const ctx = mfdCtx;
            const width = mfdCanvas.width;
            const height = mfdCanvas.height;
            const centerX = width / 2;
            const centerY = height / 2;
            
            // Clear canvas
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, width, height);
            
            const heading = currentFlightData.heading || 0;
            const groundSpeed = currentFlightData.groundSpeed || 0;
            const trueAirspeed = currentFlightData.airspeed || groundSpeed;
            
            // Draw compass rose
            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate(-heading * Math.PI / 180);
            
            // Compass circles
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(0, 0, 80, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(0, 0, 120, 0, Math.PI * 2);
            ctx.stroke();
            
            // Cardinal directions
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 16px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            // N
            ctx.fillText('N', 0, -130);
            // E
            ctx.fillText('E', 130, 0);
            // S
            ctx.fillText('S', 0, 130);
            // W
            ctx.fillText('W', -130, 0);
            
            // Heading marks every 30 degrees
            for (let i = 0; i < 360; i += 30) {
                const rad = i * Math.PI / 180;
                const x1 = Math.sin(rad) * 110;
                const y1 = -Math.cos(rad) * 110;
                const x2 = Math.sin(rad) * 120;
                const y2 = -Math.cos(rad) * 120;
                
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
                
                // Heading numbers
                if (i % 30 === 0 && ![0, 90, 180, 270].includes(i)) {
                    const x3 = Math.sin(rad) * 100;
                    const y3 = -Math.cos(rad) * 100;
                    ctx.fillStyle = '#888';
                    ctx.font = '12px Arial';
                    ctx.fillText(i.toString().padStart(3, '0'), x3, y3);
                }
            }
            
            ctx.restore();
            
            // Fixed aircraft symbol
            ctx.strokeStyle = '#ffff00';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(centerX - 15, centerY);
            ctx.lineTo(centerX - 5, centerY - 8);
            ctx.lineTo(centerX + 5, centerY - 8);
            ctx.lineTo(centerX + 15, centerY);
            ctx.lineTo(centerX + 5, centerY - 8);
            ctx.lineTo(centerX, centerY - 20);
            ctx.lineTo(centerX - 5, centerY - 8);
            ctx.closePath();
            ctx.stroke();
            ctx.fillStyle = '#ffff00';
            ctx.fill();
            
            // Heading bug (autopilot heading)
            const apHeading = currentFlightData.apHeading || heading;
            const bugAngle = (apHeading - heading) * Math.PI / 180;
            const bugX = centerX + Math.sin(bugAngle) * 120;
            const bugY = centerY - Math.cos(bugAngle) * 120;
            
            ctx.fillStyle = '#ff00ff';
            ctx.beginPath();
            ctx.moveTo(bugX, bugY - 10);
            ctx.lineTo(bugX - 6, bugY);
            ctx.lineTo(bugX + 6, bugY);
            ctx.closePath();
            ctx.fill();
            
            // Info boxes
            // Ground Speed
            ctx.fillStyle = '#0d0d0d';
            ctx.fillRect(10, 10, 80, 30);
            ctx.strokeStyle = '#333';
            ctx.strokeRect(10, 10, 80, 30);
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 10px Arial';
            ctx.textAlign = 'left';
            ctx.fillText('GS', 15, 22);
            ctx.fillStyle = '#01E00D';
            ctx.font = 'bold 14px Arial';
            ctx.fillText(Math.round(groundSpeed) + ' kts', 15, 36);
            
            // True Airspeed
            ctx.fillStyle = '#0d0d0d';
            ctx.fillRect(10, 45, 80, 30);
            ctx.strokeStyle = '#333';
            ctx.strokeRect(10, 45, 80, 30);
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 10px Arial';
            ctx.fillText('TAS', 15, 57);
            ctx.fillStyle = '#01E00D';
            ctx.font = 'bold 14px Arial';
            ctx.fillText(Math.round(trueAirspeed) + ' kts', 15, 71);
            
            // Next waypoint
            const nextWp = currentFlightData.nextWaypoint || 'N/A';
            ctx.fillStyle = '#0d0d0d';
            ctx.fillRect(width - 90, 10, 80, 30);
            ctx.strokeStyle = '#333';
            ctx.strokeRect(width - 90, 10, 80, 30);
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 10px Arial';
            ctx.textAlign = 'right';
            ctx.fillText('NEXT', width - 15, 22);
            ctx.fillStyle = '#00ff00';
            ctx.font = 'bold 12px Arial';
            ctx.fillText(nextWp.substring(0, 6), width - 15, 36);
            
            // Distance to waypoint
            const wpDist = currentFlightData.distanceToWaypoint || 0;
            ctx.fillStyle = '#0d0d0d';
            ctx.fillRect(width - 90, 45, 80, 30);
            ctx.strokeStyle = '#333';
            ctx.strokeRect(width - 90, 45, 80, 30);
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 10px Arial';
            ctx.fillText('DIST', width - 15, 57);
            ctx.fillStyle = '#01E00D';
            ctx.font = 'bold 12px Arial';
            ctx.fillText(wpDist.toFixed(1) + ' nm', width - 15, 71);
            
            // Bottom info bar
            ctx.fillStyle = '#0d0d0d';
            ctx.fillRect(0, height - 40, width, 40);
            ctx.strokeStyle = '#333';
            ctx.strokeRect(0, height - 40, width, 40);
            
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('HDG ' + Math.round(heading) + '°', centerX, height - 15);
        }

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


