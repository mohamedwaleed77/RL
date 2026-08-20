import React, { useEffect, useRef, useState } from 'react';

const DEFAULT_CAR_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><rect x="5" y="10" width="90" height="30" rx="8" fill="%232563eb" stroke="%23ffffff" stroke-width="2"/><rect x="35" y="14" width="30" height="22" rx="4" fill="%231e293b"/><rect x="38" y="16" width="24" height="18" rx="2" fill="%2338bdf8" opacity="0.8"/><rect x="15" y="4" width="18" height="8" rx="2" fill="%230f172a" stroke="%23cbd5e1" stroke-width="1"/><rect x="67" y="4" width="18" height="8" rx="2" fill="%230f172a" stroke="%23cbd5e1" stroke-width="1"/><rect x="15" y="38" width="18" height="8" rx="2" fill="%230f172a" stroke="%23cbd5e1" stroke-width="1"/><rect x="67" y="38" width="18" height="8" rx="2" fill="%230f172a" stroke="%23cbd5e1" stroke-width="1"/><rect x="91" y="13" width="4" height="6" rx="1" fill="%23fef08a"/><rect x="91" y="31" width="4" height="6" rx="1" fill="%23fef08a"/><rect x="5" y="14" width="3" height="5" rx="1" fill="%23ef4444"/><rect x="5" y="31" width="3" height="5" rx="1" fill="%23ef4444"/></svg>`;

const API_BASE = '/api';

const getWsUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
};

// Clean Notification Modal
const ModalDialog = ({ message, onClose }) => {
  if (!message) return null;
  return (
    <div style={modalStyles.overlay}>
      <div style={modalStyles.card}>
        <h3 style={modalStyles.titleAlert}>Notification</h3>
        <p style={modalStyles.body}>{message}</p>
        <div style={modalStyles.btnGroupRight}>
          <button onClick={onClose} style={modalStyles.btnPrimary}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
};

// Clean Confirmation Modal
const ConfirmDialog = ({ config, onCancel, onConfirm }) => {
  if (!config) return null;
  return (
    <div style={modalStyles.overlay}>
      <div style={modalStyles.card}>
        <h3 style={modalStyles.titleConfirm}>Delete Profile</h3>
        <p style={modalStyles.body}>
          Are you sure you want to delete profile <strong>"{config.name}"</strong>? This action cannot be undone.
        </p>
        <div style={modalStyles.btnGroup}>
          <button onClick={onCancel} style={modalStyles.btnSecondary}>
            Cancel
          </button>
          <button onClick={onConfirm} style={modalStyles.btnDanger}>
            Delete Profile
          </button>
        </div>
      </div>
    </div>
  );
};

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

  // Modal UI States
  const [modalMessage, setModalMessage] = useState('');
  const [confirmConfig, setConfirmConfig] = useState(null);

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
      } else {
        clearCanvas();
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
      const wsUrl = getWsUrl();
      const ws = new WebSocket(wsUrl);
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
        } else if (data.type === 'error') {
          setModalMessage(data.message);
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
      const res = await fetch(`${API_BASE}/profiles`);
      const data = await res.json();
      setProfiles(data);
      if (data.length > 0 && !activeProfileRef.current) {
        selectProfile(data[0].name);
      }
    } catch (err) {
      console.error('Failed to fetch profiles:', err);
    }
  };

  const resetLocalFrameState = () => {
    latestFrameDataRef.current = null;
    targetStateRef.current = { x: 50, y: 250, vx: 0, vy: 0, lastTime: performance.now() };
    renderPosRef.current = { x: 50, y: 250 };
    setGameState(null);
  };

  const handleCreateProfile = async () => {
    const name = newProfileName.trim();
    if (!name) return;

    try {
      const res = await fetch(`${API_BASE}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      if (res.ok) {
        setNewProfileName('');
        setIsRunning(false);
        resetLocalFrameState();
        await fetchProfiles();
        selectProfile(name);
      } else {
        const errData = await res.json().catch(() => ({}));
        setModalMessage(errData.detail || `Request failed with status ${res.status}`);
      }
    } catch (err) {
      console.error('Error creating profile:', err);
      setModalMessage('Network error: Failed to connect to backend.');
    }
  };

  // Trigger pause immediately when opening confirmation prompt
  const requestDeleteProfile = (name) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ command: 'stop_simulation' }));
    }
    setIsRunning(false);

    setConfirmConfig({ name });
  };

  // Execute deletion after user confirms
  const executeDeleteProfile = async (name) => {
    setConfirmConfig(null);

    try {
      const res = await fetch(`${API_BASE}/profiles/${name}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        if (activeProfileRef.current === name) {
          setActiveProfile('');
          activeProfileRef.current = '';
          resetLocalFrameState();

          if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ command: 'select_profile', name: '' }));
          }
        }
        await fetchProfiles();
      } else {
        const errData = await res.json().catch(() => ({}));
        setModalMessage(errData.detail || 'Failed to delete profile.');
      }
    } catch (err) {
      console.error('Error deleting profile:', err);
      setModalMessage('Network error: Failed to delete profile.');
    }
  };

  const selectProfile = (name) => {
    setActiveProfile(name);
    activeProfileRef.current = name;
    setIsRunning(false);
    resetLocalFrameState();

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ command: 'stop_simulation' }));
      socketRef.current.send(JSON.stringify({ command: 'select_profile', name }));
    }
  };

  const toggleSimulation = () => {
    if (!activeProfile) {
      setModalMessage('Please select or create a profile first.');
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

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const roadTop = 50;
    const roadHeight = 400;

    ctx.fillStyle = '#064e3b';
    ctx.fillRect(0, 0, canvas.width, roadTop);
    ctx.fillRect(0, roadTop + roadHeight, canvas.width, roadTop);

    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, roadTop, canvas.width, roadHeight);
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
    (state.obstacles || []).forEach((obs, idx) => {
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
      if (isRunning) return { text: 'Training Active', color: '#10b981' };
      return { text: 'Paused', color: '#94a3b8' };
    }

    const reason = gameState?.info?.reason;
    if (reason === 'success') {
      return { text: 'Goal Reached', color: '#10b981' };
    }
    return { text: `Collision: ${reason || 'Failed'}`, color: '#ef4444' };
  };

  const hudStatus = getHudStatus();

  // Profile data fallback
  const activeProfileData = profiles.find((p) => p.name === activeProfile);
  const currentPass = gameState?.successes ?? activeProfileData?.successes ?? 0;
  const currentFail = gameState?.failures ?? activeProfileData?.failures ?? 0;

  return (
    <div style={styles.appWrapper}>
      <ModalDialog message={modalMessage} onClose={() => setModalMessage('')} />
      <ConfirmDialog
        config={confirmConfig}
        onCancel={() => setConfirmConfig(null)}
        onConfirm={() => executeDeleteProfile(confirmConfig.name)}
      />

      <header style={styles.header}>
        <div style={styles.brand}>
          <div style={styles.brandBadge}>RL</div>
          <h1 style={styles.brandTitle}>Autonomous Driver Studio</h1>
        </div>
        <div style={styles.statusIndicator}>
          <span style={styles.statusDot(wsConnected)} />
          <span style={styles.statusText}>
            {wsConnected ? 'WebSocket Connected' : 'Reconnecting...'}
          </span>
        </div>
      </header>

      <div style={styles.mainContent}>
        <div style={styles.viewportColumn}>
          <div style={styles.hudBar}>
            <div style={styles.hudMetric}>
              <span style={styles.hudLabel}>Active Agent</span>
              <span style={styles.hudValue}>{activeProfile || 'None'}</span>
            </div>
            <div style={styles.hudMetric}>
              <span style={styles.hudLabel}>Pass / Fail Ratio</span>
              <span style={styles.hudValue}>
                <span style={{ color: '#10b981' }}>{currentPass}</span>
                <span style={{ color: '#64748b', margin: '0 6px' }}>/</span>
                <span style={{ color: '#f87171' }}>{currentFail}</span>
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
            <h2 style={styles.cardTitle}>Engine Control</h2>
            <button
              onClick={toggleSimulation}
              disabled={!activeProfile || !wsConnected}
              style={{
                ...styles.btnToggle(isRunning),
                opacity: activeProfile && wsConnected ? 1 : 0.5,
                cursor: activeProfile && wsConnected ? 'pointer' : 'not-allowed',
              }}
            >
              {isRunning ? 'Pause Simulation' : 'Start Simulation'}
            </button>
          </div>

          <div style={styles.sidebarCard}>
            <h2 style={styles.cardTitle}>Create Profile</h2>
            <div style={styles.inputGroup}>
              <input
                type="text"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="Profile Name"
                style={styles.input}
              />
              <button onClick={handleCreateProfile} style={styles.btnPrimary}>
                Create
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
                        backgroundColor: isActive ? '#1e293b' : '#0f172a',
                      }}
                    >
                      <div>
                        <div style={styles.profileName}>
                          {p.name}
                          {isActive && <span style={styles.activeBadge}>Active</span>}
                        </div>
                        <div style={styles.profileSubtext}>
                          Pass: {p.successes || 0} | Fail: {p.failures || 0}
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          requestDeleteProfile(p.name);
                        }}
                        style={styles.btnDangerIcon}
                        title="Delete Profile"
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

const modalStyles = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(15, 23, 42, 0.8)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  card: {
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '12px',
    padding: '24px',
    maxWidth: '420px',
    width: '90%',
    boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)',
  },
  titleConfirm: { margin: '0 0 10px 0', fontSize: '18px', fontWeight: '600', color: '#f8fafc' },
  titleAlert: { margin: '0 0 10px 0', fontSize: '18px', fontWeight: '600', color: '#f87171' },
  body: { margin: '0 0 24px 0', color: '#94a3b8', fontSize: '14px', lineHeight: '1.5' },
  btnGroup: { display: 'flex', justifyContent: 'flex-end', gap: '12px' },
  btnGroupRight: { display: 'flex', justifyContent: 'flex-end' },
  btnPrimary: {
    backgroundColor: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    padding: '8px 16px',
    fontWeight: '500',
    fontSize: '14px',
    cursor: 'pointer',
  },
  btnSecondary: {
    backgroundColor: '#334155',
    color: '#f8fafc',
    border: 'none',
    borderRadius: '6px',
    padding: '8px 16px',
    fontWeight: '500',
    fontSize: '14px',
    cursor: 'pointer',
  },
  btnDanger: {
    backgroundColor: '#dc2626',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    padding: '8px 16px',
    fontWeight: '500',
    fontSize: '14px',
    cursor: 'pointer',
  },
};

const styles = {
  appWrapper: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
    backgroundColor: '#0b0f19',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    color: '#f8fafc',
    boxSizing: 'border-box',
    overflow: 'hidden',
  },
  header: {
    height: '60px',
    backgroundColor: '#0f172a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 28px',
    borderBottom: '1px solid #1e293b',
  },
  brand: { display: 'flex', alignItems: 'center', gap: '12px' },
  brandBadge: {
    backgroundColor: '#2563eb',
    color: '#ffffff',
    fontWeight: '700',
    fontSize: '12px',
    padding: '4px 8px',
    borderRadius: '6px',
    letterSpacing: '0.5px',
  },
  brandTitle: { fontSize: '18px', fontWeight: '600', margin: 0, color: '#f8fafc' },
  statusIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    backgroundColor: '#1e293b',
    padding: '5px 12px',
    borderRadius: '6px',
    border: '1px solid #334155',
  },
  statusDot: (connected) => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: connected ? '#10b981' : '#f87171',
  }),
  statusText: { fontSize: '13px', fontWeight: '500', color: '#94a3b8' },
  mainContent: {
    display: 'flex',
    flex: 1,
    gap: '20px',
    padding: '20px 28px',
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
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '16px',
    backgroundColor: '#0f172a',
    padding: '16px 20px',
    borderRadius: '10px',
    border: '1px solid #1e293b',
  },
  hudMetric: { display: 'flex', flexDirection: 'column', gap: '4px' },
  hudLabel: { fontSize: '11px', color: '#64748b', textTransform: 'uppercase', fontWeight: '600', letterSpacing: '0.5px' },
  hudValue: { fontSize: '18px', fontWeight: '600', color: '#f8fafc' },
  canvasContainer: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderRadius: '10px',
    border: '1px solid #1e293b',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
  },
  canvas: { width: '100%', maxHeight: '100%', borderRadius: '6px' },
  sidebar: { width: '340px', display: 'flex', flexDirection: 'column', gap: '16px' },
  sidebarCard: {
    backgroundColor: '#0f172a',
    borderRadius: '10px',
    padding: '18px',
    border: '1px solid #1e293b',
  },
  cardTitle: { fontSize: '15px', fontWeight: '600', margin: '0 0 14px 0', color: '#f8fafc' },
  inputGroup: { display: 'flex', gap: '8px' },
  input: {
    flex: 1,
    padding: '9px 12px',
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '6px',
    color: '#ffffff',
    fontSize: '13px',
    outline: 'none',
  },
  btnPrimary: {
    padding: '9px 14px',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontWeight: '500',
    fontSize: '13px',
    cursor: 'pointer',
  },
  btnToggle: (running) => ({
    width: '100%',
    padding: '12px',
    backgroundColor: running ? '#dc2626' : '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
  }),
  btnDangerIcon: {
    padding: '5px 10px',
    backgroundColor: 'transparent',
    color: '#f87171',
    border: '1px solid #7f1d1d',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  emptyText: { color: '#64748b', fontSize: '13px', margin: 0 },
  profileList: { display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto', maxHeight: '360px' },
  profileCard: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 14px',
    borderRadius: '6px',
    border: '1px solid',
    cursor: 'pointer',
    color: '#f8fafc',
    transition: 'all 0.15s ease',
  },
  profileName: { fontWeight: '600', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' },
  activeBadge: {
    backgroundColor: '#1e3a8a',
    color: '#60a5fa',
    fontSize: '10px',
    padding: '2px 6px',
    borderRadius: '4px',
    fontWeight: '500',
  },
  profileSubtext: { fontSize: '12px', color: '#64748b', marginTop: '4px' },
};