// Mobile App Fixes (HTML/JavaScript)

// First, let's update the color from #00c853 to #167fac throughout the HTML
// (This is a global change in the CSS)

// Fix for total distance display
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
    
    // Total distance to destination - FIXED
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

    // Pause state - FIXED
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

// Fix for LOC Hold and ILS buttons
function toggleAP(system) {
    // FIXED: Send the correct system name for LOC and ILS
    if (system === 'nav') {
        ws.send(JSON.stringify({ type: 'autopilot_toggle', system: 'loc' }));
    } else if (system === 'approach') {
        ws.send(JSON.stringify({ type: 'autopilot_toggle', system: 'ils' }));
    } else {
        ws.send(JSON.stringify({ type: 'autopilot_toggle', system }));
    }
}

// Fix for speedbrake and parking brake
function toggleSpoilers() {
    ws.send(JSON.stringify({ type: 'toggle_speedbrake' }));
}

function toggleParkingBrake() {
    ws.send(JSON.stringify({ type: 'toggle_parking_brake' }));
}
