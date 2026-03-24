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
    currentLayer?: number | null;
    totalLayer?: number | null;
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
  const [streamPaused, setStreamPaused] = useState<Record<string, boolean>>({});
  const [capturedFrames, setCapturedFrames] = useState<Record<string, string>>({});
  const imageKeysRef = useRef<Record<string, number>>({});
  // Use ref to store captured frames synchronously (available immediately, not async like state)
  const capturedFramesRefSync = useRef<Record<string, string>>({});
  const [fullscreenPrinterId, setFullscreenPrinterId] = useState<string | null>(null);

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

  // Load paused state from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('printspy_stream_paused');
    if (saved) {
      try {
        setStreamPaused(JSON.parse(saved));
      } catch (e) {
        console.error('Error loading paused state:', e);
      }
    }
  }, []);

  // Save paused state to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('printspy_stream_paused', JSON.stringify(streamPaused));
  }, [streamPaused]);

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

    // Build the full stream URL
    const ip = printer.ip.split(':')[0];
    const port = printer.ip.includes(':') ? printer.ip.split(':')[1] : '';
    const baseUrl = port ? `http://${ip}:${port}` : `http://${ip}`;

    let fullStreamUrl: string;
    if (printer.streamPath.startsWith(':')) {
      // Port-based path like :3031/video
      fullStreamUrl = `http://${ip}${printer.streamPath}`;
    } else {
      fullStreamUrl = `${baseUrl}${printer.streamPath}`;
    }

    // Route ALL HTTP streams through our proxy to avoid CORS issues
    // This allows us to capture frames for the pause functionality
    const encodedUrl = encodeURIComponent(fullStreamUrl);
    return `/api/stream-proxy?url=${encodedUrl}`;
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

  const captureFrame = (imgElement: HTMLImageElement, printerId: string): string | null => {
    try {
      // Ensure image is loaded and has dimensions
      if (!imgElement.complete || imgElement.naturalWidth === 0 || imgElement.naturalHeight === 0) {
        return null;
      }

      const canvas = document.createElement('canvas');
      canvas.width = imgElement.naturalWidth || imgElement.width;
      canvas.height = imgElement.naturalHeight || imgElement.height;

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(imgElement, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        // Store in ref FIRST (synchronous, available immediately)
        capturedFramesRefSync.current[printerId] = dataUrl;
        // Then update state (async)
        setCapturedFrames(prev => ({ ...prev, [printerId]: dataUrl }));
        return dataUrl;
      }
      return null;
    } catch {
      // CORS or other error - silently fail
      return null;
    }
  };

  const handleToggleStream = (printerId: string, imgElement: HTMLImageElement | null): void => {
    const currentlyPaused = streamPaused[printerId] || false;

    if (!currentlyPaused) {
      // PAUSING: Capture frame FIRST, then update state
      let capturedDataUrl: string | null = null;

      // Try to capture from provided image element
      if (imgElement) {
        try {
          const width = imgElement.naturalWidth || imgElement.width || imgElement.clientWidth;
          const height = imgElement.naturalHeight || imgElement.height || imgElement.clientHeight;

          if (width > 0 && height > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(imgElement, 0, 0, width, height);
              capturedDataUrl = canvas.toDataURL('image/jpeg', 0.9);
            }
          }
        } catch {
          // Capture failed - will try fallback
        }
      }

      // Fallback to existing pre-captured frame
      if (!capturedDataUrl) {
        capturedDataUrl = capturedFramesRefSync.current[printerId] || null;
      }

      // Store frame in BOTH ref and state
      if (capturedDataUrl) {
        capturedFramesRefSync.current[printerId] = capturedDataUrl;
        setCapturedFrames(prev => ({ ...prev, [printerId]: capturedDataUrl! }));
      }

      // Increment key to force React to unmount the live stream img
      imageKeysRef.current[printerId] = (imageKeysRef.current[printerId] || 0) + 1;

      // Set paused state
      setStreamPaused(prev => ({ ...prev, [printerId]: true }));
    } else {
      // RESUMING: Clear captured frame and restore live stream
      imageKeysRef.current[printerId] = (imageKeysRef.current[printerId] || 0) + 1;

      // Clear captured frame from ref
      delete capturedFramesRefSync.current[printerId];

      // Clear paused state
      setStreamPaused(prev => {
        const updated = { ...prev };
        delete updated[printerId];
        return updated;
      });

      // Clear captured frame state after a small delay
      setTimeout(() => {
        setCapturedFrames(prev => {
          const updated = { ...prev };
          delete updated[printerId];
          return updated;
        });
      }, 100);
    }
  };

  const handleFullscreen = (printerId: string): void => {
    if (fullscreenPrinterId === printerId) {
      // Close modal
      setFullscreenPrinterId(null);
    } else {
      // Open modal
      setFullscreenPrinterId(printerId);
    }
  };

  // Close modal on ESC key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && fullscreenPrinterId) {
        setFullscreenPrinterId(null);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [fullscreenPrinterId]);

  // Store image element refs for each printer
  const imageRefsRef = useRef<Record<string, HTMLImageElement | null>>({});

  // Track which printers have had their key incremented after frame capture
  const frameSwitchedRef = useRef<Record<string, boolean>>({});

  // When paused and frame becomes available, switch to it immediately
  useEffect(() => {
    Object.keys(streamPaused).forEach(printerId => {
      if (streamPaused[printerId] && capturedFrames[printerId] && !frameSwitchedRef.current[printerId]) {
        // Frame is now available, increment key to switch to it (only once)
        imageKeysRef.current[printerId] = (imageKeysRef.current[printerId] || 0) + 1;
        frameSwitchedRef.current[printerId] = true;
      }
    });

    // Reset tracking when resuming
    Object.keys(capturedFrames).forEach(printerId => {
      if (!streamPaused[printerId]) {
        frameSwitchedRef.current[printerId] = false;
      }
    });
  }, [capturedFrames, streamPaused]);

  // Periodically capture frames from all active (non-paused) streams
  // This ensures we always have a recent frame available when the user clicks pause
  useEffect(() => {
    const captureInterval = setInterval(() => {
      printers.forEach(printer => {
        const isPaused = streamPaused[printer.id];
        if (!isPaused) {
          const imgEl = imageRefsRef.current[printer.id];
          if (imgEl && imgEl.complete && imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0) {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = imgEl.naturalWidth;
              canvas.height = imgEl.naturalHeight;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(imgEl, 0, 0);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                capturedFramesRefSync.current[printer.id] = dataUrl;
              }
            } catch {
              // Silently ignore capture errors (CORS, etc.)
            }
          }
        }
      });
    }, 5000);

    return () => clearInterval(captureInterval);
  }, [printers, streamPaused]);

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
                  <path d="M15 5L5 15M5 5L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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
          const isPaused = streamPaused[printer.id] || false;
          const capturedFrame = capturedFrames[printer.id];

          // Determine which image source to use
          // When paused: use captured frame ONLY (never streamUrl - it keeps MJPEG loading!)
          // When live: use streamUrl
          const pausedFrame = capturedFramesRefSync.current[printer.id] || capturedFrame;
          const imageSrc = isPaused ? pausedFrame : streamUrl;

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
                {imageSrc ? (
                  <img
                    key={`${printer.id}-${imageKeysRef.current[printer.id] || 0}-${isPaused ? 'paused' : 'live'}`}
                    ref={(el) => {
                      imageRefsRef.current[printer.id] = el;
                      if (el && document.fullscreenElement === el) {
                        setFullscreenPrinterId(printer.id);
                      }
                    }}
                    src={imageSrc}
                    alt={printer.name}
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      // Pre-capture when NOT paused (live stream)
                      if (!isPaused && img.complete && img.naturalWidth > 0) {
                        captureFrame(img, printer.id);
                      }
                    }}
                    onError={() => {
                      // If paused frame fails to load, try to resume
                      if (isPaused && pausedFrame) {
                        setStreamPaused(prev => {
                          const updated = { ...prev };
                          delete updated[printer.id];
                          return updated;
                        });
                      }
                    }}
                    style={{ cursor: 'default' }}
                  />
                ) : (
                  <div className={isPaused ? "paused-placeholder" : "error"}>
                    {isPaused
                      ? 'Stream Paused'
                      : printer.printerType === 'Elegoo' && !printer.streamPath
                        ? 'Waiting for video stream URL...'
                        : printer.streamPath && printer.streamPath.startsWith('rtsp://')
                          ? 'RTSP stream - Loading...'
                          : 'No stream URL'}
                  </div>
                )}
                {/* Always show overlay if streamUrl exists or if paused (so user can resume) */}
                {(streamUrl || isPaused) && (
                  <div className="printer-feed-overlay">
                    <div className="stream-controls">
                      <button
                        type="button"
                        className="stream-control-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          let imgEl = imageRefsRef.current[printer.id];
                          if (!imgEl) {
                            const feedContainer = e.currentTarget.closest('.printer-feed');
                            imgEl = feedContainer?.querySelector('img') as HTMLImageElement || null;
                          }
                          handleToggleStream(printer.id, imgEl);
                        }}
                        aria-label={isPaused ? 'Resume stream' : 'Pause stream'}
                      >
                        {isPaused ? (
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                          </svg>
                        ) : (
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="6" y="4" width="4" height="16"></rect>
                            <rect x="14" y="4" width="4" height="16"></rect>
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        className="stream-control-btn stream-fullscreen-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFullscreen(printer.id);
                        }}
                        aria-label="Fullscreen"
                      >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="printer-info">
                <div className="printer-main-info-container">
                  {printer.printerType === 'OctoPrint' ? (
                    <a
                      href={`http://${printer.ip}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="printer-ip printer-ip-link"
                      title="Open OctoPrint"
                    >
                      {printer.ip}
                    </a>
                  ) : (
                    <div className="printer-ip">{printer.ip}</div>
                  )}
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
                                {printer.printerType === 'Elegoo' && printer.status.job.currentLayer != null && (
                                  <div className="job-layers">
                                    🖨️ Layer {printer.status.job.currentLayer}{printer.status.job.totalLayer != null ? ` / ${printer.status.job.totalLayer}` : ''}
                                  </div>
                                )}
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

      {/* Fullscreen Modal */}
      {fullscreenPrinterId && (() => {
        const printer = printers.find(p => p.id === fullscreenPrinterId);
        if (!printer) return null;

        const streamUrl = getStreamUrl(printer);
        const isPaused = streamPaused[printer.id] || false;
        const capturedFrame = capturedFrames[printer.id];
        const pausedFrame = capturedFramesRefSync.current[printer.id] || capturedFrame;
        const imageSrc = isPaused ? pausedFrame : streamUrl;

        return (
          <div
            className="fullscreen-modal-overlay"
            onClick={() => setFullscreenPrinterId(null)}
          >
            <div
              className="fullscreen-modal-content"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="fullscreen-modal-header">
                <div className="fullscreen-header-left">
                  <h2>{printer.name}</h2>
                  {printer.status?.printer && (
                    <span className={`status-badge status-${printer.status.printer.flags?.printing ? 'printing' : printer.status.printer.flags?.paused ? 'paused' : printer.status.printer.flags?.error ? 'error' : 'idle'}`}>
                      {printer.status.printer.state}
                    </span>
                  )}
                </div>
                <button
                  className="fullscreen-modal-close"
                  onClick={() => setFullscreenPrinterId(null)}
                  aria-label="Close fullscreen"
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
              <div className="fullscreen-modal-feed">
                {imageSrc ? (
                  <>
                    <img
                      key={`fullscreen-${printer.id}-${imageKeysRef.current[printer.id] || 0}-${isPaused ? 'paused' : 'live'}`}
                      ref={(el) => {
                        imageRefsRef.current[printer.id] = el;
                      }}
                      src={imageSrc}
                      alt={printer.name}
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        if (img.complete && img.naturalWidth > 0) {
                          if (!isPaused) {
                            captureFrame(img, printer.id);
                          }
                          if (isPaused && !capturedFrame) {
                            captureFrame(img, printer.id);
                            imageKeysRef.current[printer.id] = (imageKeysRef.current[printer.id] || 0) + 1;
                          }
                        }
                      }}
                      onError={() => {
                        if (isPaused) {
                          setStreamPaused(prev => {
                            const updated = { ...prev };
                            delete updated[printer.id];
                            return updated;
                          });
                        }
                      }}
                    />
                    {(streamUrl || isPaused) && (
                      <div className="fullscreen-modal-overlay-controls">
                        <div className="stream-controls">
                          <button
                            type="button"
                            className="stream-control-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              // Get image element - try ref first, then find in DOM
                              let imgEl = imageRefsRef.current[printer.id];
                              if (!imgEl) {
                                // Fallback: find image in fullscreen modal
                                const feedContainer = e.currentTarget.closest('.fullscreen-modal-feed');
                                imgEl = feedContainer?.querySelector('img') as HTMLImageElement || null;
                              }
                              handleToggleStream(printer.id, imgEl || null);
                            }}
                            aria-label={isPaused ? 'Resume stream' : 'Pause stream'}
                          >
                            {isPaused ? (
                              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="5 3 19 12 5 21 5 3"></polygon>
                              </svg>
                            ) : (
                              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="6" y="4" width="4" height="16"></rect>
                                <rect x="14" y="4" width="4" height="16"></rect>
                              </svg>
                            )}
                          </button>
                          <button
                            className="stream-control-btn stream-fullscreen-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setFullscreenPrinterId(null);
                            }}
                            aria-label="Close fullscreen"
                          >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path>
                            </svg>
                          </button>
                        </div>
                      </div>
                    )}
                    {/* Bottom-right HUD: persistent print info overlay */}
                    {printer.status && !printer.status.error && (
                      <div className="fullscreen-hud">
                        {printer.status.job?.progress ? (
                          <>
                            {printer.status.job.file && (
                              <div className="fullscreen-hud-file">📄 {printer.status.job.file}</div>
                            )}
                            <div className="fullscreen-hud-progress">
                              <div className="fullscreen-hud-bar">
                                <div className="fullscreen-hud-fill" style={{ width: `${printer.status.job.progress.completion}%` }} />
                              </div>
                              <span className="fullscreen-hud-pct">{Math.round(printer.status.job.progress.completion)}%</span>
                            </div>
                            {printer.printerType === 'Elegoo' && printer.status.job.currentLayer != null && (
                              <div className="fullscreen-hud-row">🖨️ Layer {printer.status.job.currentLayer}{printer.status.job.totalLayer != null ? ` / ${printer.status.job.totalLayer}` : ''}</div>
                            )}
                            {printer.status.job.progress.printTimeLeft != null && (
                              <div className="fullscreen-hud-row">⏱️ {formatTime(printer.status.job.progress.printTimeLeft)} left</div>
                            )}
                          </>
                        ) : (
                          <div className="fullscreen-hud-idle">No active job</div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div className={isPaused ? "paused-placeholder" : "error"}>
                    {isPaused
                      ? 'Stream Paused'
                      : printer.printerType === 'Elegoo' && !printer.streamPath
                        ? 'Waiting for video stream URL...'
                        : printer.streamPath && printer.streamPath.startsWith('rtsp://')
                          ? 'RTSP stream - Loading...'
                          : 'No stream URL'}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}



