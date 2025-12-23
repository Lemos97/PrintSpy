import { NextRequest, NextResponse } from 'next/server';
import WebSocket from 'ws';

interface StatusRequest {
  ip: string;
  printerType: string;
  auth?: {
    type: string;
    key?: string;
  };
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

async function getOctoPrintStatus(baseUrl: string, auth: any) {
  const headers = getAuthHeaders(auth);
  const status: any = {
    printer: null,
    job: null,
    error: null,
  };

  try {
    // Get printer status
    const printerResponse = await fetchWithTimeout(`${baseUrl}/api/printer`, {
      method: 'GET',
      headers: headers,
    });

    if (printerResponse.ok) {
      const printerData = await printerResponse.json();
      status.printer = {
        state: printerData.state?.text || 'Unknown',
        flags: printerData.state?.flags || {},
        temperature: {
          tool0: printerData.temperature?.tool0 || null,
          bed: printerData.temperature?.bed || null,
        },
        sd: printerData.sd || null,
      };
    } else if (printerResponse.status === 401 || printerResponse.status === 403) {
      status.error = 'Authentication failed';
      return status;
    } else {
      // Non-200 response that's not auth error
      const errorText = await printerResponse.text();
      console.error(`Printer API error (${printerResponse.status}):`, errorText);
      status.error = `Printer API returned ${printerResponse.status}`;
    }
  } catch (e: any) {
    console.error('Error fetching printer status:', e);
    status.error = `Failed to fetch printer status: ${e.message}`;
  }

  try {
    // Get job status
    const jobResponse = await fetchWithTimeout(`${baseUrl}/api/job`, {
      method: 'GET',
      headers: headers,
    });

    if (jobResponse.ok) {
      const jobData = await jobResponse.json();
      // OctoPrint job API structure: jobData.progress contains completion, printTime, printTimeLeft
      status.job = {
        state: jobData.state || 'Unknown',
        progress: jobData.progress ? {
          completion: jobData.progress.completion || 0,
          printTime: jobData.progress.printTime || null,
          printTimeLeft: jobData.progress.printTimeLeft || null,
        } : null,
        file: jobData.job?.file?.name || null,
        estimatedPrintTime: jobData.job?.estimatedPrintTime || null,
        printTime: jobData.progress?.printTime || null,
        printTimeLeft: jobData.progress?.printTimeLeft || null,
      };
    } else {
      console.error(`Job API error (${jobResponse.status})`);
      // Don't set error for job failures, it's optional
    }
  } catch (e: any) {
    // Job status is optional, don't fail if it errors
    console.error('Failed to fetch job status:', e);
  }

  return status;
}

// SDCP Command Constants
const CMD_REQUEST_STATUS_REFRESH = 0;
const CMD_REQUEST_ATTRIBUTES = 1;
const CMD_SET_VIDEO_STREAM = 386;
const WEBSOCKET_PORT = 3030;

// Generate a random hex string for RequestID (like Python's secrets.token_hex(8))
function generateRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Exponential backoff retry system for Elegoo WebSocket connections
interface RetryState {
  retryCount: number;
  lastAttemptTime: number;
  lastSuccessTime: number | null;
}

const retryStateMap = new Map<string, RetryState>();

const MAX_RETRIES = 5;
const COOLDOWN_PERIOD_MS = 10 * 60 * 1000; // 10 minutes
const INITIAL_BACKOFF_MS = 1000; // 1 second

function getBackoffDelay(retryCount: number): number {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s
  return INITIAL_BACKOFF_MS * Math.pow(2, retryCount);
}

function shouldAttemptConnection(ip: string): { shouldAttempt: boolean; reason?: string; waitTime?: number } {
  const state = retryStateMap.get(ip);
  
  if (!state) {
    // No previous attempts, allow connection
    return { shouldAttempt: true };
  }
  
  const now = Date.now();
  
  // If we've exceeded max retries, check cooldown period
  if (state.retryCount >= MAX_RETRIES) {
    const timeSinceLastAttempt = now - state.lastAttemptTime;
    
    if (timeSinceLastAttempt < COOLDOWN_PERIOD_MS) {
      const remainingWait = COOLDOWN_PERIOD_MS - timeSinceLastAttempt;
      return {
        shouldAttempt: false,
        reason: `Max retries (${MAX_RETRIES}) reached. Waiting ${Math.ceil(remainingWait / 1000)}s before next attempt.`,
        waitTime: remainingWait,
      };
    } else {
      // Cooldown period expired, reset retry count
      retryStateMap.set(ip, {
        retryCount: 0,
        lastAttemptTime: now,
        lastSuccessTime: state.lastSuccessTime,
      });
      return { shouldAttempt: true };
    }
  }
  
  // Check if we need to wait for backoff delay
  const timeSinceLastAttempt = now - state.lastAttemptTime;
  const backoffDelay = getBackoffDelay(state.retryCount);
  
  if (timeSinceLastAttempt < backoffDelay) {
    const remainingWait = backoffDelay - timeSinceLastAttempt;
    return {
      shouldAttempt: false,
      reason: `Exponential backoff: waiting ${Math.ceil(remainingWait / 1000)}s before retry ${state.retryCount + 1}/${MAX_RETRIES}`,
      waitTime: remainingWait,
    };
  }
  
  return { shouldAttempt: true };
}

function recordConnectionAttempt(ip: string, success: boolean) {
  const state = retryStateMap.get(ip) || {
    retryCount: 0,
    lastAttemptTime: 0,
    lastSuccessTime: null,
  };
  
  const now = Date.now();
  
  if (success) {
    // Reset retry count on success
    retryStateMap.set(ip, {
      retryCount: 0,
      lastAttemptTime: now,
      lastSuccessTime: now,
    });
  } else {
    // Increment retry count on failure
    retryStateMap.set(ip, {
      retryCount: state.retryCount + 1,
      lastAttemptTime: now,
      lastSuccessTime: state.lastSuccessTime,
    });
  }
}

// Elegoo Machine Status enum values (from SDCP)
const ElegooMachineStatus = {
  IDLE: 0,
  PRINTING: 1,
  FILE_TRANSFERRING: 2,
  EXPOSURE_TESTING: 3,
  DEVICES_TESTING: 4,
  LEVELING: 5,
  INPUT_SHAPING: 6,
  STOPPING: 7,
  STOPPED: 8,
  HOMING: 9,
  LOADING_UNLOADING: 10,
  PID_TUNING: 11,
  RECOVERY: 12,
};

function getStatusText(statusValue: number | number[]): string {
  let statusInt: number;
  if (Array.isArray(statusValue)) {
    statusInt = statusValue[0] || 0;
  } else {
    statusInt = statusValue;
  }

  const statusMap: Record<number, string> = {
    0: 'Idle',
    1: 'Printing',
    2: 'File Transferring',
    3: 'Exposure Testing',
    4: 'Devices Testing',
    5: 'Leveling',
    6: 'Input Shaping',
    7: 'Stopping',
    8: 'Stopped',
    9: 'Homing',
    10: 'Loading/Unloading',
    11: 'PID Tuning',
    12: 'Recovery',
  };

  return statusMap[statusInt] || 'Unknown';
}

async function getElegooStatus(ip: string): Promise<any> {
  const status: any = {
    printer: null,
    job: null,
    video: null,
    error: null,
  };

  // Check if we should attempt connection (exponential backoff / cooldown)
  const attemptCheck = shouldAttemptConnection(ip);
  if (!attemptCheck.shouldAttempt) {
    status.error = attemptCheck.reason || 'Connection attempt blocked by retry system';
    console.log(`[Retry System] ${ip}: ${status.error} - Skipping connection attempt`);
    return status; // Return immediately without any network calls
  }

  // First, try to check if the port is even reachable via HTTP
  // This helps diagnose if the port is open but not serving WebSocket
  // Only do this if we're actually going to attempt a connection
  try {
    const httpCheck = await fetchWithTimeout(`http://${ip}:${WEBSOCKET_PORT}`, {
      method: 'GET',
    }, 3000);
    // HTTP check completed (no logging needed)
  } catch (e) {
    // Port might not be reachable at all, or it's WebSocket-only
  }

  return new Promise((resolve) => {
    let connectionSuccessful = false;
    
    // Wrapper to record attempt result before resolving
    const resolveWithRetryRecord = (finalStatus: any) => {
      // Determine if connection was successful (we got status data, not just an error)
      const success = finalStatus.printer !== null || (finalStatus.job !== null && !finalStatus.error);
      recordConnectionAttempt(ip, success);
      
      if (success) {
        console.log(`[Retry System] ${ip}: Connection successful, retry count reset`);
      } else {
        const state = retryStateMap.get(ip);
        const retryCount = state?.retryCount || 0;
        if (retryCount >= MAX_RETRIES) {
          console.log(`[Retry System] ${ip}: Connection failed, max retries reached. Cooldown period started.`);
        } else {
          console.log(`[Retry System] ${ip}: Connection failed, retry count: ${retryCount}/${MAX_RETRIES}`);
        }
      }
      
      resolve(finalStatus);
    };
    // Try different WebSocket URL formats
    // Note: Elegoo printers may require the WebSocket server to be active (SDCPStatus = 1)
    // The WebSocket server might only be available when the printer is in a ready state
    // Based on SDCP attributes: SDCPStatus = 1 means service is connected
    const wsUrls = [
      `ws://${ip}:${WEBSOCKET_PORT}/websocket`,
    ];
    
    // SDCP protocol requires MainboardID and Connection ID
    // For first connection, we'll use placeholder values and try to get attributes first
    // If we have stored attributes, use them; otherwise use defaults
    let mainboardId = 'ffffffff'; // Default placeholder
    let connectionId = '00000000'; // Default placeholder
    let hasAttributes = false;
    
    let timeout: NodeJS.Timeout;
    let ws: WebSocket | null = null;
    let currentUrlIndex = 0;
    const pendingRequests = new Map<string, { resolve: () => void; timeout: NodeJS.Timeout }>();

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (ws) {
        try {
          // Only try to close if WebSocket is in a state that allows closing
          // WebSocket states: CONNECTING (0), OPEN (1), CLOSING (2), CLOSED (3)
          const state = ws.readyState;
          if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
            ws.removeAllListeners();
            try {
              ws.close();
            } catch (closeError) {
              // Ignore - WebSocket might have changed state between check and close
            }
          }
        } catch (e) {
          // Ignore close errors - WebSocket might already be closed
        } finally {
          ws = null;
        }
      }
    };

    const tryConnect = (urlIndex: number) => {
      if (urlIndex >= wsUrls.length) {
        cleanup();
        status.error = `WebSocket connection failed on all attempted URLs (${wsUrls.join(', ')}). The printer's WebSocket server may not be running on port ${WEBSOCKET_PORT}. This can happen if: 1) The printer is in sleep mode, 2) The printer needs to be "awakened" by interacting with it, 3) The WebSocket server only starts during active printing, or 4) The printer firmware doesn't support WebSocket on this port.`;
        resolveWithRetryRecord(status);
        return;
      }

      const wsUrl = wsUrls[urlIndex];

      // Set timeout for connection and response
      timeout = setTimeout(() => {
        cleanup();
        if (!status.printer && !status.error) {
          // Try next URL
          tryConnect(urlIndex + 1);
        }
      }, 8000); // 8 second timeout per attempt

      try {
        // Create WebSocket connection
        // Note: Some printers may require specific headers or subprotocols
        ws = new WebSocket(wsUrl, {
          // Try without any specific options first
        });
        
        // Set up message handler BEFORE connection opens
        // This ensures we catch any messages sent immediately upon connection

        ws.on('open', () => {
          // Clear connection timeout, set response timeout
          clearTimeout(timeout);
          
          // Listen for any incoming messages first (printer might send unsolicited status)
          // Then send status refresh command after a short delay using proper SDCP format
          setTimeout(() => {
            // First, try to get attributes to get MainboardID and Connection ID
            // If we don't have attributes yet, request them first
            if (!hasAttributes) {
              const requestId = generateRequestId();
              const attributesCommand = {
                Id: connectionId,
                Data: {
                  Cmd: CMD_REQUEST_ATTRIBUTES,
                  Data: {},
                  RequestID: requestId,
                  MainboardID: mainboardId,
                  TimeStamp: Math.floor(Date.now() / 1000),
                  From: 0,
                },
                Topic: `sdcp/request/${mainboardId}`,
              };
              ws!.send(JSON.stringify(attributesCommand));
              
              // Set timeout for attributes response
              const attrTimeout = setTimeout(() => {
                // If attributes don't come, try status with placeholder IDs
                sendStatusRequest();
              }, 3000);
              
              pendingRequests.set(requestId, {
                resolve: () => {
                  clearTimeout(attrTimeout);
                  // After getting attributes, send status request
                  sendStatusRequest();
                },
                timeout: attrTimeout,
              });
            } else {
              sendStatusRequest();
            }
            
            function sendStatusRequest() {
              const requestId = generateRequestId();
              const command = {
                Id: connectionId,
                Data: {
                  Cmd: CMD_REQUEST_STATUS_REFRESH,
                  Data: {},
                  RequestID: requestId,
                  MainboardID: mainboardId,
                  TimeStamp: Math.floor(Date.now() / 1000),
                  From: 0,
                },
                Topic: `sdcp/request/${mainboardId}`,
              };
              ws!.send(JSON.stringify(command));
              
              // Track this request
              const statusTimeout = setTimeout(() => {
                pendingRequests.delete(requestId);
              }, 10000);
              
              pendingRequests.set(requestId, {
                resolve: () => {
                  clearTimeout(statusTimeout);
                  // After getting status, request video stream
                  sendVideoRequest();
                },
                timeout: statusTimeout,
              });
            }
            
            function sendVideoRequest() {
              // First, disable the video stream to reset any stuck connections
              const disableRequestId = generateRequestId();
              const disableCommand = {
                Id: connectionId,
                Data: {
                  Cmd: CMD_SET_VIDEO_STREAM,
                  Data: { Enable: 0 }, // Disable video stream first to reset
                  RequestID: disableRequestId,
                  MainboardID: mainboardId,
                  TimeStamp: Math.floor(Date.now() / 1000),
                  From: 0,
                },
                Topic: `sdcp/request/${mainboardId}`,
              };
              ws!.send(JSON.stringify(disableCommand));
              
              // Track disable request (don't wait for response, just send it)
              const disableTimeout = setTimeout(() => {
                pendingRequests.delete(disableRequestId);
              }, 2000);
              
              pendingRequests.set(disableRequestId, {
                resolve: () => {
                  clearTimeout(disableTimeout);
                  pendingRequests.delete(disableRequestId);
                },
                timeout: disableTimeout,
              });
              
              // After a short delay, enable the video stream
              setTimeout(() => {
                const enableRequestId = generateRequestId();
                const enableCommand = {
                  Id: connectionId,
                  Data: {
                    Cmd: CMD_SET_VIDEO_STREAM,
                    Data: { Enable: 1 }, // Enable video stream
                    RequestID: enableRequestId,
                    MainboardID: mainboardId,
                    TimeStamp: Math.floor(Date.now() / 1000),
                    From: 0,
                  },
                  Topic: `sdcp/request/${mainboardId}`,
                };
                ws!.send(JSON.stringify(enableCommand));
                
                // Track this request
                const videoTimeout = setTimeout(() => {
                  pendingRequests.delete(enableRequestId);
                  // If video request times out, still resolve with status
                  if (status.printer) {
                    clearTimeout(timeout);
                    timeout = setTimeout(() => {
                      cleanup();
                      resolveWithRetryRecord(status);
                    }, 1000);
                  }
                }, 5000);
                
                pendingRequests.set(enableRequestId, {
                  resolve: () => {
                    clearTimeout(videoTimeout);
                    // Video received, resolve after brief delay
                    clearTimeout(timeout);
                    timeout = setTimeout(() => {
                      cleanup();
                      resolveWithRetryRecord(status);
                    }, 1000);
                  },
                  timeout: videoTimeout,
                });
              }, 500); // Wait 500ms after disabling before re-enabling
            }
          }, 500); // Wait 500ms for any initial messages from printer
          
          // Set timeout for response (increased to 10 seconds)
          timeout = setTimeout(() => {
            cleanup();
            if (!status.printer && !status.error) {
              status.error = 'Response timeout after connection. The printer may not be sending status updates, or the WebSocket server may not be fully initialized.';
              resolveWithRetryRecord(status);
            }
          }, 10000); // Increased to 10 seconds
        });

        ws.on('message', (data: WebSocket.Data) => {
          try {
            const response = JSON.parse(data.toString());
            const fullResponse = JSON.stringify(response);
            const topic = response.Topic || '';
            // Message received - processing by topic
            
            // Handle messages by Topic (SDCP protocol)
            if (topic.startsWith('sdcp/response/')) {
              // Command response - check RequestID
              const responseData = response.Data;
              if (responseData) {
                const requestId = responseData.RequestID;
                if (requestId && pendingRequests.has(requestId)) {
                  const pending = pendingRequests.get(requestId)!;
                  clearTimeout(pending.timeout);
                  pending.resolve();
                  pendingRequests.delete(requestId);
                }
                
                // Handle attributes response
                if (responseData.Cmd === CMD_REQUEST_ATTRIBUTES) {
                  const attributes = responseData.Data?.Attributes || responseData.Data;
                  if (attributes?.MainboardID) {
                    mainboardId = attributes.MainboardID;
                    connectionId = attributes.MainboardID; // Use MainboardID as connection ID
                    hasAttributes = true;
                    // MainboardID and ConnectionID obtained
                  }
                }
                
                // Handle video stream response
                if (responseData.Cmd === CMD_SET_VIDEO_STREAM) {
                  // Log the full response for debugging
                  console.log('[Elegoo Status] Video stream response:', JSON.stringify(responseData, null, 2));
                  
                  // According to ElegooVideo model, VideoUrl is in Data.Data
                  // Structure: response.Data.Data.VideoUrl
                  const videoData = responseData.Data || {};
                  const nestedData = videoData.Data || {};
                  
                  // Try multiple possible locations for the video URL
                  const videoUrl = nestedData.VideoUrl 
                    || videoData.VideoUrl 
                    || nestedData.video_url
                    || videoData.video_url 
                    || nestedData.VideoURL
                    || videoData.VideoURL
                    || nestedData.url
                    || videoData.url
                    || responseData.VideoUrl
                    || responseData.video_url;
                  
                  // Also check Ack status (0 = success)
                  const ack = nestedData.Ack !== undefined ? nestedData.Ack : (videoData.Ack !== undefined ? videoData.Ack : -1);
                  
                  console.log('[Elegoo Status] Extracted video URL:', videoUrl);
                  console.log('[Elegoo Status] Ack status:', ack);
                  
                  if (videoUrl) {
                    status.video = {
                      url: videoUrl,
                      status: ack === 0 ? 'enabled' : 'error',
                    };
                    console.log('[Elegoo Status] Video stream URL set:', videoUrl);
                  } else {
                    console.log('[Elegoo Status] WARNING: Video URL not found in response');
                    console.log('[Elegoo Status] ResponseData keys:', Object.keys(responseData));
                    console.log('[Elegoo Status] VideoData keys:', Object.keys(videoData));
                    console.log('[Elegoo Status] NestedData keys:', Object.keys(nestedData));
                    console.log('[Elegoo Status] Full responseData:', JSON.stringify(responseData, null, 2));
                  }
                }
              }
            } else if (topic.startsWith('sdcp/status/')) {
              // Unsolicited status update - process it
              processStatusData(response);
            } else if (topic.startsWith('sdcp/attributes/')) {
              // Attributes update
              const attributes = response.Attributes || response.Data?.Attributes || response.Data;
              if (attributes?.MainboardID) {
                mainboardId = attributes.MainboardID;
                connectionId = attributes.MainboardID;
                hasAttributes = true;
                // MainboardID obtained from attributes
              }
            } else if (!topic) {
              // Fallback: check for status data in response (legacy format or no topic)
              const hasStatusData = response.Status !== undefined || 
                                   response.CurrentStatus !== undefined || 
                                   response.PrintInfo !== undefined ||
                                   response.TempOfUVLED !== undefined ||
                                   response.TempOfBox !== undefined;
              
              if (hasStatusData) {
                processStatusData(response);
              }
            }
            
            function processStatusData(data: any) {
              // Check if this message contains status data
              const hasStatusData = data.Status !== undefined || 
                                   data.CurrentStatus !== undefined || 
                                   data.PrintInfo !== undefined ||
                                   data.TempOfUVLED !== undefined ||
                                   data.TempOfBox !== undefined ||
                                   (data.Data && (data.Data.Status || data.Data.CurrentStatus));
              
              if (!hasStatusData) return;
              
              // Clear any pending timeout
              clearTimeout(timeout);
              
              // Check for errors
              if (data.Ack !== undefined && data.Ack !== 0) {
                status.error = `SDCP error: ${data.Ack}`;
                cleanup();
                resolveWithRetryRecord(status);
                return;
              }

              // Parse status data
              // SDCP response structure can be:
              // - { Status: { CurrentStatus: [...], PrintInfo: {...}, ... } }
              // - { Data: { Status: { CurrentStatus: [...], ... } } }
              // - Flat format: { CurrentStatus: [...], PrintInfo: {...}, ... }
              const statusData = data.Status || data.Data?.Status || data.Data || data;
              const currentStatus = statusData.CurrentStatus;
              const printInfo = statusData.PrintInfo || statusData;
              
              // Parsing status data

              // Map printer status
              status.printer = {
                state: getStatusText(currentStatus || 0),
                flags: {
                  operational: true,
                  printing: Array.isArray(currentStatus) 
                    ? currentStatus[0] === ElegooMachineStatus.PRINTING
                    : currentStatus === ElegooMachineStatus.PRINTING,
                  paused: false, // SDCP doesn't have a paused state, it's part of printing
                  error: false, // Would need to check error status
                  ready: Array.isArray(currentStatus)
                    ? currentStatus[0] === ElegooMachineStatus.IDLE
                    : currentStatus === ElegooMachineStatus.IDLE,
                },
                temperature: {
                  // For resin printers: UV LED and box temperatures
                  uvled: statusData.TempOfUVLED ? {
                    actual: Math.round(statusData.TempOfUVLED * 10) / 10,
                    target: null,
                  } : null,
                  box: statusData.TempOfBox ? {
                    actual: Math.round(statusData.TempOfBox * 10) / 10,
                    target: statusData.TempTargetBox ? Math.round(statusData.TempTargetBox * 10) / 10 : null,
                  } : null,
                },
              };

              // Map job status
              if (printInfo.Filename || printInfo.Progress !== undefined || printInfo.CurrentLayer !== undefined) {
                const progress = printInfo.Progress !== undefined ? printInfo.Progress : null;
                const currentLayer = printInfo.CurrentLayer;
                const totalLayers = printInfo.TotalLayer;
                
                // Calculate progress from layers if not provided
                let completion = progress;
                if (completion === null && currentLayer !== undefined && totalLayers !== undefined && totalLayers > 0) {
                  completion = Math.round((currentLayer / totalLayers) * 100);
                }

                // Calculate time remaining (remaining_ticks is in milliseconds)
                const remainingTicks = printInfo.RemainingTicks;
                const printTimeLeft = remainingTicks !== undefined && remainingTicks !== null
                  ? Math.floor(remainingTicks / 1000) // Convert ms to seconds
                  : null;

                status.job = {
                  state: status.printer.state,
                  progress: completion !== null ? {
                    completion: completion,
                    printTime: printInfo.CurrentTicks ? Math.floor(printInfo.CurrentTicks / 1000) : null,
                    printTimeLeft: printTimeLeft,
                  } : null,
                  file: printInfo.Filename || null,
                  estimatedPrintTime: printInfo.TotalTicks ? Math.floor(printInfo.TotalTicks / 1000) : null,
                  printTime: printInfo.CurrentTicks ? Math.floor(printInfo.CurrentTicks / 1000) : null,
                  printTimeLeft: printTimeLeft,
                };
              }

              // We got status data - resolve after a brief delay to allow for more updates
              clearTimeout(timeout);
              timeout = setTimeout(() => {
                cleanup();
                resolveWithRetryRecord(status);
              }, 1000); // Wait 1 second for potential additional updates
            }
            
            // Handle response messages that might contain status in Data.Status
            if (topic.startsWith('sdcp/response/')) {
              const responseData = response.Data;
              if (responseData?.Data?.Status || responseData?.Status) {
                processStatusData(responseData.Data || responseData);
              }
            }
          } catch (e: any) {
            cleanup();
            status.error = `Failed to parse response: ${e.message}`;
            resolveWithRetryRecord(status);
          }
        });

        ws.on('error', (error: Error) => {
          console.error(`WebSocket error on ${wsUrl}:`, error.message);
          cleanup();
          
          // If it's "Unexpected server response: 200", try next URL
          if (error.message.includes('Unexpected server response')) {
            console.log(`Server responded with HTTP instead of WebSocket, trying next URL...`);
            tryConnect(urlIndex + 1);
            return;
          }
          
          // For other errors, try next URL or fail
          if (urlIndex < wsUrls.length - 1) {
            tryConnect(urlIndex + 1);
            return;
          }
          
          // All URLs failed
          if (error.message.includes('ECONNREFUSED')) {
            status.error = `Connection refused on port ${WEBSOCKET_PORT}. The printer may be offline or the WebSocket server is not running.`;
          } else if (error.message.includes('ETIMEDOUT') || error.message.includes('timeout')) {
            status.error = `Connection timeout. The printer at ${ip}:${WEBSOCKET_PORT} may be unreachable.`;
          } else {
            status.error = `WebSocket error: ${error.message}`;
          }
          resolveWithRetryRecord(status);
        });

        ws.on('close', (code: number, reason: Buffer) => {
          // If we haven't resolved yet, it means connection closed unexpectedly
          if (!status.printer && !status.error) {
            const reasonStr = reason.toString();
            // If connection closed before we got data, try next URL
            if (urlIndex < wsUrls.length - 1 && code !== 1000) {
              console.log(`Connection closed unexpectedly (code: ${code}), trying next URL...`);
              cleanup();
              tryConnect(urlIndex + 1);
              return;
            }
            cleanup();
            status.error = `Connection closed (code: ${code}${reasonStr ? `, reason: ${reasonStr}` : ''})`;
            resolveWithRetryRecord(status);
          } else {
            // Connection closed normally after we got data, just cleanup
            cleanup();
          }
        });
      } catch (error: any) {
        cleanup();
        // Try next URL if available
        if (urlIndex < wsUrls.length - 1) {
          tryConnect(urlIndex + 1);
          return;
        }
        status.error = `Failed to create WebSocket: ${error.message}`;
        resolveWithRetryRecord(status);
      }
    };

    // Start connection attempt
    tryConnect(0);
  });
}

export async function POST(request: NextRequest) {
  try {
    const body: StatusRequest = await request.json();
    const { ip, printerType, auth } = body;

    if (!ip) {
      return NextResponse.json({ error: 'IP address is required' }, { status: 400 });
    }

    let status: any;

    if (printerType === 'OctoPrint') {
      const baseUrl = `http://${ip}`;
      status = await getOctoPrintStatus(baseUrl, auth || null);
    } else if (printerType === 'Elegoo') {
      status = await getElegooStatus(ip);
    } else {
      return NextResponse.json({ error: 'Status fetching only supported for OctoPrint and Elegoo' }, { status: 400 });
    }

    return NextResponse.json(status);
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to fetch status' },
      { status: 500 }
    );
  }
}

