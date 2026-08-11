import React, { useEffect, useRef, useState } from 'react';

const DEFAULT_CAR_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><rect x="5" y="10" width="90" height="30" rx="8" fill="%232563eb" stroke="%23ffffff" stroke-width="2"/><rect x="35" y="14" width="30" height="22" rx="4" fill="%231e293b"/><rect x="38" y="16" width="24" height="18" rx="2" fill="%2338bdf8" opacity="0.8"/><rect x="15" y="4" width="18" height="8" rx="2" fill="%230f172a" stroke="%23cbd5e1" stroke-width="1"/><rect x="67" y="4" width="18" height="8" rx="2" fill="%230f172a" stroke="%23cbd5e1" stroke-width="1"/><rect x="15" y="38" width="18" height="8" rx="2" fill="%230f172a" stroke="%23cbd5e1" stroke-width="1"/><rect x="67" y="38" width="18" height="8" rx="2" fill="%230f172a" stroke="%23cbd5e1" stroke-width="1"/><rect x="91" y="13" width="4" height="6" rx="1" fill="%23fef08a"/><rect x="91" y="31" width="4" height="6" rx="1" fill="%23fef08a"/><rect x="5" y="14" width="3" height="5" rx="1" fill="%23ef4444"/><rect x="5" y="31" width="3" height="5" rx="1" fill="%23ef4444"/></svg>`;

export default function App() {
  const canvasRef = useRef(null);
  const socketRef = useRef(null);
  const carImageRef = useRef(null);
  const activeProfileRef = useRef('');

  // Smooth Motion Ref Tracking
  const targetStateRef = useRef({ x: 50, y: 250, vx: 0, vy: 0, lastTime: performance.now() });
  const renderPosRef = useRef({ x: 50, y: 250 });
  const animFrameIdRef = useRef(null);
  const latestFrameDataRef = useRef(null);

  const [profiles, setProfiles] = useState([]);
  const [activeProfile, setActiveProfile] = useState('');
  const [newProfileName, setNewProfileName] = useState('car1');
  const [gameState, setGameState] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    activeProfileRef.current = activeProfile;
  }, [activeProfile]);

  useEffect(() => {
    const img = new Image();
    img.src = '/car.svg';
    img.onload = () => { carImageRef.current = img; };
    img.onerror = () => {
      const fallbackImg = new Image();
      fallbackImg.src = DEFAULT_CAR_SVG;
      fallbackImg.onload = () => { carImageRef.current = fallbackImg; };
    };
  }, []);

  // Smooth Extrapolated Render Loop
  useEffect(() => {
    const lerp = (start, end, factor) => start + (end - start) * factor;

    const renderLoop = () => {
      const now = performance.now();
      const dt = (now - targetStateRef.current.lastTime) / 1000;

      const predictedX = targetStateRef.current.x + (targetStateRef.current.vx || 0) * dt * 60;
      const predictedY = targetStateRef.current.y + (targetStateRef.current.vy || 0) * dt * 60;

      renderPosRef.current.x = lerp(renderPosRef.current.x, predictedX, 0.3);
      renderPosRef.current.y = lerp(renderPosRef.current.y, predictedY, 0.3);

      if (latestFrameDataRef.current) {
        drawCanvas(latestFrameDataRef.current, renderPosRef.current);
      }

      animFrameIdRef.current = requestAnimationFrame(renderLoop);
    };

    animFrameIdRef.current = requestAnimationFrame(renderLoop);
    return () => {
      if (animFrameIdRef.current) cancelAnimationFrame(animFrameIdRef.current);
    };
  }, []);

  // WebSocket Connection
  useEffect(() => {
    fetchProfiles();
    let reconnectTimeout = null;

    const connectWebSocket = () => {
      const ws = new WebSocket('ws://127.0.0.1:8000/ws');
      socketRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        fetchProfiles();

        if (activeProfileRef.current) {
          ws.send(JSON.stringify({ command: 'select_profile', name: activeProfileRef.current }));
        }
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'frame') {
          latestFrameDataRef.current = data;
          setGameState(data);

          if (Math.abs(data.car.x - targetStateRef.current.x) > 100) {
            renderPosRef.current = { x: data.car.x, y: data.car.y };
          }

          targetStateRef.current = {
            x: data.car.x,
            y: data.car.y,
            vx: data.car.vx || 0,
            vy: data.car.vy || 0,
            lastTime: performance.now(),
          };
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        setIsRunning(false);
        reconnectTimeout = setTimeout(connectWebSocket, 2000);
      };

      ws.onerror = (err) => {
        console.error('WebSocket Error:', err);
        ws.close();
      };
    };

    connectWebSocket();

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (socketRef.current) socketRef.current.close();
    };
  }, []);

  const fetchProfiles = async () => {
    try {
      const res = await fetch('http://127.0.0.1:8000/api/profiles');
      const data = await res.json();
      setProfiles(data);
      if (data.length > 0 && !activeProfileRef.current) {
        selectProfile(data[0].name);
      }
    } catch (err) {
      console.error('Failed to fetch profiles:', err);
    }
  };

  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) return;
    try {
      const res = await fetch('http://127.0.0.1:8000/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newProfileName.trim() }),
      });

      if (res.ok) {
        const createdName = newProfileName.trim();
        setNewProfileName('');
        setIsRunning(false); // Reset running state for new profile
        await fetchProfiles();
        selectProfile(createdName);
      } else {
        alert('Profile already exists!');
      }
    } catch (err) {
      console.error('Error creating profile:', err);
    }
  };

  const handleDeleteProfile = async (name) => {
    if (!window.confirm(`Delete profile "${name}"?`)) return;

    try {
      const res = await fetch(`http://127.0.0.1:8000/api/profiles/${name}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        if (activeProfile === name) {
          setActiveProfile('');
          setIsRunning(false);
          setGameState(null);
        }
        await fetchProfiles();
      }
    } catch (err) {
      console.error('Error deleting profile:', err);
    }
  };

  const selectProfile = (name) => {
    setActiveProfile(name);
    setIsRunning(false); // Pause simulation when switching profiles
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ command: 'stop_simulation' }));
      socketRef.current.send(JSON.stringify({ command: 'select_profile', name }));
    }
  };

  const toggleSimulation = () => {
    if (!activeProfile) {
      alert('Please select or create a profile first!');
      return;
    }

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      if (isRunning) {
        socketRef.current.send(JSON.stringify({ command: 'stop_simulation' }));
        setIsRunning(false);
      } else {
        socketRef.current.send(JSON.stringify({ command: 'start_simulation' }));
        setIsRunning(true);
      }
    }
  };

  const drawCanvas = (state, carPos) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const roadTop = 50;
    const roadHeight = 400;

    // Grass
    ctx.fillStyle = '#064e3b';
    ctx.fillRect(0, 0, canvas.width, roadTop);
    ctx.fillRect(0, roadTop + roadHeight, canvas.width, roadTop);

    // Asphalt
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, roadTop, canvas.width, roadHeight);

    // Bounds
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(0, roadTop);
    ctx.lineTo(canvas.width, roadTop);
    ctx.moveTo(0, roadTop + roadHeight);
    ctx.lineTo(canvas.width, roadTop + roadHeight);
    ctx.stroke();

    // Centerline
    ctx.setLineDash([30, 20]);
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, roadTop + roadHeight / 2);
    ctx.lineTo(canvas.width, roadTop + roadHeight / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Finish line
    const finishX = state.finish_x || 1100;
    ctx.fillStyle = '#10b981';
    ctx.fillRect(finishX, roadTop, 16, roadHeight);
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < roadHeight; i += 20) {
      if ((i / 20) % 2 === 0) {
        ctx.fillRect(finishX + 8, roadTop + i, 8, 20);
      }
    }

    // Square Obstacles
    const size = 40;
    state.obstacles.forEach((obs, idx) => {
      const halfSize = size / 2;
      const isGate = idx >= 5;

      ctx.fillStyle = isGate ? '#a855f7' : '#ef4444';
      ctx.fillRect(obs.x - halfSize, obs.y - halfSize, size, size);

      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(obs.x - halfSize, obs.y - halfSize, size, size);

     });

    // Car Render
    ctx.save();
    ctx.translate(carPos.x, carPos.y);

    if (carImageRef.current) {
      ctx.drawImage(carImageRef.current, -25, -12.5, 50, 25);
    } else {
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(-22, -13, 44, 26);
    }

    ctx.restore();
  };

  const getHudStatus = () => {
    if (!gameState?.done) {
      if (isRunning) return { text: 'Training AI...', color: '#10b981' };
      return { text: 'Paused', color: '#94a3b8' };
    }

    const reason = gameState?.info?.reason;
    if (reason === 'success') {
      return { text: '🏁 Goal Reached!', color: '#10b981' };
    }
    return { text: `💥 Crash: ${reason || 'Collision'}`, color: '#ef4444' };
  };

  const hudStatus = getHudStatus();

  return (
    <div style={styles.appWrapper}>
      <header style={styles.header}>
        <div style={styles.brand}>
          <span style={styles.logoIcon}>🏎️</span>
          <h1 style={styles.brandTitle}>RL Autonomous Driver Studio</h1>
        </div>
        <div style={styles.statusIndicator}>
          <span style={styles.statusDot(wsConnected)} />
          <span style={styles.statusText}>
            Engine WS: {wsConnected ? 'Connected (Ready)' : 'Reconnecting...'}
          </span>
        </div>
      </header>

      <div style={styles.mainContent}>
        <div style={styles.viewportColumn}>
          {/* UPDATED HUD BAR: 3 Columns, Epsilon Hidden */}
          <div style={styles.hudBar}>
            <div style={styles.hudMetric}>
              <span style={styles.hudLabel}>Active Agent</span>
              <span style={styles.hudValue}>{activeProfile || 'None'}</span>
            </div>
            <div style={styles.hudMetric}>
              <span style={styles.hudLabel}>Success / Fail Ratio</span>
              <span style={styles.hudValue}>
                <span style={{ color: '#10b981' }}>{gameState?.successes || 0}</span> /{' '}
                <span style={{ color: '#ef4444' }}>{gameState?.failures || 0}</span>
              </span>
            </div>
            <div style={styles.hudMetric}>
              <span style={styles.hudLabel}>Status</span>
              <span style={{ ...styles.hudValue, color: hudStatus.color }}>
                {hudStatus.text}
              </span>
            </div>
          </div>

          <div style={styles.canvasContainer}>
            <canvas ref={canvasRef} width={1200} height={500} style={styles.canvas} />
          </div>
        </div>

        <aside style={styles.sidebar}>
          <div style={styles.sidebarCard}>
            <h2 style={styles.cardTitle}>Simulation Engine</h2>
            <button
              onClick={toggleSimulation}
              disabled={!activeProfile || !wsConnected}
              style={{
                ...styles.btnToggle(isRunning),
                opacity: activeProfile && wsConnected ? 1 : 0.5,
                cursor: activeProfile && wsConnected ? 'pointer' : 'not-allowed',
              }}
            >
              {isRunning ? '⏸ Pause Training' : '▶ Start High-Speed Training'}
            </button>
          </div>

          <div style={styles.sidebarCard}>
            <h2 style={styles.cardTitle}>Create Profile</h2>
            <div style={styles.inputGroup}>
              <input
                type="text"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="Profile Name (e.g. car1)"
                style={styles.input}
              />
              <button onClick={handleCreateProfile} style={styles.btnPrimary}>
                + Add
              </button>
            </div>
          </div>

          <div style={{ ...styles.sidebarCard, flex: 1, display: 'flex', flexDirection: 'column' }}>
            <h2 style={styles.cardTitle}>Agent Profiles</h2>
            {profiles.length === 0 ? (
              <p style={styles.emptyText}>No saved profiles found.</p>
            ) : (
              <div style={styles.profileList}>
                {profiles.map((p) => {
                  const isActive = activeProfile === p.name;
                  return (
                    <div
                      key={p.name}
                      onClick={() => selectProfile(p.name)}
                      style={{
                        ...styles.profileCard,
                        borderColor: isActive ? '#3b82f6' : '#334155',
                        backgroundColor: isActive ? '#1e3a8a' : '#0f172a',
                      }}
                    >
                      <div>
                        <div style={styles.profileName}>{p.name}</div>
                        <div style={styles.profileSubtext}>
                          Pass: {p.successes || 0} | Fail: {p.failures || 0}
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteProfile(p.name);
                        }}
                        style={styles.btnDanger}
                      >
                        Delete
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

const styles = {
  appWrapper: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
    backgroundColor: '#0f172a',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    color: '#f8fafc',
    boxSizing: 'border-box',
    overflow: 'hidden',
  },
  header: {
    height: '64px',
    backgroundColor: '#1e293b',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 32px',
    borderBottom: '1px solid #334155',
  },
  brand: { display: 'flex', alignItems: 'center', gap: '12px' },
  logoIcon: { fontSize: '24px' },
  brandTitle: { fontSize: '20px', fontWeight: '700', margin: 0 },
  statusIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    backgroundColor: '#0f172a',
    padding: '6px 14px',
    borderRadius: '20px',
    border: '1px solid #334155',
  },
  statusDot: (connected) => ({
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: connected ? '#10b981' : '#ef4444',
  }),
  statusText: { fontSize: '13px', fontWeight: '500', color: '#cbd5e1' },
  mainContent: {
    display: 'flex',
    flex: 1,
    gap: '24px',
    padding: '24px 32px',
    boxSizing: 'border-box',
    overflow: 'hidden',
  },
  viewportColumn: {
    flex: '1 1 1200px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  hudBar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)', // Updated from 4 to 3 columns
    gap: '16px',
    backgroundColor: '#1e293b',
    padding: '16px 24px',
    borderRadius: '12px',
    border: '1px solid #334155',
  },
  hudMetric: { display: 'flex', flexDirection: 'column', gap: '4px' },
  hudLabel: { fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: '600' },
  hudValue: { fontSize: '20px', fontWeight: '700', color: '#f8fafc' },
  canvasContainer: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderRadius: '12px',
    border: '1px solid #334155',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
  },
  canvas: { width: '100%', maxHeight: '100%', borderRadius: '8px' },
  sidebar: { width: '360px', display: 'flex', flexDirection: 'column', gap: '16px' },
  sidebarCard: {
    backgroundColor: '#1e293b',
    borderRadius: '12px',
    padding: '20px',
    border: '1px solid #334155',
  },
  cardTitle: { fontSize: '16px', fontWeight: '600', margin: '0 0 14px 0', color: '#f1f5f9' },
  inputGroup: { display: 'flex', gap: '10px' },
  input: {
    flex: 1,
    padding: '10px 14px',
    backgroundColor: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '6px',
    color: '#ffffff',
    fontSize: '14px',
  },
  btnPrimary: {
    padding: '10px 16px',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontWeight: '600',
    cursor: 'pointer',
  },
  btnToggle: (running) => ({
    width: '100%',
    padding: '14px',
    backgroundColor: running ? '#dc2626' : '#059669',
    color: '#ffffff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '16px',
    fontWeight: '700',
    transition: 'all 0.2s ease',
  }),
  btnDanger: {
    padding: '6px 12px',
    backgroundColor: '#dc2626',
    color: '#ffffff',
    border: 'none',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
  },
  emptyText: { color: '#64748b', fontSize: '14px' },
  profileList: { display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto', maxHeight: '360px' },
  profileCard: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderRadius: '8px',
    border: '2px solid',
    cursor: 'pointer',
    color: '#f8fafc',
  },
  profileName: { fontWeight: '700', fontSize: '15px' },
  profileSubtext: { fontSize: '12px', color: '#94a3b8', marginTop: '2px' },
};