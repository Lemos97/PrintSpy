'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import './globals.css';

interface PrinterStatus {
  printer: {
    state: string;
    flags: {
      operational?: boolean;
      paused?: boolean;
      printing?: boolean;
      cancelling?: boolean;
      pausing?: boolean;
      error?: boolean;
      ready?: boolean;
    };
    temperature: {
      tool0?: {
        actual: number;
        target: number;
      } | null;
      bed?: {
        actual: number;
        target: number;
      } | null;
      uvled?: {
        actual: number;
        target: number | null;
      } | null;
      box?: {
        actual: number;
        target: number | null;
      } | null;
    };
    sd?: {
      ready: boolean;
    } | null;
  } | null;
  job: {
    state: string;
    progress: {
      completion: number;
      printTime: number;
      printTimeLeft: number;
    } | null;
    file: string | null;
    estimatedPrintTime: number | null;
    printTime: number | null;
    printTimeLeft: number | null;
  } | null;
  video?: {
    url: string;
    status: string;
  } | null;
  error: string | null;
}

interface Printer {
  id: string;
  name: string;
  ip: string;
  streamPath: string;
  notes?: string;
  printerType?: string;
  detectedInfo?: any;
  auth?: {
    type: string;
    key?: string;
  };
  status?: PrinterStatus;
}

