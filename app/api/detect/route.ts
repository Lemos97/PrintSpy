import { NextRequest, NextResponse } from 'next/server';

interface DetectionInfo {
  reachable: boolean;
  printerType?: string;
  printerInfo?: any;
  cameraStreams: Array<{ path: string; type: string }>;
  errors: string[];
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}

function getAuthHeaders(auth: { type: string; key?: string; apiKey?: string } | null) {
  const headers: Record<string, string> = {};
  
  if (!auth) {
    return headers;
  }
  
  // Application Key authentication (Bearer token) - recommended method
  if (auth.type === 'applicationKey' && auth.key) {
    headers['Authorization'] = `Bearer ${auth.key}`;
  }
  // Legacy support
  else if (auth.type === 'apikey' && auth.apiKey) {
    headers['Authorization'] = `Bearer ${auth.apiKey}`;
    headers['X-Api-Key'] = auth.apiKey;
  }
  
  return headers;
}

async function checkOctoPrint(baseUrl: string, info: DetectionInfo, auth: any = null) {
  try {
    const headers = getAuthHeaders(auth);
    const response = await fetchWithTimeout(`${baseUrl}/api/version`, {
      method: 'GET',
      headers: headers,
    });
    
    if (response.status === 401 || response.status === 403) {
      if (!auth) {
        info.errors.push('OctoPrint: Authentication required (401/403). Please provide an Application Key.');
      } else {
        info.errors.push('OctoPrint: Authentication failed. Please check your Application Key.');
      }
      return info;
    }
    
    if (response.ok) {
      const data = await response.json();
      info.reachable = true;
      info.printerType = 'OctoPrint';
      info.printerInfo = {
        server: data.server || 'OctoPrint',
        api: data.api || 'Unknown',
        text: data.text || '',
      };
      
      // Try to get printer info
      try {
        const printerResponse = await fetchWithTimeout(`${baseUrl}/api/printer`, {
          method: 'GET',
          headers: headers,
        });
        if (printerResponse.ok) {
          const printerData = await printerResponse.json();
          if (printerData.printer_profile) {
            info.printerInfo.model = printerData.printer_profile.name || 'Unknown';
          }
        }
      } catch (e) {
        // Ignore printer info errors
      }
      
      info.cameraStreams.push({ path: '/webcam/?action=stream', type: 'OctoPrint Webcam' });
      info.cameraStreams.push({ path: '/?action=stream', type: 'MJPEG Stream' });
      return info;
    }
  } catch (e: any) {
    if (e.message.includes('timeout')) {
      info.errors.push('OctoPrint: Request timeout');
    } else {
      info.errors.push(`OctoPrint: ${e.message}`);
    }
  }
  return info;
}

async function checkPrusaLink(baseUrl: string, info: DetectionInfo) {
  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/v1/status`, { method: 'GET' });
    if (response.ok) {
      const data = await response.json();
      info.reachable = true;
      info.printerType = 'PrusaLink';
      info.printerInfo = {
        server: 'PrusaLink',
        printer: data.printer?.name || 'Unknown Prusa Printer',
      };
      info.cameraStreams.push({ path: '/webcam/?action=stream', type: 'PrusaLink Webcam' });
      return info;
    }
  } catch (e: any) {
    if (e.message.includes('timeout')) {
      info.errors.push('PrusaLink: Request timeout');
    } else {
      info.errors.push(`PrusaLink: ${e.message}`);
    }
  }
  return info;
}

async function checkKlipper(baseUrl: string, info: DetectionInfo) {
  try {
    const response = await fetchWithTimeout(`${baseUrl}/printer/info`, { method: 'GET' });
    if (response.ok) {
      const data = await response.json();
      info.reachable = true;
      info.printerType = 'Klipper';
      info.printerInfo = {
        server: 'Moonraker',
        state: data.result?.state || 'Unknown',
      };
      info.cameraStreams.push({ path: '/webcam/?action=stream', type: 'Klipper Webcam' });
      return info;
    }
  } catch (e: any) {
    if (e.message.includes('timeout')) {
      info.errors.push('Klipper: Request timeout');
    } else {
      info.errors.push(`Klipper: ${e.message}`);
    }
  }
  return info;
}

async function checkElegooWebSocket(ip: string, port: number = 3030): Promise<boolean> {
  // WebSocket check would need a WebSocket library on the server
  // For now, we'll check HTTP endpoints
  return false;
}

async function checkElegoo(baseUrl: string, info: DetectionInfo) {
  // Try WebSocket first (would need ws library)
  // For now, check common HTTP endpoints
  try {
    // Check if it's an Elegoo by trying common endpoints
    const response = await fetchWithTimeout(`${baseUrl}/api/status`, { method: 'GET' });
    if (response.ok) {
      info.reachable = true;
      info.printerType = 'Elegoo';
      info.printerInfo = { server: 'Elegoo' };
      // FDM printers typically use port 3031 for video
      info.cameraStreams.push({ path: ':3031/video', type: 'Elegoo FDM MJPEG' });
      return info;
    }
  } catch (e: any) {
    // Elegoo might not have HTTP API, but WebSocket might work
    info.errors.push('Elegoo: HTTP API not available (WebSocket may still work)');
    // Still add camera stream possibilities
    info.cameraStreams.push({ path: ':3031/video', type: 'Elegoo FDM MJPEG' });
  }
  return info;
}

async function checkMachineInfo(ip: string, selectedType: string, auth: any = null): Promise<DetectionInfo> {
  const info: DetectionInfo = {
    reachable: false,
    printerType: undefined,
    printerInfo: undefined,
    cameraStreams: [],
    errors: [],
  };

  // Validate IP address
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(ip)) {
    info.errors.push('Invalid IP address format');
    return info;
  }

  const baseUrl = `http://${ip}`;

  // Check based on selected type
  if (selectedType === 'OctoPrint' || selectedType === 'auto') {
    await checkOctoPrint(baseUrl, info, auth);
    if (info.reachable && info.printerType) {
      return info;
    }
  }

  if (selectedType === 'PrusaLink' || selectedType === 'auto') {
    await checkPrusaLink(baseUrl, info);
    if (info.reachable && info.printerType) {
      return info;
    }
  }

  if (selectedType === 'Klipper' || selectedType === 'auto') {
    await checkKlipper(baseUrl, info);
    if (info.reachable && info.printerType) {
      return info;
    }
  }

  if (selectedType === 'Elegoo' || selectedType === 'auto') {
    await checkElegoo(baseUrl, info);
    if (info.reachable && info.printerType) {
      return info;
    }
  }

  // If nothing detected, check common camera streams
  if (selectedType === 'auto' && !info.reachable) {
    info.cameraStreams.push({ path: '/?action=stream', type: 'Generic MJPEG Stream' });
    info.cameraStreams.push({ path: '/webcam/?action=stream', type: 'Generic Webcam Stream' });
  }

  return info;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ip, printerType, auth } = body;

    if (!ip) {
      return NextResponse.json({ error: 'IP address is required' }, { status: 400 });
    }

    const detectionInfo = await checkMachineInfo(ip, printerType || 'auto', auth || null);

    return NextResponse.json(detectionInfo);
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Detection failed' },
      { status: 500 }
    );
  }
}

