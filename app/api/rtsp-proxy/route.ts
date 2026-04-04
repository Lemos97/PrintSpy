import { NextRequest } from 'next/server';
import { spawn } from 'child_process';

/**
 * RTSP Proxy API Route using FFmpeg
 * 
 * This route converts RTSP streams to browser-compatible MJPEG streams.
 * 
 * Note on ffmpeg.js: While ffmpeg.js (https://github.com/Kagami/ffmpeg.js/) 
 * is a JavaScript port of FFmpeg, it's designed for batch file processing 
 * using MEMFS (in-memory file system) rather than real-time streaming.
 * For RTSP streaming, we use Node.js child_process to run the system ffmpeg
 * binary, which is more efficient and practical for continuous streams.
 * 
 * If you need a pure JavaScript solution without system dependencies, consider:
 * - Using a WebRTC-based approach
 * - Pre-recording and processing with ffmpeg.js
 * - Using a dedicated streaming service
 */

export const dynamic = 'force-dynamic'; // Disable caching for streaming

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  // Support both 'url' and 'rtsp' parameters for compatibility
  // Note: searchParams.get() automatically decodes URL-encoded values
  let rtspUrl = searchParams.get('url') || searchParams.get('rtsp');

  if (!rtspUrl) {
    // console.log('[RTSP Proxy] Missing url or rtsp parameter');
    return new Response('Missing url or rtsp parameter', { status: 400 });
  }

  // searchParams.get() already decodes, but handle case where it might be double-encoded
  // or if someone passes it unencoded (though that's not recommended)
  let decodedUrl = rtspUrl;
  try {
    // Try decoding - if already decoded, this will just return the same string
    decodedUrl = decodeURIComponent(rtspUrl);
  } catch (e) {
    // If decode fails, use original (might already be decoded or invalid)
    decodedUrl = rtspUrl;
  }

  // console.log(`[RTSP Proxy] [FFmpeg] RTSP URL received: ${rtspUrl}`);
  // console.log(`[RTSP Proxy] [FFmpeg] RTSP URL decoded: ${decodedUrl}`);

  // Validate it's an RTSP URL
  if (!decodedUrl.startsWith('rtsp://')) {
    // console.log(`[RTSP Proxy] [FFmpeg] Invalid RTSP URL format: ${decodedUrl}`);
    return new Response('Invalid RTSP URL. Must start with rtsp://', { status: 400 });
  }

  // Create a ReadableStream to pipe ffmpeg output
  let cleanupFn: (() => void) | null = null;
  const boundary = 'jpgboundary'; // Multipart boundary name (match Python version)
  // Note: Python version uses '--jpgboundary' in header, we'll match that format

  const stream = new ReadableStream({
    start(controller) {
      // FFmpeg command to convert RTSP to MJPEG
      // Similar to Python version: -rtsp_transport udp -fflags nobuffer -err_detect ignore_err
      const ffmpegArgs = [
        '-rtsp_transport', 'udp',
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-err_detect', 'ignore_err',
        '-i', decodedUrl,
        '-f', 'mjpeg',
        '-q:v', '3', // Quality setting (1-31, lower is better)
        '-vsync', '0', // Passthrough timestamps for lowest latency
        '-threads', '2', // Allow 2 threads for better performance
        '-', // Output to stdout (no space after -)
      ];

      // Spawn ffmpeg process
      const ffmpegCommand = `ffmpeg ${ffmpegArgs.join(' ')}`;
      // console.log(`[RTSP Proxy] [FFmpeg] Spawning process`);
      // console.log(`[RTSP Proxy] [FFmpeg] Command: ${ffmpegCommand}`);
      const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'], // stdin: ignore, stdout: pipe, stderr: pipe
        shell: false, // Don't use shell on Windows
        windowsHide: true, // Hide window on Windows
      });

      if (!ffmpeg.pid) {
        // console.error(`[RTSP Proxy] [FFmpeg] ERROR: Process spawned but no PID assigned`);
      } else {
        // console.log(`[RTSP Proxy] [FFmpeg] Process started successfully (PID: ${ffmpeg.pid})`);
      }

      let errorOutput = '';
      let buffer: Buffer = Buffer.alloc(0);
      let frameCount = 0;
      let bytesReceived = 0;
      let isCleaningUp = false;
      let isProcessing = false;
      let firstFrameLogged = false;
      const JPEG_START = Buffer.from([0xFF, 0xD8]); // JPEG start marker
      const JPEG_END = Buffer.from([0xFF, 0xD9]);   // JPEG end marker
      // Multipart format: --boundary\r\nContent-Type: image/jpeg\r\nContent-Length: {len}\r\n\r\n{data}\r\n
      const boundaryHeader = Buffer.from(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: `);
      const boundaryFooter = Buffer.from('\r\n\r\n');

      // Proper cleanup function
      const cleanup = () => {
        if (isCleaningUp) return;
        isCleaningUp = true;

        // Remove all event listeners to prevent memory leaks
        ffmpeg.removeAllListeners();
        if (ffmpeg.stdout) {
          ffmpeg.stdout.removeAllListeners();
          ffmpeg.stdout.destroy();
        }
        if (ffmpeg.stderr) {
          ffmpeg.stderr.removeAllListeners();
          ffmpeg.stderr.destroy();
        }

        // Try graceful termination first
        if (ffmpeg.pid && !ffmpeg.killed) {
          try {
            ffmpeg.kill('SIGTERM');

            // Force kill after 2 seconds if still running
            const forceKillTimeout = setTimeout(() => {
              if (ffmpeg.pid) {
                try {
                  // Check if process is still alive
                  process.kill(ffmpeg.pid, 0); // Signal 0 just checks if process exists
                  process.kill(ffmpeg.pid, 'SIGKILL');
                  // console.log(`[RTSP Proxy] Force killed FFmpeg process (PID: ${ffmpeg.pid})`);
                } catch (e: any) {
                  // Process may already be dead (ESRCH = no such process)
                  if (e.code !== 'ESRCH') {
                    // Only log if it's not "process doesn't exist"
                  }
                }
              }
            }, 2000);

            // Clear timeout if process exits normally
            const exitHandler = () => {
              clearTimeout(forceKillTimeout);
            };
            ffmpeg.once('exit', exitHandler);
            ffmpeg.once('close', exitHandler);
          } catch (e) {
            // Process may already be dead
          }
        }
      };

      // Store cleanup function for cancel handler
      cleanupFn = cleanup;

      // Helper function to find JPEG frames and wrap them
      // Process frames synchronously for real-time streaming
      const processBuffer = () => {
        if (isProcessing) return; // Prevent concurrent processing
        isProcessing = true;

        try {
          let startIdx = buffer.indexOf(JPEG_START);
          let processedAny = false;

          if (startIdx === -1 && buffer.length > 0) {
            // No JPEG start found but we have data - log for debugging
            if (frameCount === 0) {
              // console.log(`[RTSP Proxy] [FFmpeg] WARNING: Buffer has ${buffer.length} bytes but no JPEG start marker found`);
              // console.log(`[RTSP Proxy] [FFmpeg] First 50 bytes (hex):`, buffer.slice(0, 50).toString('hex'));
            }
            isProcessing = false;
            return;
          }

          // Process all available frames immediately for real-time streaming
          while (startIdx !== -1) {
            // Find the end of this JPEG frame
            const endIdx = buffer.indexOf(JPEG_END, startIdx);

            if (endIdx !== -1) {
              // Found a complete JPEG frame
              const frameLength = endIdx + 2 - startIdx;
              const frame = buffer.slice(startIdx, endIdx + 2);
              frameCount++;
              processedAny = true;

              // Log first frame detection
              if (!firstFrameLogged) {
                firstFrameLogged = true;
                // console.log(`[RTSP Proxy] [FFmpeg] First complete JPEG frame detected (${frameLength} bytes)`);
              }

              // Build multipart frame more efficiently
              const lengthStr = frameLength.toString();
              const lengthBuf = Buffer.from(lengthStr);
              const totalLength = boundaryHeader.length + lengthBuf.length + boundaryFooter.length + frame.length + 2;

              // Pre-allocate buffer for better performance
              const multipartFrame = Buffer.allocUnsafe(totalLength);
              let offset = 0;
              boundaryHeader.copy(multipartFrame, offset);
              offset += boundaryHeader.length;
              lengthBuf.copy(multipartFrame, offset);
              offset += lengthBuf.length;
              boundaryFooter.copy(multipartFrame, offset);
              offset += boundaryFooter.length;
              frame.copy(multipartFrame, offset);
              offset += frame.length;
              multipartFrame[offset++] = 0x0D; // \r
              multipartFrame[offset++] = 0x0A; // \n

              try {
                // Log first few frames for debugging
                if (frameCount <= 3) {
                  // console.log(`[RTSP Proxy] [FFmpeg] Enqueueing frame ${frameCount} (${frameLength} bytes, multipart: ${multipartFrame.length} bytes)`);
                  // console.log(`[RTSP Proxy] [FFmpeg] Frame header preview:`, multipartFrame.slice(0, 100).toString());
                }
                controller.enqueue(multipartFrame);
              } catch (error) {
                // Client disconnected - cleanup silently
                cleanup();
                isProcessing = false;
                return;
              }

              // Remove processed frame from buffer more efficiently
              if (endIdx + 2 < buffer.length) {
                // Keep remaining data
                const remaining = buffer.slice(endIdx + 2);
                buffer = remaining;
                startIdx = buffer.indexOf(JPEG_START);
              } else {
                // All data processed
                buffer = Buffer.alloc(0);
                startIdx = -1;
              }
            } else {
              // Incomplete frame, wait for more data
              break;
            }
          }

          isProcessing = false;
        } catch (error) {
          isProcessing = false;
          // console.error(`[RTSP Proxy] [FFmpeg] Error processing buffer:`, error);
        }
      };

      // Handle ffmpeg stdout (MJPEG data)
      // Optimize buffer management to reduce copying
      let firstDataReceived = false;
      ffmpeg.stdout.on('data', (chunk: Buffer) => {
        if (!firstDataReceived) {
          firstDataReceived = true;
          // console.log(`[RTSP Proxy] [FFmpeg] First data received from stdout (${chunk.length} bytes)`);
          // Check if first chunk contains JPEG start marker
          if (chunk.indexOf(JPEG_START) !== -1) {
            // console.log(`[RTSP Proxy] [FFmpeg] JPEG start marker found in first chunk`);
          } else {
            // console.log(`[RTSP Proxy] [FFmpeg] WARNING: No JPEG start marker in first chunk`);
          }
        }

        bytesReceived += chunk.length;

        // More efficient buffer appending - only concat if buffer exists
        if (buffer.length === 0) {
          buffer = Buffer.from(chunk);
        } else {
          // Limit buffer size to prevent memory issues (max 10MB)
          const maxBufferSize = 10 * 1024 * 1024;
          if (buffer.length + chunk.length > maxBufferSize) {
            // If buffer is too large, find last JPEG start and keep from there
            const lastStart = buffer.lastIndexOf(JPEG_START);
            if (lastStart > 0) {
              buffer = buffer.slice(lastStart);
              // console.log(`[RTSP Proxy] [FFmpeg] WARNING: Buffer size limit reached, trimming to ${buffer.length} bytes`);
            } else {
              // No JPEG start found, reset buffer
              buffer = Buffer.from(chunk);
            }
          } else {
            buffer = Buffer.concat([buffer, chunk]);
          }
        }

        // Check buffer state
        const jpegStartCount = (buffer.toString('binary').match(/\xFF\xD8/g) || []).length;
        const jpegEndCount = (buffer.toString('binary').match(/\xFF\xD9/g) || []).length;
        if (firstDataReceived && frameCount === 0 && jpegStartCount > 0) {
          // console.log(`[RTSP Proxy] [FFmpeg] Buffer state: ${buffer.length} bytes, ${jpegStartCount} JPEG starts, ${jpegEndCount} JPEG ends`);
        }

        // Process complete frames (non-blocking)
        processBuffer();
      });

      ffmpeg.stdout.on('error', (error: Error) => {
        // console.error(`[RTSP Proxy] [FFmpeg] stdout error:`, error.message);
      });

      ffmpeg.stdout.on('end', () => {
        // console.log(`[RTSP Proxy] [FFmpeg] stdout stream ended`);
        // console.log(`[RTSP Proxy] [FFmpeg] Statistics: ${frameCount} frames processed, ${Math.round(bytesReceived / 1024)}KB received`);
      });

      // Handle ffmpeg stderr (logging/errors)
      // FFmpeg outputs ALL output to stderr, including info, warnings, and errors
      let stderrBuffer = '';
      let lastStderrLog = Date.now();

      ffmpeg.stderr.on('data', (chunk: Buffer) => {
        const stderrText = chunk.toString();
        errorOutput += stderrText;
        stderrBuffer += stderrText;

        // Log important FFmpeg messages for diagnosis
        const lines = stderrText.split('\n').filter(line => line.trim());
        for (const line of lines) {
          const lowerLine = line.toLowerCase();

          // Always log errors and critical issues
          if (lowerLine.includes('error') || lowerLine.includes('failed') || lowerLine.includes('cannot')) {
            // console.error(`[RTSP Proxy] [FFmpeg] ERROR: ${line.trim()}`);
          }
          // Log connection/streaming issues
          else if (lowerLine.includes('connection') || lowerLine.includes('timeout') || lowerLine.includes('unreachable')) {
            // console.log(`[RTSP Proxy] [FFmpeg] Connection: ${line.trim()}`);
          }
          // Log stream info (first frame, codec info, etc.)
          else if (lowerLine.includes('stream') && (lowerLine.includes('video') || lowerLine.includes('codec') || lowerLine.includes('fps'))) {
            // console.log(`[RTSP Proxy] [FFmpeg] Stream info: ${line.trim()}`);
          }
          // Log frame info periodically (every 5 seconds)
          else if (lowerLine.includes('frame=') && Date.now() - lastStderrLog > 5000) {
            // console.log(`[RTSP Proxy] [FFmpeg] Status: ${line.trim()}`);
            lastStderrLog = Date.now();
          }
        }
      });

      ffmpeg.stderr.on('error', (error: Error) => {
        // console.error(`[RTSP Proxy] [FFmpeg] stderr error:`, error.message);
      });

      // Handle process exit
      ffmpeg.on('close', (code: number | null, signal: string | null) => {
        // console.log(`[RTSP Proxy] [FFmpeg] Process closed (code: ${code}, signal: ${signal || 'none'})`);

        if (code !== 0 && code !== null) {
          // console.error(`[RTSP Proxy] [FFmpeg] Process exited with error code ${code}`);
          // console.error(`[RTSP Proxy] [FFmpeg] Final statistics: ${frameCount} frames, ${Math.round(bytesReceived / 1024)}KB received`);

          // Show last 1000 chars of error output for diagnosis
          const errorSnippet = errorOutput.length > 1000
            ? errorOutput.substring(errorOutput.length - 1000)
            : errorOutput;
          // console.error(`[RTSP Proxy] [FFmpeg] Error output (last 1000 chars):`, errorSnippet);
        } else {
          // console.log(`[RTSP Proxy] [FFmpeg] Process closed normally`);
          // console.log(`[RTSP Proxy] [FFmpeg] Final statistics: ${frameCount} frames, ${Math.round(bytesReceived / 1024)}KB received`);
        }

        // Ensure cleanup is done
        cleanup();
        try {
          controller.close();
        } catch (error) {
          // Stream may already be closed
        }
      });

      // Handle process errors
      ffmpeg.on('error', (error: Error) => {
        // console.error(`[RTSP Proxy] [FFmpeg] Process error:`, error.message);
        // console.error(`[RTSP Proxy] [FFmpeg] Error code:`, (error as any).code);
        // console.error(`[RTSP Proxy] [FFmpeg] Error stack:`, error.stack);

        // Check if ffmpeg is installed
        if (error.message.includes('ENOENT') || (error as any).code === 'ENOENT') {
          // console.error(`[RTSP Proxy] [FFmpeg] ERROR: FFmpeg executable not found. Please install ffmpeg.`);
          // console.error(`[RTSP Proxy] [FFmpeg] On Windows: Download from https://ffmpeg.org/download.html`);
          // console.error(`[RTSP Proxy] [FFmpeg] On Linux/Mac: Use package manager (apt, brew, etc.)`);
          controller.error(new Error('FFmpeg not found. Please install ffmpeg.'));
        } else {
          controller.error(error);
        }
      });

      // Cleanup on abort
      request.signal.addEventListener('abort', () => {
        // console.log(`[RTSP Proxy] [FFmpeg] Request aborted by client`);
        // console.log(`[RTSP Proxy] [FFmpeg] Cleaning up (frames sent: ${frameCount}, bytes: ${Math.round(bytesReceived / 1024)}KB)`);
        cleanup();
        try {
          controller.close();
        } catch (error) {
          // Stream may already be closed
        }
      });

    },
    cancel() {
      // Called when stream is cancelled (e.g., client disconnects)
      if (cleanupFn) {
        cleanupFn();
      }
    }
  });

  // Return streaming response with MJPEG headers
  // FFmpeg outputs MJPEG as a continuous stream of JPEG frames
  // For browser compatibility, we use multipart/x-mixed-replace
  // Note: Some browsers may need the stream to be wrapped in multipart boundaries
  return new Response(stream, {
    headers: {
      'Content-Type': `multipart/x-mixed-replace; boundary=--${boundary}`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable buffering for nginx (if used)
    },
  });
}
