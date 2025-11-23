// P3D Remote Cloud Relay Server
// Deploy this to Railway, Render, or Fly.io

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Store connections
let pcClient = null;
let mobileClients = new Set();

// Serve static files
app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    pcConnected: !!pcClient,
    mobileClients: mobileClients.size 
  });
});

// Serve mobile web app
app.get('/', (req, res) => {
  res.send(getMobileAppHTML());
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('New connection from:', req.socket.remoteAddress);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Handle client identification
      if (data.type === 'identify') {
        if (data.clientType === 'pc') {
          // PC Server connected
          if (pcClient) {
            pcClient.close();
          }
          pcClient = ws;
          ws.clientType = 'pc';
          console.log('PC Server connected');
          
          // Notify all mobile clients
          broadcastToMobile({ type: 'pc_connected' });
          
        } else if (data.clientType === 'mobile') {
          // Mobile client connected
          ws.clientType = 'mobile';
          mobileClients.add(ws);
          console.log('Mobile client connected. Total:', mobileClients.size);
          
          // Send PC status
          ws.send(JSON.stringify({ 
            type: 'pc_status', 
            connected: !!pcClient 
          }));
        }
      }
      
      // Route messages between PC and mobile
      else if (data.type === 'auth' || data.type === 'pause_toggle' || 
               data.type === 'save_game' || data.type === 'autopilot_toggle' || 
               data.type === 'autopilot_set') {
        // Command from mobile to PC
        if (ws.clientType === 'mobile' && pcClient) {
          pcClient.send(JSON.stringify(data));
        }
      }
      
      else if (data.type === 'flight_data' || data.type === 'ai_aircraft' || 
               data.type === 'autopilot_state' || data.type === 'auth_success' || 
               data.type === 'auth_failed') {
        // Data from PC to mobile
        if (ws.clientType === 'pc') {
          broadcastToMobile(data);
        }
      }
      
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    if (ws.clientType === 'pc') {
      console.log('PC Server disconnected');
      pcClient = null;
      broadcastToMobile({ type: 'pc_disconnected' });
    } else if (ws.clientType === 'mobile') {
      mobileClients.delete(ws);
      console.log('Mobile client disconnected. Total:', mobileClients.size);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function broadcastToMobile(data) {
  const message = JSON.stringify(data);
  mobileClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function getMobileAppHTML() {
  const wsUrl = process.env.RAILWAY_STATIC_URL || 
                process.env.RENDER_EXTERNAL_URL || 
                `ws://localhost:${PORT}`;
  
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset='UTF-8'>
    <meta name='viewport' content='width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'>
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>P3D Remote</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 15px;
            padding-bottom: 80px;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
        }
        .header {
            background: white;
            border-radius: 15px;
            padding: 20px;
            margin-bottom: 15px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.2);
        }
        h1 { 
            color: #333; 
            font-size: 24px;
            margin-bottom: 10px;
        }
        .status {
            padding: 12px;
            border-radius: 10px;
            text-align: center;
            font-weight: bold;
            font-size: 14px;
            margin-top: 10px;
        }
        .status.connected { background: #4caf50; color: white; }
        .status.disconnected { background: #f44336; color: white; }
        .status.waiting { background: #ff9800; color: white; }
        
        .card {
            background: white;
            border-radius: 15px;
            padding: 20px;
            margin-bottom: 15px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.2);
        }
        
        .data-label { 
            font-size: 11px; 
            color: #666; 
            text-transform: uppercase;
            margin-bottom: 5px;
            font-weight: 600;
        }
        .data-value { 
            font-size: 36px; 
            font-weight: bold; 
            color: #667eea;
            line-height: 1;
        }
        .data-unit {
            font-size: 18px;
            color: #999;
        }
        
        .grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-bottom: 15px;
        }
        .grid-item {
            background: #f5f5f5;
            padding: 15px;
            border-radius: 10px;
            text-align: center;
        }
        .grid-value {
            font-size: 28px;
            font-weight: bold;
            color: #333;
            margin: 5px 0;
        }
        
        .btn {
            width: 100%;
            padding: 16px;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: transform 0.1s;
        }
        .btn:active { transform: scale(0.98); }
        .btn-pause { background: #ff9800; color: white; }
        .btn-save { background: #667eea; color: white; }
        .btn:disabled { 
            background: #ccc; 
            cursor: not-allowed;
            opacity: 0.6;
        }
        
        input {
            width: 100%;
            padding: 14px;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
            font-size: 16px;
            margin-bottom: 10px;
        }
        
        .auth-section {
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.2);
        }
        
        .hidden { display: none !important; }
        
        .info {
            background: #e3f2fd;
            padding: 15px;
            border-radius: 10px;
            margin-top: 15px;
            font-size: 13px;
            color: #1976d2;
        }
    </style>
</head>
<body>
    <div class='container'>
        <div class='header'>
            <h1>✈️ P3D Remote Control</h1>
            <div id='connectionStatus' class='status waiting'>Connecting to cloud...</div>
        </div>

        <div id='authSection' class='auth-section hidden'>
            <h2 style='margin-bottom: 15px; color: #333;'>Enter Password</h2>
            <input type='password' id='password' placeholder='Server password' value='p3d123'>
            <button class='btn btn-save' onclick='authenticate()'>Connect to Simulator</button>
        </div>

        <div id='mainSection' class='hidden'>
            <div class='card'>
                <div class='data-label'>Distance to Destination</div>
                <div class='data-value'>
                    <span id='distance'>--</span>
                    <span class='data-unit'>nm</span>
                </div>
                <div style='margin-top: 10px; color: #666; font-size: 14px;'>
                    <span id='ete'>ETE: --</span>
                </div>
            </div>

            <div class='card'>
                <div class='grid'>
                    <div class='grid-item'>
                        <div class='data-label'>Speed</div>
                        <div class='grid-value' id='speed'>--</div>
                        <div style='font-size: 12px; color: #999;'>knots</div>
                    </div>
                    <div class='grid-item'>
                        <div class='data-label'>Altitude</div>
                        <div class='grid-value' id='altitude'>--</div>
                        <div style='font-size: 12px; color: #999;'>feet</div>
                    </div>
                    <div class='grid-item'>
                        <div class='data-label'>Heading</div>
                        <div class='grid-value' id='heading'>--</div>
                        <div style='font-size: 12px; color: #999;'>degrees</div>
                    </div>
                    <div class='grid-item'>
                        <div class='data-label'>Next WP</div>
                        <div class='grid-value' style='font-size: 20px;' id='waypoint'>--</div>
                    </div>
                </div>
            </div>

            <div class='card'>
                <button class='btn btn-pause' onclick='togglePause()' id='btnPause'>
                    ⏸️ Pause Simulator
                </button>
                <button class='btn btn-save' onclick='saveGame()'>
                    💾 Save Flight
                </button>
            </div>

            <div class='info'>
                💡 <strong>Tip:</strong> Add this page to your home screen for quick access!
            </div>
        </div>
    </div>

    <script>
        let ws = null;
        let isAuthenticated = false;
        let reconnectAttempts = 0;
        let isPaused = false;

        function connect() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = protocol + '//' + window.location.host;
            
            ws = new WebSocket(wsUrl);
            
            ws.onopen = () => {
                console.log('Connected to relay server');
                reconnectAttempts = 0;
                ws.send(JSON.stringify({ 
                    type: 'identify', 
                    clientType: 'mobile' 
                }));
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    handleMessage(data);
                } catch (error) {
                    console.error('Error parsing message:', error);
                }
            };

            ws.onclose = () => {
                console.log('Disconnected from relay server');
                updateStatus('disconnected', '❌ Disconnected - Reconnecting...');
                
                // Auto-reconnect
                reconnectAttempts++;
                const delay = Math.min(1000 * reconnectAttempts, 5000);
                setTimeout(connect, delay);
            };

            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
        }

        function handleMessage(data) {
            switch(data.type) {
                case 'pc_status':
                    if (data.connected) {
                        updateStatus('waiting', '⏳ PC Connected - Enter Password');
                        document.getElementById('authSection').classList.remove('hidden');
                    } else {
                        updateStatus('disconnected', '❌ Waiting for PC Server...');
                    }
                    break;

                case 'pc_connected':
                    if (!isAuthenticated) {
                        updateStatus('waiting', '⏳ PC Connected - Enter Password');
                        document.getElementById('authSection').classList.remove('hidden');
                    }
                    break;

                case 'pc_disconnected':
                    updateStatus('disconnected', '❌ PC Server Disconnected');
                    document.getElementById('authSection').classList.add('hidden');
                    document.getElementById('mainSection').classList.add('hidden');
                    isAuthenticated = false;
                    break;

                case 'auth_success':
                    isAuthenticated = true;
                    updateStatus('connected', '✅ Connected to Simulator');
                    document.getElementById('authSection').classList.add('hidden');
                    document.getElementById('mainSection').classList.remove('hidden');
                    break;

                case 'auth_failed':
                    alert('❌ Wrong password! Check the password in your PC server window.');
                    break;

                case 'flight_data':
                    updateFlightData(data.data);
                    break;
            }
        }

        function updateStatus(type, text) {
            const status = document.getElementById('connectionStatus');
            status.className = 'status ' + type;
            status.textContent = text;
        }

        function updateFlightData(data) {
            document.getElementById('speed').textContent = Math.round(data.groundSpeed);
            document.getElementById('altitude').textContent = Math.round(data.altitude).toLocaleString();
            document.getElementById('heading').textContent = Math.round(data.heading) + '°';
            document.getElementById('distance').textContent = data.totalDistance.toFixed(1);
            document.getElementById('waypoint').textContent = data.nextWaypoint || '--';
            
            const hours = Math.floor(data.ete / 3600);
            const minutes = Math.floor((data.ete % 3600) / 60);
            const eteText = hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'm';
            document.getElementById('ete').textContent = 'ETE: ' + eteText;

            isPaused = data.isPaused;
            const btnPause = document.getElementById('btnPause');
            btnPause.textContent = isPaused ? '▶️ Resume Simulator' : '⏸️ Pause Simulator';
        }

        function authenticate() {
            const password = document.getElementById('password').value;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                    type: 'auth', 
                    password: password 
                }));
            }
        }

        function togglePause() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'pause_toggle' }));
            }
        }

        function saveGame() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'save_game' }));
                alert('✅ Flight saved!');
            }
        }

        // Start connection
        connect();

        // Handle Enter key in password field
        document.getElementById('password').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                authenticate();
            }
        });
    </script>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`✈️  P3D Cloud Relay Server running on port ${PORT}`);
  console.log(`📱 Mobile app: http://localhost:${PORT}`);
  console.log(`🖥️  PC server should connect to this relay`);
});