export default function Home() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    ip: '',
    streamPath: '',
    notes: '',
    printerType: 'auto',
    applicationKey: '',
  });
  const [detectionStatus, setDetectionStatus] = useState<any>(null);
  const [isDetecting, setIsDetecting] = useState(false);

  // Load printers from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('printspy_printers');
    if (saved) {
      try {
        setPrinters(JSON.parse(saved));
      } catch (e) {
        console.error('Error loading printers:', e);
      }
    }
  }, []);

  // Close modal on ESC key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showForm) {
        setShowForm(false);
        setEditingId(null);
        setFormData({ name: '', ip: '', streamPath: '', notes: '', printerType: 'auto', applicationKey: '' });
        setDetectionStatus(null);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [showForm]);

  // Save printers to localStorage whenever they change
  useEffect(() => {
    if (printers.length > 0) {
      localStorage.setItem('printspy_printers', JSON.stringify(printers));
    }
  }, [printers]);

  // Track which printers we're currently fetching status for
  const fetchingRef = useRef<Set<string>>(new Set());
  // Use ref to access current printers without causing re-renders
  const printersRef = useRef<Printer[]>(printers);
  
  // Update ref when printers change
  useEffect(() => {
    printersRef.current = printers;
  }, [printers]);

  // Create a stable list of printer IDs that need status updates (OctoPrint and Elegoo)
  // Only depends on printer identity (id, type, auth), not status
  const statusPrinterIds = useMemo(() => {
    return printers
      .filter(p => {
        if (p.printerType === 'OctoPrint') {
          return p.auth && p.auth.key;
        }
        return p.printerType === 'Elegoo';
      })
      .map(p => `${p.id}:${p.ip}:${p.printerType}:${p.auth?.key || ''}`)
      .sort()
      .join(',');
  }, [printers.map(p => `${p.id}|${p.printerType}|${p.auth?.key || ''}`).join(';')]);

  // Fetch status for OctoPrint and Elegoo printers periodically
  useEffect(() => {
    const statusPrinters = printersRef.current.filter(p => {
      if (p.printerType === 'OctoPrint') {
        return p.auth && p.auth.key;
      }
      return p.printerType === 'Elegoo';
    });
    
    if (statusPrinters.length === 0) {
      fetchingRef.current.clear();
      return;
    }

    const fetchStatus = async (printer: Printer) => {
      // Prevent duplicate requests
      if (fetchingRef.current.has(printer.id)) {
        return;
      }

      fetchingRef.current.add(printer.id);

      try {
        const response = await fetch('/api/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ip: printer.ip,
            printerType: printer.printerType,
            auth: printer.auth,
          }),
        });

        if (response.ok) {
          const status: PrinterStatus = await response.json();
          console.log(`Status for ${printer.name}:`, JSON.stringify(status, null, 2));
          // Use functional update to avoid dependency on printers
          setPrinters(prev => prev.map(p => {
            if (p.id === printer.id) {
              // If we got a video URL from status (Elegoo), update streamPath with RTSP URL
              // The getStreamUrl function will automatically route RTSP URLs through the proxy
              let updatedPrinter = { ...p, status };
              if (status.video?.url && p.printerType === 'Elegoo') {
                // Store the RTSP URL - getStreamUrl will convert it to proxy URL format
                updatedPrinter = { ...updatedPrinter, streamPath: status.video.url };
              }
              return updatedPrinter;
            }
            return p;
          }));
        } else {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          console.error(`Status API error for ${printer.name}:`, response.status, errorData);
          // Set error status
          setPrinters(prev => prev.map(p => 
            p.id === printer.id ? { ...p, status: { error: errorData.error || 'Failed to fetch status', printer: null, job: null } } : p
          ));
        }
      } catch (error) {
        console.error(`Error fetching status for ${printer.name}:`, error);
        // Set error status
        setPrinters(prev => prev.map(p => 
          p.id === printer.id ? { ...p, status: { error: 'Connection error', printer: null, job: null } } : p
        ));
      } finally {
        fetchingRef.current.delete(printer.id);
      }
    };

    // Fetch status immediately
    statusPrinters.forEach(fetchStatus);

    // Set up periodic refresh (every 15 seconds)
    const interval = setInterval(() => {
      // Get fresh printers from ref
      const currentPrinters = printersRef.current.filter(p => {
        if (p.printerType === 'OctoPrint') {
          return p.auth && p.auth.key;
        }
        return p.printerType === 'Elegoo';
      });
      // Only fetch if not already fetching
      currentPrinters.forEach(printer => {
        if (!fetchingRef.current.has(printer.id)) {
          fetchStatus(printer);
        }
      });
    }, 15000);

    return () => {
      clearInterval(interval);
      fetchingRef.current.clear();
    };
  }, [statusPrinterIds]);

  const handleDetect = async () => {
    if (!formData.ip.trim()) {
      alert('Please enter an IP address');
      return;
    }

    setIsDetecting(true);
    setDetectionStatus({ loading: true, message: 'Checking IP address and detecting printer type...' });

    try {
      const auth = formData.printerType === 'OctoPrint' && formData.applicationKey
        ? { type: 'applicationKey', key: formData.applicationKey }
        : null;

      const response = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: formData.ip,
          printerType: formData.printerType,
          auth: auth,
        }),
      });

      const data = await response.json();
      setDetectionStatus(data);

      // Auto-fill form with detection results
      if (data.reachable && data.printerType) {
        setFormData(prev => ({
          ...prev,
          printerType: data.printerType,
          streamPath: data.cameraStreams?.[0]?.path || prev.streamPath,
        }));
      } else if (data.printerType) {
        // Even if not fully reachable, if we detected a type, use it
        setFormData(prev => ({
          ...prev,
          printerType: data.printerType,
        }));
      }
    } catch (error: any) {
      setDetectionStatus({
        errors: [`Detection failed: ${error.message}`],
      });
    } finally {
      setIsDetecting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim() || !formData.ip.trim()) {
      alert('Please fill in the required fields (Name and IP Address)');
      return;
    }

    const printer: Printer = {
      id: editingId || Date.now().toString(),
      name: formData.name,
      ip: formData.ip,
      // For Elegoo, leave streamPath empty so it can be populated from status API
      // For others, use provided streamPath or default to '/?action=stream'
      streamPath: formData.printerType === 'Elegoo' 
        ? (formData.streamPath || '') 
        : (formData.streamPath || '/?action=stream'),
      notes: formData.notes,
      printerType: formData.printerType !== 'auto' ? formData.printerType : undefined,
      detectedInfo: detectionStatus || undefined,
      auth: formData.printerType === 'OctoPrint' && formData.applicationKey
        ? { type: 'applicationKey', key: formData.applicationKey }
        : undefined,
    };

    if (editingId) {
      setPrinters(prev => prev.map(p => p.id === editingId ? printer : p));
    } else {
      setPrinters(prev => [...prev, printer]);
    }

    // Reset form
    setFormData({
      name: '',
      ip: '',
      streamPath: '',
      notes: '',
      printerType: 'auto',
      applicationKey: '',
    });
    setDetectionStatus(null);
    setEditingId(null);
    setShowForm(false);
  };

  const handleEdit = (id: string) => {
    const printer = printers.find(p => p.id === id);
    if (printer) {
      setFormData({
        name: printer.name,
        ip: printer.ip,
        streamPath: printer.streamPath,
        notes: printer.notes || '',
        printerType: printer.printerType || 'auto',
        applicationKey: printer.auth?.key || '',
      });
      setEditingId(id);
      setShowForm(true);
    }
  };

  const handleDelete = (id: string) => {
    if (confirm('Are you sure you want to delete this printer?')) {
      setPrinters(prev => prev.filter(p => p.id !== id));
    }
  };

  const getStreamUrl = (printer: Printer) => {
    // If no streamPath, return null (will show loading/error message)
    if (!printer.streamPath) {
      return null;
    }
    
    // For Elegoo printers, always route RTSP URLs through the proxy
    if (printer.printerType === 'Elegoo' && printer.streamPath.startsWith('rtsp://')) {
      const rtspUrl = encodeURIComponent(printer.streamPath);
      return `/api/rtsp-proxy?url=${rtspUrl}`;
    }
    
    const ip = printer.ip.split(':')[0];
    const port = printer.ip.includes(':') ? printer.ip.split(':')[1] : '';
    const baseUrl = port ? `http://${ip}:${port}` : `http://${ip}`;
    
    if (printer.streamPath.startsWith('rtsp://')) {
      // Use RTSP proxy to convert RTSP to MJPEG
      const rtspUrl = encodeURIComponent(printer.streamPath);
      return `/api/rtsp-proxy?url=${rtspUrl}`;
    }
    
    if (printer.streamPath.startsWith(':')) {
      // Port-based path like :3031/video
      return `http://${ip}${printer.streamPath}`;
    }
    
    return `${baseUrl}${printer.streamPath}`;
  };

  const formatTime = (seconds: number): string => {
    if (seconds === null || seconds === undefined) return 'N/A';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  };

  return (
    <div className="container">
      <div className="logo-backdrop">
        <img src="/PrintSpy-Logo.svg" alt="PrintSpy Logo Backdrop" />
      </div>
      <header>
        <div className="header-title-group">
          <div className="header-icon">
            <img src="/PrintSpy-Logo.svg" alt="PrintSpy Logo" />
          </div>
          <h1>PrintSpy</h1>
        </div>
        <p className="subtitle">Monitor Multiple 3D Printers</p>
      </header>

      <div className="add-printer-section">
        <button className="btn-add" onClick={() => { setShowForm(true); setEditingId(null); setFormData({ name: '', ip: '', streamPath: '', notes: '', printerType: 'auto', applicationKey: '' }); setDetectionStatus(null); }}>
          + Add Printer
        </button>
      </div>

      {showForm && (
        <div className="modal-overlay" onClick={() => {
          setShowForm(false);
          setEditingId(null);
          setFormData({ name: '', ip: '', streamPath: '', notes: '', printerType: 'auto', applicationKey: '' });
          setDetectionStatus(null);
        }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingId ? 'Edit Printer' : 'Add New Printer'}</h2>
              <button 
                className="modal-close" 
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                  setFormData({ name: '', ip: '', streamPath: '', notes: '', printerType: 'auto', applicationKey: '' });
                  setDetectionStatus(null);
                }}
                aria-label="Close modal"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M15 5L5 15M5 5L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            <form onSubmit={handleSubmit} className="modal-form">
              <div className="form-group">
                <label htmlFor="printerName">Printer Name *</label>
                <input
                  type="text"
                  id="printerName"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., Prusa MK3S"
                />
              </div>

              <div className="form-group">
                <label htmlFor="printerType">Printer Type</label>
                <select
                  id="printerType"
                  className="form-select"
                  value={formData.printerType}
                  onChange={(e) => setFormData(prev => ({ ...prev, printerType: e.target.value }))}
                >
                  <option value="auto">Auto-detect</option>
                  <option value="OctoPrint">OctoPrint</option>
                  <option value="Elegoo">Elegoo</option>
                  <option value="PrusaLink">PrusaLink</option>
                  <option value="Klipper">Klipper/Moonraker</option>
                  <option value="other">Other/Generic</option>
                </select>
                <small>Select the printer type or use auto-detect</small>
              </div>

              <div className="form-group">
                <label htmlFor="printerIP">Printer IP Address *</label>
                <div className="ip-input-group">
                  <input
                    type="text"
                    id="printerIP"
                    required
                    value={formData.ip}
                    onChange={(e) => setFormData(prev => ({ ...prev, ip: e.target.value }))}
                    placeholder="e.g., 192.168.1.100"
                  />
                  <button
                    type="button"
                    className="btn-detect"
                    onClick={handleDetect}
                    disabled={isDetecting}
                  >
                    {isDetecting ? '🔍 Detecting...' : '🔍 Detect'}
                  </button>
                </div>
                {detectionStatus && (
                  <div className="detection-status">
                    {detectionStatus.loading && (
                      <div className="detection-loading">{detectionStatus.message}</div>
                    )}
                    {detectionStatus.reachable && detectionStatus.printerType && (
                      <div className="detection-success">
                        ✓ Detected: {detectionStatus.printerType}
                        {formData.printerType === detectionStatus.printerType && (
                          <span style={{ marginLeft: '8px', fontSize: '0.85em', opacity: 0.8 }}>
                            (Auto-filled)
                          </span>
                        )}
                      </div>
                    )}
                    {detectionStatus.errors && detectionStatus.errors.length > 0 && (
                      <div className="detection-errors">
                        {detectionStatus.errors.map((err: string, i: number) => (
                          <div key={i}>{err}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="printerStream">Stream Path (optional)</label>
                <input
                  type="text"
                  id="printerStream"
                  value={formData.streamPath}
                  onChange={(e) => setFormData(prev => ({ ...prev, streamPath: e.target.value }))}
                  placeholder="e.g., /?action=stream or :3031/video"
                />
                <small>Leave empty for default. For Elegoo FDM: use <code>:3031/video</code>. For Elegoo Resin: video URL is obtained via WebSocket/SDCP protocol.</small>
              </div>

              {formData.printerType === 'OctoPrint' && (
                <div className="form-group">
                  <label htmlFor="applicationKey">Application Key (for OctoPrint)</label>
                  <input
                    type="text"
                    id="applicationKey"
                    value={formData.applicationKey}
                    onChange={(e) => setFormData(prev => ({ ...prev, applicationKey: e.target.value }))}
                    placeholder="OctoPrint Application Key"
                    autoComplete="off"
                  />
                  <small>Get your Application Key from OctoPrint Settings &gt; Application Keys. The key will be sent as a Bearer token (Authorization: Bearer &lt;key&gt;). <a href="https://docs.octoprint.org/en/main/bundledplugins/appkeys.html" target="_blank" rel="noopener">Learn more</a></small>
                </div>
              )}

              <div className="form-group">
                <label htmlFor="printerNotes">Notes (optional)</label>
                <textarea
                  id="printerNotes"
                  rows={3}
                  value={formData.notes}
                  onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                  placeholder="Additional information about this printer..."
                />
              </div>

              <div className="form-actions">
                <button type="submit" className="btn-primary">
                  {editingId ? 'Update Printer' : 'Add Printer'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowForm(false);
                    setEditingId(null);
                    setFormData({ name: '', ip: '', streamPath: '', notes: '', printerType: 'auto', applicationKey: '' });
                    setDetectionStatus(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="printers-grid">
        {printers.map((printer) => {
          const streamUrl = getStreamUrl(printer);
          return (
            <div key={printer.id} className="printer-card">
              <div className="printer-header">
                <div className="printer-name">{printer.name}</div>
                <div className="printer-actions">
                  <button className="btn-edit" onClick={() => handleEdit(printer.id)}>
                    Edit
                  </button>
                  <button className="btn-delete" onClick={() => handleDelete(printer.id)}>
                    Delete
                  </button>
                </div>
              </div>
              <div className="printer-feed">
                {streamUrl ? (
                  <img 
                    src={streamUrl} 
                    alt={printer.name}
                    onDoubleClick={(e) => {
                      const img = e.currentTarget;
                      if (img.requestFullscreen) {
                        img.requestFullscreen().catch(err => {
                          console.error('Error attempting to enable fullscreen:', err);
                        });
                      } else if ((img as any).webkitRequestFullscreen) {
                        // Safari
                        (img as any).webkitRequestFullscreen();
                      } else if ((img as any).mozRequestFullScreen) {
                        // Firefox
                        (img as any).mozRequestFullScreen();
                      } else if ((img as any).msRequestFullscreen) {
                        // IE/Edge
                        (img as any).msRequestFullscreen();
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                    title="Double-click to fullscreen"
                  />
                ) : (
                  <div className="error">
                    {printer.printerType === 'Elegoo' && !printer.streamPath
                      ? 'Waiting for video stream URL...' 
                      : printer.streamPath && printer.streamPath.startsWith('rtsp://')
                      ? 'RTSP stream - Loading...' 
                      : 'No stream URL'}
                  </div>
                )}
              </div>
              <div className="printer-info">
                <div className="printer-main-info-container">
                <div className="printer-ip">{printer.ip}</div>
                  {printer.auth && (
                    <div className="printer-auth-indicator">
                      Authenticated (Application Key)
                    </div>
                  )}
                </div>
                {printer.detectedInfo && printer.detectedInfo.printerType && (
                  <div className="printer-detected-info">
                    <div className="detected-type">
                      Type: {printer.detectedInfo.printerType}
                    </div>
                  </div>
                )}
                
                {/* Printer Status Display (OctoPrint and Elegoo) */}
                {(printer.printerType === 'OctoPrint' || printer.printerType === 'Elegoo') && printer.status && (
                  <div className="printer-status">
                    {printer.status.error ? (
                      <div className="status-error">⚠️ {printer.status.error}</div>
                    ) : (
                      <>
                        {printer.status.printer && (
                          <div className="status-section">
                            <div className="status-state">
                              <span className={`status-badge status-${printer.status.printer.flags?.printing ? 'printing' : printer.status.printer.flags?.paused ? 'paused' : printer.status.printer.flags?.error ? 'error' : 'idle'}`}>
                                {printer.status.printer.state}
                              </span>
                            </div>
                            
                            {printer.status.printer.temperature && (
                              <div className="status-temperatures">
                                {/* OctoPrint temperatures */}
                                {printer.status.printer.temperature.tool0 && (
                                  <div className="temp-reading">
                                    <span className="temp-label">Hotend:</span>
                                    <span className="temp-value">
                                      {Math.round(printer.status.printer.temperature.tool0.actual)}°C
                                      {printer.status.printer.temperature.tool0.target > 0 && (
                                        <span className="temp-target"> / {Math.round(printer.status.printer.temperature.tool0.target)}°C</span>
                                      )}
                                    </span>
                                  </div>
                                )}
                                {printer.status.printer.temperature.bed && (
                                  <div className="temp-reading">
                                    <span className="temp-label">Bed:</span>
                                    <span className="temp-value">
                                      {Math.round(printer.status.printer.temperature.bed.actual)}°C
                                      {printer.status.printer.temperature.bed.target > 0 && (
                                        <span className="temp-target"> / {Math.round(printer.status.printer.temperature.bed.target)}°C</span>
                                      )}
                                    </span>
                                  </div>
                                )}
                                {/* Elegoo resin printer temperatures */}
                                {printer.status.printer.temperature.uvled && (
                                  <div className="temp-reading">
                                    <span className="temp-label">UV LED:</span>
                                    <span className="temp-value">
                                      {printer.status.printer.temperature.uvled.actual}°C
                                    </span>
                                  </div>
                                )}
                                {printer.status.printer.temperature.box && (
                                  <div className="temp-reading">
                                    <span className="temp-label">Box:</span>
                                    <span className="temp-value">
                                      {printer.status.printer.temperature.box.actual}°C
                                      {printer.status.printer.temperature.box.target && (
                                        <span className="temp-target"> / {printer.status.printer.temperature.box.target}°C</span>
                                      )}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        
                        {printer.status.job && (
                          <div className="status-job">
                            {printer.status.job.file && (
                              <div className="job-file">📄 {printer.status.job.file}</div>
                            )}
                            {printer.status.job.progress && printer.status.job.progress.completion !== undefined ? (
                              <>
                                <div className="job-progress">
                                  <div className="progress-bar">
                                    <div 
                                      className="progress-fill" 
                                      style={{ width: `${printer.status.job.progress.completion}%` }}
                                    ></div>
                                  </div>
                                  <div className="progress-text">{Math.round(printer.status.job.progress.completion)}%</div>
                                </div>
                                {printer.status.job.progress.printTimeLeft !== null && printer.status.job.progress.printTimeLeft !== undefined && (
                                  <div className="job-time">
                                    ⏱️ {formatTime(printer.status.job.progress.printTimeLeft)}
                                  </div>
                                )}
                              </>
                            ) : (
                              <div className="job-progress">
                                <div className="progress-text">No active job</div>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
                
                {printer.notes && (
                  <div className="printer-notes">{printer.notes}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {printers.length === 0 && (
        <div className="empty-state">
          <p>No printers added yet. Click &quot;+ Add Printer&quot; to get started!</p>
        </div>
      )}
    </div>
  );
}



