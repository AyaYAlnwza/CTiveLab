'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Camera,
  Video,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Eye,
  Sliders,
  Play,
  Pause,
  Upload,
} from 'lucide-react';

export interface GestureDetectionResult {
  confidenceScore: number;
  timestamp: Date;
  handDetected: boolean;
  isSOS: boolean;
}

interface GestureDetectorProps {
  onSOSDetected: (result: GestureDetectionResult) => void;
  isLocked?: boolean;
  requiredHoldDurationSec?: number; // default: 1.5s
}

// MediaPipe 21 Hand Landmark indices
export const HAND_LANDMARKS = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

// Connections between joints for drawing skeleton
const SKELETON_CONNECTIONS = [
  // Palm
  [0, 1], [1, 2], [2, 5], [5, 9], [9, 13], [13, 17], [17, 0],
  // Thumb
  [2, 3], [3, 4],
  // Index
  [5, 6], [6, 7], [7, 8],
  // Middle
  [9, 10], [10, 11], [11, 12],
  // Ring
  [13, 14], [14, 15], [15, 16],
  // Pinky
  [17, 18], [18, 19], [19, 20],
];

interface Landmark {
  x: number;
  y: number;
  z: number;
}

export default function GestureDetector({
  onSOSDetected,
  isLocked = false,
  requiredHoldDurationSec = 1.5,
}: GestureDetectorProps) {
  // DOM element refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Runtime & stream refs
  const cameraRef = useRef<any>(null);
  const handsRef = useRef<any>(null);
  const animFrameIdRef = useRef<number | null>(null);

  // Hold duration state refs
  const holdStartTimeRef = useRef<number | null>(null);
  const isCooldownRef = useRef<boolean>(false);
  const cooldownTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Component states
  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [modelLoading, setModelLoading] = useState<boolean>(true);
  const [feedMode, setFeedMode] = useState<'camera' | 'fallback_video'>('camera');
  const [isVideoPlaying, setIsVideoPlaying] = useState<boolean>(false);
  const [currentGestureStatus, setCurrentGestureStatus] = useState<
    'NONE' | 'HAND_TRACKED' | 'THUMB_TUCKED' | 'SOS_DETECTING' | 'TRIGGERED'
  >('NONE');
  const [holdProgress, setHoldProgress] = useState<number>(0); // 0 to 100%
  const [confidence, setConfidence] = useState<number>(0);
  const [fps, setFps] = useState<number>(0);
  const [videoFileSrc, setVideoFileSrc] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Performance telemetry
  const lastFrameTimeRef = useRef<number>(performance.now());
  const frameCountRef = useRef<number>(0);

  /**
   * 3D Euclidean distance helper
   */
  const distance = (p1: Landmark, p2: Landmark): number => {
    return Math.sqrt(
      Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2) + Math.pow(p1.z - p2.z, 2)
    );
  };

  /**
   * SIGNAL FOR HELP (Canadian Women's Foundation SOS Gesture) Detection Logic
   * 1. Thumb is tucked across the palm towards pinky base
   * 2. Four fingers (Index, Middle, Ring, Pinky) are folded down over thumb
   */
  const evaluateSOSGesture = useCallback((landmarks: Landmark[]) => {
    const wrist = landmarks[HAND_LANDMARKS.WRIST];
    const thumbTip = landmarks[HAND_LANDMARKS.THUMB_TIP];
    const thumbMcp = landmarks[HAND_LANDMARKS.THUMB_MCP];

    const indexMcp = landmarks[HAND_LANDMARKS.INDEX_MCP];
    const indexPip = landmarks[HAND_LANDMARKS.INDEX_PIP];
    const indexTip = landmarks[HAND_LANDMARKS.INDEX_TIP];

    const middleMcp = landmarks[HAND_LANDMARKS.MIDDLE_MCP];
    const middlePip = landmarks[HAND_LANDMARKS.MIDDLE_PIP];
    const middleTip = landmarks[HAND_LANDMARKS.MIDDLE_TIP];

    const ringMcp = landmarks[HAND_LANDMARKS.RING_MCP];
    const ringPip = landmarks[HAND_LANDMARKS.RING_PIP];
    const ringTip = landmarks[HAND_LANDMARKS.RING_TIP];

    const pinkyMcp = landmarks[HAND_LANDMARKS.PINKY_MCP];
    const pinkyPip = landmarks[HAND_LANDMARKS.PINKY_PIP];
    const pinkyTip = landmarks[HAND_LANDMARKS.PINKY_TIP];

    // Reference palm scale (distance between Wrist and Middle MCP) to make checks scale-invariant
    const palmSize = distance(wrist, middleMcp);
    if (palmSize < 0.02) {
      return { isSOS: false, isThumbTucked: false, confidence: 0 };
    }

    // --- CHECK 1: Thumb Tucked into Palm ---
    // In open palm, thumbTip is far from Pinky MCP and Pinky Base.
    // When tucked, thumb tip moves toward the center of the palm or base of the pinky.
    const thumbToPinkyMcpDist = distance(thumbTip, pinkyMcp);
    const thumbToIndexMcpDist = distance(thumbTip, indexMcp);
    const thumbTuckRatio = thumbToPinkyMcpDist / palmSize;

    // Thumb is considered tucked if it crosses under index MCP toward pinky
    const isThumbTucked =
      thumbTuckRatio < 0.85 ||
      distance(thumbTip, middleMcp) < palmSize * 0.65;

    // --- CHECK 2: Four Fingers Folded Down ---
    // A finger is folded when its TIP is closer to the wrist than its PIP joint,
    // or when the TIP-to-MCP distance is significantly shorter than PIP-to-MCP distance.
    const isIndexFolded =
      distance(indexTip, wrist) < distance(indexPip, wrist) * 1.05 ||
      distance(indexTip, indexMcp) < distance(indexPip, indexMcp) * 1.1;

    const isMiddleFolded =
      distance(middleTip, wrist) < distance(middlePip, wrist) * 1.05 ||
      distance(middleTip, middleMcp) < distance(middlePip, middleMcp) * 1.1;

    const isRingFolded =
      distance(ringTip, wrist) < distance(ringPip, wrist) * 1.05 ||
      distance(ringTip, ringMcp) < distance(ringPip, ringMcp) * 1.1;

    const isPinkyFolded =
      distance(pinkyTip, wrist) < distance(pinkyPip, wrist) * 1.05 ||
      distance(pinkyTip, pinkyMcp) < distance(pinkyPip, pinkyMcp) * 1.1;

    const foldedFingersCount = [
      isIndexFolded,
      isMiddleFolded,
      isRingFolded,
      isPinkyFolded,
    ].filter(Boolean).length;

    // SOS is valid when thumb is tucked AND at least 3 to 4 fingers are folded down over it
    const isSOS = isThumbTucked && foldedFingersCount >= 3;

    // Calculate normalized confidence score [0.0, 1.0]
    let score = 0;
    if (isThumbTucked) score += 0.35;
    score += (foldedFingersCount / 4) * 0.65;

    return {
      isSOS,
      isThumbTucked,
      confidence: Math.min(1.0, parseFloat(score.toFixed(2))),
    };
  }, []);

  /**
   * MediaPipe Hands frame result processor
   */
  const onResults = useCallback(
    (results: any) => {
      // Calculate FPS
      frameCountRef.current += 1;
      const now = performance.now();
      if (now - lastFrameTimeRef.current >= 1000) {
        setFps(frameCountRef.current);
        frameCountRef.current = 0;
        lastFrameTimeRef.current = now;
      }

      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Sync canvas resolution with video dimensions
      if (video.videoWidth && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Check if any hands detected
      if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        // Reset hold duration when no hand is present
        holdStartTimeRef.current = null;
        setHoldProgress(0);
        setConfidence(0);
        if (!isCooldownRef.current) {
          setCurrentGestureStatus('NONE');
        }
        ctx.restore();
        return;
      }

      // Process primary hand
      const landmarks: Landmark[] = results.multiHandLandmarks[0];
      const { isSOS, isThumbTucked, confidence: confScore } = evaluateSOSGesture(landmarks);
      setConfidence(confScore);

      // Determine visual theme based on gesture phase
      let strokeColor = '#10b981'; // Green: Normal
      let glowColor = 'rgba(16, 185, 129, 0.4)';

      if (isCooldownRef.current) {
        strokeColor = '#ec4899'; // Magenta: Cooldown / Dispatched
        glowColor = 'rgba(236, 72, 153, 0.6)';
        setCurrentGestureStatus('TRIGGERED');
      } else if (isSOS) {
        strokeColor = '#ef4444'; // Red: SOS In Progress
        glowColor = 'rgba(239, 68, 68, 0.8)';
        setCurrentGestureStatus('SOS_DETECTING');

        // HOLD DURATION LOGIC (1.5 seconds)
        if (!holdStartTimeRef.current) {
          holdStartTimeRef.current = now;
        }

        const elapsedSec = (now - holdStartTimeRef.current) / 1000;
        const progressPct = Math.min(100, (elapsedSec / requiredHoldDurationSec) * 100);
        setHoldProgress(Math.round(progressPct));

        // When hold threshold is met, trigger SOS event
        if (elapsedSec >= requiredHoldDurationSec && !isCooldownRef.current) {
          isCooldownRef.current = true;
          setCurrentGestureStatus('TRIGGERED');
          setHoldProgress(100);

          onSOSDetected({
            confidenceScore: confScore,
            timestamp: new Date(),
            handDetected: true,
            isSOS: true,
          });

          // 5-second cooldown before allowing subsequent trigger
          cooldownTimerRef.current = setTimeout(() => {
            isCooldownRef.current = false;
            holdStartTimeRef.current = null;
            setHoldProgress(0);
            setCurrentGestureStatus('NONE');
          }, 5000);
        }
      } else if (isThumbTucked) {
        strokeColor = '#f59e0b'; // Amber: Thumb tucked, waiting for fingers
        glowColor = 'rgba(245, 158, 11, 0.5)';
        setCurrentGestureStatus('THUMB_TUCKED');
        holdStartTimeRef.current = null;
        setHoldProgress(0);
      } else {
        setCurrentGestureStatus('HAND_TRACKED');
        holdStartTimeRef.current = null;
        setHoldProgress(0);
      }

      // --- DRAW HAND SKELETON CONNECTIONS ---
      ctx.lineWidth = 4;
      ctx.strokeStyle = strokeColor;
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 12;

      for (const [startIdx, endIdx] of SKELETON_CONNECTIONS) {
        const p1 = landmarks[startIdx];
        const p2 = landmarks[endIdx];
        ctx.beginPath();
        ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
        ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
        ctx.stroke();
      }

      // --- DRAW LANDMARK KEYPOINTS ---
      for (let i = 0; i < landmarks.length; i++) {
        const lm = landmarks[i];
        const cx = lm.x * canvas.width;
        const cy = lm.y * canvas.height;

        ctx.beginPath();
        // Emphasize thumb tip and finger tips
        const isTip = [4, 8, 12, 16, 20].includes(i);
        const radius = isTip ? 6 : 4;
        ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
        ctx.fillStyle = isTip ? '#ffffff' : strokeColor;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = strokeColor;
        ctx.stroke();
      }

      // --- DRAW HUD OVERLAY ON CANVAS (Status & Progress Ring) ---
      const wrist = landmarks[HAND_LANDMARKS.WRIST];
      const headX = wrist.x * canvas.width;
      const headY = Math.max(30, wrist.y * canvas.height - 80);

      // HUD Label
      ctx.font = 'bold 14px ui-monospace, SFMono-Regular, monospace';
      ctx.fillStyle = strokeColor;
      ctx.textAlign = 'center';
      if (isCooldownRef.current) {
        ctx.fillText('EMERGENCY DISPATCHED', headX, headY);
      } else if (isSOS) {
        ctx.fillText(`SOS DETECTED (${Math.round((holdProgress / 100) * requiredHoldDurationSec * 10) / 10}s / ${requiredHoldDurationSec}s)`, headX, headY);

        // Radial progress arc
        ctx.beginPath();
        ctx.arc(headX, headY - 24, 16, -Math.PI / 2, (-Math.PI / 2) + (2 * Math.PI * (holdProgress / 100)));
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#ef4444';
        ctx.stroke();
      } else if (isThumbTucked) {
        ctx.fillText('STEP 1: THUMB TUCKED - FOLD FINGERS', headX, headY);
      } else {
        ctx.fillText('HAND ACTIVE', headX, headY);
      }

      ctx.restore();
    },
    [evaluateSOSGesture, requiredHoldDurationSec, onSOSDetected]
  );

  /**
   * Initialize MediaPipe Hands and Camera
   */
  useEffect(() => {
    let isSubscribed = true;

    async function initMediaPipe() {
      try {
        setModelLoading(true);
        setErrorMessage(null);

        // Load MediaPipe from window or dynamic bundle
        // Using Google CDN scripts ensures robust Next.js SSR compatibility
        const loadScript = (src: string) => {
          return new Promise<void>((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) {
              resolve();
              return;
            }
            const script = document.createElement('script');
            script.src = src;
            script.crossOrigin = 'anonymous';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
            document.head.appendChild(script);
          });
        };

        // Load Hands and Camera Utils
        await Promise.all([
          loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js'),
          loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js'),
        ]);

        if (!isSubscribed) return;

        const mpHands = (window as any).Hands;
        const mpCamera = (window as any).Camera;

        if (!mpHands) {
          throw new Error('MediaPipe Hands library could not be instantiated.');
        }

        const hands = new mpHands({
          locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
        });

        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 1,
          minDetectionConfidence: 0.65,
          minTrackingConfidence: 0.6,
        });

        hands.onResults(onResults);
        handsRef.current = hands;

        // Initialize webcam if mode is camera
        if (feedMode === 'camera' && videoRef.current && mpCamera) {
          const camera = new mpCamera(videoRef.current, {
            onFrame: async () => {
              if (videoRef.current && handsRef.current) {
                await handsRef.current.send({ image: videoRef.current });
              }
            },
            width: 640,
            height: 480,
          });
          await camera.start();
          cameraRef.current = camera;
          setCameraActive(true);
        }

        setModelLoading(false);
      } catch (err: any) {
        console.error('[GestureDetector] Initialization error:', err);
        if (isSubscribed) {
          setErrorMessage(err.message || 'Failed to initialize vision pipeline.');
          setModelLoading(false);
        }
      }
    }

    initMediaPipe();

    return () => {
      isSubscribed = false;
      if (cameraRef.current) {
        try {
          cameraRef.current.stop();
        } catch (e) {
          // cleanup
        }
      }
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current);
      }
      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current);
      }
    };
  }, [onResults, feedMode]);

  /**
   * Continuous loop for Fallback Video processing
   */
  const processFallbackVideoFrame = useCallback(async () => {
    if (
      feedMode === 'fallback_video' &&
      videoRef.current &&
      handsRef.current &&
      !videoRef.current.paused &&
      !videoRef.current.ended
    ) {
      await handsRef.current.send({ image: videoRef.current });
    }
    if (feedMode === 'fallback_video' && isVideoPlaying) {
      animFrameIdRef.current = requestAnimationFrame(processFallbackVideoFrame);
    }
  }, [feedMode, isVideoPlaying]);

  useEffect(() => {
    if (feedMode === 'fallback_video' && isVideoPlaying) {
      animFrameIdRef.current = requestAnimationFrame(processFallbackVideoFrame);
    }
    return () => {
      if (animFrameIdRef.current) cancelAnimationFrame(animFrameIdRef.current);
    };
  }, [feedMode, isVideoPlaying, processFallbackVideoFrame]);

  /**
   * Handle Fallback Video File Upload
   */
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Release camera if running
      if (cameraRef.current) {
        try {
          cameraRef.current.stop();
        } catch (e) {}
      }
      const url = URL.createObjectURL(file);
      setVideoFileSrc(url);
      setFeedMode('fallback_video');
      setCameraActive(false);
      setIsVideoPlaying(false);
    }
  };

  /**
   * Toggle Video Play/Pause in Fallback Mode
   */
  const toggleVideoPlayback = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsVideoPlaying(true);
    } else {
      videoRef.current.pause();
      setIsVideoPlaying(false);
    }
  };

  /**
   * Switch back to Live Camera Mode
   */
  const switchToCamera = async () => {
    setFeedMode('camera');
    setVideoFileSrc(null);
    setIsVideoPlaying(false);
    if ((window as any).Camera && videoRef.current) {
      const camera = new (window as any).Camera(videoRef.current, {
        onFrame: async () => {
          if (videoRef.current && handsRef.current) {
            await handsRef.current.send({ image: videoRef.current });
          }
        },
        width: 640,
        height: 480,
      });
      await camera.start();
      cameraRef.current = camera;
      setCameraActive(true);
    }
  };

  /**
   * Manual SOS Simulation Fallback (as required in Part I & K of HRI proposal)
   */
  const handleSimulateSOS = () => {
    if (isCooldownRef.current) return;
    isCooldownRef.current = true;
    setCurrentGestureStatus('TRIGGERED');
    setHoldProgress(100);
    setConfidence(0.99);

    onSOSDetected({
      confidenceScore: 0.99,
      timestamp: new Date(),
      handDetected: true,
      isSOS: true,
    });

    cooldownTimerRef.current = setTimeout(() => {
      isCooldownRef.current = false;
      setHoldProgress(0);
      setCurrentGestureStatus('NONE');
    }, 5000);
  };

  return (
    <div className="relative flex flex-col bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
      {/* Top Control Bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-950/80 border-b border-slate-800 backdrop-blur-md z-20">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                currentGestureStatus === 'TRIGGERED'
                  ? 'bg-rose-500 animate-ping'
                  : currentGestureStatus === 'SOS_DETECTING'
                  ? 'bg-amber-400 animate-pulse'
                  : cameraActive || isVideoPlaying
                  ? 'bg-emerald-400'
                  : 'bg-slate-500'
              }`}
            />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              {feedMode === 'camera' ? 'Webcam Live Stream' : 'Fallback Video Feed'}
            </span>
          </div>

          <div className="hidden sm:flex items-center text-xs text-slate-400 space-x-3 border-l border-slate-800 pl-3">
            <span>FPS: <strong className="text-slate-200">{fps}</strong></span>
            <span>Confidence: <strong className="text-slate-200">{Math.round(confidence * 100)}%</strong></span>
          </div>
        </div>

        {/* Source switchers & Fallback tools */}
        <div className="flex items-center space-x-2">
          {feedMode === 'fallback_video' ? (
            <button
              onClick={switchToCamera}
              className="flex items-center space-x-1.5 px-2.5 py-1 text-xs font-medium text-cyan-400 hover:text-cyan-300 bg-cyan-950/50 hover:bg-cyan-900/50 border border-cyan-800 rounded-lg transition-colors"
            >
              <Camera className="w-3.5 h-3.5" />
              <span>Use Webcam</span>
            </button>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center space-x-1.5 px-2.5 py-1 text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-800/60 hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors"
              title="Upload sample MP4 video fallback"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Load Video</span>
            </button>
          )}

          {/* Hidden File Input for video fallback */}
          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/webm"
            className="hidden"
            onChange={handleFileUpload}
          />

          {/* Manual Emergency Fallback Simulation */}
          <button
            onClick={handleSimulateSOS}
            disabled={isCooldownRef.current || isLocked}
            className="flex items-center space-x-1 px-2.5 py-1 text-xs font-medium text-rose-400 hover:text-rose-300 bg-rose-950/40 hover:bg-rose-900/40 border border-rose-800/80 rounded-lg transition-colors disabled:opacity-50"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>Simulate SOS</span>
          </button>
        </div>
      </div>

      {/* Viewport Frame */}
      <div className="relative w-full aspect-[4/3] bg-black overflow-hidden flex items-center justify-center">
        {/* Loading overlay */}
        {modelLoading && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950/90 backdrop-blur-sm text-slate-300">
            <RefreshCw className="w-8 h-8 text-cyan-400 animate-spin mb-3" />
            <p className="text-sm font-medium">Initializing MediaPipe Hands Vision Pipeline...</p>
            <p className="text-xs text-slate-500 mt-1">Loading 21-keypoint kinematic model (Client-side 100%)</p>
          </div>
        )}

        {/* Error overlay */}
        {errorMessage && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950/95 p-6 text-center">
            <AlertTriangle className="w-10 h-10 text-rose-500 mb-3" />
            <h4 className="text-base font-semibold text-rose-300">Camera / Vision Error</h4>
            <p className="text-xs text-slate-400 mt-1 max-w-sm">{errorMessage}</p>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="mt-4 px-4 py-2 text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition"
            >
              Switch to Fallback MP4 Video
            </button>
          </div>
        )}

        {/* Video stream element (Mirrored when live camera) */}
        <video
          ref={videoRef}
          src={videoFileSrc || undefined}
          playsInline
          muted
          loop={feedMode === 'fallback_video'}
          className={`w-full h-full object-cover ${
            feedMode === 'camera' ? '-scale-x-100' : ''
          }`}
          onPlay={() => setIsVideoPlaying(true)}
          onPause={() => setIsVideoPlaying(false)}
        />

        {/* Vision Skeleton Overlay Canvas */}
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 w-full h-full object-cover pointer-events-none ${
            feedMode === 'camera' ? '-scale-x-100' : ''
          }`}
        />

        {/* Fallback Video Play/Pause floating button */}
        {feedMode === 'fallback_video' && (
          <button
            onClick={toggleVideoPlayback}
            className="absolute bottom-4 right-4 z-20 p-2.5 rounded-full bg-slate-900/80 hover:bg-slate-800 text-white border border-slate-700 backdrop-blur shadow-lg transition"
          >
            {isVideoPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
          </button>
        )}

        {/* Persistent Bottom Progress Bar (Active during SOS Detection) */}
        {holdProgress > 0 && (
          <div className="absolute bottom-0 left-0 right-0 z-20 h-2 bg-slate-900/80">
            <div
              className={`h-full transition-all duration-75 ease-linear ${
                holdProgress >= 100
                  ? 'bg-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.9)]'
                  : 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]'
              }`}
              style={{ width: `${holdProgress}%` }}
            />
          </div>
        )}
      </div>

      {/* Dynamic Status Banner */}
      <div className="p-4 bg-slate-950 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center space-x-3 w-full sm:w-auto">
          {currentGestureStatus === 'TRIGGERED' ? (
            <div className="p-2 rounded-xl bg-rose-500/20 text-rose-400 border border-rose-500/40 animate-bounce">
              <AlertTriangle className="w-5 h-5" />
            </div>
          ) : currentGestureStatus === 'SOS_DETECTING' ? (
            <div className="p-2 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse">
              <Eye className="w-5 h-5" />
            </div>
          ) : (
            <div className="p-2 rounded-xl bg-slate-800 text-emerald-400 border border-slate-700">
              <CheckCircle2 className="w-5 h-5" />
            </div>
          )}

          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Detector State
            </div>
            <div className="text-sm font-bold text-slate-100">
              {currentGestureStatus === 'TRIGGERED' && (
                <span className="text-rose-400">DISTRESS DETECTED &bull; ROBOT DISPATCHED</span>
              )}
              {currentGestureStatus === 'SOS_DETECTING' && (
                <span className="text-amber-400">
                  SOS Gesture Held: {holdProgress}% (Hold {requiredHoldDurationSec}s)
                </span>
              )}
              {currentGestureStatus === 'THUMB_TUCKED' && (
                <span className="text-amber-300">Thumb Tucked: Fold 4 fingers over thumb</span>
              )}
              {currentGestureStatus === 'HAND_TRACKED' && (
                <span className="text-emerald-400">Hand Active &bull; Ready for Signal for Help</span>
              )}
              {currentGestureStatus === 'NONE' && (
                <span className="text-slate-400">Waiting for hand in camera view...</span>
              )}
            </div>
          </div>
        </div>

        {/* Visual Gesture Guide Indicator */}
        <div className="flex items-center space-x-2 text-xs bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800">
          <span className="text-slate-400">Signal for Help Guide:</span>
          <span
            className={`px-1.5 py-0.5 rounded font-mono ${
              currentGestureStatus === 'THUMB_TUCKED' || currentGestureStatus === 'SOS_DETECTING' || currentGestureStatus === 'TRIGGERED'
                ? 'bg-amber-950 text-amber-300 border border-amber-800'
                : 'bg-slate-800 text-slate-400'
            }`}
          >
            1. Tuck Thumb
          </span>
          <span className="text-slate-600">&rarr;</span>
          <span
            className={`px-1.5 py-0.5 rounded font-mono ${
              currentGestureStatus === 'SOS_DETECTING' || currentGestureStatus === 'TRIGGERED'
                ? 'bg-rose-950 text-rose-300 border border-rose-800'
                : 'bg-slate-800 text-slate-400'
            }`}
          >
            2. Fold 4 Fingers
          </span>
        </div>
      </div>
    </div>
  );
}
