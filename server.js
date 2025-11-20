// P3D Remote Cloud Relay Server - Multi-User with Permissions
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Session management with permissions
const sessions = new Map(); 
// sessionId -> { 
//   pcClient, 
//   mobileClients: Map(ws -> {role: 'owner'|'pilot'|'observer', nickname}),
//   accessCodes: { pilot: 'code1', observer: 'code2' },
//   permissions: { allowObservers: true, allowPilots: true }
// }

app.use(express.static('public'));

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    activeSessions: sessions.size,
    totalMobileClients: Array.from(sessions.values()).reduce((sum, s) => sum + s.mobileClients.size, 0)
  });
});

app.get('/', (req, res) => {
  res.send(getMobileAppHTML());
});

wss.on('connection', (ws, req) => {
  console.log('New connection from:', req.socket.remoteAddress);
  
  ws.sessionId = null;
  ws.clientType = null;
  ws.role = null;
  ws.nickname = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'identify') {
        if (data.clientType === 'pc') {
          // PC Server connected - create new session with access codes
          const sessionId = crypto.randomBytes(8).toString('hex');
          const pilotCode = crypto.randomBytes(4).toString('hex');
          const observerCode = crypto.randomBytes(4).toString('hex');
          
          ws.sessionId = sessionId;
          ws.clientType = 'pc';
          
          sessions.set(sessionId, {
            pcClient: ws,
            mobileClients: new Map(),
            accessCodes: {
              pilot: pilotCode,
              observer: observerCode
            },
            permissions: {
              allowObservers: true,
              allowPilots: true
            }
          });
          
          console.log(`PC Server connected. Session: ${sessionId}`);
          
          // Send session info back to PC
          ws.send(JSON.stringify({ 
            type: 'session_created', 
            sessionId: sessionId,
            pilotCode: pilotCode,
            observerCode: observerCode
          }));
          
        } else if (data.clientType === 'mobile') {
          // Mobile client wants to connect
          const sessionId = data.sessionId;
          const accessCode = data.accessCode;
          const password = data.password;
          const nickname = data.nickname || 'Guest';
          
          if (!sessionId || !sessions.has(sessionId)) {
            ws.send(JSON.stringify({ 
              type: 'session_error', 
              message: 'Invalid session ID' 
            }));
            return;
          }
          
          const session = sessions.get(sessionId);
          
          // Determine role based on access code
          let role = 'observer';
          if (accessCode === session.accessCodes.pilot) {
            role = 'pilot';
          } else if (accessCode === session.accessCodes.observer) {
            role = 'observer';
          } else {
            // No access code or wrong code - need password for owner
            ws.send(JSON.stringify({ 
              type: 'auth_required',
              message: 'Authentication required'
            }));
            ws.pendingAuth = { sessionId, password, nickname };
            return;
          }
          
          // Check permissions
          if (role === 'pilot' && !session.permissions.allowPilots) {
            ws.send(JSON.stringify({ 
              type: 'access_denied', 
              message: 'Pilot access is disabled' 
            }));
            return;
          }
          
          if (role === 'observer' && !session.permissions.allowObservers) {
            ws.send(JSON.stringify({ 
              type: 'access_denied', 
              message: 'Observer access is disabled' 
            }));
            return;
          }
          
          ws.sessionId = sessionId;
          ws.clientType = 'mobile';
          ws.role = role;
          ws.nickname = nickname;
          
          session.mobileClients.set(ws, { role, nickname });
          
          console.log(`Mobile client "${nickname}" connected as ${role} to session ${sessionId}`);
          
          // Notify mobile about their role
          ws.send(JSON.stringify({ 
            type: 'connected', 
            role: role,
            nickname: nickname,
            canControl: role !== 'observer'
          }));
          
          // Notify PC about new connection
          if (session.pcClient && session.pcClient.readyState === WebSocket.OPEN) {
            session.pcClient.send(JSON.stringify({
              type: 'client_connected',
              nickname: nickname,
              role: role,
              totalClients: session.mobileClients.size
            }));
          }
          
          // Send current client list to new user
          broadcastClientList(sessionId);
        }
      }
      
      else if (data.type === 'auth' && ws.pendingAuth) {
        // Handle password authentication for owner role
        const { sessionId, password, nickname } = ws.pendingAuth;
        const session = sessions.get(sessionId);
        
        if (!session) {
          ws.send(JSON.stringify({ type: 'session_error', message: 'Session expired' }));
          return;
        }
        
        // Forward auth to PC
        if (session.pcClient && session.pcClient.readyState === WebSocket.OPEN) {
          ws.pendingAuthData = { sessionId, nickname };
          session.pcClient.send(JSON.stringify({ 
            type: 'auth', 
            password: password,
            clientId: ws.pendingAuthData
          }));
        }
      }
      
      else if (data.type === 'auth_success' || data.type === 'auth_failed') {
        // PC responded to auth - find the pending client
        const session = sessions.get(ws.sessionId);
        if (!session) return;
        
        session.mobileClients.forEach((clientInfo, client) => {
          if (client.pendingAuthData) {
            if (data.type === 'auth_success') {
              client.role = 'owner';
              client.nickname = client.pendingAuthData.nickname;
              clientInfo.role = 'owner';
              clientInfo.nickname = client.pendingAuthData.nickname;
              
              client.send(JSON.stringify({ 
                type: 'connected', 
                role: 'owner',
                nickname: client.nickname,
                canControl: true
              }));
              
              console.log(`Client authenticated as owner: ${client.nickname}`);
              broadcastClientList(ws.sessionId);
            } else {
              client.send(JSON.stringify({ type: 'auth_failed' }));
            }
            delete client.pendingAuthData;
          }
        });
      }
      
      else if (data.type === 'update_permissions') {
        // PC updating permissions
        const session = sessions.get(ws.sessionId);
        if (session && ws.clientType === 'pc') {
          session.permissions = data.permissions;
          console.log(`Permissions updated for session ${ws.sessionId}`);
        }
      }
      
      else if (data.type === 'kick_client') {
        // PC kicking a client
        const session = sessions.get(ws.sessionId);
        if (session && ws.clientType === 'pc') {
          session.mobileClients.forEach((clientInfo, client) => {
            if (clientInfo.nickname === data.nickname) {
              client.send(JSON.stringify({ 
                type: 'kicked', 
                message: 'You were disconnected by the host' 
              }));
              client.close();
            }
          });
        }
      }
      
      // Route messages based on permissions
      else {
        const session = sessions.get(ws.sessionId);
        if (!session) return;
        
        if (ws.clientType === 'mobile' && session.pcClient) {
          // Check if user has permission to send commands
          if (ws.role === 'observer' && 
              (data.type === 'pause_toggle' || 
               data.type === 'save_game' || 
               data.type === 'autopilot_toggle' || 
               data.type === 'autopilot_set')) {
            ws.send(JSON.stringify({ 
              type: 'permission_denied', 
              message: 'Observers cannot control the aircraft' 
            }));
            return;
          }
          
          // Forward command to PC
          session.pcClient.send(JSON.stringify(data));
          
        } else if (ws.clientType === 'pc') {
          // Broadcast PC data to all clients
          session.mobileClients.forEach((clientInfo, client) => {
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
    if (ws.sessionId) {
      const session = sessions.get(ws.sessionId);
      if (!session) return;
      
      if (ws.clientType === 'pc') {
        console.log(`PC Server disconnected. Session ${ws.sessionId} closed.`);
        
        // Notify all clients
        session.mobileClients.forEach((clientInfo, client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'pc_disconnected' }));
          }
        });
        
        sessions.delete(ws.sessionId);
        
      } else if (ws.clientType === 'mobile') {
        session.mobileClients.delete(ws);
        console.log(`Mobile client "${ws.nickname}" (${ws.role}) disconnected from session ${ws.sessionId}`);
        
        // Notify PC
        if (session.pcClient && session.pcClient.readyState === WebSocket.OPEN) {
          session.pcClient.send(JSON.stringify({
            type: 'client_disconnected',
            nickname: ws.nickname,
            role: ws.role,
            totalClients: session.mobileClients.size
          }));
        }
        
        broadcastClientList(ws.sessionId);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function broadcastClientList(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  
  const clientList = Array.from(session.mobileClients.values()).map(c => ({
    nickname: c.nickname,
    role: c.role
  }));
  
  const message = JSON.stringify({
    type: 'client_list',
    clients: clientList
  });
  
  // Send to PC
  if (session.pcClient && session.pcClient.readyState === WebSocket.OPEN) {
    session.pcClient.send(message);
  }
  
  // Send to all clients
  session.mobileClients.forEach((clientInfo, client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

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
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: #1a1a2e;
            color: white;
            overflow-x: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 15px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header h1 { font-size: 18px; }
        .role-badge {
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: bold;
        }
        .role-owner { background: #ffd700; color: #333; }
        .role-pilot { background: #4caf50; color: white; }
        .role-observer { background: #2196f3; color: white; }
        
        .status {
            padding: 8px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: bold;
            margin-top: 5px;
        }
        .status.connected { background: #4caf50; }
        .status.disconnected { background: #f44336; }
        .status.waiting { background: #ff9800; }
        
        .tabs {
            display: flex;
            background: #16213e;
            border-bottom: 2px solid #0f3460;
        }
        .tab {
            flex: 1;
            padding: 12px;
            text-align: center;
            cursor: pointer;
            border: none;
            background: transparent;
            color: #999;
            font-size: 13px;
            font-weight: bold;
        }
        .tab.active {
            color: white;
            background: #0f3460;
            border-bottom: 3px solid #667eea;
        }
        
        .tab-content {
            display: none;
            padding: 15px;
        }
        .tab-content.active { display: block; }
        
        .card {
            background: #16213e;
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
            background: #0f3460;
            padding: 12px;
            border-radius: 8px;
            text-align: center;
        }
        .data-label {
            font-size: 11px;
            color: #999;
            text-transform: uppercase;
            margin-bottom: 5px;
        }
        .data-value {
            font-size: 24px;
            font-weight: bold;
            color: #667eea;
        }
        
        #map {
            height: 350px;
            border-radius: 12px;
            overflow: hidden;
        }
        
        .btn {
            width: 100%;
            padding: 14px;
            border: none;
            border-radius: 10px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .btn:active { transform: scale(0.98); }
        .btn-primary { background: #667eea; color: white; }
        .btn-warning { background: #ff9800; color: white; }
        .btn-success { background: #4caf50; color: white; }
        .btn:disabled { background: #555; opacity: 0.5; cursor: not-allowed; }
        
        .ap-control {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px;
            background: #0f3460;
            border-radius: 8px;
            margin-bottom: 8px;
        }
        .ap-label { font-size: 14px; }
        .ap-toggle {
            padding: 6px 16px;
            border-radius: 20px;
            border: none;
            font-weight: bold;
            cursor: pointer;
            font-size: 12px;
        }
        .ap-toggle.on { background: #4caf50; color: white; }
        .ap-toggle.off { background: #555; color: #999; }
        
        input[type="number"], input[type="text"], input[type="password"] {
            width: 100%;
            padding: 12px;
            background: #0f3460;
            border: 2px solid #667eea;
            border-radius: 8px;
            color: white;
            font-size: 14px;
            margin: 8px 0;
        }
        
        .session-input {
            background: #16213e;
            padding: 20px;
            border-radius: 12px;
            margin: 20px;
        }
        
        .access-option {
            background: #0f3460;
            padding: 15px;
            border-radius: 10px;
            margin: 10px 0;
            cursor: pointer;
            border: 2px solid transparent;
            transition: all 0.3s;
        }
        .access-option:hover {
            border-color: #667eea;
        }
        .access-option.selected {
            border-color: #4caf50;
            background: #1a3a1a;
        }
        
        .client-list-item {
            background: #0f3460;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .hidden { display: none !important; }
        
        .info-box {
            background: #2196f3;
            padding: 12px;
            border-radius: 8px;
            margin: 10px 0;
            font-size: 13px;
        }
        .warning-box {
            background: #ff9800;
            padding: 12px;
            border-radius: 8px;
            margin: 10px 0;
            font-size: 13px;
            color: #333;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class='header'>
        <div>
            <h1>✈️ P3D Remote</h1>
            <div id='roleBadge' class='role-badge role-observer' style='display:none;'>Observer</div>
        </div>
        <div>
            <div id='statusBadge' class='status waiting'>Connecting</div>
        </div>
    </div>

    <div id='sessionSetup' class='session-input'>
        <h2 style='margin-bottom: 15px;'>Connect to Simulator</h2>
        
        <div class='info-box'>
            💡 <strong>Three ways to connect:</strong><br>
            • <strong>Owner</strong>: Full control (need password)<br>
            • <strong>Pilot</strong>: Can control (need Pilot Code)<br>
            • <strong>Observer</strong>: Watch only (need Observer Code)
        </div>
        
        <input type='text' id='sessionId' placeholder='Session ID (from PC)'>
        <input type='text' id='nickname' placeholder='Your Nickname' value='Guest'>
        
        <div class='access-option' onclick='selectAccessMode("owner")' id='optOwner'>
            <strong>👑 Owner (Full Control)</strong>
            <div style='font-size:12px; color:#999; margin-top:5px;'>Requires password</div>
        </div>
        
        <div class='access-option' onclick='selectAccessMode("pilot")' id='optPilot'>
            <strong>✈️ Pilot (Can Control)</strong>
            <div style='font-size:12px; color:#999; margin-top:5px;'>Requires Pilot Code</div>
        </div>
        
        <div class='access-option' onclick='selectAccessMode("observer")' id='optObserver'>
            <strong>👁️ Observer (Watch Only)</strong>
            <div style='font-size:12px; color:#999; margin-top:5px;'>Requires Observer Code</div>
        </div>
        
        <div id='ownerAuth' class='hidden'>
            <input type='password' id='password' placeholder='Password' value='p3d123'>
        </div>
        
        <div id='codeAuth' class='hidden'>
            <input type='text' id='accessCode' placeholder='Access Code'>
        </div>
        
        <button class='btn btn-primary' onclick='connectToSession()'>Connect</button>
    </div>

    <div id='mainApp' class='hidden'>
        <div class='tabs'>
            <button class='tab active' onclick='switchTab(0)'>Flight</button>
            <button class='tab' onclick='switchTab(1)'>Map</button>
            <button class='tab' onclick='switchTab(2)'>Autopilot</button>
            <button class='tab' onclick='switchTab(3)'>Users</button>
        </div>

        <div class='tab-content active'>
            <div class='card'>
                <div class='data-label'>Distance to Destination</div>
                <div class='data-value'><span id='distance'>--</span> nm</div>
                <div style='margin-top: 8px; color: #999; font-size: 13px;' id='ete'>ETE: --</div>
            </div>

            <div class='card'>
                <div class='data-grid'>
                    <div class='data-item'>
                        <div class='data-label'>Speed</div>
                        <div class='data-value' id='speed'>--</div>
                        <div style='font-size: 11px; color: #999;'>knots</div>
                    </div>
                    <div class='data-item'>
                        <div class='data-label'>Altitude</div>
                        <div class='data-value' id='altitude'>--</div>
                        <div style='font-size: 11px; color: #999;'>feet</div>
                    </div>
                    <div class='data-item'>
                        <div class='data-label'>Heading</div>
                        <div class='data-value' id='heading'>--</div>
                        <div style='font-size: 11px; color: #999;'>degrees</div>
                    </div>
                    <div class='data-item'>
                        <div class='data-label'>Next WP</div>
                        <div class='data-value' style='font-size: 16px;' id='waypoint'>--</div>
                    </div>
                </div>
            </div>

            <div class='card' id='controlsCard'>
                <button class='btn btn-warning' onclick='togglePause()' id='btnPause'>
                    ⏸️ Pause
                </button>
                <button class='btn btn-primary' onclick='saveGame()'>💾 Save Flight</button>
            </div>
            
            <div id='observerNotice' class='warning-box' style='display:none;'>
                👁️ You're in <strong>Observer Mode</strong> - you can watch but cannot control the aircraft
            </div>
        </div>

        <div class='tab-content'>
            <div class='card'>
                <div id='map'></div>
            </div>
        </div>

        <div class='tab-content'>
            <div class='card' id='autopilotCard'>
                <h3 style='margin-bottom: 15px;'>Autopilot Controls</h3>
                
                <div class='ap-control'>
                    <span class='ap-label'>Master</span>
                    <button class='ap-toggle off' id='apMaster' onclick='toggleAP("master")'>OFF</button>
                </div>
                
                <div class='ap-control'>
                    <span class='ap-label'>Altitude Hold</span>
                    <button class='ap-toggle off' id='apAlt' onclick='toggleAP("altitude")'>OFF</button>
                </div>
                <input type='number' id='targetAlt' placeholder='Target Altitude (ft)' value='10000'>
                <button class='btn btn-success' onclick='setAltitude()'>Set Altitude</button>
                
                <div class='ap-control'>
                    <span class='ap-label'>Heading Hold</span>
                    <button class='ap-toggle off' id='apHdg' onclick='toggleAP("heading")'>OFF</button>
                </div>
                <input type='number' id='targetHdg' placeholder='Target Heading (°)' value='090'>
                <button class='btn btn-success' onclick='setHeading()'>Set Heading</button>
                
                <div class='ap-control'>
                    <span class='ap-label'>NAV Mode</span>
                    <button class='ap-toggle off' id='apNav' onclick='toggleAP("nav")'>OFF</button>
                </div>
                
                <div class='ap-control'>
                    <span class='ap-label'>Approach</span>
                    <button class='ap-toggle off' id='apApp' onclick='toggleAP("approach")'>OFF</button>
                </div>
            </div>
        </div>
        
        <div class='tab-content'>
            <div class='card'>
                <h3 style='margin-bottom: 15px;'>Connected Users</h3>
                <div id='clientList'></div>
            </div>
        </div>
    </div>

    <script>
        let ws = null;
        let map = null;
        let aircraftMarker = null;
        let currentTab = 0;
        let sessionId = null;
        let myRole = null;
        let myNickname = null;
        let accessMode = 'owner';
        let canControl = false;

        function selectAccessMode(mode) {
            accessMode = mode;
            document.querySelectorAll('.access-option').forEach(opt => opt.classList.remove('selected'));
            document.getElementById('opt' + mode.charAt(0).toUpperCase() + mode.slice(1)).classList.add('selected');
            
            if (mode === 'owner') {
                document.getElementById('ownerAuth').classList.remove('hidden');
                document.getElementById('codeAuth').classList.add('hidden');
            } else {
                document.getElementById('ownerAuth').classList.add('hidden');
                document.getElementById('codeAuth').classList.remove('hidden');
            }
        }

        function switchTab(index) {
            currentTab = index;
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

        function connectToSession() {
            sessionId = document.getElementById('sessionId').value.trim();
            myNickname = document.getElementById('nickname').value.trim() || 'Guest';
            
            if (!sessionId) {
                alert('Please enter a Session ID');
                return;
            }
            
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = protocol + '//' + window.location.host;
            
            ws = new WebSocket(wsUrl);
            
            ws.onopen = () => {
                const identifyMsg = {
                    type: 'identify',
                    clientType: 'mobile',
                    sessionId: sessionId,
                    nickname: myNickname
                };
                
                if (accessMode === 'owner') {
                    identifyMsg.password = document.getElementById('password').value;
                } else {
                    identifyMsg.accessCode = document.getElementById('accessCode').value.trim();
                }
                
                ws.send(JSON.stringify(identifyMsg));
            };

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                handleMessage(data);
            };

            ws.onclose = () => {
                updateStatus('disconnected', 'Disconnected');
                setTimeout(() => location.reload(), 3000);
            };
        }

        function handleMessage(data) {
            switch(data.type) {
                case 'session_error':
                case 'access_denied':
                    alert(data.message);
                    break;
                    
                case 'auth_required':
                    const password = document.getElementById('password').value;
                    ws.send(JSON.stringify({ type: 'auth', password }));
                    break;

                case 'connected':
                    myRole = data.role;
                    canControl = data.canControl;
                    updateStatus('connected', 'Connected');
                    document.getElementById('sessionSetup').classList.add('hidden');
                    document.getElementById('mainApp').classList.remove('hidden');
                    
                    // Update role badge
                    const badge = document.getElementById('roleBadge');
                    badge.textContent = data.role.charAt(0).toUpperCase() + data.role.slice(1);
                    badge.className = 'role-badge role-' + data.role;
                    badge.style.display = 'block';
                    
                    // Show/hide controls based on role
                    if (!canControl) {
                        document.getElementById('controlsCard').style.display = 'none';
                        document.getElementById('autopilotCard').style.display = 'none';
                        document.getElementById('observerNotice').style.display = 'block';
                    }
                    break;

                case 'auth_failed':
                    alert('Wrong password!');
                    break;
                    
                case 'permission_denied':
                    alert(data.message);
                    break;
                    
                case 'kicked':
                    alert(data.message);
                    ws.close();
                    break;

                case 'flight_data':
                    updateFlightData(data.data);
                    break;

                case 'autopilot_state':
                    updateAutopilotUI(data.data);
                    break;
                    
                case 'client_list':
                    updateClientList(data.clients);
                    break;

                case 'pc_disconnected':
                    updateStatus('waiting', 'PC Disconnected');
                    break;
            }
        }

        function updateStatus(type, text) {
            const badge = document.getElementById('statusBadge');
            badge.className = 'status ' + type;
            badge.textContent = text;
        }

        function updateFlightData(data) {
            document.getElementById('speed').textContent = Math.round(data.groundSpeed);
            document.getElementById('altitude').textContent = Math.round(data.altitude).toLocaleString();
            document.getElementById('heading').textContent = Math.round(data.heading) + '°';
            document.getElementById('distance').textContent = data.totalDistance.toFixed(1);
            document.getElementById('waypoint').textContent = data.nextWaypoint || '--';
            
            const hours = Math.floor(data.ete / 3600);
            const minutes = Math.floor((data.ete % 3600) / 60);
            document.getElementById('ete').textContent = 'ETE: ' + (hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'm');

            const btnPause = document.getElementById('btnPause');
            btnPause.textContent = data.isPaused ? '▶️ Resume' : '⏸️ Pause';
            btnPause.className = 'btn ' + (data.isPaused ? 'btn-success' : 'btn-warning');

            if (map && data.latitude && data.longitude) {
                updateMap(data.latitude, data.longitude, data.heading);
            }
        }

        function updateAutopilotUI(data) {
            updateToggle('apMaster', data.master);
            updateToggle('apAlt', data.altitude);
            updateToggle('apHdg', data.heading);
            updateToggle('apNav', data.nav);
            updateToggle('apApp', data.approach);
            
            if (data.targetAltitude) document.getElementById('targetAlt').value = data.targetAltitude;
            if (data.targetHeading) document.getElementById('targetHdg').value = data.targetHeading;
        }

        function updateToggle(id, state) {
            const btn = document.getElementById(id);
            btn.className = 'ap-toggle ' + (state ? 'on' : 'off');
            btn.textContent = state ? 'ON' : 'OFF';
        }
        
        function updateClientList(clients) {
            const listDiv = document.getElementById('clientList');
            if (clients.length === 0) {
                listDiv.innerHTML = '<div style="text-align:center;color:#999;padding:20px;">No other users connected</div>';
                return;
            }
            
            let html = '';
            clients.forEach(c => {
                const roleColor = c.role === 'owner' ? '#ffd700' : (c.role === 'pilot' ? '#4caf50' : '#2196f3');
                const roleIcon = c.role === 'owner' ? '👑' : (c.role === 'pilot' ? '✈️' : '👁️');
                html += '<div class="client-list-item">';
                html += '<div>';
                html += '<strong>' + roleIcon + ' ' + c.nickname + '</strong>';
                html += '<div style="font-size:11px;color:#999;margin-top:3px;">' + c.role + '</div>';
                html += '</div>';
                html += '<div style="width:12px;height:12px;border-radius:50%;background:' + roleColor + ';"></div>';
                html += '</div>';
            });
            listDiv.innerHTML = html;
        }

        function initMap() {
            map = L.map('map').setView([0, 0], 8);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors'
            }).addTo(map);
            
            const planeIcon = L.divIcon({
                html: '<div style="font-size:24px;transform:rotate(0deg)">✈️</div>',
                className: '',
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            });
            aircraftMarker = L.marker([0, 0], { icon: planeIcon }).addTo(map);
        }

        function updateMap(lat, lon, heading) {
            if (!map) return;
            
            const planeIcon = L.divIcon({
                html: \`<div style="font-size:24px;transform:rotate(\${heading}deg)">✈️</div>\`,
                className: '',
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            });
            
            aircraftMarker.setLatLng([lat, lon]);
            aircraftMarker.setIcon(planeIcon);
            map.setView([lat, lon], map.getZoom());
        }

        function togglePause() {
            if (!canControl) {
                alert('You do not have permission to control the aircraft');
                return;
            }
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'pause_toggle' }));
            }
        }

        function saveGame() {
            if (!canControl) {
                alert('You do not have permission to control the aircraft');
                return;
            }
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'save_game' }));
                alert('Flight saved!');
            }
        }

        function toggleAP(system) {
            if (!canControl) {
                alert('You do not have permission to control the aircraft');
                return;
            }
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'autopilot_toggle', system }));
            }
        }

        function setAltitude() {
            if (!canControl) {
                alert('You do not have permission to control the aircraft');
                return;
            }
            const alt = parseInt(document.getElementById('targetAlt').value);
            if (ws && ws.readyState === WebSocket.OPEN && !isNaN(alt)) {
                ws.send(JSON.stringify({ type: 'autopilot_set', param: 'altitude', value: alt }));
            }
        }

        function setHeading() {
            if (!canControl) {
                alert('You do not have permission to control the aircraft');
                return;
            }
            const hdg = parseInt(document.getElementById('targetHdg').value);
            if (ws && ws.readyState === WebSocket.OPEN && !isNaN(hdg)) {
                ws.send(JSON.stringify({ type: 'autopilot_set', param: 'heading', value: hdg }));
            }
        }
        
        // Auto-select owner mode by default
        selectAccessMode('owner');
    </script>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`✈️  P3D Cloud Relay Server running on port ${PORT}`);
  console.log(`📱 Mobile app: http://localhost:${PORT}`);
  console.log(`🔒 Multi-user with permissions enabled`);
});
